/**
 * Carrier —— 让主控端页面真正接管远端 Host。
 *
 * ## 官方契约（唯一权威来源：`installConnection` in dsh-client-connection）
 *
 * `connection` 插件的 `apply(ctx)` 会把页面全局 `__DSH_TRANSPORT__` **原样**
 * 作为 `options.transport` 传入，内部只消费这三处：
 *
 * ```js
 * const rpc = transport?.rpc ?? createWebConnectionRpc(transport?.fetch, transport?.openStream)
 * const handle = {
 *   openWebSocket: (path) => openConnectionWebSocket(path, transport?.createWebSocket, transport?.streamBaseUrl),
 *   isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(...),
 * }
 * ```
 *
 * 因此本模块产出六个字段中的五个（`rpc` 故意不用：走官方 `createWebConnectionRpc`
 * 可白拿信封构造、rpcId 校验与 multipart 解析）：
 *
 * | 字段 | 本模块取值 |
 * | --- | --- |
 * | `fetch` | 把相对路径 `api/xxx` 改写成 `<guard>/remote/rpc` |
 * | `createWebSocket` | 改写 path 到 `/remote/ws` 并附加令牌 |
 * | `streamBaseUrl` | 守卫 origin（与 createWebSocket 同源） |
 * | `ownsHost` | `true`（接管后我们就代表远端 Host） |
 * | `openStream` | 可选长轮询实现（客户端半边提供） |
 *
 * ## 与旧实现的差异（重要）
 *
 * 1. **原样返回 Response**：旧实现 `await response.text()` 后重建，会破坏
 *    `multipart/form-data` 的二进制附件并丢 header。现在直接透传。
 * 2. **补全相对路径**：官方传的是 `'api/session/list'`（无前导斜杠）。
 * 3. **WebSocket 接管**：官方 WS 端点是 `/api/remote.mux`，必须改写到守卫的
 *    `/remote/ws` 并带令牌，否则长连接永远连回本机。
 * 4. **快照合并与恢复**：桌面 shell 预置 `{ ownsHost, streamBaseUrl }`，
 *    退出 cloud 时必须恢复原值。
 *
 * @module dsh-remote-hub/client/carrier
 */
import {
  MODE_KEY,
  readCarrierMode,
  writeCarrierMode,
  type CarrierMode,
} from '@core/carrier-contract.js'
import { announcePermissionDenied } from './permission-notice.js'
import { AUTH_HEADER, BEARER_SCHEME, ERROR_CODES, GUARD_ROUTES, HUB_PROTOCOL_HEADER, PROTOCOL_VERSION } from '@core/protocol.js'

/** 守卫受理 WebSocket 的路径（与 GUARD_ROUTES 平行，但只用于 WS 升级）。 */
export const GUARD_WS_PATH = '/remote/ws'

/** 守卫侧还原转发目标的 query 参数名。 */
export const HUB_WS_TARGET_PARAM = 'ws-target'

/** WebSocket 鉴权失败的自定义关闭码（守卫 401 时使用）。 */
export const WS_AUTH_CLOSE_CODE = 4401

/** 官方 transport 契约（只列本模块关心的字段）。 */
export interface DshTransport {
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  openStream?: (endpoint: string, payload: unknown, signal: AbortSignal, uplink: unknown) => unknown
  createWebSocket?: (url: string) => WebSocket
  streamBaseUrl?: string
  ownsHost?: boolean
  rpc?: unknown
}

/** 全局对象形状（可注入，便于测试）。 */
export interface CarrierGlobal {
  __DSH_TRANSPORT__?: DshTransport
  __DSH_REMOTE_HUB_CARRIER__?: CarrierInstallResult
  __DSH_BOOT_READY__?: { promise?: Promise<unknown> }
  /** 页面 location（重载用；测试可注入）。 */
  location?: { reload?: () => void }
}

