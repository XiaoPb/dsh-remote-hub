/**
 * 浏览器传输层：一元 RPC + 三方法长轮询，**没有任何 WebSocket**（D-3）。
 *
 * 为什么不是 socket：官方 `/api/remote.mux` 的升级走 `admitConnection()`，
 * 只认 `browserAuth` → **恒为 owner Peer**，非 owner 设备拿不到那条 socket。
 * 所以 v1 的下行是 `hub/stream.{open,next,cancel}` 三条**一元**方法，走同一个
 * `POST /remote/rpc` 入口，同样过官方 `decide()`（红线 R9）。
 *
 * 规则：
 * - 每请求带 `Authorization: Bearer <deviceToken>`；令牌只在内存，**绝不进 URL**。
 * - 401 → 调一次 `onUnauthorized()`、清令牌、**停止所有重试**。
 * - `remote-access/denied` / `forbidden` 也停止重试（入口本来就不该存在）。
 * - 超时判定发生在 `STREAM_BUDGET.holdMs + STREAM_BUDGET.pollSlackMs` 之后；
 *   空闲 60s 内 `hub/stream.next` ≈ 15 次，业务方法调用数为 0。
 *
 * @module dsh-remote-hub/client/transport
 */
import {
  AUTH_HEADER,
  BEARER_SCHEME,
  ERROR_CODES,
  GUARD_ROUTES,
  HUB_METHODS,
  HUB_PROTOCOL_HEADER,
  OFFICIAL_ERROR_CODES,
  PAIR_ISSUE_HEADER,
  PROTOCOL_VERSION,
  STREAM_BUDGET,
  hubEndpoint,
} from '@core/protocol.js'
import type { IssuedDeviceToken } from '@core/device.js'
import type { RoleName } from '@core/roles.js'

/** 官方 `client-request` 信封。 */
export interface ClientRequestEnvelope {
  type: 'client-request'
  rpcId: string
  method: string
  payload: { args: Record<string, unknown> }
}

/** 官方 `server-response` 信封。 */
export interface ServerResponseEnvelope {
  type: 'server-response'
  rpcId: string
  result:
    | { ok: true; value?: unknown }
    | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }
}

/**
 * 错误分类（页面诊断用）。
 *
 * 浏览器里「守卫没起来」「CORS 预检被拒」「凭据不对」「HTTP 4xx」此前全部被压成
 * `Failed to fetch` / 一句散文，无法定位。每个请求都带一个明确的 kind：
 * - `missing-injection`：本机未注入 guard origin 或 pairIssueToken（宿主未装配）。
 * - `preflight-failed`：跨源预检没通过（守卫未运行 / 守卫版本过旧不做 OPTIONS）。
 * - `network-unreachable`：fetch 直接 reject（连接被拒、DNS、离线）。
 * - `cors-blocked`：请求已发出但读不到响应（缺 Access-Control-Allow-Origin）。
 * - `http-400`/`http-401`/`http-403`/`http-404`/`http-5xx`：守卫明确拒绝。
 * - `closed`：transport 已被 401 终止。
 */
export type RemoteHubErrorKind =
  | 'missing-injection'
  | 'preflight-failed'
  | 'network-unreachable'
  | 'cors-blocked'
  | 'http-400'
  | 'http-401'
  | 'http-403'
  | 'http-404'
  | 'http-5xx'
  | 'closed'

/** 带 `code` 的错误，便于 UI 分类（不是普通网络错误）。 */
export class RemoteHubError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> = {},
    /** 诊断分类（缺省时由 status 推导）。 */
    readonly kind?: RemoteHubErrorKind,
    /** 请求路径（不含 query / 不含凭据）。 */
    readonly path?: string,
  ) {
    super(message)
    this.name = 'RemoteHubError'
  }
}

/**
 * 由 HTTP 状态推导错误分类。
 *
 * 成功状态（2xx/3xx）返回 `'ok'`——调用方据此区分「诊断上报」与「错误」。
 * 之前把 2xx 兜底成 `http-400`，导致诊断卡把成功的请求显示成 `200 · http-400`。
 */
export function errorKindOf(status: number): RemoteHubErrorKind | 'ok' {
  if (status >= 200 && status < 400) return 'ok'
  if (status === 0) return 'network-unreachable'
  if (status === 400) return 'http-400'
  if (status === 401) return 'http-401'
  if (status === 403) return 'http-403'
  if (status === 404) return 'http-404'
  if (status >= 400) return 'http-5xx'
  return 'ok'
}

