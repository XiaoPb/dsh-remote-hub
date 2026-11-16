/**
 * 浏览器登录页与 **HttpOnly Cookie** 会话（守卫 origin 上的两步登录）。
 *
 * ## 为什么是 Cookie 而不是 `localStorage`
 *
 * 会话令牌如果放进 `localStorage` / `sessionStorage`，同源的**任何**一段 JS
 * （第三方脚本、注入的插件脚本、装饰器、XSS 载荷）都能 `getItem` 把它读走，
 * 再用 fetch 带到任意地方——它本质上是「明文凭据驻留在脚本可达的存储里」。
 * 换成 `HttpOnly` Cookie 之后，`document.cookie` 读不到会话值，XSS 只能
 * **借用**当前页面发起请求，无法把凭据**带走**到本机之外；再叠加
 * `SameSite=Strict`（跨站请求根本不带这份 Cookie）与 `Path=/`，会话的作用域
 * 就被收窄成「这个 origin 上的这些请求」。
 *
 * ## 不变量（改动前先读）
 *
 * - 令牌**绝不**出现在 HTML 里：`renderLoginPage()` 是纯静态函数，参数里没有
 *   令牌，页面源码任何位置（内联 CSS / 内联 JS / 注释）都不含令牌。
 * - `mfaToken` 只在两条通道里流动：本次 `POST` 的**响应体**，以及登录页与宿主
 *   页面之间的 `postMessage`（`WEB_LOGIN_CHANNEL`，定向到 `location.origin`）。
 *   它不进 HTML、不进 URL、不进存储。
 * - 口令、动态码、令牌原文**绝不**进入日志或错误消息：`message` 一律是本模块
 *   写死的中文文案，服务端 `reason` 只在进程内可读的 `reason` 字段里（守卫不得
 *   把它写进响应或日志）。
 * - 未绑定 TOTP 的账号**直接拒绝**（`auth-totp-required`），绝不因为「这一轮不用
 *   动态码」就随手发一个弱会话 Cookie；也不允许改由第二步来完成绑定（绑定只能在
 *   已登录会话上做，见 `service.startTotpSetup`）。
 *
 * @module dsh-remote-hub/host/auth/web-session
 */
import type { IncomingMessage } from 'node:http'

import type { AuthErrorCode } from '@core/auth.js'

import type { AuthService } from './service.js'

/**
 * 认证面错误码的**镜像**（运行期使用）。
 *
 * 为什么不 import `AUTH_ERROR_CODES`：本模块是唯一「可以被 Node 直接加载来做
 * 行为测试」的纯逻辑单元（见 `test/web-session.test.mjs` 直接加载 emit 后的
 * `.build/host/host/src/auth/web-session.js`），而 `@core/auth.js` 别名只在
 * 打包期解析。错误码字符串是**部署间的线上契约**，改动必须与
 * `core/src/auth.ts` 的 `AUTH_ERROR_CODES` 同步；测试会逐条比对两边一致。
 */
export const ERROR_CODES = Object.freeze({
  unauthorized: 'auth-unauthorized',
  forbidden: 'auth-forbidden',
  badRequest: 'auth-bad-request',
  bootstrapRequired: 'auth-bootstrap-required',
  invalidCredentials: 'auth-invalid-credentials',
  mfaRequired: 'auth-mfa-required',
  mfaInvalid: 'auth-mfa-invalid',
  mfaExpired: 'auth-mfa-expired',
  rateLimited: 'auth-rate-limited',
  passwordChangeRequired: 'auth-password-change-required',
  totpRequired: 'auth-totp-required',
  unavailable: 'auth-unavailable',
  internal: 'auth-internal',
  accountDisabled: 'auth-account-disabled',
})

/**
 * 浏览器会话 Cookie 名（与 `core/src/auth.ts` 的 `SESSION_COOKIE` 同值）。
 *
 * `HttpOnly` 的会话值放在这里；它**不是** `dsh-auth`（DSH 核心自己的 Cookie）。
 */
