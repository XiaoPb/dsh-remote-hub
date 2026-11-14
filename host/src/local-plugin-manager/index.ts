/**
 * 本地插件管理直连通道：路由、事件通道与转发（Host 半边）。
 *
 * 这是「插件管理直连接口」的装配入口：把 {@link LocalPluginManagerService} 挂到
 * `client-connection` 的 `/api` 前缀路由之下的一组**精确路径**上，并提供：
 *
 * - `POST /api/hub/local-plugin-manager/<method>` × 15 —— 一元调用；
 * - `GET  /api/hub/local-plugin-manager/detail-file` —— 详情图片转发（与官方同构）；
 * - `WS   /api/hub/local-plugin-manager/events` —— 官方 4 个 `plugin-manager/*` 事件的本机订阅面。
 *
 * ## 为什么是精确路径而不是 RPC
 *
 * `connection.fetch.register` 注册的是**精确路径路由**，`createSharedFetchHandler('/api')`
 * 只把 `peer.principal.kind === 'owner'` 的请求交给它（其它一律 403），并且**不会**进入
 * api-gateway 的 endpoint 名册。因此：
 *
 * 1. 云端配对设备（`remote-device`）调不到；
 * 2. `POST /api/localPluginManager/<m>` 这类走共享 RPC 通道的写法在本 Host 上**不存在**（404）；
 * 3. `${'$'}ctx.remote.typertGateway.registerRemoteEvents` 等全局单例一个都没被占用。
 *
 * @module dsh-remote-hub/host/local-plugin-manager
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

import {
  LOCAL_PLUGIN_CHANNEL,
  LOCAL_PLUGIN_DETAIL_FILE_PATH,
  LOCAL_PLUGIN_ERRORS,
  LOCAL_PLUGIN_EVENTS_PATH,
  LOCAL_PLUGIN_METHODS,
  localPluginPath,
  type LocalPluginEventFrame,
  type LocalPluginFailureBody,
  type LocalPluginMethod,
} from '@core/index.js'

import {
  LocalPluginError,
  LocalPluginManagerService,
  asLocalPluginError,
  failureBody,
  resolveLocalPluginUpstreams,
} from './service.js'
import { createDetailFileHandler } from './detail-file.js'
import { LocalPluginEventBus } from './events.js'

/** 直连通道的运行时句柄。 */
export interface LocalPluginChannelHandle {
  /** 本通道是否真的挂上了（服务就绪 + 路由注册成功）。 */
  readonly mounted: boolean
  /** 事件总线（测试与诊断用）。 */
  readonly events?: LocalPluginEventBus
  /** 卸载：移除全部路由与升级路由、关闭事件订阅。 */
  dispose(): void
}

/**
 * 构造一个 JSON 响应。
 * @param value - 响应体。
 * @param status - HTTP 状态。
 */
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

/**
 * 构造一个错误响应。
 * @param error - 归一后的直连错误。
 */
function failure(error: LocalPluginError): Response {
  return json(failureBody(error) satisfies LocalPluginFailureBody, error.status)
}

/** 判断一个值是否是「非本机 owner」的调用方。 */
interface PeerLike {
  readonly principal?: { readonly kind?: unknown } | null
}

/**
 * 断言调用方是本机 owner（同源页面 / 进程内直调用）。
 *
 * `createSharedFetchHandler` 已对精确路由做过一次 owner 检查；这里**再查一次**是防御性的：
 * 路由将来若被别处以其它方式挂载（例如被某个宿主组合直接调用），闸门仍然有效。
 * @param peer - 请求携带的 Peer。
 * @param route - 路由名（错误信息用）。
 * @returns 通过时的 Peer。
 * @throws {LocalPluginError} 调用方不是 owner。
 */
export function assertOwnerPeer(peer: PeerLike | undefined, route: string): PeerLike {
  const kind = peer?.principal?.kind
  // principal 缺失（进程内直调）或显式 owner 都放行；remote-device 与其它 kind 一律拒绝。
  if (kind === undefined || kind === null || kind === 'owner') return peer ?? {}
  throw new LocalPluginError(
    LOCAL_PLUGIN_ERRORS.forbidden,
    `${route} is available to the local owner page only`,
    { principal: String(kind) },
    403,
  )
}

