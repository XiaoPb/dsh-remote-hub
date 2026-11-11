/**
 * 本插件**自己**的 Remote 面（namespace `hub`）。
 *
 * ⚠️ v0.2 / D-1：这里**不再镜像**官方 endpoint（那十个业务方法的翻译层已删除）。
 * 官方 endpoint 由守卫直接转发到 `createSharedFetchHandler('/api')`；这里只剩下
 * 官方**不给非 owner Peer** 的三件事：设备管理、流（长轮询）、审批应答。
 *
 * 每个类都是 `TypertRemoteService` 子类，用 `@Remote` 装饰器导出方法 —— 所以
 * 它们和官方 endpoint 走**完全相同**的裁决路径：Gateway 的参数校验 →
 * `remoteAccess.decide()` → 业务调用（红线 R9：不存在绕过守卫的简化端点）。
 *
 * ## 参数形状为什么这么写
 *
 * Gateway 的 SRC 描述符用 `Function.prototype.toString()` 读方法的**参数名**，
 * 并把它们当作 wire 字段名（`methodParameterNames()` in gateway/src/index.ts）。
 * 所以下面每个方法的参数名就是客户端 `payload.args` 里必须出现的字段名，
 * 一个不多一个不少（`assertExactArguments` 会拒掉多余字段）。这是**故意**的：
 * 它让「参数校验只有一份实现」成为现实（D-1 的直接收益）。
 *
 * 对应关系（客户端 `hub/stream.*` 契约与此逐字一致）：
 * - `hub/stream.open(endpoint, args)`      → `{ endpoint, args }`
 * - `hub/stream.next(streamId, cursor, holdMs)` → `{ streamId, cursor, holdMs }`
 * - `hub/stream.cancel(streamId)`          → `{ streamId }`
 * - `hub/devices()`                        → `{}`
 * - `hub/revoke(deviceId)`                 → `{ deviceId }`
 * - `hub/answerApproval(requestId, outcome)` → `{ requestId, outcome }`
 *
 * @module dsh-remote-hub/host/services
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  Remote,
  TypertRemoteService,
  principalOf,
} from '@deepseek-ai/dsh-typert-protocol'

import { ERROR_CODES, GUARD_ROUTES, HUB_NAMESPACE, HUB_SERVICE_KEYS } from '@core/index.js'
import { allActionsFor } from '@core/capabilities.js'
import type { RoleName } from '@core/index.js'

import type { AccessPolicyHandles } from '../policy.js'
import type { StreamEngine } from '../streams.js'
import type { ApprovalBridge } from '../approval-bridge.js'
import type { DeviceStore } from '../devices.js'
import type { TokenService } from '../token.js'
import { remoteDeviceOf } from '../principal.js'

/** 所有 `hub/*` 服务共享的依赖。 */
export interface HubServicesDeps {
  streams: StreamEngine
  approvals: ApprovalBridge
  devices: DeviceStore
  tokens: TokenService
  policy: AccessPolicyHandles
  /** 把吊销事件传播到流引擎（由 plugin.ts 接线）。 */
  onRevoked: (deviceId: string) => void
}

/** 服务抛出的结构化错误（Gateway 会把它转成 `server-response` 的 ok:false）。 */
class HubFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'HubFailure'
  }
}

function deny(code: string, message: string): never {
  throw new HubFailure(code, message)
}

/**
 * 从当前调用里读出 `remote-device` principal。
 *
 * `principalOf(this.ctx.invocation)` 是官方导出的取法；用宽松形状调用以保持
 * 与 0.2.x 的类型兼容。
 */
function caller(ctx: Context): { deviceId: string; role: RoleName } {
  const invocation = (ctx as unknown as { invocation?: unknown }).invocation
  const principal = (principalOf as unknown as (value: unknown) => unknown)(invocation)
  const device = remoteDeviceOf(principal)
  if (device === undefined) {
    deny(ERROR_CODES.forbidden, 'hub/* requires a remote-device Peer')
  }
  return { deviceId: (device as { deviceId: string }).deviceId, role: (device as { role: RoleName }).role }
}

/**
 * 三条长轮询方法（D-3/D-4）。
 *
 * **不是** Typert stream 方法：它们是一元方法，返回普通值，因此不需要
 * `/api/remote.mux`（那条 socket 的 Peer 恒为 owner，非 owner 拿不到）。
 */
export class HubStreamsService extends TypertRemoteService {
  constructor(ctx: Context, private readonly engine: StreamEngine) {
    super(ctx, HUB_SERVICE_KEYS.streams, { namespace: HUB_NAMESPACE })
  }

  /**
   * 打开一条流。
   * @param endpoint - 官方 stream endpoint，必须在该角色的 `openableStreams()` 里。
   * @param args - 该官方方法的命名参数。
   * @returns `{ streamId, cursor }`。
   */
  @Remote('stream.open')
  async open(endpoint: string, args: Record<string, unknown>): Promise<{ streamId: string; cursor: number }> {
    const { deviceId, role } = caller(this.ctx)
    const result = await this.engine.open({
      deviceId,
      role,
      endpoint,
      args: args ?? {},
      peer: (this.ctx as unknown as { invocation?: { peer?: unknown } }).invocation?.peer,
    })
    if (result === null) {
      // 统一错误：**不区分**「不存在」「角色不足」「不是 stream 方法」「超并发」。
      deny(ERROR_CODES.streamOpenDenied, 'stream target is not available')
    }
    return result as { streamId: string; cursor: number }
  }

