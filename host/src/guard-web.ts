/**
 * 守卫的浏览器静态面：`GET /` 的 index 注入 + 官方静态资源的流式反代。
 *
 * ## 为什么需要这一层
 *
 * 远程浏览器要「整机接管」另一台 DSH，就必须能在**守卫 origin**上拿到官方
 * Web 的那一套外壳：`index.html`、`/assets/*`、`/plugins/*`、
 * `manifest.webmanifest`、`favicon*.svg`。它们此刻只存在于官方 `:3080` 上，
 * 而 `:3080` 是**绝不对外**的（隧道明确拒绝它，见 `tunnel.ts` 文件头）。
 * 所以守卫自己把这几条路径反代出来，其余（`/remote/rpc`、`/api/*`）仍归
 * `guard.ts` 的原有分发。
 *
 * ## 三个必须守住的性质
 *
 * 1. **`__DSH_BOOT__` 是官方写进 index 的唯一数据源**（模块图、主题、注入表）。
 *    我们**不解析、不重建、不删改**它——只在它前后各插一行
 *    `globalThis.__DSH_REMOTE_HUB__ = …`。一旦重建，官方的
 *    `__DSH_BOOT_READY__` 时序与注入表就会漂移。
 * 2. **注入里绝不能带令牌**。本机 index 页的 `__DSH_REMOTE_HUB__` 含
 *    `pairIssueToken`（见 `guard.ts` 的 `PAIR_ISSUE_GLOBAL`）；这里的同名全局
 *    只有 `{ mode: 'remote-browser' }` 一个字段，且旧值被**显式覆盖**。
 * 3. **静态资源必须流式转发**：`/assets/*` 是几百 KB 的 JS，整段读入内存会
 *    在并发页面加载时放大成 OOM 面。用 `node:http` 的 `request` + `pipe`。
 *
 * ## 不在本模块的东西
 *
 * - 认证（`/remote-auth/*`）与 RPC（`/remote/rpc`）：`guard.ts` 与 `auth/*`。
 * - 会话 Cookie：本模块**不种任何 Cookie**，也**不转发**客户端的 Cookie 给上游
 *   （官方 Web 的来源围栏只看 Origin/Referer/Sec-Fetch-Site，不看我们的 Cookie）。
 *
 * @module dsh-remote-hub/host/guard-web
 */
import { createHash } from 'node:crypto'
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import type { OutgoingHttpHeaders } from 'node:http'

import { GUARD_ROUTES, maskSecret } from '@core/index.js'
import type { RoleName } from '@core/index.js'

/**
 * 注入到索引页的全局名（与 `guard.ts` 的 `PAIR_ISSUE_GLOBAL` 同名、不同内容）。
 *
 * 同名是**刻意的**：浏览器插件半边（`client/src/plugin.ts`）只认这一个全局。
 * 差别在内容——本机页面的那份带 `pairIssueToken`，远程浏览器这份**只有** `mode`。
 */
export const REMOTE_BROWSER_GLOBAL = '__DSH_REMOTE_HUB__'

/** 远程浏览器标记：插件半边据此切到「浏览器直连」模式（不注入 transport）。 */
export const REMOTE_BROWSER_MODE = 'remote-browser'

/** 注入的那一行（整段唯一内容，便于 grep 与测试断言）。 */
// **必须合并而不是赋值**：Host 自己也会往同一个全局里写 `__DSH_REMOTE_HUB__`
// （配对签发令牌、设备表、guardOrigin 等）。直接赋值会把那一片数据覆盖掉，
// 本机页面与远程页面都会少掉配对能力。
export const REMOTE_BROWSER_MARKUP =
  `globalThis.${REMOTE_BROWSER_GLOBAL} = Object.assign(globalThis.${REMOTE_BROWSER_GLOBAL} ?? {}, {"mode":"${REMOTE_BROWSER_MODE}"});`

/** 官方 index 里的单一数据源标记。 */
export const BOOT_GLOBAL = '__DSH_BOOT__'