export interface CarrierOptions {
  /** 注入模式读取（测试用）。 */
  readMode?: () => CarrierMode
  /**
   * 异步模式来源：磁盘上的 `carrier-mode.json`（经 `admin.carrier`）。
   *
   * **磁盘优先于 localStorage**：磁盘能区分「用户显式断开」（`explicit:true`）
   * 与「从未配对」；localStorage 区分不了，它可能残留上次连接的 cloud 状态。
   * @returns 模式；查不到时返回 `{ mode: 'local', explicit: false }`。
   */
  fetchMode?: () => Promise<ResolvedModeSource>
  /**
   * **同步**模式来源（磁盘真源）。
   *
   * 这是修复「connection 先于 carrier 捕获 fetch」的关键：`connection.apply()`
   * 在 cordis 启动时同步读 transport，任何 `await` 都会让我们晚一步（实测：
   * connection 在 42ms 读取、carrier 在 118ms 才写入）。同步来源让它能在
   * boot 回调里**立即**拿到磁盘值，从而同步注入。
   *
   * 实现方通常用同步 XHR（仅冷路径：localStorage 没缓存时才调用）。
   * @returns 模式；无法同步取得时返回 null（退回 localStorage + 异步纠正）。
   */
  fetchModeSync?: () => ResolvedModeSource | null
  /** 注入模式写入（测试用；默认清成 local）。 */
  fallbackMode?: () => void
  /**
   * 把「已停止接管」持久化到**磁盘真源**（`admin.carrierWrite`）。
   *
   * **为什么必须写磁盘**：启动时磁盘优先（见 `installCarrierResolvingMode`）。
   * 如果身份失效时只清 localStorage，重载后又会从磁盘读到 cloud 并再次接管
   * 同一个已失效的目标——即「401 → 重载 → 又 401」的循环（设计 v0.3 §8）。
   * 写入完成后才重载；写失败也不阻塞重载（本次会话必须回到本机）。
   * @returns 写入完成或失败的 Promise（失败不应抛出）。
   */
  persistLocal?: () => Promise<unknown>
  /** 注入 fetch（测试用；默认 globalThis.fetch）。 */
  fetchImpl?: typeof globalThis.fetch
  /** 注入 WebSocket 构造（测试用；默认 globalThis.WebSocket）。 */
  webSocketImpl?: (url: string) => WebSocket
  /** 注入 reload（测试用）。 */
  reload?: () => void
  /** 注入全局对象（测试用）。 */
  globalObject?: CarrierGlobal
  /**
   * @deprecated 接管模式下**不会**接入长轮询（设计 v0.3 ADR-03-01）。
   * 保留字段是为了不破坏既有调用方；传入即被忽略。
   */
  openStream?: DshTransport['openStream']
}

export interface CarrierInstallResult {
  /** 是否处于 cloud 模式（即安装了覆盖）。 */
  readonly active: boolean
  /** 传给官方 client 的 transport 对象（local 模式为 undefined）。 */
  readonly transport: DshTransport | undefined
  /** 安装前的 `__DSH_TRANSPORT__` 快照（退出时恢复用）。 */
  readonly snapshot: DshTransport | undefined
  /** 401/吊销时的降级入口（诊断用）。 */
  readonly fallback: (reason: CarrierFallback) => void
  /** 卸载：把 `__DSH_TRANSPORT__` 恢复成快照。 */
  readonly uninstall: () => void
}

/** 降级原因。 */
export type CarrierFallback = 'unauthorized' | 'revoked' | 'unreachable' | 'manual'

/** 请求是否指向本机 `/api` 面（官方一元 RPC / 精确 Fetch 路由）。 */
export function isApiRequest(url: URL): boolean {
  return url.pathname === '/api' || url.pathname.startsWith('/api/')
}

/**
 * 把官方传入的 fetch 入参规范成以 `/` 开头的路径。
 *
 * 官方 `createWebConnectionRpc` 传的是 `` `${channel}/${endpoint}`.slice(1) ``，
 * 即 `'api/session/list'`（**无前导斜杠**）。
 * @param input - fetch 的第一个参数。
 * @returns 规范后的路径；无法解析时返回 null。
 */