/** 一次管理请求的诊断快照（页面「守卫诊断」区直接消费；绝不含凭据）。 */
export interface AdminRequestDiagnostic {
  path: string
  method: string
  /** 目标守卫 origin。 */
  origin: string
  /** 本机页面 origin（浏览器侧；Node 测试下为空）。 */
  pageOrigin: string
  status: number
  kind: RemoteHubErrorKind | 'ok'
  /** 守卫返回的错误码（若有）。 */
  code?: string
  /** 守卫返回的错误文案（已脱敏）。 */
  message?: string
  at: number
}

/** 一条页面日志（用户可见的排障时间线；凭据一律脱敏）。 */
export interface HubLogEntry {
  at: number
  /** 级别：info 正常 / warn 降级 / error 失败。 */
  level: 'info' | 'warn' | 'error'
  /** 简短标题（例如「签发二维码」「读取设备清单」）。 */
  title: string
  /** 补充细节（错误分类、HTTP 状态、原因）。 */
  detail?: string
  /** 相关端点或路径。 */
  path?: string
}

/** 日志保留条数（页面只显示最近 N 条）。 */
export const HUB_LOG_LIMIT = 60

export interface TransportOptions {
  /** 守卫 origin（`https://…` 经隧道，`http://127.0.0.1:8443` 本机）。 */
  origin: string
  /** 设备令牌；缺省表示未配对。 */
  token?: string
  /** 本机 index 页注入的 `pairIssueToken`（签发端点专用；隧道侧拿不到）。 */
  pairIssueToken?: string
  /** 401 时调用一次，之后停止所有重试。 */
  onUnauthorized?: () => void
  /** 收到角色 / 权限快照时回调。 */
  onAccessSnapshot?: (snapshot: { role: RoleName }) => void
  /** 可注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
  /** 可注入的时钟（超时测试用）。 */
  now?: () => number
  /** 管理请求诊断回调（每次管理请求后调用；凭据已脱敏）。 */
  onAdminDiagnostic?: (diagnostic: AdminRequestDiagnostic) => void
  /** 页面日志回调（用户可见排障时间线；凭据已脱敏）。 */
  onLog?: (entry: HubLogEntry) => void
  /** 本机页面 origin（缺省从 `location.origin` 读）。 */
  pageOrigin?: string
  /**
   * 同源管理通道（优先）：走宿主 `/api/hub/admin.*`，零 CORS。
   *
   * 桌面端页面 origin 是 `dsh-app://app`（不透明来源），浏览器禁止它直接 fetch
   * `http://127.0.0.1:8443`。Electron 的 `forwardWebRequest` 会把
   * `dsh-app://app/*` 同源转发到本机 Host，所以管理端点同时注册成 Remote 方法，
   * 页面用同源 POST 调它们即可。取值为 `/api` 这类前缀；缺省 `'/api'`。
   * 设为空字符串可强制关闭（仅用于测试守卫直连路径）。
   */
  adminChannel?: string
}

/** 一条已配对设备（守卫 `/remote/devices` 的返回行）。 */
export interface GuardDeviceRow {
  deviceId: string
  label: string
  role: RoleName
  createdAt: string
  lastSeenAt: string | null
  revokedAt: string | null
}

/** 本机被控端状态（守卫 `/remote/devices` 的返回体）。 */
export interface DeviceAdminSnapshot {
  ok: boolean
  protocolVersion: number
  guard: { host: string; port: number; origin: string }
  /** 单控策略：同一时刻只允许一台设备控制本机。 */
  singleController: boolean
  devices: GuardDeviceRow[]
}

export interface OutboundTargetView {
  id: string
  origin: string
  deviceLabel?: string
  deviceId?: string
  role?: string
  pairedAt?: number
  lastConnectedAt: number
}

