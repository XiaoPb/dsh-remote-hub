/**
 * 守卫 WebSocket 端点 `/remote/ws`（A3 形态：认领 + 移交）。
 *
 * ## 为什么不自己转发
 *
 * 调研结论（架构说明 §10.7–10.9）：
 *
 * 1. 官方 `webServer.registerUpgrade(route)` 是公开的 WS 升级注册接口；
 * 2. `connection.admitConnection(request)` 是官方的「认领 API socket」同步能力；
 * 3. **实测**：守卫作为 WS 客户端连 Host 的 `/api/remote.mux` 被拒（非 101），
 *    因为 `admitConnection` 要求合法 Host 会话，外部进程拿不到。
 *
 * 因此正确形态是：**守卫与 Host 在同一进程**，守卫完成设备令牌校验后，
 * 把 socket **直接移交**给 Host 的 mux —— 不需要任何上游连接、不需要解析帧。
 *
 * ## 职责边界
 *
 * | 守卫负责 | 守卫**不**负责 |
 * | --- | --- |
 * | 校验设备令牌 | 解析 mux 业务帧 |
 * | 校验转发目标白名单 | 维护流状态 |
 * | 认领 socket（admitConnection） | 处理心跳/ping（Host mux 自己管） |
 * | 失败时回 401/400 | 记令牌到日志 |
 *
 * @module dsh-remote-hub/host/guard-ws
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

/** 浏览器连守卫的路径。 */
export const GUARD_WS_PATH = '/remote/ws'

/** 守卫还原转发目标的 query 参数名。 */
export const HUB_WS_TARGET_PARAM = 'ws-target'

/** 默认转发目标（DSH Gateway 的 Remote mux 路由）。 */
export const DEFAULT_WS_TARGET = '/api/remote.mux'

/** 允许转发的目标白名单前缀（防路径穿越 / SSRF）。 */
export const ALLOWED_TARGET_PREFIXES: readonly string[] = ['/api/']

/** 一次升级请求的处理结局。 */
export type GuardWsOutcome =
  | 'accepted'
  | 'unauthorized'
  | 'bad-target'
  | 'refused'

/** 守卫 WS 依赖：全部由 `plugin.ts` 从 Host ctx 注入。 */
export interface GuardWsDeps {
  /** 校验设备令牌（复用 TokenService.verify）。 */
  authenticate: (
    token: string,
    request: IncomingMessage,
  ) => { deviceId: string; role: string } | null | Promise<{ deviceId: string; role: string } | null>
  /**
   * 把已校验的 socket **移交**给 Host 的 mux。
   *
   * 实现方（plugin.ts）应调用官方的 `connection.admitConnection(req)` +
   * `mux.handleUpgrade(req, socket, head, admission.peer)`；
   * 本模块只负责「决定是否放行」。
   */
  handoff: (input: {
    request: IncomingMessage
    socket: Duplex
    head: Buffer
    target: string
    deviceId: string
    role: string
  }) => void | Promise<void>
  /** 记录一次结局（**不得**包含令牌）。 */
  onEvent?: (event: { outcome: GuardWsOutcome; deviceId?: string; target?: string }) => void
}

/** 守卫 WS 句柄。 */
export interface GuardWsHandle {
  /** 由 webServer.registerUpgrade 注册的 route。 */
  readonly route: { path: string; handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void }
}

/** 写一个最小 HTTP 错误响应并关闭 socket。 */
function reject(socket: Duplex, status: number, reason: string): void {
  const body = `${reason}\n`
  const response = [
    `HTTP/1.1 ${status} ${reason}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n')
  try { socket.end(response) } catch { /* 已关闭 */ }
  try { socket.destroy() } catch { /* 已关闭 */ }
}

/**
 * 构造 `/remote/ws` 的升级路由。
 *
 * 调用方（plugin.ts）把它交给 `webServer.registerUpgrade(route)`；
 * 返回值是 route 对象，便于测试直接调用 handler。
 * @param deps - 依赖（全部来自 Host ctx）。
 * @returns 句柄（含 route）。
 */
export function createGuardWsRoute(deps: GuardWsDeps): GuardWsHandle {
  const handler = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let url: URL
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1')
    } catch {
      reject(socket, 400, 'Bad Request')
      deps.onEvent?.({ outcome: 'refused' })
      return
    }

    // 1. 必须是合法的 WS 升级请求
    const key = request.headers['sec-websocket-key']
    const upgrade = String(request.headers.upgrade ?? '').toLowerCase()
    if (upgrade !== 'websocket' || typeof key !== 'string' || key === '') {
      reject(socket, 400, 'Bad Request')
      deps.onEvent?.({ outcome: 'refused' })
      return
    }

    // 2. 令牌（只读一次，从不写日志）
    const token = url.searchParams.get('token') ?? ''
    if (token === '') {
      reject(socket, 401, 'Unauthorized')
      deps.onEvent?.({ outcome: 'unauthorized' })
      return
    }

    // 3. 转发目标白名单
    const target = url.searchParams.get(HUB_WS_TARGET_PARAM) ?? DEFAULT_WS_TARGET
    if (!ALLOWED_TARGET_PREFIXES.some(prefix => target.startsWith(prefix))) {
      reject(socket, 400, 'Bad Request')
      deps.onEvent?.({ outcome: 'bad-target' })
      return
    }

    // 4. 校验令牌 → 移交
    void Promise.resolve()
      .then(() => deps.authenticate(token, request))
      .then(peer => {
        if (peer === null) {
          reject(socket, 401, 'Unauthorized')
          deps.onEvent?.({ outcome: 'unauthorized' })
          return
        }
        return Promise.resolve(deps.handoff({
          request,
          socket,
          head,
          target,
          deviceId: peer.deviceId,
          role: peer.role,
        })).then(() => {
          deps.onEvent?.({ outcome: 'accepted', deviceId: peer.deviceId, target })
        })
      })
      .catch(error => {
        reject(socket, 500, 'Internal Server Error')
        deps.onEvent?.({ outcome: 'refused' })
      })
  }

  return { route: { path: GUARD_WS_PATH, handler } }
}