export const SESSION_COOKIE = 'dsh_hub_session'

/** 登录页上第二步的缺省端点（与 `core/src/auth.ts` 的 `MFA_ENDPOINT` 同值）。 */
export const MFA_ENDPOINT = '/remote-web/mfa'

/** 登录页与宿主页面之间的 `postMessage` 通道名（与 `core/src/auth.ts` 的 `WEB_LOGIN_CHANNEL` 同值）。 */
export const WEB_LOGIN_CHANNEL = 'dsh-remote-hub/web-login'

/**
 * 登录页各控件的 `data-testid`（与 `core/src/auth.ts` 的 `TEST_IDS` 同值）。
 *
 * 这里是**唯一**的插值来源：渲染时只用这些常量，绝不把调用方字符串拼进属性，
 * 因此 `data-testid` 与渠道名永远不会被注入改变。
 */
export const TEST_IDS = Object.freeze({
  username: 'web-login-username',
  password: 'web-login-password',
  submit: 'web-login-submit',
  mfaCode: 'web-mfa-code',
  mfaSubmit: 'web-mfa-submit',
  error: 'web-login-error',
})

/**
 * 会话 Cookie 令牌的最小合法形状：`<sid>.<secret>`。
 *
 * 与 `service.ts` 里 `parseSessionToken` 的判据保持一致，但**不在**这里做校验的
 * 最终裁决——认识这个形状只是为了区分「带了一个像会话的 Cookie」与「带了一个
 * 垃圾值」：前者交给服务端判定真伪（失败即 `auth-unauthorized`），后者直接忽略，
 * 免得一个畸形 Cookie 把用户困在登录页。
 */
const SESSION_TOKEN_PATTERN = /^sid_[0-9a-f]{24}\.[A-Za-z0-9_-]{16,128}$/u

/** 守卫 origin 上登录失败时的进程内细节（**不得**回给浏览器或写进日志）。 */
export interface WebLoginFailureDetails {
  /** 服务端原始原因（英文、未脱敏），仅供宿主进程内排查。 */
  reason: string
}

/**
 * 登录失败的返回形状。
 *
 * `message` 是可直接展示给终端用户的中文文案（已脱敏）；`reason` 非可枚举，
 * 打印/序列化时不会出现，避免把服务端原文（虽然不含口令）顺手写进日志。
 */
export interface WebLoginFailure {
  ok: false
  code: AuthErrorCode
  message: string
  reason?: string
}

/** `handleLogin` 的返回：成功时要么直接完成，要么给出 `mfaToken`。 */
export type WebLoginOutcome =
  | { ok: true; mfaRequired: false }
  | { ok: true; mfaRequired: true; mfaToken: string; expiresAt: number }
  | WebLoginFailure

/** 第二步失败（同上：`message` 可展示，`reason` 仅进程内）。 */
export type WebMfaOutcome =
  | { ok: true; setCookie: string }
  | WebLoginFailure

/** 登录页的最小方言：只依赖 `self` / `parent` / `document`。 */
export interface WebLoginPageOptions {
  /**
   * 相对守卫 origin 的第二步端点（缺省 `MFA_ENDPOINT`）。
   *
   * 页面**从不**自己拼绝对 URL，因此部署在子路径 / 反代前缀下也能用。
   */
  mfaEndpoint?: string
  /** 同页 `postMessage` 的通道名（缺省 `WEB_LOGIN_CHANNEL`）。 */
  channel?: string
}

/** `createWebSession` 的依赖。 */
export interface WebSessionDeps {
  /** 认证服务（**只调用**，不修改其行为）。 */
  service: AuthService
  /** 会话 Cookie 的 `Max-Age`（毫秒；内部按秒向下取整，最小 1 秒）。 */
  sessionTtlMs: number
  /**
   * 守卫自己的 origin（`https://host:port` 或 `http://host:port`）。
   *
   * 只用来决定 `Secure`：`https:` 开头才加。注意 `Secure` 一旦泄漏到纯 HTTP
   * 部署上，浏览器会**静默丢弃**这条 Cookie——登录「成功」但永远没登录上。
   */
  guardOrigin: string
}