export interface RemoteTransport {
  /** 发一条官方一元 RPC。 */
  call<T>(method: string, args: Record<string, unknown>): Promise<T>
  /** 打开一条长轮询流。 */
  openStream(endpoint: string, args: Record<string, unknown>): Promise<{ streamId: string; cursor: number }>
  /** 拉取下一批。 */
  next(streamId: string, cursor: number, holdMs?: number): Promise<StreamNextValue>
  /** 取消一条流。 */
  cancel(streamId: string): Promise<{ ok: boolean }>
  /** 开始轮询循环；返回停止函数。 */
  subscribe(onEvent: (frame: unknown) => void): () => void
  /** 兑换票据/短码。 */
  redeem(input: { ticket?: string; code?: string; clientLabel: string }): Promise<IssuedDeviceToken>
  /** 签发 QR 票据（本机）。 */
  issueTicket(role: RoleName): Promise<{ ticket: string; expiresAt: number; role: RoleName }>
  /** 签发短码（本机）。 */
  issueCode(role: RoleName): Promise<{ code: string; expiresAt: number; role: RoleName }>
  /** 健康检查。 */
  health(): Promise<{ ok: boolean; protocolVersion: number }>
  /** 守卫健康与实例信息（同源管理面；桌面端唯一可用路径）。 */
  adminHealth(): Promise<{
    ok: true
    protocolVersion: number
    guard: { origin: string; loopbackOrigin: string; port: number }
    singleController: boolean
  }>
  /** 同源签发配对凭据（桌面端「生成二维码/短码」的唯一可用路径）。 */
  adminIssue(input: { kind: 'ticket' | 'code'; role: RoleName }): Promise<{
    ok: true
    kind: 'ticket' | 'code'
    value: string
    expiresAt: number
    role: string
  }>
  /** 本机对外监听信息（局域网 IPv4 + 端口；来自 admin.endpoints）。 */
  endpoints(): Promise<{
    port: number
    network: 'loopback' | 'lan'
    origin: string
    candidates: readonly string[]
    preferred: string
  }>
  /** 出站连接状态（`carrier-mode.json`；页面轮询真源）。 */
  carrier(): Promise<{ mode: Record<string, unknown>; at: number }>
  /** 把页面出站状态写回磁盘（返回写入后的 mtime）。 */
  carrierWrite(mode: Record<string, unknown>): Promise<number>
  listOutboundTargets(): Promise<readonly OutboundTargetView[]>
  saveOutboundTarget(target: { origin: string; token: string; deviceLabel?: string; deviceId?: string; role?: string; pairedAt?: number; lastConnectedAt?: number }): Promise<OutboundTargetView>
  activateOutboundTarget(targetId: string): Promise<number>
  forgetOutboundTarget(targetId: string): Promise<boolean>
  /** 列出本机已配对设备（需要 pairIssueToken；仅回环页面可用）。 */
  listDevices(): Promise<DeviceAdminSnapshot>
  forgetDevice(deviceId: string): Promise<boolean>
  /** 清除配对（单台或全部；需要 pairIssueToken）。 */
  revokeDevices(input: { deviceId?: string; all?: boolean }): Promise<{ revoked: string[] }>
  /** 守卫运行指标（需要 pairIssueToken；旧版本守卫 404）。 */
  stats(): Promise<{ ok: boolean } & HubMetricsSnapshot>
  /** 配置快照（需要 pairIssueToken；旧版本守卫 404）。 */
  getConfig(): Promise<{ ok: boolean; config: Record<string, unknown> }>
  /** 配置白名单子集写入（越界字段 400）。 */
  patchConfig(input: Record<string, unknown>): Promise<{ ok: boolean; config: Record<string, unknown> }>
  /** 更新内存令牌。 */
  setToken(token: string | undefined): void
  /** 关闭全部轮询。 */
  close(): void
  readonly closed: boolean
  /** 诊断：`hub/stream.next` 调用次数。 */
  readonly streamNextCalls: number
  /** 诊断：业务方法轮询次数（恒为 0）。 */
  readonly businessPollCalls: number
}

export interface StreamNextValue {
  items: unknown[]
  nextCursor: number
  done?: boolean
  terminal?: { code: string }
  truncated?: boolean
}

const RETRYABLE_STATUS: readonly number[] = [408, 429, 502, 503, 504]
const RETRYABLE_CODES: readonly string[] = [
  ERROR_CODES.streamNotFound,
  'gateway/internal',
  'gateway/service-unavailable',
]

