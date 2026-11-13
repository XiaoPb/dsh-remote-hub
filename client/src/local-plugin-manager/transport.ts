/**
 * 本地插件管理直连通道的**浏览器半边传输层**。
 *
 * ## 为什么不复用 `ctx.remote`
 *
 * 官方插件页的控制器直接调 `ctx.remote.pluginManager.*`；接管后那条链路被 `__DSH_TRANSPORT__`
 * 改道云端。本模块提供的是**同源、本机、不经 transport** 的调用面：
 *
 * - 一元：`POST /api/hub/local-plugin-manager/<method>`，body `{ args: [...] }`；
 * - 事件：`WS /api/hub/local-plugin-manager/events?since=<seq>`；
 * - 详情图片：`GET /api/hub/local-plugin-manager/detail-file?...`（由 `detailFileUrl()` 构造）。
 *
 * ## 与官方 `Answer<T>` 同构
 *
 * 控制器（vendored 官方代码）读的是 `{ ok: true, value } | { ok: false, error }`。本模块把
 * 「HTTP 200 + JSON」与「非 200 + `{ code, message, details }`」都映射成那个形状，
 * 于是控制器与页面的错误分支**一行都不用改**。
 *
 * @module dsh-remote-hub/client/local-plugin-manager/transport
 */
import {
  LOCAL_PLUGIN_DETAIL_FILE_PATH,
  LOCAL_PLUGIN_ERRORS,
  LOCAL_PLUGIN_EVENTS_PATH,
  localPluginPath,
  type LocalPluginEventFrame,
  type LocalPluginFailureBody,
  type LocalPluginMethod,
} from '@core/index.js'

/** 与官方 `@deepseek-ai/dsh-api-remotes/client` 的 `RemoteFailure` 同形。 */
export interface LocalPluginFailure {
  readonly code: string
  readonly message: string
  readonly details: Record<string, unknown>
}

/** 与官方生成的远端调用返回值同构（`Answer<T>`）。 */
export type LocalPluginAnswer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: LocalPluginFailure }

/** 一次调用的诊断分类（页面「诊断」区与测试用）。 */
export type LocalPluginErrorKind =
  | 'ok'
  | 'network-unreachable'
  | 'http-400'
  | 'http-401'
  | 'http-403'
  | 'http-404'
  | 'http-5xx'
  | 'bad-envelope'

/** 传输层选项。 */
export interface LocalPluginTransportOptions {
  /** 基础路径前缀；默认同源空串（相对 URL）。测试可注入。 */
  readonly base?: string
  /** 注入 fetch（测试用）。 */
  readonly fetch?: typeof globalThis.fetch
  /** 注入 WebSocket 构造器（测试用）。 */
  readonly WebSocket?: typeof globalThis.WebSocket
  /** 最近一次请求的诊断回调（凭据无关，只有路径/状态/分类）。 */
  readonly onDiagnostic?: (diagnostic: {
    readonly path: string
    readonly method: string
    readonly status: number
    readonly kind: LocalPluginErrorKind
    readonly code?: string
  }) => void
}

/** 事件订阅回调。 */
export interface LocalPluginEventHandlers {
  /** 收到一帧业务事件。 */
  readonly onFrame?: (frame: LocalPluginEventFrame) => void
  /** 服务端要求全量刷新（断档 / 慢消费者丢弃）。 */
  readonly onReset?: () => void
  /** 建链成功。 */
  readonly onOpen?: (watermark: number) => void
  /** 链路关闭（自动重连前）。 */
  readonly onClose?: (reason: string) => void
}

/** 事件订阅句柄。 */
export interface LocalPluginSubscription {
  /** 当前水位（最近收到的 `seq`）。 */
  readonly watermark: () => number
  /** 取消订阅并关闭连接。 */
  dispose(): void
}

/** 重连退避：200ms 起，×2，上限 5s。 */
const RECONNECT_BASE_MS = 200
const RECONNECT_MAX_MS = 5000

/**
 * 由 HTTP 状态推导诊断分类。
 * @param status - HTTP 状态码（0 = 请求被 reject）。
 */
export function errorKindOf(status: number): LocalPluginErrorKind {
  if (status >= 200 && status < 400) return 'ok'
  if (status === 0) return 'network-unreachable'
  if (status === 400) return 'http-400'
  if (status === 401) return 'http-401'
  if (status === 403) return 'http-403'
  if (status === 404) return 'http-404'
  return 'http-5xx'
}