/** `createWebSession` 的对外面。 */
export interface WebSession {
  /** 渲染登录页 HTML（纯静态、无令牌）。 */
  renderLoginPage(options?: WebLoginPageOptions): string
  /** 口令步骤。 */
  handleLogin(username: string, password: string): Promise<WebLoginOutcome>
  /** 第二步（TOTP / 备用码），成功返回完整 `Set-Cookie`。 */
  handleMfa(mfaToken: string, code: string): Promise<WebMfaOutcome>
  /**
   * 从入站请求里取会话令牌。
   * @returns 令牌；没有合法形状的 Cookie 时为 undefined（**不**抛错）。
   */
  readCookie(request: IncomingMessage | { headers?: Record<string, unknown> }): string | undefined
  /** 这个部署是否给 Cookie 加 `Secure`。 */
  secureCookie(): boolean
  /** 构造 `Set-Cookie`（`handleMfa` 已用它；守卫也可用它写同一形状的 Cookie）。 */
  buildSetCookie(sessionToken: string): string
  /** 构造清除 Cookie 的 `Set-Cookie`（登出；`Max-Age=0`）。 */
  buildClearCookie(): string
}

/**
 * 解析 `Cookie` 请求头。
 *
 * 容忍浏览器与中间件的各种脏输入，**任何**输入都不抛错：
 * - 多 Cookie：`a=1; b=2`（`;` 后带不带空格都行）；
 * - 空值：`a=` 解析成空串，调用方按「没有」处理；
 * - 无 `=` 的片段（`flag`）直接忽略；
 * - 同名重复：**先出现的赢**（浏览器按 `Path` 由长到短排列，先出现的更具体）；
 * - 引号包裹的值：去掉一对首尾双引号；空名 / 空键的片段丢弃。
 *
 * @param header - `Cookie` 头的原始值（可能是 `string[]`，也可能缺失）。
 * @returns 名称 → 值（永不带原型，避免 `__proto__` 之类的键污染对象）。
 */
export function parseCookieHeader(header: string | readonly string[] | undefined | null): Record<string, string> {
  const cookies: Record<string, string> = Object.create(null) as Record<string, string>
  if (header === undefined || header === null) return cookies
  const text = Array.isArray(header) ? header.join('; ') : typeof header === 'string' ? header : ''
  if (text === '') return cookies
  for (const part of text.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    if (name === '') continue
    if (Object.prototype.hasOwnProperty.call(cookies, name)) continue
    let value = part.slice(index + 1).trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    cookies[name] = value
  }
  return cookies
}

/**
 * 只取会话 Cookie 的值（先出现的那一条）。
 * @param header - `Cookie` 头的原始值。
 * @param name - Cookie 名（缺省 `SESSION_COOKIE`）。
 * @returns 令牌；缺失或为空串时为 undefined。
 */
export function readSessionCookie(
  header: string | readonly string[] | undefined | null,
  name: string = SESSION_COOKIE,
): string | undefined {
  const value = parseCookieHeader(header)[name]
  return value === undefined || value === '' ? undefined : value
}

/** 是否形如会话令牌（形状判据，**不是**真伪判据）。 */
function looksLikeSessionToken(value: string | undefined): value is string {
  return typeof value === 'string' && SESSION_TOKEN_PATTERN.test(value)
}

/** 把毫秒 TTL 换成 Cookie 的 `Max-Age` 秒（向下取整，至少 1 秒）。 */
function maxAgeSeconds(ttlMs: number): number {
  const ms = typeof ttlMs === 'number' && Number.isFinite(ttlMs) ? Math.floor(ttlMs) : 0
  return Math.max(1, Math.floor(ms / 1000))
}