export function normalizePath(input: RequestInfo | URL): string | null {
  const raw = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.pathname
      : typeof (input as Request).url === 'string'
        ? (input as Request).url
        : null
  if (raw === null || raw === '') return null
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    try { return new URL(raw).pathname } catch { return null }
  }
  return raw.startsWith('/') ? raw : `/${raw}`
}

/**
 * 给 WebSocket URL 附加令牌与转发目标。
 *
 * 浏览器 WebSocket API **不支持自定义 header**，所以令牌只能走 query。
 * 守卫不记录 query（见 guard-ws 的日志策略）。
 * @param url - 官方已拼好的 URL（http/https，已含 `/api/remote.mux`）。
 * @param token - 设备令牌。
 * @returns 指向守卫的 ws/wss URL。
 */
export function buildGuardWebSocketUrl(url: string, token: string): string {
  const parsed = new URL(url)
  // 官方拼出的是 http(s)://<streamBaseUrl>/api/remote.mux；改成守卫的 WS 入口。
  const target = parsed.pathname
  parsed.pathname = GUARD_WS_PATH
  parsed.search = ''
  parsed.searchParams.set(HUB_WS_TARGET_PARAM, target)
  parsed.searchParams.set('token', token)
  if (parsed.protocol === 'http:') parsed.protocol = 'ws:'
  else if (parsed.protocol === 'https:') parsed.protocol = 'wss:'
  return parsed.href
}

/**
 * 判断一个错误响应是否是「设备身份已失效」——两种来源：
 *  - HTTP 401（守卫 Bearer 校验失败）；
 *  - 200 信封里的 `device-revoked` 错误码。
 * @param status - HTTP 状态。
 * @param bodyText - 响应体文本（用于查找错误码）。
 * @returns 失效时为 true。
 */
export function isIdentityFailure(status: number, bodyText: string): boolean {
  if (status === 401) return true
  if (!bodyText.includes(ERROR_CODES.deviceRevoked)) return false
  try {
    const parsed: unknown = JSON.parse(bodyText)
    if (typeof parsed !== 'object' || parsed === null) return false
    const result = (parsed as { result?: { error?: { code?: unknown } } }).result
    return result?.error?.code === ERROR_CODES.deviceRevoked
  } catch {
    return false
  }
}

