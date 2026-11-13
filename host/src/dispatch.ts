/**
 * 设备 → Peer 的生命周期表，以及**唯一**的一元派发入口（D-2）。
 *
 * 派发模型：守卫**不**自己做反向代理，也**不**调 `ctx.typertGateway.invoke()`。
 * 一元调用一律是
 *
 * ```ts
 * ctx.connection.createSharedFetchHandler('/api').fetch(request, peer)
 * ```
 *
 * 只有走 `sharedFetch` 才复用到 Connection 的信封解析、二进制附件投影、
 * `/api/<ns>/<method>` 路径解析，以及它对非 owner 的 exact-Fetch-403 /
 * 未认领 endpoint-404 语义 —— 这两条正是我们要的可诊断行为。
 *
 * `Request.url` 用 `http://hub.internal/api/<ns>/<method>`；这个主机名**不参与
 * 任何判定**（官方 LiveShare 用 `http://liveshare.internal`）。它不是网络请求，
 * `sharedFetch` 直接进程内分派。真正的来源判定在 `fence.ts`。
 *
 * **`interactions: 'none'`（D-13）**：默认是 `'answer'`，那会让设备 Peer 白白
 * 多开一条 `$events` 流；非 owner 永远不能回答 waterfall（Gateway 里
 * `answers = principal.kind === 'owner'`），所以 `'none'` 让 `$events` 直接以
 * `gateway/interactions-forbidden` 拒绝，少一条伪造面。
 *
 * **一个设备一个长期 Peer**（按 `deviceId` 归并）。吊销或角色变更时 `dispose()`
 * 旧 Peer 并重建 —— 否则旧 Peer 里固定的 `principal.role` 会继续生效。
 *
 * @module dsh-remote-hub/host/dispatch
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'

import { ERROR_CODES } from '@core/index.js'
import type { RoleName } from '@core/index.js'

import { remoteDevicePrincipal } from './principal.js'
import type { TokenService } from './token.js'

/** 内部主机名；不参与判定，只用来构造合法的 `Request.url`。 */
export const DISPATCH_ORIGIN = 'http://hub.internal'

/** 一个设备的 Peer 条目。 */
export interface DevicePeer {
  readonly deviceId: string
  readonly role: RoleName
  readonly peer: PeerScope
  /** `Peer.dispose()`（运行时存在，`PeerScope` 类型上未声明）。 */
  dispose(): Promise<void>
}

export interface Dispatcher {
  /** 为已认证的设备取（或惰性创建）Peer。 */
  peerFor(deviceId: string, role: RoleName): PeerScope
  /**
   * 用 `peer` 身份派发一条官方 `/api` 一元调用。
   * @param endpoint - `<namespace>/<method>`，例如 `session/list`。
   * @param envelope - **完整的官方 `client-request` 信封**，原样转发（守卫已做过
   *   形状校验；Gateway 的 zod 还要再校验一次，字段必须保留）。
   * @param peer - 由令牌推导，客户端无法自称。
   * @returns Connection 的 Fetch `Response`（含官方 `server-response` 信封）。
   */
  fetch(endpoint: string, envelope: unknown, peer: PeerScope): Promise<Response>
  /** 丢弃该设备的 Peer（吊销 / 角色变更 / 断开）。 */
  drop(deviceId: string): Promise<void>
  /** `dispose()`：按逆序丢弃全部 Peer。 */
  dispose(): Promise<void>
  /** 当前活跃 Peer 数（诊断与测试）。 */
  readonly size: number
}

interface ConnectionHandle {
  createSharedFetchHandler(channel: '/api'): {
    fetch(request: Request, peer: PeerScope): Promise<Response>
    requestBodyMode(request: { method: string; url: URL }): string
  }
  createPeer(options: { principal: unknown; interactions: 'answer' | 'none' }): PeerScope
}

/**
 * 创建 dispatcher。
 * @param ctx - Host Context，必须已注入 `connection`。
 * @param tokens - 令牌服务（订阅吊销/角色变更以自动丢 Peer）。
 * @returns `Dispatcher`。
 * @throws 当 `ctx.connection` 缺失时（fail loud）。
 */
export function createDispatcher(ctx: Context, tokens: TokenService): Dispatcher {
  // **必须走 reflect.get 读实例**：reflect.props[name] 是声明元数据而非服务对象
  // （2026-11-11 实机教训，与 policy.ts 同修）。调用点在 ctx.inject 回调里（服务
  // 已就绪），strict=false 宽松读不抛错。
  const connection = (ctx as unknown as {
    reflect?: { get?: (name: string, strict?: boolean) => unknown }
  }).reflect?.get?.('connection', false) as ConnectionHandle | undefined
  if (connection === undefined || typeof connection.createSharedFetchHandler !== 'function') {
    throw new Error(
      'dsh-remote-hub: ctx.connection is unavailable; the web profile must mount '
      + '@deepseek-ai/dsh-client-connection before this plugin starts',
    )
  }
  const handler = connection.createSharedFetchHandler('/api')
  const peers = new Map<string, DevicePeer>()

  const makePeer = (deviceId: string, role: RoleName): DevicePeer => {
    const principal = remoteDevicePrincipal({ deviceId, role })
    const peer = connection.createPeer({ principal, interactions: 'none' })
    const dispose = (peer as unknown as { dispose?: () => Promise<void> }).dispose
    return {
      deviceId,
      role,
      peer,
      async dispose() {
        if (typeof dispose === 'function') await dispose.call(peer)
      },
    }
  }

  const offRevoked = tokens.onRevoked(deviceId => { void drop(deviceId) })
  const offRoleChanged = tokens.onRoleChanged((deviceId, role) => {
    void drop(deviceId).then(() => {
      // 下一次请求会携带新角色（惰性重建）。
      void role
    })
  })

  async function drop(deviceId: string): Promise<void> {
    const entry = peers.get(deviceId)
    if (entry === undefined) return
    peers.delete(deviceId)
    await entry.dispose()
  }

  return {
    get size() { return peers.size },
    peerFor(deviceId, role) {
      const existing = peers.get(deviceId)
      if (existing !== undefined) {
        if (existing.role === role) return existing.peer
        // 角色变了：同步换掉旧 Peer，下一次请求用新 principal。
        void drop(deviceId)
      }
      const entry = makePeer(deviceId, role)
      peers.set(deviceId, entry)
      return entry.peer
    },
    async fetch(endpoint, envelope, peer) {
      if (!/^[A-Za-z0-9_$.-]+\/[A-Za-z0-9_$.-]+$/u.test(endpoint)) {
        return Response.json({
          type: 'server-response',
          rpcId: 'invalid-endpoint',
          result: {
            ok: false,
            error: { code: ERROR_CODES.badRequest, message: 'invalid Remote endpoint', details: {} },
          },
        }, { status: 400 })
      }
      const request = new Request(`${DISPATCH_ORIGIN}/api/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // **原样转发完整信封**：Gateway 的 zod 会再次校验 {type, rpcId, method,
        // payload}，丢掉外层字段就会得到 `invalid client-request message`。
        body: JSON.stringify(envelope),
      })
      return handler.fetch(request, peer)
    },
    drop,
    async dispose() {
      offRevoked()
      offRoleChanged()
      const entries = [...peers.values()].reverse()
      peers.clear()
      for (const entry of entries) await entry.dispose()
    },
  }
}