function uuid(): string {
  // Web Crypto 在浏览器与现代 WebView 都有；缺失时退化成时间戳+随机。
  const cryptoObj = globalThis.crypto as { randomUUID?: () => string } | undefined
  if (typeof cryptoObj?.randomUUID === 'function') return cryptoObj.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** 判断一个错误是否应该「停止重试」（终态）。 */
function isTerminal(error: RemoteHubError): boolean {
  if (error.status === 401) return true
  if (error.code === OFFICIAL_ERROR_CODES.remoteAccessDenied) return true
  if (error.code === ERROR_CODES.forbidden) return true
  if (error.code === ERROR_CODES.protocolVersionMismatch) return true
  if (error.code === ERROR_CODES.deviceRevoked) return true
  if (RETRYABLE_STATUS.includes(error.status)) return false
  if (RETRYABLE_CODES.includes(error.code)) return false
  return error.status >= 400 && error.status < 500
}

/** 守卫运行指标（`/remote/stats` 返回体；与 host HubMetrics 同形）。 */
export interface HubMetricsSnapshot {
  startedAt: string
  pairIssued: number
  pairRedeemed: number
  pairRejected: number
  authAccepted: number
  authDenied: number
  activeStreams: number
  streamsOpened: number
  hourly: readonly number[]
  daily: readonly number[]
}

/**
 * 创建浏览器 transport。
 * @param options - origin、令牌、回调与注入依赖。
 * @returns `RemoteTransport`。
 */
export function createTransport(options: TransportOptions): RemoteTransport {
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args))
  const now = options.now ?? (() => Date.now())
  const origin = options.origin.replace(/\/+$/u, '')
  let token: string | undefined = options.token
  let closed = false
  let unauthorizedCalled = false
  let streamNextCalls = 0
  let businessPollCalls = 0
  const pollLoops = new Set<{ stop: () => void }>()

  const baseHeaders = (): Record<string, string> => ({
    [HUB_PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    ...(token === undefined ? {} : { [AUTH_HEADER]: `${BEARER_SCHEME} ${token}` }),
  })

  const handleUnauthorized = (): void => {
    token = undefined
    if (unauthorizedCalled) return
    unauthorizedCalled = true
    options.onUnauthorized?.()
    // 401 之后**停止所有重试**：清掉全部轮询循环。
    for (const loop of [...pollLoops]) loop.stop()
    pollLoops.clear()
    closed = true
  }

  /** 统一解析官方 server-response 信封。 */
  const parseEnvelope = (rpcId: string, status: number, text: string): unknown => {
    let parsed: ServerResponseEnvelope
    try {
      parsed = JSON.parse(text) as ServerResponseEnvelope
    } catch {
      throw new RemoteHubError(ERROR_CODES.internal, 'malformed server-response envelope', status)
    }
    if (parsed.type !== 'server-response' || parsed.result === undefined) {
      throw new RemoteHubError(ERROR_CODES.internal, 'not a server-response envelope', status)
    }
    if (parsed.rpcId !== rpcId && parsed.rpcId !== 'guard' && parsed.rpcId !== 'invalid-endpoint') {
      // 守卫层的拒绝不携带客户端 rpcId；业务响应必须严格回显。
      throw new RemoteHubError(ERROR_CODES.internal, 'rpcId mismatch', status)
    }
    if (!parsed.result.ok) {
      const error = new RemoteHubError(
        parsed.result.error.code,
        parsed.result.error.message,
        status,
        parsed.result.error.details ?? {},
      )
      if (status === 401) handleUnauthorized()
      throw error
    }
    return parsed.result.value
  }

  const pageOrigin = options.pageOrigin
    ?? (globalThis.location as { origin?: string } | undefined)?.origin
    ?? ''

  /**
   * 低层 HTTP 请求。
   *
   * 除了发请求，它负责把三类此前无法区分的失败翻译成分类错误：
   * 1. `fetch` 直接 reject → 网络不可达（守卫未启动 / 端口不对）；
   * 2. 失败前没做过预检却带自定义头 → 预检失败（守卫版本旧，不做 OPTIONS）；
   * 3. 请求看似成功但读不到 body → CORS 未宣告（浏览器吞掉响应）。
   */
  const rawFetch = async (
    path: string,
    init: { method: string; body?: string; headers?: Record<string, string> },
  ): Promise<{ status: number; text: string }> => {
    const url = `${origin}${path}`
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: init.method,
        headers: { ...baseHeaders(), ...(init.headers ?? {}) },
        ...(init.body === undefined ? {} : { body: init.body }),
      })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      // 浏览器对 CORS/连接两类失败的文案都是 "Failed to fetch"，无法就地区分；
      // 这里给出两者合并的分类，并由页面诊断区显示 pageOrigin 与 targetOrigin 供判断。
      const kind: RemoteHubErrorKind = /Failed to fetch|NetworkError|Load failed/iu.test(message)
        ? 'preflight-failed'
        : 'network-unreachable'
      throw new RemoteHubError(
        ERROR_CODES.internal,
        `${kind === 'preflight-failed' ? '跨源预检或网络连接失败' : '网络不可达'}：${message}`,
        0,
        { url, pageOrigin, targetOrigin: origin },
        kind,
        path,
      )
    }
    let text: string
    try {
      text = await response.text()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      throw new RemoteHubError(
        'cors-blocked',
        `响应不可读（缺少 Access-Control-Allow-Origin？）：${message}`,
        0,
        { url, pageOrigin, targetOrigin: origin },
        'cors-blocked',
        path,
      )
    }
    return { status: response.status, text }
  }

  /** 上报一次管理请求诊断（不含凭据）。 */
  const reportDiagnostic = (
    path: string,
    method: string,
    status: number,
    kind: RemoteHubErrorKind | 'ok',
    code?: string,
    message?: string,
  ): void => {
    options.onAdminDiagnostic?.({
      path,
      method,
      origin,
      pageOrigin,
      status,
      kind,
      ...(code === undefined ? {} : { code }),
      ...(message === undefined ? {} : { message }),
      at: now(),
    })
    // 同时写一条用户可见日志：成功只记 info，失败记 error 并带分类。
    options.onLog?.({
      at: now(),
      level: kind === 'ok' ? 'info' : 'error',
      title: kind === 'ok' ? '请求成功' : '请求失败',
      detail: kind === 'ok'
        ? `HTTP ${status}`
        : `${kind}${code === undefined ? '' : ` (${code})`}${message === undefined ? '' : `：${message}`}`,
      path: `${method} ${path}`,
    })
  }

  /** 解析管理端点的错误体（守卫统一用 server-response 信封）。 */
  const adminFailure = (path: string, method: string, status: number, text: string): RemoteHubError => {
    let code: string | undefined
    let message: string | undefined
    try {
      const parsed = JSON.parse(text) as ServerResponseEnvelope
      if (parsed?.result !== undefined && parsed.result.ok === false) {
        code = parsed.result.error.code
        message = parsed.result.error.message
      }
    } catch {
      // 非 JSON（例如反向代理的 HTML 错误页）：保留状态码分类即可。
    }
    // 走到这里的都是失败响应（非 2xx 或无信封）：状态必然是错误类。
    const kind = errorKindOf(status) === 'ok' ? 'http-400' : errorKindOf(status) as RemoteHubErrorKind
    reportDiagnostic(path, method, status, kind, code, message)
    return new RemoteHubError(
      code ?? ERROR_CODES.internal,
      message ?? `守卫拒绝请求（HTTP ${status}）`,
      status,
      { targetOrigin: origin, pageOrigin },
      kind,
      path,
    )
  }

  /**
   * 守卫直连（回退路径）：web 部署或旧宿主没有管理面服务时使用。
   * 桌面端（`dsh-app://app`）**不可用**——跨协议 fetch 会被浏览器拦下。
   */
  const adminFetch = async (
    path: string,
    init: { method: string; body?: string },
  ): Promise<{ status: number; text: string }> => {
    if (options.pairIssueToken === undefined || options.pairIssueToken === '') {
      // 注入缺失是纯本地问题，连请求都不发，避免伪装成网络错误。
      reportDiagnostic(path, init.method, 0, 'missing-injection')
      throw new RemoteHubError(
        ERROR_CODES.forbidden,
        '本机未提供签发凭据（宿主插件可能处于休眠）',
        0,
        { targetOrigin: origin, pageOrigin },
        'missing-injection',
        path,
      )
    }
    const { status, text } = await rawFetch(path, {
      method: init.method,
      headers: {
        [PAIR_ISSUE_HEADER]: options.pairIssueToken,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: init.body }),
    })
    if (status !== 200) throw adminFailure(path, init.method, status, text)
    reportDiagnostic(path, init.method, status, errorKindOf(status))
    return { status, text }
  }

  /**
   * 同源管理通道调用（首选路径）。
   *
   * 页面 origin 可能是 `dsh-app://app`（桌面）或 `http://127.0.0.1:<webPort>`（web）。
   * 两种情况都**同源**访问宿主的 `/api/<endpoint>`：
   * - 桌面：Electron `forwardWebRequest` 转发到本机 Host；
   * - web：本来就是同一 Host。
   * 信封与官方一致，因此零翻译、零预检。
   *
   * @param endpoint - `hub/admin.*` 端点。
   * @param args - 方法参数。
   * @returns 方法返回值。
   * @throws `RemoteHubError`（kind 为 http-* / admin-channel-unavailable）。
   */
  const adminCall = async <T>(endpoint: string, args: Record<string, unknown>): Promise<T> => {
    const channel = options.adminChannel ?? '/api'
    const rpcId = uuid()
    const envelope: ClientRequestEnvelope = {
      type: 'client-request',
      rpcId,
      method: endpoint,
      payload: { args },
    }
    // 同源：不带 Origin 判断，也不带 Bearer（owner 身份由宿主会话 cookie 决定）。
    let response: Response
    try {
      response = await fetchImpl(`${channel}/${endpoint.replace(/^\/+/u, '')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
      })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      reportDiagnostic(endpoint, 'POST', 0, 'network-unreachable', undefined, message)
      throw new RemoteHubError(
        'admin-channel-unavailable',
        `同源管理通道不可达：${message}`,
        0,
        { channel, pageOrigin },
        'network-unreachable',
        endpoint,
      )
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw adminFailure(endpoint, 'POST', response.status, text)
    }
    const text = await response.text()
    let parsed: ServerResponseEnvelope
    try {
      parsed = JSON.parse(text) as ServerResponseEnvelope
    } catch {
      throw adminFailure(endpoint, 'POST', 200, text)
    }
    if (parsed.result === undefined) throw adminFailure(endpoint, 'POST', 200, text)
    if (!parsed.result.ok) {
      reportDiagnostic(endpoint, 'POST', 200, 'http-403', parsed.result.error.code, parsed.result.error.message)
      throw new RemoteHubError(
        parsed.result.error.code,
        parsed.result.error.message,
        200,
        { channel, pageOrigin },
        'http-403',
        endpoint,
      )
    }
    reportDiagnostic(endpoint, 'POST', 200, errorKindOf(200))
    return parsed.result.value as T
  }

  /**
   * 管理端点请求：**优先同源通道**，不可用时回退守卫直连。
   *
   * 同源通道是桌面端唯一可行的路径（不透明 origin 无法跨协议 fetch）；
   * 守卫直连保留给 web 部署与旧宿主兼容。
   */
  const adminRequest = async (
    channelEndpoint: string,
    guardPath: string,
    init: { method: string; body?: string },
  ): Promise<{ status: number; text: string }> => {
    if (options.adminChannel !== '') {
      const value = await adminCall<unknown>(channelEndpoint, init.body === undefined ? {} : JSON.parse(init.body))
      return { status: 200, text: JSON.stringify({ ok: true, ...(value as Record<string, unknown>) }) }
    }
    return adminFetch(guardPath, init)
  }

  const rpc = async (method: string, args: Record<string, unknown>): Promise<unknown> => {
    if (closed) throw new RemoteHubError(ERROR_CODES.internal, 'transport is closed', 0)
    const rpcId = uuid()
    const envelope: ClientRequestEnvelope = {
      type: 'client-request',
      rpcId,
      method,
      payload: { args },
    }
    let attempt = 0
    // 有限重试：只对可重试状态/码，且最多 3 次；401/403/4xx 终态立刻抛。
    for (;;) {
      const { status, text } = await rawFetch(GUARD_ROUTES.rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rpc-id': rpcId },
        body: JSON.stringify(envelope),
      })
      try {
        return parseEnvelope(rpcId, status, text)
      } catch (error) {
        if (!(error instanceof RemoteHubError)) throw error
        if (isTerminal(error) || attempt >= 2) throw error
        attempt += 1
        await new Promise<void>(resolve => setTimeout(resolve, 100 * attempt))
      }
    }
  }

  const next = async (streamId: string, cursor: number, holdMs?: number): Promise<StreamNextValue> => {
    streamNextCalls += 1
    const value = await rpc(hubEndpoint(HUB_METHODS.streamNext), {
      streamId,
      cursor,
      ...(holdMs === undefined ? {} : { holdMs }),
    })
    if (typeof value !== 'object' || value === null || !Array.isArray((value as { items?: unknown }).items)) {
      throw new RemoteHubError(ERROR_CODES.internal, 'malformed stream.next result', 200)
    }
    return value as StreamNextValue
  }

  return {
    get closed() { return closed },
    get streamNextCalls() { return streamNextCalls },
    get businessPollCalls() { return businessPollCalls },
    async call<T>(method: string, args: Record<string, unknown>): Promise<T> {
      return rpc(method, args) as Promise<T>
    },
    async openStream(endpoint, args) {
      const value = await rpc(hubEndpoint(HUB_METHODS.streamOpen), { endpoint, args })
      if (typeof value !== 'object' || value === null || typeof (value as { streamId?: unknown }).streamId !== 'string') {
        throw new RemoteHubError(ERROR_CODES.internal, 'malformed stream.open result', 200)
      }
      return value as { streamId: string; cursor: number }
    },
    next,
    async cancel(streamId) {
      const value = await rpc(hubEndpoint(HUB_METHODS.streamCancel), { streamId })
      return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === true
        ? { ok: true }
        : { ok: false }
    },
    subscribe(onEvent) {
      // 长轮询循环：先 open，再反复 next。**不**对业务方法起轮询。
      const loop: { stop: () => void } = { stop: () => {} }
      let stopped = false
      let currentStreamId: string | undefined
      pollLoops.add(loop)
      loop.stop = () => {
        if (stopped) return
        stopped = true
        pollLoops.delete(loop)
        if (currentStreamId !== undefined) void this.cancel(currentStreamId)
      }
      void (async () => {
        try {
          const opened = await this.openStream('session/events', {})
          currentStreamId = opened.streamId
          let cursor = opened.cursor
          while (!stopped && !closed) {
            const startedAt = now()
            let batch: StreamNextValue
            try {
              batch = await next(opened.streamId, cursor, STREAM_BUDGET.holdMs)
            } catch (error) {
              if (error instanceof RemoteHubError && !isTerminal(error) && !stopped) {
                await new Promise<void>(resolve => setTimeout(resolve, STREAM_BUDGET.pollSlackMs))
                continue
              }
              break
            }
            // 超时余量：一轮读超过 hold+slack 才认定为「这一轮丢了」。
            if (now() - startedAt > STREAM_BUDGET.holdMs + STREAM_BUDGET.pollSlackMs) {
              // 显示降级但不重连业务方法；继续下一轮 next。
            }
            for (const item of batch.items) onEvent(item)
            cursor = batch.nextCursor
            if (batch.terminal !== undefined || batch.done === true) {
              if (batch.terminal?.code === ERROR_CODES.deviceRevoked) handleUnauthorized()
              break
            }
            // 空批也按 holdMs 节奏继续，不洪泛。
            if (batch.items.length === 0) {
              await new Promise<void>(resolve => setTimeout(resolve, STREAM_BUDGET.pollSlackMs))
            }
          }
        } catch {
          // open 失败（例如无可见流）：安静停止，不洪泛重试。
        }
      })()
      return () => loop.stop()
    },
    async redeem(input) {
      const { status, text } = await rawFetch(GUARD_ROUTES.pair, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(input.ticket === undefined ? {} : { ticket: input.ticket }),
          ...(input.code === undefined ? {} : { code: input.code }),
          clientLabel: input.clientLabel,
        }),
      })
      let parsed: Record<string, unknown>
      try { parsed = JSON.parse(text) as Record<string, unknown> } catch {
        throw new RemoteHubError(ERROR_CODES.internal, 'malformed pairing response', status)
      }
      if (status !== 200) {
        const code = typeof (parsed.result as { error?: { code?: unknown } } | undefined)?.error?.code === 'string'
          ? (parsed.result as { error: { code: string } }).error.code
          : (typeof parsed.error === 'object' && parsed.error !== null
            ? String((parsed.error as { code?: unknown }).code ?? ERROR_CODES.pairInvalid)
            : ERROR_CODES.pairInvalid)
        throw new RemoteHubError(code, 'pairing credential rejected', status)
      }
      const issued = parsed as unknown as IssuedDeviceToken
      token = issued.token
      unauthorizedCalled = false
      options.onAccessSnapshot?.({ role: issued.role })
      return issued
    },
    async issueTicket(role) {
      if (options.adminChannel !== '') {
        // 同源优先：桌面页面无法跨协议访问守卫。
        const issued = await adminCall<{ ok: true; kind: string; value: string; expiresAt: number; role: string }>(
          hubEndpoint(HUB_METHODS.adminIssue),
          { kind: 'ticket', role },
        )
        return { ticket: issued.value, expiresAt: issued.expiresAt, role: issued.role as RoleName }
      }
      const { status, text } = await rawFetch(GUARD_ROUTES.pairTicket, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pair-issue-token': options.pairIssueToken ?? '',
        },
        body: JSON.stringify({ role }),
      })
      if (status !== 200) throw new RemoteHubError(ERROR_CODES.forbidden, 'pairing issue refused', status)
      return JSON.parse(text) as { ticket: string; expiresAt: number; role: RoleName }
    },
    async issueCode(role) {
      if (options.adminChannel !== '') {
        const issued = await adminCall<{ ok: true; kind: string; value: string; expiresAt: number; role: string }>(
          hubEndpoint(HUB_METHODS.adminIssue),
          { kind: 'code', role },
        )
        return { code: issued.value, expiresAt: issued.expiresAt, role: issued.role as RoleName }
      }
      const { status, text } = await rawFetch(GUARD_ROUTES.pairCode, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pair-issue-token': options.pairIssueToken ?? '',
        },
        body: JSON.stringify({ role }),
      })
      if (status !== 200) throw new RemoteHubError(ERROR_CODES.forbidden, 'pairing issue refused', status)
      return JSON.parse(text) as { code: string; expiresAt: number; role: RoleName }
    },
    async health() {
      const { status, text } = await rawFetch(GUARD_ROUTES.health, { method: 'GET' })
      if (status !== 200) throw new RemoteHubError(ERROR_CODES.internal, 'health check failed', status)
      return JSON.parse(text) as { ok: boolean; protocolVersion: number }
    },
    async adminHealth() {
      // 同源优先：桌面端 `dsh-app://app` 无法跨协议访问守卫。
      if (options.adminChannel !== '') {
        return adminCall(hubEndpoint(HUB_METHODS.adminHealth), {})
      }
      const { status, text } = await rawFetch(GUARD_ROUTES.health, { method: 'GET' })
      if (status !== 200) throw new RemoteHubError(ERROR_CODES.internal, 'health check failed', status)
      const parsed = JSON.parse(text) as { ok: boolean; protocolVersion: number }
      return {
        ok: true,
        protocolVersion: parsed.protocolVersion,
        guard: { origin, loopbackOrigin: origin, port: Number(new URL(origin || 'http://127.0.0.1:8443').port) },
        singleController: true,
      }
    },
    async adminIssue(input) {
      // 同源通道：owner 页面专用，不需要 pin（也不需要跨协议 fetch）。
      return adminCall(hubEndpoint(HUB_METHODS.adminIssue), {
        kind: input.kind,
        role: input.role,
      })
    },
    async endpoints() {
      return adminCall(hubEndpoint(HUB_METHODS.adminEndpoints), {})
    },
    async carrier() {
      const result = await adminCall<{ ok: true; mode: Record<string, unknown>; at: number }>(
        hubEndpoint(HUB_METHODS.adminCarrier),
        {},
      )
      return { mode: result.mode, at: result.at }
    },
    async carrierWrite(mode) {
      const result = await adminCall<{ ok: true; at: number }>(
        hubEndpoint(HUB_METHODS.adminCarrierWrite),
        { mode },
      )
      return result.at
    },
    async listOutboundTargets() {
      const result = await adminCall<{ ok: true; targets: readonly OutboundTargetView[] }>(
        hubEndpoint(HUB_METHODS.adminOutboundTargets), {},
      )
      return result.targets
    },
    async saveOutboundTarget(target) {
      const result = await adminCall<{ ok: true; target: OutboundTargetView }>(
        hubEndpoint(HUB_METHODS.adminOutboundSave), { target },
      )
      return result.target
    },
    async activateOutboundTarget(targetId) {
      const result = await adminCall<{ ok: true; at: number }>(
        hubEndpoint(HUB_METHODS.adminOutboundActivate), { targetId },
      )
      return result.at
    },
    async forgetOutboundTarget(targetId) {
      const result = await adminCall<{ ok: true; removed: boolean }>(
        hubEndpoint(HUB_METHODS.adminOutboundForget), { targetId },
      )
      return result.removed
    },
    async listDevices() {
      const { text } = await adminRequest(
        hubEndpoint(HUB_METHODS.adminDevices),
        GUARD_ROUTES.devices,
        { method: 'GET' },
      )
      // 同源通道返回 `{ ok, ...snapshot }`；守卫直连返回守卫原始快照。
      const parsed = JSON.parse(text) as DeviceAdminSnapshot & { guard?: DeviceAdminSnapshot['guard'] }
      if (parsed.guard !== undefined) return parsed as DeviceAdminSnapshot
      // 管理面没有 devices 方法时（未来扩展），退化为空表而不是错误。
      return {
        ok: true,
        protocolVersion: PROTOCOL_VERSION,
        guard: { host: '127.0.0.1', port: 8443, origin },
        singleController: true,
        devices: [],
      }
    },
    async revokeDevices(input) {
      const { text } = await adminRequest(
        hubEndpoint(HUB_METHODS.revoke),
        GUARD_ROUTES.devicesRevoke,
        { method: 'POST', body: JSON.stringify(input.all === true ? { all: true } : { deviceId: input.deviceId }) },
      )
      const parsed = JSON.parse(text) as { revoked?: unknown }
      return { revoked: Array.isArray(parsed.revoked) ? parsed.revoked.map(String) : [] }
    },
    async stats() {
      const { text } = await adminRequest(hubEndpoint(HUB_METHODS.adminStats), GUARD_ROUTES.stats, { method: 'GET' })
      return JSON.parse(text) as { ok: boolean } & HubMetricsSnapshot
    },
    async forgetDevice(deviceId) {
      const result = await adminCall<{ ok: true; removed: boolean }>(hubEndpoint(HUB_METHODS.adminDeviceForget), { deviceId })
      return result.removed
    },
    async getConfig() {
      const { text } = await adminRequest(hubEndpoint(HUB_METHODS.adminConfig), GUARD_ROUTES.config, { method: 'GET' })
      return JSON.parse(text) as { ok: boolean; config: Record<string, unknown> }
    },
    async patchConfig(input) {
      if (options.adminChannel !== '') {
        return adminCall<{ ok: true; config: Record<string, unknown> }>(
          hubEndpoint(HUB_METHODS.adminConfigPatch), { patch: input },
        )
      }
      const { text } = await adminFetch(GUARD_ROUTES.config, { method: 'PUT', body: JSON.stringify(input) })
      const parsed = JSON.parse(text) as { ok?: boolean; config?: Record<string, unknown> }
      return { ok: true, config: parsed.config ?? {} }
    },
    setToken(value) {
      token = value
      if (value !== undefined) unauthorizedCalled = false
    },
    close() {
      closed = true
      for (const loop of [...pollLoops]) loop.stop()
      pollLoops.clear()
    },
  }
}