/** origin 是否用了 https（决定 `Secure`）。 */
function isSecureOrigin(origin: string): boolean {
  if (typeof origin !== 'string') return false
  return origin.trim().toLowerCase().startsWith('https:')
}

/**
 * 错误码 → 可展示的中文文案。
 *
 * 这里**刻意**不区分「账号不存在」与「口令错误」（都走 `invalidCredentials`），
 * 也不回显服务端原文：文案只说明「怎么办」，不透露「哪里错」。
 * @param code - 认证错误码。
 * @returns 中文提示（不含任何凭据）。
 */
function messageForCode(code: AuthErrorCode): string {
  switch (code) {
    case ERROR_CODES.invalidCredentials:
      return '用户名或口令不正确。'
    case ERROR_CODES.rateLimited:
      return '失败次数过多，请稍后再试。'
    case ERROR_CODES.mfaInvalid:
      return '动态码或备用码不正确。'
    case ERROR_CODES.mfaExpired:
      return '验证已过期，请重新输入用户名与口令。'
    case ERROR_CODES.totpRequired:
      return '该账号尚未绑定两步验证：请先在本机完成绑定后再从浏览器登录。'
    case ERROR_CODES.forbidden:
      return '该账号当前不可登录。'
    case ERROR_CODES.accountDisabled:
      return '该账号已被停用。'
    case ERROR_CODES.bootstrapRequired:
      return '尚未创建管理员账号：请先在本机完成初始化。'
    case ERROR_CODES.badRequest:
      return '请求格式不正确。'
    case ERROR_CODES.unauthorized:
      return '会话已失效，请重新登录。'
    case ERROR_CODES.unavailable:
      return '认证服务暂时不可用，请稍后再试。'
    default:
      return '登录失败，请稍后重试。'
  }
}

/**
 * 构造失败结果。
 *
 * `reason` 用不可枚举属性挂上去：`JSON.stringify` / `console.log` 都看不到它，
 * 守卫必须显式读取（也**只**该在进程内读取）。
 * @param code - 认证错误码。
 * @param reason - 服务端原始原因（可为空串）。
 * @param message - 覆盖默认中文文案（用于「尚未绑定 2FA」这类需要更精确的场合）。
 * @returns 失败结果。
 */
function fail(code: AuthErrorCode, reason = '', message = messageForCode(code)): WebLoginFailure {
  const result: WebLoginFailure = { ok: false, code, message }
  Object.defineProperty(result, 'reason', {
    value: reason,
    enumerable: false,
    writable: false,
    configurable: true,
  })
  return result
}

/**
 * 判断一个账号是否需要先绑定两步验证。
 *
 * 用 `service.status(sessionToken)` 读**已认证视图**：它的 `totpEnrollmentRequired`
 * 只有在「拿到了有效会话 + 该账号是管理员 + `requireMfa` + 尚未确认绑定」时才为
 * true。这不依赖新建的出站会话，因此也覆盖「默认管理员首次登录、库里还没落 TOTP」
 * 这种本应被拒但 `login()` 仍会发出会话的情况（见 `createWebSession` 的说明）。
 * @param service - 认证服务。
 * @param sessionToken - 刚由登录得到的会话令牌（**只在内存里**，不写 Cookie）。
 * @returns 需要先绑定 TOTP 则为 true。
 */
async function needsTotpEnrollment(service: AuthService, sessionToken: string): Promise<boolean> {
  try {
    const status = await service.status(sessionToken)
    // 会话没被认出来（令牌形状不对等）时不能断定「需要绑定」——交给调用方按成功处理。
    if (status.session === null) return false
    return status.totpEnrollmentRequired === true
  } catch {
    // 读状态失败不改变登录结论：宁可放行一个已绑定 MFA 的账号，也不把人也锁在门外。
    return false
  }
}