/**
 * index 的缓存窗口（5 秒）。
 *
 * 为什么要有窗口：index 是**每个标签页**都要回源一次的请求，而它本身只有几 KB，
 * 但官方每次渲染都会重新跑注入表（`webserver/index-inject`）。5 秒窗口让
 * 「浏览器开新标签」与「SSE 重连刷页」共享同一份结果，又不至于让插件启停后
 * 的模块图变化延迟到用户以为坏了。
 */
export const INDEX_CACHE_TTL_MS = 5_000

/** 静态资源的缓存头：文件名带 hash，永不失效（官方资源 URL 自带内容摘要）。 */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable'

/** index 的缓存头：`no-cache` 让浏览器每次都回来验证 ETag（我们自己的 5s 窗口才是真缓存）。 */
export const INDEX_CACHE_CONTROL = 'no-cache'

/** 打不开上游（连接拒绝 / DNS 失败 / 超时）→ 503。 */
export const STATUS_UPSTREAM_UNREACHABLE = 503

/** 上游连上了但回错（5xx / 4xx）→ 502。 */
export const STATUS_UPSTREAM_ERROR = 502

/** 反代 index 的上游超时（毫秒）：官方渲染注入表是同步的，1 秒足够，超出即视为不可达。 */
export const UPSTREAM_INDEX_TIMEOUT_MS = 1_000

/**
 * 白名单取法的上游请求头：**只转发这五个**。
 *
 * 刻意不是一个透传 `req.headers`：客户端的 `authorization` / `cookie` /
 * `x-pair-issue-token` 属于不同的信任域，绝不能被顺手带给官方 Web。
 */
const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'accept-encoding',
  'accept-language',
  'if-none-match',
  'if-modified-since',
  'range',
] as const

/**
 * 白名单回写的上游响应头。
 *
 * 去掉 `set-cookie`（官方 Web 的会话 Cookie 属于 `:3080` 的信任域，带到守卫
 * origin 上就是跨域凭据搬运）、`connection` 系列（逐跳头）与 `content-length`
 * （流式转发时长度由 node 分块重算；注入改写后的长度另行显式设置）。
 */
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'cache-control',
  'etag',
  'last-modified',
  'content-encoding',
  'content-language',
  'vary',
] as const

/** 一次静态反代的结局（审计用；**不含** URL query 原文）。 */
export type GuardWebProxyOutcome =
  /** 上游 2xx/3xx（含 304），已把字节流交给客户端。 */
  | 'ok'
  /** 上游不可达（连接失败、提前断开、超时）。 */
  | 'unreachable'
  /** 上游回了非 2xx/3xx。 */
  | 'upstream-error'

/**
 * 守卫静态面的依赖。
 *
 * 全部由 `plugin.ts` 注入；**没有一个字段是凭据**，所以整份 deps 打印到日志
 * 也不会泄漏令牌（`audit` 里也刻意只记路径与结局）。
 */