/** 认证头。 */
function authHeaders(token: string): Record<string, string> {
  return {
    [AUTH_HEADER]: `${BEARER_SCHEME} ${token}`,
    [HUB_PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
  }
}

function normalizeSessionCreateBody(body: BodyInit | null | undefined): BodyInit | null | undefined {
  if (typeof body !== 'string') return body
  try {
    const envelope = JSON.parse(body) as { method?: unknown; payload?: { args?: { request?: Record<string, unknown> } } }
    if (envelope.method !== 'session/create') return body
    const request = envelope.payload?.args?.request
    if (!request || request.sessionId !== '') return body
    delete request.sessionId
    return JSON.stringify(envelope)
  } catch {
    return body
  }
}
/**
 * 构造 cloud 模式的官方 transport 覆盖（**纯函数，不触碰全局**）。
 * @param options - 注入依赖。
 * @returns 安装结果（含 transport 与快照）。
 */
export function createCarrier(options: CarrierOptions = {}): CarrierInstallResult {
  const readMode = options.readMode ?? readCarrierMode
  const fallbackMode = options.fallbackMode ?? (() => writeCarrierMode({ mode: 'local' }))
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args))
  const reload = options.reload ?? (() => { try { globalThis.location?.reload() } catch { /* 无 location */ } })
  const globalObject = (options.globalObject ?? (globalThis as unknown as CarrierGlobal))

  const mode = readMode()
  if (mode.mode !== 'cloud' || mode.origin === undefined || mode.token === undefined) {
    return {
      active: false,
      transport: undefined,
      snapshot: undefined,
      fallback: () => {},
      uninstall: () => {},
    }
  }

  const guardOrigin = mode.origin.replace(/\/+$/u, '')
  const token = mode.token
  const snapshot = globalObject.__DSH_TRANSPORT__
  let fallbackDone = false

  /**
   * 报告一个会挤压默认 mux 路线的既有字段。
   *
   * 这些字段**不会**被我们覆盖（属于宿主/其它插件），但必须让排障可见：
   * 否则现象会是「transport 明明注入了，长连接却仍走本机/长轮询」。
   * @param field - 冲突字段名。
   */
  const warnConflict = (field: string): void => {
    try {
      console.warn(
        `dsh-remote-hub: existing __DSH_TRANSPORT__.${field} detected; `
        + 'it takes precedence over the remote transport and may disable the native mux',
      )
    } catch { /* 忽略 */ }
  }

  const fallback = (reason: CarrierFallback): void => {
    if (fallbackDone) return
    fallbackDone = true
    try { console.warn(`dsh-remote-hub: carrier fallback (${reason}); returning to local mode`) } catch { /* 忽略 */ }
    // 恢复 shell 预置的 transport，避免把页面留在一个半残状态。
    if (snapshot !== undefined) globalObject.__DSH_TRANSPORT__ = snapshot
    fallbackMode()
    // **先落盘再重载**：否则重载后启动读到磁盘上残留的 cloud，又连回失效目标。
    // 落盘失败也要重载（本次会话必须回到本机），但不能假装落盘成功。
    let written: Promise<unknown>
    try {
      written = options.persistLocal === undefined ? Promise.resolve() : options.persistLocal()
    } catch {
      written = Promise.resolve()
    }
    void Promise.resolve(written)
      .catch(error => {
        try {
          console.warn(`dsh-remote-hub: carrier fallback could not persist local mode (${String(error)}); `
            + 'the page will reload but the on-disk target may still be cloud')
        } catch { /* 忽略 */ }
      })
      .then(() => reload())
  }

  /**
   * 一元 RPC 改道：`api/*` → `<guard>/remote/rpc`。
   *
   * **不消费 body**：直接返回原始 Response，保证 `multipart/form-data` 的
   * 二进制附件与 header 原封不动（旧实现读 text() 会破坏它）。
   */
  const carrierFetch: typeof globalThis.fetch = async (input, init) => {
    const path = normalizePath(input)
    // 非 RPC 请求放行到原始 fetch（静态资源、插件 bundle 等）。
    if (path === null || !path.startsWith('/api')) return fetchImpl(input, init)

    let response: Response
    try {
      response = await fetchImpl(`${guardOrigin}${GUARD_ROUTES.rpc}`, {
        ...init,
        ...(init?.body === undefined ? {} : { body: normalizeSessionCreateBody(init.body) }),
        method: 'POST',
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          ...authHeaders(token),
          'content-type': 'application/json',
        },
      })
    } catch (error) {
      // 守卫不可达：不吞，让官方重连循环工作。
      throw error
    }

    if (response.status === 401) {
      fallback('unauthorized')
      return response
    }

    // 200 信封里也可能带 device-revoked：需要读一次文本判身份，读完后重建。
    // 仅在 content-type 是 JSON 时这么做（multipart 不进入这条路径）。
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      const text = await response.text()
      if (isIdentityFailure(response.status, text)) {
        fallback('revoked')
        return new Response(text, { status: response.status, headers: response.headers })
      }
      try {
        const envelope = JSON.parse(text) as {
          result?: { ok?: boolean; error?: { code?: string; details?: { action?: string; reason?: string } } }
        }
        if (envelope.result?.ok === false && envelope.result.error?.code === 'remote-access/denied') {
          announcePermissionDenied(globalObject as unknown as Parameters<typeof announcePermissionDenied>[0], envelope.result.error.details ?? {})
        }
      } catch { /* Non-RPC JSON is returned untouched; official caller handles parsing. */ }
      return new Response(text, { status: response.status, headers: response.headers })
    }
    return response
  }

  /**
   * WebSocket 接管：官方已把 URL 拼成 `<streamBaseUrl>/api/remote.mux`，
   * 这里改写到守卫的 `/remote/ws` 并附加令牌。
   */
  const createWebSocket = (url: string): WebSocket => {
    const target = buildGuardWebSocketUrl(url, token)
    const factory = options.webSocketImpl ?? ((href: string) => new WebSocket(href))
    return factory(target)
  }

  const transport: DshTransport = {
    fetch: carrierFetch,
    createWebSocket,
    // 必须与 createWebSocket 同源：mux 用它对 `'/api/remote.mux'.slice(1)` 做 base 解析。
    streamBaseUrl: guardOrigin,
    ownsHost: true,
    // **绝不提供 `openStream`**（设计 v0.3 ADR-03-01 / tech/carrier.md §2 陷阱一）：
    // 官方逻辑是「只有 `rpc.open` 不存在时才启动原生 mux」，一旦提供 openStream
    // 就等于自己关掉长连接通道。这里刻意不读 `options.openStream`——参数存在也
    // 不接入，避免调用方以为「顺手带上更稳妥」。
  }

  // 合并已有 transport 时，`rpc` / `openStream` 会**抢在**我们的 fetch 之前生效
  // （官方优先用 `transport.rpc`）。存在这些字段必须在装载期就叫出来。
  if (typeof snapshot?.rpc === 'object' && snapshot.rpc !== null) {
    warnConflict('rpc')
  }
  if (snapshot?.openStream !== undefined) {
    warnConflict('openStream')
  }

  return {
    active: true,
    transport,
    snapshot,
    fallback,
    uninstall: () => {
      if (snapshot === undefined) delete globalObject.__DSH_TRANSPORT__
      else globalObject.__DSH_TRANSPORT__ = snapshot
    },
  }
}