/**
 * 渲染登录页的内联脚本。
 *
 * 全部逻辑只做「填表 → POST → 显示错误 / 显示动态码 → 再 POST」，不发任何第三方
 * 请求；`textContent` + `hidden` 属性做界面切换，避免注入面。
 * @param mfaEndpoint - 第二步端点（相对路径）。
 * @param channel - `postMessage` 通道名。
 * @returns 内联 `<script>` 片段。
 */
function loginScript(mfaEndpoint: string, channel: string): string {
  const ids = TEST_IDS
  return `<script>
(function () {
  'use strict'
  var IDS = { username: '${ids.username}', password: '${ids.password}', submit: '${ids.submit}', mfaCode: '${ids.mfaCode}', mfaSubmit: '${ids.mfaSubmit}', error: '${ids.error}' }
  var MFA_ENDPOINT = '${mfaEndpoint}'
  var CHANNEL = '${channel}'
  var mfaToken = ''
  var mfaForm = document.querySelector('[data-step="mfa"]')
  var loginForm = document.querySelector('[data-step="login"]')
  var hint = document.querySelector('[data-step="hint"]')

  function byTestId(name) {
    return document.querySelector('[data-testid="' + name + '"]')
  }
  function setError(text) {
    var box = byTestId(IDS.error)
    if (box === null) return
    box.textContent = text
    box.hidden = text === ''
  }
  function notify(type, extra) {
    var payload = { channel: CHANNEL, type: type }
    if (extra) { for (var key in extra) { if (Object.prototype.hasOwnProperty.call(extra, key)) payload[key] = extra[key] } }
    try {
      if (window.parent && window.parent !== window) window.parent.postMessage(payload, location.origin)
    } catch (error) { /* 被嵌入方拒绝也是正常情况：页面自己照样能走完流程 */ }
  }
  function submit(url, body) {
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (response) {
      return response.json().then(function (data) { return { status: response.status, data: data } })
    }).catch(function () {
      return { status: 0, data: null }
    })
  }
  function failureOf(result) {
    var data = result.data
    if (data && typeof data.message === 'string' && data.message !== '') return data.message
    return '网络或服务暂时不可用，请稍后重试。'
  }

  // 登录成功后离开登录页。只接受同源相对路径（以单个 / 开头且不以 // 开头），
  // 任何绝对 URL 都退回 "/"——否则 ?next= 会变成开放重定向。
  function afterLogin() {
    var next = ''
    try {
      next = new URL(location.href).searchParams.get('next') || ''
    } catch (error) {
      next = ''
    }
    var safe = /^\/(?![\/\\])/.test(next) ? next : '/'
    location.replace(safe)
  }

  loginForm.addEventListener('submit', function (event) {
    event.preventDefault()
    setError('')
    var username = byTestId(IDS.username).value
    var password = byTestId(IDS.password).value
    byTestId(IDS.submit).disabled = true
    submit(location.pathname, { username: username, password: password }).then(function (result) {
      byTestId(IDS.submit).disabled = false
      var data = result.data
      if (data && data.ok === true && data.mfaRequired === true && typeof data.mfaToken === 'string') {
        mfaToken = data.mfaToken
        loginForm.hidden = true
        mfaForm.hidden = false
        hint.hidden = false
        byTestId(IDS.password).value = ''
        byTestId(IDS.mfaCode).focus()
        notify('challenge', { mfaToken: mfaToken, expiresAt: data.expiresAt })
        return
      }
      if (data && data.ok === true) {
        loginForm.hidden = true
        hint.hidden = false
        hint.textContent = '已登录。'
        notify('complete')
        afterLogin()
        return
      }
      setError(failureOf(result))
      notify('error', { code: (data && data.code) || '', message: failureOf(result) })
    })
  })

  mfaForm.addEventListener('submit', function (event) {
    event.preventDefault()
    setError('')
    var code = byTestId(IDS.mfaCode).value.trim()
    byTestId(IDS.mfaSubmit).disabled = true
    submit(MFA_ENDPOINT, { mfaToken: mfaToken, code: code }).then(function (result) {
      byTestId(IDS.mfaSubmit).disabled = false
      var data = result.data
      byTestId(IDS.mfaCode).value = ''
      if (data && data.ok === true) {
        mfaToken = ''
        mfaForm.hidden = true
        hint.hidden = false
        hint.textContent = '验证通过，已登录。'
        notify('complete')
        afterLogin()
        return
      }
      setError(failureOf(result))
      notify('error', { code: (data && data.code) || '', message: failureOf(result) })
    })
  })
})()
</script>`
}