export interface GuardWebDeps {
  /**
   * 官方 Web 的 origin，形如 `http://127.0.0.1:<port>`（`resolveHostOrigin` 的返回值）。
   *
   * 缺省（`undefined`）时静态面**整体不可用**：`GET /` 与静态路径一律 503，
   * 其余路径仍返回 `false`（交给原有分发）。这样在没有官方 Web 的宿主
   * （desktop）里挂载本模块是安全的。
   */
  hostOrigin?: string
  /**
   * 官方 Web 的自启动令牌（`?token=`）。
   *
   * 官方 `:3080` 对未带令牌的 `GET /` 回 401，所以守卫反代必须**在服务端**补上它。
   * 它**绝不**出现在返回给浏览器的任何字节里（不写进 HTML、不回写入 Cookie）：
   * 浏览器侧的认证由守卫自己的 HttpOnly Cookie 负责，两套凭据互不泄漏。
   */
  hostToken?: string
  /**
   * 进程内取官方 index 的 HTML（**优先于** HTTP 反代）。
   *
   * 官方 `:3080` 对未带 `?token=` 的 `GET /` 回 401，而插件运行在 Host 进程内，
   * 直接读渲染结果比「先拿到自启动令牌再发 HTTP」干净得多：不碰令牌、
   * 不依赖网络、也不会把令牌带进任何日志或响应。
   *
   * 由 `plugin.ts` 注入 `webServer.renderIndex(html, peer)` 的绑定。
   * 缺省时回落到 HTTP 反代（需要 `hostToken`）。
   */
  readIndex?: (accountId: string, role: RoleName) => Promise<string | undefined> | string | undefined
  /**
   * 从请求里解析当前浏览器会话的账号 id。
   *
   * index 要按**读取者本人的身份**渲染访问快照（官方 liveshare 同款做法：
   * `webServer.readResource(request, peer)`），所以这里必须先知道是谁在看。
   * 缺省或未登录时按匿名处理（外壳仍可渲染，只是没有访问行）。
   */
  readerOf?: (req: IncomingMessage) => Promise<{ accountId: string, role: RoleName } | undefined>
    | { accountId: string, role: RoleName }
    | undefined
  /**
   * 进程内读一个页面资源（`assets/...`、`plugins/...`）。
   *
   * 官方 `webServer.readResource(request, peer)` 对**未带令牌**的请求同样放行，
   * 前提是给了 peer 身份 —— liveshare 的 viewer-assets 就是这么做的。
   * 有了它，静态面完全不必反代到 `:3080`（那条路需要自启动令牌）。
   *
   * @param pathWithQuery - 页面相对路径（含 query，例如 `plugins/??a/client.js&rev=x`）。
   * @param accountId - 当前会话账号；空串表示匿名。
   * @returns 资源内容与 content-type；不可用时 undefined。
   */
  readAsset?: (
    pathWithQuery: string,
    accountId: string,
    role: RoleName,
  ) => Promise<{ body: Uint8Array; contentType: string } | undefined> | { body: Uint8Array; contentType: string } | undefined
  /**
   * 结构化审计。**不得**写入任何令牌 / Cookie / 完整 query。
   *
   * 只会在两种情况下被调用：`'web-proxy-error'`（上游错误或不可达）
   * 与 `'web-index-rewrite-failed'`（index 里找不到 `__DSH_BOOT__`）。
   */
  audit?: (event: string, fields: Record<string, unknown>) => void
  /**
   * 时钟注入（测试用）。缺省 `Date.now`。
   *
   * 只影响 index 的 5 秒缓存窗口判定，不参与任何安全判定。
   */
  now?: () => number
  /**
   * 反代 index 的上游超时覆盖（测试用）。缺省 `UPSTREAM_INDEX_TIMEOUT_MS`。
   *
   * 为什么不必给静态资源也配一个：资源是流式的，超时语义应交给客户端断开
   * （`res.on('close')` → 中止上游请求），而不是服务端一刀切。
   */
  indexTimeoutMs?: number
}

/** 守卫静态面句柄。 */
export interface GuardWebHandle {
  /**
   * 处理一次 HTTP 请求。
   *
   * @param req - 入站请求（只读其 `method` / `url` / `headers`）。
   * @param res - 出站响应；返回 `true` 时本方法**已经**写响应（可能已 `end`）。
   * @returns `true` = 本模块已处理，调用方不得再分发；`false` = 不是本模块的路径。
   */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>
}

/** index 缓存条目：5 秒窗口内共享同一份改写结果。 */
interface IndexCacheEntry {
  /** 上游响应的 ETag（原样回写给浏览器，让它在窗口内走 304）。 */
  etag: string
  /** 上游响应的 Content-Type。 */
  contentType: string
  /** 已注入标记的 HTML 字节（**绝不含令牌**）。 */
  body: Buffer
  /** 写入时间（`now()` 毫秒）。 */
  storedAt: number
}

/**
 * 判定一个路径是否归本模块的**静态资源**白名单。
 *
 * 白名单而不是黑名单：官方资源路径只有这四类（`/assets/` chunk、
 * `/plugins/` 插件 bundle、`manifest.webmanifest`、`favicon*.svg`）。
 * 其余一律不是本模块的（例如 `/api/*`、`/remote/*`、`/plugins.json`）。
 *
 * `/plugins/??a/client.js,b/client.js&rev=xxx` 这种**拼接形式**只看
 * `pathname` 就知道是 `/plugins/` 前缀——query 由调用方原样透传。
 *
 * @param pathname - 已解析的路径（不含 query）。
 * @returns `true` 表示应当反代给官方 Web。
 */