/** 判断一个值是否是直连通道的错误体。 */
function isFailureBody(value: unknown): value is LocalPluginFailureBody {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.code === 'string' && typeof record.message === 'string'
}

/**
 * 本地插件管理客户端。
 *
 * 一次构造可服务整个面板生命周期；`dispose()` 关闭全部事件连接。
 */
export class LocalPluginManagerClient {
  private readonly base: string
  private readonly doFetch: typeof globalThis.fetch
  private readonly WebSocketCtor: typeof globalThis.WebSocket | undefined
  private readonly options: LocalPluginTransportOptions
  private readonly subscriptions = new Set<LocalPluginSubscription>()
  private disposed = false

  /**
   * @param options - 传输选项。
   */
  constructor(options: LocalPluginTransportOptions = {}) {
    this.options = options
    this.base = options.base ?? ''
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.WebSocketCtor = options.WebSocket ?? globalThis.WebSocket
  }

  /**
   * 调用一个直连方法。
   * @param method - 方法名。
   * @param args - 位置参数（与官方签名顺序一致）。
   * @param signal - 取消信号。
   * @returns 官方形状的 `Answer`；**永不**抛错（网络异常也映射成 `ok:false`）。
   */
  async call<T>(method: LocalPluginMethod, args: readonly unknown[] = [], signal?: AbortSignal): Promise<LocalPluginAnswer<T>> {
    const path = localPluginPath(method)
    let response: Response
    try {
      response = await this.doFetch(this.url(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ args }),
        credentials: 'same-origin',
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      const aborted = (error as { name?: string } | undefined)?.name === 'AbortError'
      const failure: LocalPluginFailure = {
        code: aborted ? 'aborted' : LOCAL_PLUGIN_ERRORS.unavailable,
        message: error instanceof Error ? error.message : String(error),
        details: { path },
      }
      this.diagnose(path, 'POST', 0, aborted ? 'network-unreachable' : 'network-unreachable', failure.code)
      return { ok: false, error: failure }
    }

    const kind = errorKindOf(response.status)
    this.diagnose(path, 'POST', response.status, kind)
    if (!response.ok) {
      const failure = await this.readFailure(response, path)
      this.diagnose(path, 'POST', response.status, kind, failure.code)
      return { ok: false, error: failure }
    }
    try {
      const value = await response.json() as T
      return { ok: true, value }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: LOCAL_PLUGIN_ERRORS.upstream,
          message: `response is not JSON: ${error instanceof Error ? error.message : String(error)}`,
          details: { path },
        },
      }
    }
  }

  /**
   * 订阅本机插件管理事件。
   *
   * 断线自动重连（指数退避），并用 `?since=` 续传；服务端回 `reset` 时调用 `onReset`。
   * @param handlers - 回调。
   * @returns 订阅句柄。
   */
  subscribe(handlers: LocalPluginEventHandlers = {}): LocalPluginSubscription {
    let watermark = 0
    let attempt = 0
    let closed = false
    let socket: WebSocket | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    const connect = (): void => {
      if (closed || this.disposed) return
      const Ctor = this.WebSocketCtor
      if (Ctor === undefined) {
        handlers.onClose?.('WebSocket is unavailable')
        return
      }
      const url = this.wsUrl(watermark)
      let current: WebSocket
      try {
        current = new Ctor(url)
      } catch (error) {
        handlers.onClose?.(error instanceof Error ? error.message : String(error))
        schedule()
        return
      }
      socket = current
      current.addEventListener('open', () => {
        attempt = 0
      })
      current.addEventListener('message', (event: MessageEvent) => {
        const frame = parseFrame(event.data)
        if (frame === null) return
        if (frame.type === 'hello') {
          // 服务端水位高于本地：说明中途丢帧，请做一次全量刷新。
          if (watermark !== 0 && frame.seq > watermark) handlers.onReset?.()
          watermark = Math.max(watermark, frame.seq)
          handlers.onOpen?.(frame.seq)
          return
        }
        watermark = Math.max(watermark, frame.seq)
        if (frame.type === 'reset') {
          handlers.onReset?.()
          return
        }
        handlers.onFrame?.(frame)
      })
      current.addEventListener('close', () => {
        if (socket === current) socket = undefined
        if (closed || this.disposed) return
        handlers.onClose?.('socket closed')
        schedule()
      })
      current.addEventListener('error', () => {
        // 'close' 随后一定会到；这里只避免未处理的 error 事件。
      })
    }

    const schedule = (): void => {
      if (closed || this.disposed) return
      attempt += 1
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS)
      timer = setTimeout(connect, delay)
    }

    const subscription: LocalPluginSubscription = {
      watermark: () => watermark,
      dispose: () => {
        if (closed) return
        closed = true
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
        try {
          socket?.close()
        } catch {
          // 已断开。
        }
        socket = undefined
        this.subscriptions.delete(subscription)
      },
    }
    this.subscriptions.add(subscription)
    connect()
    return subscription
  }

  /**
   * 构造详情图片的 URL。
   *
   * 官方页的图片是相对路径 `api/plugin-manager/detail-file`；接管解析到云端，所以本地页必须用这条。
   * @param query - 查询参数（`bundle` / `document` / `path` / `sources`）。
   * @returns 绝对或相对 URL（`<img src>` 直接用）。
   */
  detailFileUrl(query: {
    readonly bundle: string
    readonly document: string
    readonly path: string
    readonly sources?: readonly string[]
  }): string {
    const params = new URLSearchParams({ bundle: query.bundle, document: query.document, path: query.path })
    if (query.sources !== undefined && query.sources.length > 0) params.set('sources', query.sources.join(','))
    return this.url(`${LOCAL_PLUGIN_DETAIL_FILE_PATH}?${params.toString()}`)
  }

  /** 关闭全部事件连接（面板卸载时调用）。 */
  dispose(): void {
    this.disposed = true
    for (const subscription of [...this.subscriptions]) subscription.dispose()
    this.subscriptions.clear()
  }

  /** 拼接 HTTP URL（同源相对路径；测试可注入 base）。 */
  private url(path: string): string {
    if (this.base === '') return path
    return new URL(path, this.base).href
  }

  /** 拼接 WebSocket URL（协议随页面 origin 切换 ws/wss）。 */
  private wsUrl(since: number): string {
    const path = `${LOCAL_PLUGIN_EVENTS_PATH}${since > 0 ? `?since=${String(since)}` : ''}`
    const location = (globalThis as { location?: Location }).location
    if (this.base === '') {
      const origin = location?.origin ?? 'http://127.0.0.1'
      const protocol = origin.startsWith('https:') ? 'wss:' : 'ws:'
      return `${protocol}//${new URL(origin).host}${path}`
    }
    const base = new URL(this.base, location?.origin ?? 'http://127.0.0.1')
    const protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${base.host}${path}`
  }

  /** 读取非 2xx 响应的错误体（解析失败时给出兜底错误）。 */
  private async readFailure(response: Response, path: string): Promise<LocalPluginFailure> {
    try {
      const body: unknown = await response.json()
      if (isFailureBody(body)) {
        return {
          code: body.code,
          message: body.message,
          details: typeof body.details === 'object' && body.details !== null ? body.details : {},
        }
      }
    } catch {
      // 非 JSON 响应（例如 401/403 的纯文本）：落到下面的兜底。
    }
    return {
      code: errorKindOf(response.status) === 'http-403' ? LOCAL_PLUGIN_ERRORS.forbidden : LOCAL_PLUGIN_ERRORS.upstream,
      message: `HTTP ${String(response.status)}`,
      details: { path, status: response.status },
    }
  }

  /** 上报一次诊断。 */
  private diagnose(path: string, method: string, status: number, kind: LocalPluginErrorKind, code?: string): void {
    try {
      this.options.onDiagnostic?.({ path, method, status, kind, ...(code === undefined ? {} : { code }) })
    } catch {
      // 诊断回调异常不得影响调用。
    }
  }
}

/**
 * 把一条 WebSocket 消息解析成事件帧。
 * @param data - 原始消息（字符串或 Blob/ArrayBuffer）。
 * @returns 帧；畸形消息返回 null。
 */
export function parseFrame(data: unknown): LocalPluginEventFrame | null {
  const text = typeof data === 'string' ? data : null
  if (text === null) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as { type?: unknown; seq?: unknown }
    if (typeof record.type !== 'string' || typeof record.seq !== 'number') return null
    return parsed as LocalPluginEventFrame
  } catch {
    return null
  }
}