/**
 * 把步骤端点收敛成「只有一个前导斜杠的相对路径」。
 *
 * 端点会被**拼进内联脚本**，因此必须先排除 `'`、`"`、`\`、`<`、`>` 与空白：
 * 任何插值都只能是安全字符，绝不靠转义来兜底。非法输入退回缺省路径。
 * @param value - 调用方给的端点。
 * @returns 安全的相对路径。
 */
function safeRelativePath(value: unknown): string {
  if (typeof value !== 'string') return MFA_ENDPOINT
  const trimmed = value.trim()
  if (!/^\/(?!\/)[A-Za-z0-9/_.-]*$/u.test(trimmed)) return MFA_ENDPOINT
  return trimmed
}

/**
 * 把通道名收敛成安全标识符。
 * @param value - 调用方给的通道名。
 * @returns 安全通道名。
 */
function safeChannel(value: unknown): string {
  if (typeof value !== 'string') return WEB_LOGIN_CHANNEL
  const trimmed = value.trim()
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(trimmed)) return WEB_LOGIN_CHANNEL
  return trimmed
}

/** 登录页的内联样式（不引用任何外部资源、字体或图片）。 */
const LOGIN_PAGE_STYLE = `:root {
  color-scheme: light dark;
  --bg: #f6f7f9;
  --card: #ffffff;
  --fg: #1b1d22;
  --muted: #5f6673;
  --line: #d8dce4;
  --accent: #2f6feb;
  --danger: #b42318;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #14161a; --card: #1d2026; --fg: #e8eaee; --muted: #9aa2b0; --line: #333944; --danger: #ff8a80; }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg);
  color: var(--fg);
  font: 15px/1.6 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  padding: 24px;
}
main {
  width: 100%;
  max-width: 360px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 24px;
}
h1 { margin: 0 0 4px; font-size: 18px; }
p.sub { margin: 0 0 20px; color: var(--muted); font-size: 13px; }
label { display: block; margin-bottom: 6px; font-size: 13px; color: var(--muted); }
input {
  width: 100%;
  padding: 9px 11px;
  margin-bottom: 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
}
input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
button {
  width: 100%;
  padding: 10px 12px;
  border: 0;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font: inherit;
  cursor: pointer;
}
button:disabled { opacity: .6; cursor: progress; }
[data-testid="web-login-error"] {
  margin: 0 0 14px;
  color: var(--danger);
  font-size: 13px;
  min-height: 1.2em;
}
[data-step="hint"] { margin: 12px 0 0; color: var(--muted); font-size: 13px; }
[hidden] { display: none !important; }`