  /**
   * 拉取下一批。
   * @param streamId - `open()` 返回的 id（绑定 deviceId，跨设备猜测无效）。
   * @param cursor - 上一次返回的 `nextCursor`；回退或超越 → `cursor-invalid`。
   * @param holdMs - 期望持有时间（被配置上限钳制）。
   * @returns 批次、下一游标、可选的终态。
   */
  @Remote('stream.next')
  async next(
    streamId: string,
    cursor: number,
    holdMs?: number,
  ): Promise<{
    items: unknown[]
    nextCursor: number
    done?: boolean
    terminal?: { code: string }
    truncated?: boolean
  }> {
    const { deviceId } = caller(this.ctx)
    const result = await this.engine.next({ deviceId, streamId, cursor, ...(holdMs === undefined ? {} : { holdMs }) })
    if (result === null) {
      deny(ERROR_CODES.streamNotFound, 'stream not found')
    }
    return result as { items: unknown[]; nextCursor: number }
  }

  /**
   * 取消一条流。
   * @param streamId - 流 id。
   * @returns `{ ok }`。
   */
  @Remote('stream.cancel')
  async cancel(streamId: string): Promise<{ ok: boolean }> {
    const { deviceId } = caller(this.ctx)
    return this.engine.cancel(deviceId, streamId)
  }
}

/** 设备管理与审批应答。 */
export class HubDevicesService extends TypertRemoteService {
  constructor(ctx: Context, private readonly deps: HubServicesDeps) {
    super(ctx, HUB_SERVICE_KEYS.devices, { namespace: HUB_NAMESPACE })
  }

  /**
   * 列出设备（只给 `control` / `full`；`read-only` 由 `decide()` 拒掉）。
   * 返回的字段里**只有** `tokenHash`，没有明文令牌。
   * @returns 设备清单。
   */
  @Remote('devices')
  devices(): { items: readonly unknown[] } {
    const { role } = caller(this.ctx)
    if (!allActionsFor(role).includes('hub/devices')) {
      deny('remote-access/denied', 'hub/devices is not granted to this role')
    }
    return {
      items: this.deps.devices.list().map(device => ({
        deviceId: device.deviceId,
        label: device.label,
        role: device.role,
        createdAt: device.createdAt,
        lastSeenAt: device.lastSeenAt,
        revokedAt: device.revokedAt,
        // tokenHash 故意不返回：设备清单不是凭据分发面。
      })),
    }
  }

  /**
   * 吊销一台设备（只给 `full`）。吊销后 ≤ `streamHoldMs` 内该设备的下一次
   * `hub/stream.next` 得到终态 `device-revoked`。
   * @param deviceId - 目标设备。
   * @returns `{ ok }`。
   */
  @Remote('revoke')
  async revoke(deviceId: string): Promise<{ ok: boolean }> {
    const { role } = caller(this.ctx)
    if (!allActionsFor(role).includes('hub/revoke')) {
      deny('remote-access/denied', 'hub/revoke is not granted to this role')
    }
    await this.deps.tokens.revoke(deviceId)
    this.deps.streams.markRevoked(deviceId)
    this.deps.onRevoked(deviceId)
    this.deps.policy.invalidate(deviceId)
    return { ok: true }
  }

  /**
   * 回答一次审批。**只接受三值**（`unavailable` 会被拒）。
   * @param requestId - 审批帧里的 id。
   * @param outcome - `allowed-once` | `rejected` | `cancelled`。
   * @returns `{ ok }` 或 `{ ok: false, error }`。
   */
  @Remote('answerApproval')
  answerApproval(requestId: string, outcome: string): { ok: boolean; error?: string } {
    const { deviceId, role } = caller(this.ctx)
    if (!allActionsFor(role).includes('hub/answerApproval')) {
      deny('remote-access/denied', 'hub/answerApproval is not granted to this role')
    }
    return this.deps.approvals.answer({ deviceId, role, requestId, outcome })
  }
}

/** 注册全部 `hub/*` 服务。返回 disposer。 */
export interface RemoteServicesHandle {
  dispose(): Promise<void>
}

/**
 * 注册 `hubStreams` 与 `hubDevices` 两个 Cordis 服务。
 *
 * 两个类共用 wire namespace `hub`，但 service key 不同 —— Gateway 的
 * `resolveSrcDescriptor` 按 namespace + method 找唯一候选，只要方法名不重复
 * 就不会 `ambiguous-endpoint`。
 * @param ctx - Host Context。
 * @param deps - 共享依赖。
 * @returns 句柄。
 */
export function registerRemoteServices(ctx: Context, deps: HubServicesDeps): RemoteServicesHandle {
  const streams = new HubStreamsService(ctx, deps.streams)
  const devices = new HubDevicesService(ctx, deps)
  return {
    async dispose() {
      void streams
      void devices
      // Service 实例随 fiber 自动注销；这里保留显式入口以便测试与未来扩展。
    },
  }
}

/** 守卫的路由表（供 guard.ts 与契约快照共用；这里 re-export 避免两份真相）。 */
export { GUARD_ROUTES }