export function isProxyableAssetPath(pathname: string): boolean {
  if (pathname.startsWith('/assets/') || pathname.startsWith('/plugins/')) return true
  if (pathname === '/manifest.webmanifest') return true
  // 官方 favicon 家族：`/favicon.svg`、`/favicon-32x32.svg` 等。
  return /^\/favicon[a-zA-Z0-9._-]*\.svg$/u.test(pathname)
}

/**
 * 把远程标记插进官方 index（**保持 `__DSH_BOOT__` 原样**）。
 *
 * 插入位置：`<head>` 打开标签之后。理由是 `__DSH_BOOT__` 与客户端入口模块都在
 * head/body 顶部执行，标记必须**先于**插件工厂可见——插件半边在 factory 里读它。
 *
 * 找不到 `__DSH_BOOT__` 时**不注入**：那说明上游不是官方 index（例如错误页），
 * 照原样送回更安全，由调用方记一条审计。
 *
 * @param html - 上游 index 的 UTF-8 文本。
 * @returns `body` 是最终字节；`injected` 表示是否真的插入了标记。
 */
/**
 * 把远程标记插进官方 index（**保持 `__DSH_BOOT__` 原样**）。
 *
 * 位置很关键：Host 自己也往同一个全局写 `__DSH_REMOTE_HUB__`（配对令牌、设备表），
 * 而它走的是 `webserver/index-inject`，渲染在 body 末尾。若我们把标记放在 `<head>`，
 * 就会被后写的 Host 对象整个覆盖（实测：`mode` 消失）。所以这里插在 **`</body>` 之前**，
 * 保证最后执行，并用 `Object.assign` 合并而不是赋值。
 *
 * @param html - 上游 index 的 UTF-8 文本。
 * @returns `body` 是最终字节；`injected` 表示是否真的插入了标记。
 */
export function injectRemoteBrowserMarker(html: string): { body: string; injected: boolean } {
  const marker = `<script>${REMOTE_BROWSER_MARKUP}</script>`
  // 位置①：`</body>` 之前 —— 最后执行，不会被子序列写入覆盖。
  const bodyClose = html.lastIndexOf('</body>')
  if (bodyClose >= 0) {
    return { body: `${html.slice(0, bodyClose)}${marker}${html.slice(bodyClose)}`, injected: true }
  }
  // 位置②：没有 body 的页面，退到 `</html>` 之前。
  const htmlClose = html.lastIndexOf('</html>')
  if (htmlClose >= 0) {
    return { body: `${html.slice(0, htmlClose)}${marker}${html.slice(htmlClose)}`, injected: true }
  }
  // 位置③：既没有 body 也没有 html（上游不是官方 index）—— 不注入。
  return { body: html, injected: false }
}

/**
 * 校验并归一 `hostOrigin`（只接受 `http:` / `https:` 且必须带 host）。
 *
 * 校验的目的不是防注入（值来自调用方），而是让配置写错时**立刻 503**，
 * 而不是在 `http.request` 里抛一个未捕获异常。
 *
 * @param hostOrigin - deps 里的 origin。
 * @returns 归一后的 `URL`，或 `undefined`（不可用）。
 */