/**
 * 幂等安装：把 cloud 覆盖合并到 `globalThis.__DSH_TRANSPORT__`。
 *
 * **保留 shell 预置的其它字段**（桌面端会写 `ownsHost`/`streamBaseUrl`），
 * 但 `fetch`/`createWebSocket`/`streamBaseUrl` 由我们覆盖——否则长连接连回本机。
 *
 * **幂等语义（重要）**：只有「已成功激活的 cloud 安装」才短路返回。
 * local 模式不缓存，因为用户随后点击「连接」会切到 cloud——
 * 若把 inactive 结果缓存住，那次切换就永远装不上了。
 *
 * @param options - 注入依赖。
 * @returns 安装结果。
 */
export function installCarrier(options: CarrierOptions = {}): CarrierInstallResult {
  const globalObject = (options.globalObject ?? (globalThis as unknown as CarrierGlobal))
  const installed = globalObject.__DSH_REMOTE_HUB_CARRIER__
  // 只有活跃安装才幂等返回；inactive 每次都重新判定（模式可能已变）。
  if (installed !== undefined && installed.active) return installed
  const result = createCarrier(options)
  if (result.active && result.transport !== undefined) {
    const existing = globalObject.__DSH_TRANSPORT__ ?? {}
    globalObject.__DSH_TRANSPORT__ = { ...existing, ...result.transport }
  }
  globalObject.__DSH_REMOTE_HUB_CARRIER__ = result
  return result
}

/**
 * 等待桌面 shell 写完 `__DSH_TRANSPORT__` 之后再生效。
 *
 * 桌面 shell 在 boot 过程中会覆写 `__DSH_TRANSPORT__ = { ownsHost, streamBaseUrl }`；
 * 早于它注入会被覆盖。官方顺序是 shell 写完后才 `r.resolve()` 再启动 cordis，
 * 因此 `__DSH_BOOT_READY__.promise` resolve **晚于** shell 写入、**早于**
 * `connection.apply`，是唯一安全窗口。
 * @param options - 注入依赖。
 * @returns 安装结果（异步就绪）。
 */