/**
 * 读取并校验一元请求体。
 *
 * 形状：`{ args: [...] }`。用位置参数数组而不是命名对象，是为了与官方 `@Remote` 方法的
 * 位置参数签名逐位对照，避免命名映射成为第二个真相。
 * @param request - 原始请求。
 * @returns 位置参数数组（缺省为空）。
 */
async function readArgs(request: Request): Promise<unknown[]> {
  let parsed: unknown
  try {
    const text = await request.text()
    parsed = text === '' ? {} : JSON.parse(text)
  } catch {
    throw new LocalPluginError(LOCAL_PLUGIN_ERRORS.badRequest, 'request body is not valid JSON', {}, 400)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LocalPluginError(LOCAL_PLUGIN_ERRORS.badRequest, 'request body must be an object', {}, 400)
  }
  const args = (parsed as { args?: unknown }).args
  if (args === undefined) return []
  if (!Array.isArray(args)) {
    throw new LocalPluginError(LOCAL_PLUGIN_ERRORS.badRequest, 'args must be an array', {}, 400)
  }
  return args
}

/** 从 Context 上读一个可能未就绪的服务（与本插件其它地方同一口径）。 */
function serviceOf(ctx: Context, name: string): unknown {
  const reflect = (ctx as unknown as { reflect?: { get?: (key: string, strict?: boolean) => unknown } }).reflect
  try {
    return reflect?.get?.(name, false)
  } catch {
    return undefined
  }
}

/**
 * 在 Host Context 上装配本地插件管理直连通道。
 *
 * **延迟装配**：`pluginManager` 就绪后才挂；`connection` / `webServer` 就绪后才注册路由。
 * 任一必需服务缺席 → 通道不挂（fail-closed），绝不抛错拖垮宿主。
 * @param ctx - Host Context。
 * @returns 句柄；未挂载时 `mounted === false`。
 */
export function applyLocalPluginManager(ctx: Context): LocalPluginChannelHandle {
  const disposers: (() => void)[] = []
  let mounted = false
  let events: LocalPluginEventBus | undefined

  const disposer = (): void => {
    for (const dispose of [...disposers].reverse()) {
      try {
        dispose()
      } catch {
        // 卸载期异常不得影响宿主收尾。
      }
    }
    disposers.length = 0
    mounted = false
  }

  // pluginManager 缺席（或早期）时安静不挂。
  const upstreams = resolveLocalPluginUpstreams(ctx)
  if (upstreams === undefined) return { mounted: false, dispose: disposer }

  const service = new LocalPluginManagerService(upstreams)

  const connection = serviceOf(ctx, 'connection') as {
    fetch?: { register?: (route: unknown) => () => void }
  } | undefined
  if (connection?.fetch?.register === undefined) return { mounted: false, dispose: disposer }

  // 事件总线：只在服务挂上时创建（它自身按需订阅 4 个 Cordis 事件）。
  events = new LocalPluginEventBus(ctx)
  disposers.push(() => { events?.dispose() })

  // ── 一元方法：每个方法一条精确路径 ──────────────────────────────────────────
  for (const method of LOCAL_PLUGIN_METHODS) {
    const route = localPluginPath(method)
    disposers.push(connection.fetch.register({
      path: route,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request: Request) => {
        // exact route 在 `createSharedFetchHandler` 里已对非 owner 直接 403；
        // `fetch` 形状不带 peer，所以这里只能依赖那层闸门 + 事件通道里的显式 owner 校验。
        return handleCall(service, method, route, request)
      },
    }))
  }

  // ── 详情图片转发 ────────────────────────────────────────────────────────────
  const detailFile = createDetailFileHandler(upstreams, ctx)
  disposers.push(connection.fetch.register({
    path: LOCAL_PLUGIN_DETAIL_FILE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    // 图片走 <img src>，浏览器不会带自定义头；owner 校验由 createSharedFetchHandler 完成。
    fetch: (request: Request) => detailFile(request),
  }))

  // ── 事件通道：专用 WebSocket 升级路由 ───────────────────────────────────────
  const webServer = serviceOf(ctx, 'webServer') as {
    registerUpgrade?: (route: unknown) => () => void
  } | undefined
  if (webServer?.registerUpgrade !== undefined && events !== undefined) {
    const bus = events
    disposers.push(webServer.registerUpgrade({
      path: LOCAL_PLUGIN_EVENTS_PATH,
      handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        admitUpgrade(ctx, req, socket, head, bus)
      },
    }))
  }

  mounted = true
  const handle: LocalPluginChannelHandle = {
    get mounted() { return mounted },
    get events() { return events },
    dispose: disposer,
  }
  // 随插件 fiber 一起卸载。
  ctx.effect(() => () => disposer(), 'dsh-remote-hub: local plugin manager channel')
  return handle
}