function parseHostOrigin(hostOrigin: string | undefined): URL | undefined {
  if (hostOrigin === undefined || hostOrigin.trim() === '') return undefined
  try {
    const url = new URL(hostOrigin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    if (url.hostname === '') return undefined
    return url
  } catch {
    return undefined
  }
}

/**
 * 给上游 URL 补上自启动令牌。
 *
 * 官方 `:3080` 对未带令牌的 `GET /` 回 401；令牌只在**服务端之间**传递，
 * 永不写进返回给浏览器的字节（HTML、Cookie、日志都不含它）。
 *
 * @param url - 上游 URL（会被复制，不改原对象）。
 * @param hostToken - 令牌；缺省时原样返回。
 * @returns 带令牌的 URL。
 */
function withHostToken(url: URL, hostToken: string | undefined): URL {
  if (hostToken === undefined || hostToken === '') return url
  const next = new URL(url.toString())
  next.searchParams.set('token', hostToken)
  return next
}

/** 只写一个纯文本错误响应（不带任何内部细节）。 */
function plainError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.end()
    return
  }
  const body = Buffer.from(`${message}\n`, 'utf8')
  res.statusCode = status
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.setHeader('content-length', String(body.length))
  // 错误页绝不缓存：否则上游恢复后浏览器仍拿到 503。
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/**
 * 构造转发给上游的请求头（白名单 + Host 改写）。
 *
 * @param req - 客户端请求（只按白名单取字段）。
 * @param upstream - 上游 URL。
 * @param hostToken - 官方 Web 的自启动令牌；在服务端补 `?token=`，不外泄。
 * @returns 上游请求头。
 */
function upstreamRequestHeaders(req: IncomingMessage, upstream: URL, hostToken?: string): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {}
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers[name]
    if (typeof value === 'string' && value !== '') headers[name] = value
    else if (Array.isArray(value) && value.length > 0) headers[name] = value.join(', ')
  }
  // **Host 必须改成上游的**：官方 Web 的来源围栏拿 Host 判同源，原样带
  // `127.0.0.1:8443` 会被它当成伪造来源而拒绝。
  headers.host = upstream.host
  // 告诉上游「这是我们代为取资源」；不带任何客户端凭据。
  headers['user-agent'] = 'dsh-remote-hub/guard-web'
  return headers
}

/** 从上游响应里挑出白名单头写回客户端。 */
function applyUpstreamResponseHeaders(res: ServerResponse, upstreamHeaders: OutgoingHttpHeaders): void {
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstreamHeaders[name]
    if (value === undefined) continue
    // 长度头不在白名单里：流式转发后长度由 node 重算（注入改写同理）。
    res.setHeader(name, value)
  }
}

/** 把任意错误收窄成可审计的短字符串（**不到达客户端**）。 */
function shortError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  // 上游错误信息里偶尔会带 URL（含 query）；截断并去掉疑似凭据段。
  return maskSecret(text).slice(0, 200)
}

/**
 * 创建守卫的浏览器静态面。
 *
 * 返回的 `handle` 对**本模块之外**的路径一律返回 `false`（不写响应），
 * 调用方据此继续走 `guard.ts` 的原分发——两条分发链互不覆盖。
 *
 * @param deps - 依赖（官方 Web origin + 可选审计/时钟）。
 * @returns `GuardWebHandle`；`handle` 永不抛未捕获异常（内部错误 → 502/503）。
 */