export function installCarrierAfterBoot(options: CarrierOptions = {}): Promise<CarrierInstallResult> {
  const globalObject = (options.globalObject ?? (globalThis as unknown as CarrierGlobal))
  const boot = globalObject.__DSH_BOOT_READY__
  if (boot?.promise === undefined) return Promise.resolve(installCarrier(options))
  return boot.promise.then(
    () => installCarrier(options),
    () => installCarrier(options),
  )
}

/**
 * `installCarrierResolvingMode` 的模式来源。
 *
 * `explicit: true` 表示**用户主动断开**（磁盘上有 `{mode:'local'}`），
 * 此时必须否决 localStorage 里的旧 cloud 状态，否则「断开」会被翻盘。
 */
export type ResolvedModeSource = CarrierMode & {
  /** 是否为用户显式断开（否决接管）。 */
  explicit?: boolean
}

/**
 * boot 后安装；若 localStorage 里没有 cloud 状态，先向宿主查询 `carrier-mode.json`。
 *
 * ## ⚠️ 时序约束（2026-11-12 页面实测确认的缺陷）
 *
 * 官方 `connection.apply()` 在 cordis 启动时执行，并**立即闭包捕获**
 * `__DSH_TRANSPORT__.fetch`。所以「等到 boot.promise 再 `await` 一次网络查询」
 * 是不可靠的：查询是异步的，`connection` 很可能先跑完，于是页面拿到了
 * **本机** fetch —— transport 明明注入了，RPC 却走本机（实测：页面里 hook
 * `transport.fetch` 后调用 `api/session/list`，拦截列表为空）。
 *
 * 因此这里改成**两段式**：
 *
 * 1. **同步段**（在 boot.promise 回调里立即执行）：用 localStorage 缓存决定是否
 *    注入。这一份是上一轮成功连接/断开时写下的，足够覆盖「刚连上就刷新」的
 *    绝大多数场景，且**没有任何 await**，保证早于 connection 捕获。
 * 2. **异步段**：查询磁盘真源；若结果与缓存不一致（CLI 刚配对、或已断开），
 *    再写回缓存并**重载页面**，让下一轮同步段读到正确值。
 *
 * 这样既不放弃「磁盘优先」的正确性，也不再依赖「异步查询必须跑赢 connection」
 * 这个不成立的假设。
 *
 * @param options - 注入依赖（`fetchMode` 提供查询函数）。
 * @returns 安装结果。
 */