/**
 * 创建浏览器登录页 + HttpOnly Cookie 会话。
 *
 * ## 与 `service.login()` 的关系（为什么不直接转发服务端结果）
 *
 * `service.login()` 在账号**未绑定 TOTP** 时返回 `mfaRequired: false` **并直接签发
 * 一个会话 Cookie**（见 `service.ts` 的 `totpVerified` 分支）。对浏览器登录面这不
 * 可接受：本模块的契约是「口令对但没绑两步验证 → 明确拒绝，不发 Cookie」。因此
 * 这里在拿到会话后额外读一次 `service.status(token)`：
 * - `totpEnrollmentRequired === true` → 立刻 `service.logout(token)` 撤销刚签发的
 *   会话（令牌只在内存里，从未写进 Cookie / HTML），返回 `auth-totp-required`；
 * - 否则**丢弃**服务端附带的 cookie，只返回 `mfaToken`，会话真正签发推到
 *   `handleMfa()`——这样 `Set-Cookie` 只从本模块的 `buildSetCookie()` 出来，
 *   `HttpOnly` / `SameSite=Strict` / `Secure` 只有一个来源。
 *
 * `service.login()` 不会在未绑定 TOTP 时返回 `mfaToken`（它认为「不需要第二步」），
 * 所以浏览器侧**不能**把动态码步骤拿去完成首次绑定；绑定必须在已登录的管理面上
 * 做（`service.startTotpSetup` / `confirmTotp`）。
 *
 * @param deps - 认证服务、会话有效期与守卫 origin。
 * @returns `WebSession`（方法见各方法 JSDoc）。
 */