export function createGuardWeb(deps: GuardWebDeps = {}): GuardWebHandle {
  const upstreamBase = parseHostOrigin(deps.hostOrigin)
  const now = deps.now ?? (() => Date.now())
  const indexTimeoutMs = deps.indexTimeoutMs ?? UPSTREAM_INDEX_TIMEOUT_MS

  /**
   * index 缓存（窗口 `INDEX_CACHE_TTL_MS`）。
   *
   * 只存**已注入**的字节与上游 ETag：绝不存原始上游响应（原始响应里没有
   * 我们的标记，误发出去会让浏览器跑成「本机模式」而始终连不上）。
   */
  let indexCache: IndexCacheEntry | undefined

  const audit = (event: string, fields: Record<string, unknown>): void => {
    try {
      deps.audit?.(event, fields)
    } catch {
      // 审计后端抛错不能影响响应（否则一次日志故障就变成 500）。
    }
  }

  /**
   * 从上游取回 index 并注入标记。
   *
   * @param req - 客户端请求（只用来决定是否需要 304）。
   * @param res - 客户端响应。
   * @returns `true` 表示已写响应。
   */
  const serveIndex = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (upstreamBase === undefined) {
      audit('web-proxy-error', { kind: 'index', reason: 'host-origin-unset' })
      plainError(res, STATUS_UPSTREAM_UNREACHABLE, 'upstream unavailable')
      return true
    }

    // ① 窗口内的缓存直接命中：浏览器带同一个 ETag 就回 304，省掉回源。
    const cached = indexCache
    if (cached !== undefined && now() - cached.storedAt < INDEX_CACHE_TTL_MS) {
      const ifNoneMatch = req.headers['if-none-match']
      if (typeof ifNoneMatch === 'string' && ifNoneMatch === cached.etag) {
        res.statusCode = 304
        res.setHeader('etag', cached.etag)
        res.setHeader('cache-control', INDEX_CACHE_CONTROL)
        res.end()
        return true
      }
      res.statusCode = 200
      res.setHeader('content-type', cached.contentType)
      res.setHeader('etag', cached.etag)
      res.setHeader('cache-control', INDEX_CACHE_CONTROL)
      res.setHeader('content-length', String(cached.body.length))
      res.end(cached.body)
      return true
    }

    // ①.5 进程内优先：插件就在 Host 进程里，直接拿渲染后的 index，
    //      既不碰自启动令牌，也不依赖 `:3080` 的 HTTP 可达性。
    if (deps.readIndex !== undefined) {
      let html: string | undefined
      let readerAccountId = ''
      let readerRole: RoleName = 'read-only'
      try {
        const reader = await deps.readerOf?.(req)
        if (reader !== undefined) {
          readerAccountId = reader.accountId
          readerRole = reader.role
        }
      } catch { /* 按匿名处理 */ }
      try {
        html = await deps.readIndex(readerAccountId, readerRole)
      } catch (error) {
        audit('web-index-rewrite-failed', { reason: 'read-index-threw', detail: shortError(error) })
        html = undefined
      }
      if (html === undefined || html.trim() === '') {
        // 读不到就落到 HTTP 反代；那条路需要自启动令牌，通常也是 503，
        // 但至少能让运维从审计里看出「进程内读取失败」而不是静默空页。
        audit('web-index-rewrite-failed', { reason: 'read-index-empty' })
      }
      if (typeof html === 'string' && html.trim() !== '') {
        const rewritten = injectRemoteBrowserMarker(html).body
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          // 页面外壳不缓存：免得 boot 里的 rev 与插件清单在升级后错位。
          'cache-control': 'no-store',
        })
        res.end(rewritten)
        return true
      }
    }

    // ② 回源：整段读入（index 只有几 KB，且必须改写字节，不能流式）。
    const upstream = withHostToken(new URL('/', upstreamBase), deps.hostToken)
    let status = 0
    let headers: OutgoingHttpHeaders = {}
    let raw = ''
    try {
      const result = await new Promise<{ status: number; headers: OutgoingHttpHeaders; body: Buffer }>(
        (resolve, reject) => {
          const request = httpRequest(upstream, {
            method: 'GET',
            headers: upstreamRequestHeaders(req, upstream, deps.hostToken),
            // 超时即视为不可达：官方渲染注入表是同步的，1 秒没回就是上游病了。
          }, response => {
            const chunks: Buffer[] = []
            response.on('data', (chunk: Buffer) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)) })
            response.on('end', () => {
              resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) })
            })
            response.on('error', reject)
          })
          // 上游不响应：直接销毁，落到下面的 catch → 503。
          request.setTimeout(indexTimeoutMs, () => {
            request.destroy(new Error(`upstream index timeout after ${indexTimeoutMs}ms`))
          })
          request.on('error', reject)
          // GET 无请求体：立即 end（不 `req.pipe`，避免把客户端的怪异 body 带上去）。
          request.end()
        },
      )
      status = result.status
      headers = result.headers
      raw = result.body.toString('utf8')
    } catch (error) {
      // 连接拒绝 / DNS 失败 / 超时：**上游不可达** → 503。
      audit('web-proxy-error', {
        kind: 'index',
        reason: 'unreachable',
        detail: shortError(error),
      })
      plainError(res, STATUS_UPSTREAM_UNREACHABLE, 'upstream unavailable')
      return true
    }

    if (status < 200 || status >= 300) {
      // 上游连上了但回错（例如官方 Web 还没起完就回 5xx）→ 502。
      audit('web-proxy-error', { kind: 'index', reason: 'upstream-status', status })
      plainError(res, STATUS_UPSTREAM_ERROR, 'upstream error')
      return true
    }

    // ③ 注入标记（绝不重建 `__DSH_BOOT__`）。
    const { body, injected } = injectRemoteBrowserMarker(raw)
    if (!injected) {
      // 上游不是官方 index（没有 `__DSH_BOOT__`，也没有 `<head>`）。
      // 照原样回送（不注入），但留痕——这正是「官方改了 index 结构」的早期信号。
      audit('web-index-rewrite-failed', { reason: 'boot-marker-and-head-missing' })
    }
    // `content-encoding` 不适用于我们改写过的字节（上游通常是明文，保险起见置空）。
    const buffer = Buffer.from(body, 'utf8')
    // 未注入时不要缓存：下一次请求应重新看一眼上游是否已恢复。
    const etag = injected
      ? `W/"hub-${createHash('sha256').update(buffer).digest('hex').slice(0, 16)}"`
      : ''
    if (injected) {
      indexCache = {
        etag,
        contentType: typeof headers['content-type'] === 'string'
          ? headers['content-type']
          : 'text/html; charset=utf-8',
        body: buffer,
        storedAt: now(),
      }
      res.statusCode = 200
      res.setHeader('content-type', indexCache.contentType)
      res.setHeader('etag', etag)
      res.setHeader('cache-control', INDEX_CACHE_CONTROL)
      res.setHeader('content-length', String(buffer.length))
      res.end(buffer)
      return true
    }
    res.statusCode = 200
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('content-length', String(buffer.length))
    res.end(buffer)
    return true
  }

  /**
   * 流式反代一个静态资源（`/assets/*`、`/plugins/*` 等）。
   *
   * `req.url` **原样**透传：`/plugins/??a/client.js,b/client.js&rev=xxx` 这种
   * 拼接形式的 query 由官方 Web 自己解释，我们不做任何拆分或重写。
   *
   * @param req - 客户端请求。
   * @param res - 客户端响应。
   * @returns 恒为 `true`（已接管）。
   */
  const serveAsset = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (upstreamBase === undefined) {
      audit('web-proxy-error', { kind: 'asset', reason: 'host-origin-unset', path: safePath(req.url) })
      plainError(res, STATUS_UPSTREAM_UNREACHABLE, 'upstream unavailable')
      return true
    }

    // 原样透传 path + query（含拼接形式）。`upstreamBase` 已保证没有自己的 path。
    const upstream = new URL(req.url ?? '/', upstreamBase)
    const pathname = upstream.pathname
    const method = (req.method ?? 'GET').toUpperCase()

    return await new Promise<boolean>(resolve => {
      let settled = false
      /** 只结算一次：pipe 与 error 可能先后触发。 */
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        resolve(value)
      }

      const withToken = withHostToken(upstream, deps.hostToken)
      const request = httpRequest(withToken, {
        method,
        headers: upstreamRequestHeaders(req, withToken, deps.hostToken),
      }, response => {
        const status = response.statusCode ?? 0
        if (status < 200 || status >= 300) {
          audit('web-proxy-error', {
            kind: 'asset',
            reason: 'upstream-status',
            status,
            path: pathname,
          })
          // 先把上游体丢弃，避免 socket 卡在半读状态。
          response.resume()
          plainError(res, STATUS_UPSTREAM_ERROR, 'upstream error')
          finish(true)
          return
        }
        res.statusCode = status
        applyUpstreamResponseHeaders(res, response.headers)
        // 静态资源一律带 immutable：文件名自带内容 hash，换了内容就换 URL。
        res.setHeader('cache-control', IMMUTABLE_CACHE_CONTROL)
        // HEAD 不写体（node 会自动丢弃，但显式 end 更直观）。
        if (method === 'HEAD') {
          response.resume()
          res.end()
          finish(true)
          return
        }
        // 流式转发：背压由 pipe 负责，不整段读入内存。
        response.pipe(res)
        response.on('end', () => { finish(true) })
        // 上游中途断开：客户端已经拿到部分字节，只能断掉连接（不能再写 502）。
        response.on('error', () => {
          audit('web-proxy-error', { kind: 'asset', reason: 'upstream-aborted', path: pathname })
          res.destroy()
          finish(true)
        })
      })

      request.on('error', error => {
        // 连接拒绝 / DNS 失败 / 超时：**上游不可达** → 503。
        audit('web-proxy-error', {
          kind: 'asset',
          reason: 'unreachable',
          path: pathname,
          detail: shortError(error),
        })
        plainError(res, STATUS_UPSTREAM_UNREACHABLE, 'upstream unavailable')
        finish(true)
      })

      // 客户端提前断开（换页/取消）：立即中止上游，别让流悬挂。
      res.on('close', () => {
        if (!res.writableFinished) {
          request.destroy()
          finish(true)
        }
      })

      // GET/HEAD 无请求体；其它方法（官方静态面会回 405）也不转发 body。
      request.end()
    })
  }

  /**
   * 分发一次请求。
   *
   * @param req - 入站请求。
   * @param res - 出站响应。
   * @returns `true` = 已处理；`false` = 不是本模块的路径（未写响应）。
   */
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if ((req.method ?? 'GET').toUpperCase() === 'CONNECT') return false
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    } catch {
      // 连 URL 都解析不了：不是我们的问题路径，交回调用方（它会 404）。
      return false
    }

    // `GET /`：官方 index + 远程标记。
    if (pathname === GUARD_ROUTES.web) {
      return await serveIndex(req, res)
    }

    // 静态白名单。**任何方法都算我们的路径**：`POST /assets/x.js` 由本模块回
    // 405，而不是漏给守卫变成一条「未知路由」的 404（避免误以为路径不存在）。
    if (isProxyableAssetPath(pathname)) {
      const method = (req.method ?? 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'HEAD') {
        if (!res.headersSent) {
          res.statusCode = 405
          res.setHeader('allow', 'GET, HEAD')
          res.setHeader('content-length', '0')
          res.end()
        }
        return true
      }
      // 优先走进程内读取：与 index 同一条路（readResource + peer），
      // 不需要自启动令牌，也不依赖 `:3080` 的 HTTP 可达性。
      if (deps.readAsset !== undefined) {
        let accountId = ''
        let role: RoleName = 'read-only'
        try {
          const reader = await deps.readerOf?.(req)
          if (reader !== undefined) {
            accountId = reader.accountId
            role = reader.role
          }
        } catch { /* 按匿名处理 */ }
        let asset: { body: Uint8Array, contentType: string } | undefined
        try {
          const rawUrl = req.url ?? '/'
          const queryAt = rawUrl.indexOf('?')
          const query = queryAt >= 0 ? rawUrl.slice(queryAt) : ''
          asset = await deps.readAsset(pathname.slice(1) + query, accountId, role)
        } catch {
          asset = undefined
        }
        if (asset !== undefined) {
          res.writeHead(200, {
            'content-type': asset.contentType,
            // 带 rev 的资源不可变，可以长缓存（与官方一致）。
            'cache-control': IMMUTABLE_CACHE_CONTROL,
            'content-length': String(asset.body.length),
          })
          res.end(Buffer.from(asset.body))
          return true
        }
      }
      return await serveAsset(req, res)
    }

    // 其余路径（含 `/remote/*`、`/api/*`、`/remote-auth/*`）不是本模块的。
    return false
  }

  return { handle }
}

/**
 * 审计用的「安全路径」：去掉 query 原文（query 里可能夹带一次性票据）。
 *
 * @param url - `req.url`。
 * @returns 只含 pathname 的短字符串。
 */
function safePath(url: string | undefined): string {
  if (url === undefined) return '/'
  try {
    return new URL(url, 'http://127.0.0.1').pathname.slice(0, 200)
  } catch {
    return '<unparsable>'
  }
}