export function installCarrierResolvingMode(
  options: CarrierOptions = {},
): Promise<CarrierInstallResult> {
  const globalObject = (options.globalObject ?? (globalThis as unknown as CarrierGlobal))
  const readMode = options.readMode ?? readCarrierMode
  const reload = () => { try { globalObject.location?.reload?.() } catch { /* 无 location */ } }

  /** 第一段：**同步**决定模式并安装（绝不 await）。 */
  const installSync = (): CarrierInstallResult => {
    // 顺序：**同步磁盘来源优先**（它最能反映「用户是否刚点了断开」），
    // 其次 localStorage 缓存，最后不接管。
    //
    // ⚠️ 不能因为缓存是 cloud 就跳过磁盘：用户点「断开」后磁盘写成 local，
    // 而 localStorage 里仍残留 cloud——只看缓存会让断开在下次加载时被翻盘。
    if (options.fetchModeSync !== undefined) {
      let fromDisk: ResolvedModeSource | null = null
      try {
        fromDisk = options.fetchModeSync()
      } catch {
        fromDisk = null
      }
      if (fromDisk !== null) {
        const resolved: CarrierMode = fromDisk.mode === 'cloud'
          ? {
            mode: 'cloud',
            ...(fromDisk.origin === undefined ? {} : { origin: fromDisk.origin }),
            ...(fromDisk.targetId === undefined ? {} : { targetId: fromDisk.targetId }),
            ...(fromDisk.token === undefined ? {} : { token: fromDisk.token }),
            ...(fromDisk.deviceLabel === undefined ? {} : { deviceLabel: fromDisk.deviceLabel }),
          }
          : { mode: 'local' }
        try { writeCarrierMode(resolved) } catch { /* 无 storage */ }
        // 无论 cloud 还是 local，都以**磁盘**为准（local 时不注入）。
        return installCarrier({ ...options, readMode: () => resolved })
      }
    }
    const cached = readMode()
    return installCarrier({ ...options, readMode: () => cached })
  }

  /**
   * 第二段：异步核对磁盘真源，与缓存不一致时写回并重载。
   * @returns 是否触发了重载。
   */
  const reconcile = async (installed: CarrierInstallResult): Promise<boolean> => {
    if (options.fetchMode === undefined) return false
    let remote: ResolvedModeSource
    try {
      remote = await options.fetchMode() as ResolvedModeSource
    } catch {
      return false
    }
    const cached = readMode()
    // 用户显式断开：磁盘 local 是权威，清缓存并回本机。
    if (remote.mode === 'local' && remote.explicit === true) {
      if (cached.mode === 'cloud') {
        try { writeCarrierMode({ mode: 'local' }) } catch { /* 无 storage */ }
        reload()
        return true
      }
      try { writeCarrierMode({ mode: 'local' }) } catch { /* 无 storage */ }
      return false
    }
    if (remote.mode !== 'cloud') return false
    if (options.fetchModeSync !== undefined) {
      const installedTarget = installed.active
        && installed.transport?.streamBaseUrl?.replace(/\/+$/u, '') === remote.origin?.replace(/\/+$/u, '')
        && (cached.mode !== 'cloud' || cached.targetId === undefined || remote.targetId === undefined
          || cached.targetId === remote.targetId)
      if (installedTarget) return false
      reload()
      return true
    }
    // Compatibility path for embeddings without a sync host source. The stored mode is
    // intentionally only a hint; bearer persistence is delegated to the host API.
    const sameHint = cached.mode === 'cloud' && cached.origin === remote.origin
      && (cached.targetId === undefined || remote.targetId === undefined || cached.targetId === remote.targetId)
    try { writeCarrierMode(remote) } catch { /* 无 storage */ }
    if (sameHint && installed.active) return false
    reload()
    return true
  }

  const boot = globalObject.__DSH_BOOT_READY__
  /** 同步安装 + 检查是否被外来的写入覆盖。 */
  const installAndGuard = (): CarrierInstallResult => {
    // 若之前已注入、但全局被外部整体赋值抹掉了我们的 fetch，就先清掉幂等标记，
    // 让下方 installCarrier 重新安装一次（桌面 shell 会直接赋值 `__DSH_TRANSPORT__`）。
    const previous = globalObject.__DSH_REMOTE_HUB_CARRIER__
    if (previous !== undefined && previous.active) {
      const current = globalObject.__DSH_TRANSPORT__
      const stillOurs = current !== undefined && typeof current.fetch === 'function'
        && current.fetch === previous.transport?.fetch
      if (!stillOurs) {
        // 被覆盖：作废缓存，重新安装（保留既有其它字段）。
        delete globalObject.__DSH_REMOTE_HUB_CARRIER__
      }
    }
    const installed = installSync()
    void reconcile(installed).catch(() => {})
    return installed
  }

  if (boot?.promise === undefined) {
    // 纯 web：无 shell 覆盖，同步安装即可。
    return Promise.resolve(installAndGuard())
  }

  // ⚠️ 关键：页面 HTML 里的 `(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()`
  // 是**同步**执行的，早于插件 bundle。若这里仍走 `boot.promise.then(...)`，
  // 注入就变成微任务，可能排在 cordis 启动（connection.apply 同步捕获 fetch）
  // 之后——实测「transport 注入了、页面 RPC 却仍走本机」正是这个原因。
  //
  // 因此：**先同步注入一次**（bundle 顶层阶段），再在 boot 落定后**复核一次**
  // （桌面 shell 可能在此期间整体赋值覆盖全局）。
  const first = installAndGuard()
  return boot.promise.then(
    () => installAndGuard(),
    () => installAndGuard(),
  ).then(() => first)
}

export { MODE_KEY }