export function createWebSession(deps: WebSessionDeps): WebSession {
  const { service } = deps
  const ttlMs = typeof deps.sessionTtlMs === 'number' && Number.isFinite(deps.sessionTtlMs) && deps.sessionTtlMs > 0
    ? deps.sessionTtlMs
    : 0
  const secure = isSecureOrigin(deps.guardOrigin)
  const maxAge = maxAgeSeconds(ttlMs)

  /**
   * 构造会话 Cookie。
   *
   * 属性一个都不能少：`HttpOnly`（JS 读不到）、`SameSite=Strict`（跨站不带）、
   * `Path=/`（全站有效）、`Max-Age`（与服务端 `expiresAt` 同一口径），
   * 以及 https 部署上的 `Secure`。
   * @param sessionToken - `<sid>.<secret>` 明文。
   * @returns 完整的一行 `Set-Cookie` 值。
   */
  function buildSetCookie(sessionToken: string): string {
    return [
      `${SESSION_COOKIE}=${sessionToken}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${maxAge}`,
      ...(secure ? ['Secure'] : []),
    ].join('; ')
  }

  /**
   * 构造清除会话 Cookie（登出）。
   * @returns 完整的一行 `Set-Cookie` 值（`Max-Age=0`）。
   */
  function buildClearCookie(): string {
    return [
      `${SESSION_COOKIE}=`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      'Max-Age=0',
      ...(secure ? ['Secure'] : []),
    ].join('; ')
  }

  return {
    renderLoginPage(options: WebLoginPageOptions = {}): string {
      const mfaEndpoint = safeRelativePath(options.mfaEndpoint)
      const channel = safeChannel(options.channel)
      const ids = TEST_IDS
      return [
        '<!DOCTYPE html>',
        '<html lang="zh-CN">',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<meta name="robots" content="noindex, nofollow">',
        '<title>远程访问登录</title>',
        `<style>${LOGIN_PAGE_STYLE}</style>`,
        '</head>',
        '<body>',
        '<main>',
        '<h1>远程访问登录</h1>',
        '<p class="sub">用本机 DSH 的账号登录。若该账号已启用两步验证，下一步会要求动态码。</p>',
        `<form data-step="login" method="post" action="" autocomplete="on" novalidate>`,
        `<label for="username">用户名</label>`,
        `<input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required data-testid="${ids.username}">`,
        `<label for="password">口令</label>`,
        `<input id="password" name="password" type="password" autocomplete="current-password" required data-testid="${ids.password}">`,
        `<button type="submit" data-testid="${ids.submit}">登录</button>`,
        '</form>',
        '<form data-step="mfa" method="post" action="" novalidate hidden>',
        `<label for="mfa-code">动态码（或备用码）</label>`,
        `<input id="mfa-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="16" data-testid="${ids.mfaCode}">`,
        `<button type="submit" data-testid="${ids.mfaSubmit}">验证</button>`,
        '</form>',
        `<p data-testid="${ids.error}" role="alert" aria-live="assertive" hidden></p>`,
        '<p data-step="hint" hidden></p>',
        '</main>',
        loginScript(mfaEndpoint, channel),
        '</body>',
        '</html>',
      ].join('\n')
    },

    async handleLogin(username: string, password: string): Promise<WebLoginOutcome> {
      let result: Awaited<ReturnType<AuthService['login']>>
      try {
        result = await service.login({
          username: String(username ?? ''),
          password: String(password ?? ''),
        })
      } catch (error) {
        // 异常只会是「服务内部故障」；原始消息留在 reason 里，绝不进响应。
        return fail(ERROR_CODES.internal, error instanceof Error ? error.message : 'login failed')
      }
      if (!result.ok) return fail(result.code, result.reason)

      if (result.response.mfaRequired) {
        // 已绑定 TOTP：服务端只给一次性挑战，会话要等第二步才签发。
        return {
          ok: true,
          mfaRequired: true,
          mfaToken: result.response.mfaToken,
          expiresAt: result.response.expiresAt,
        }
      }

      // 走到这里说明服务端认为「不需要第二步」——可能是账号根本**没绑定** TOTP。
      // 服务端已顺带签发了一个会话：先看它是哪种情况，再决定撤销还是丢弃。
      const issued = result.cookie
      if (issued === undefined) {
        // 没有会话也没有挑战：登录面无法安全推进，按未授权处理（不发 Cookie）。
        return fail(ERROR_CODES.unauthorized, 'login issued no session and no challenge')
      }
      if (await needsTotpEnrollment(service, issued)) {
        // 未绑定 TOTP：撤销刚签发的会话，拒绝浏览器登录，一格 Cookie 都不发。
        await service.logout(issued).catch(() => { /* 撤销失败也不能签出会话 */ })
        return fail(ERROR_CODES.totpRequired, 'totp enrollment required before web sign-in')
      }
      // 已经绑定（只是本次不需要第二步，例如部署关闭了 requireMfa）：同样丢弃
      // 服务端直接给的 cookie，由第二步端点统一签发，Cookie 形状只有一个来源。
      return fail(ERROR_CODES.mfaRequired, 'second factor required to issue the session cookie')
    },

    async handleMfa(mfaToken: string, code: string): Promise<WebMfaOutcome> {
      const token = String(mfaToken ?? '').trim()
      const value = String(code ?? '').trim()
      if (token === '' || value === '') {
        return fail(ERROR_CODES.badRequest, 'missing mfaToken or code', '请填写动态码。')
      }
      let issued: Awaited<ReturnType<AuthService['verifyMfa']>>
      try {
        issued = await service.verifyMfa({ mfaToken: token, code: value })
      } catch (error) {
        return fail(ERROR_CODES.internal, error instanceof Error ? error.message : 'mfa failed')
      }
      if ('error' in issued) return fail(issued.error, issued.reason)
      // 只有这里会产出 `Set-Cookie`：`issued.cookie` 是服务端会话令牌，
      // 立刻换成一整行属性齐全的 Set-Cookie，绝不再往外传原文。
      const setCookie = buildSetCookie(issued.cookie)
      return { ok: true, setCookie }
    },

    readCookie(request: IncomingMessage | { headers?: Record<string, unknown> }): string | undefined {
      const headers = request?.headers
      if (headers === undefined || headers === null) return undefined
      const raw = (headers as Record<string, unknown>).cookie ?? (headers as Record<string, unknown>).Cookie
      const token = readSessionCookie(
        typeof raw === 'string'
          ? raw
          : Array.isArray(raw)
            ? raw.filter((part): part is string => typeof part === 'string')
            : undefined,
      )
      // 形状不对的 Cookie 当作「没带会话」：否则一个陈旧/畸形的值会把用户锁在
      // 「会话已被拒绝」的循环里，而它本来就不可能通过服务端校验。
      return looksLikeSessionToken(token) ? token : undefined
    },

    secureCookie(): boolean {
      return secure
    },

    buildSetCookie,

    buildClearCookie,
  }
}