/**
 * 处理一次一元调用。
 * @param service - 直连服务实例。
 * @param method - 方法名。
 * @param route - 路由（错误信息用）。
 * @param request - 原始请求。
 */
async function handleCall(
  service: LocalPluginManagerService,
  method: LocalPluginMethod,
  route: string,
  request: Request,
): Promise<Response> {
  try {
    const args = await readArgs(request)
    const value = await service.call(method, args, { signal: request.signal })
    return json(value)
  } catch (error) {
    const normalized = asLocalPluginError(error)
    // 路由名只出现在错误信息里，绝不回显请求体（安装日志可能含 npm token）。
    if (normalized.code === LOCAL_PLUGIN_ERRORS.upstream) normalized.message = `${route}: ${normalized.message}`
    return failure(normalized)
  }
}

/**
 * 推进一次 WebSocket 升级：信任栅栏 → 认证 → owner 校验 → 交给事件总线。
 * @param ctx - Host Context。
 * @param req - 升级请求。
 * @param socket - 底层 socket。
 * @param head - 升级头之后已读到的字节。
 * @param bus - 事件总线。
 */
function admitUpgrade(
  ctx: Context,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  bus: LocalPluginEventBus,
): void {
  const connection = serviceOf(ctx, 'connection') as {
    admit?: (request: IncomingMessage) => { peer?: PeerLike } | { rejection: number; release?: unknown }
    admitConnection?: (request: IncomingMessage) =>
      { peer?: PeerLike; release?: () => Promise<void> } | { rejection: number; release?: unknown }
  } | undefined
  if (connection?.admit === undefined && connection?.admitConnection === undefined) {
    // 没有 admission 能力就无法证明 owner 身份 → fail-closed（宁可事件不实时，也不放行）。
    return rejectUpgrade(socket, 403)
  }
  /**
   * ⚠️ 这里**只用 `admit()`**，不调 `requestRejection()` / `admitConnection()`：
   *
   * - `requestRejection()` 内部就是 `admit()`，重复调用没有意义；
   * - `admitConnection()` 会顺手把 peer 标成「已拥有 socket」（`ownsSocket = true`），
   *   而它只能由既有的 `/ws` 升级路径配套释放。我们的路由随后自己 `ws.handleUpgrade`，
   *   用它换来的是 `409`（2026-11-14 沙箱实测：事件通道永远连不上）。
   *
   * 所以顺序是：`admit()` 验 Host/Origin 围栏 + owner 身份 → 再校验 peer 是 owner → 交给我们自己的 ws。
   */
  let admission: { peer?: PeerLike } | { rejection: number }
  try {
    admission = connection.admit !== undefined ? connection.admit(req) : connection.admitConnection!(req)
  } catch {
    return rejectUpgrade(socket, 403)
  }
  if ('rejection' in admission) return rejectUpgrade(socket, admission.rejection)
  try {
    assertOwnerPeer(admission.peer, LOCAL_PLUGIN_EVENTS_PATH)
  } catch {
    return rejectUpgrade(socket, 403)
  }
  bus.accept(req, socket, head)
}

/**
 * 用一个 HTTP 响应拒绝一次升级（不把 socket 交给 ws）。
 * @param socket - 底层 socket。
 * @param status - 401 / 403。
 */
export function rejectUpgrade(socket: Duplex, status: number): void {
  const reason = status === 401 ? 'Unauthorized' : 'Forbidden'
  const body = reason.toLowerCase()
  socket.end([
    `HTTP/1.1 ${String(status)} ${reason}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    '',
    body,
  ].join('\r\n'))
}
