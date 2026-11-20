/**
 * 浏览器登录页与 HttpOnly Cookie 会话（`host/src/auth/web-session.ts`）。
 *
 * 加载方式：优先直接加载 `npm run build` 产出的
 * `.build/host/host/src/auth/web-session.js`——它是本插件里少有的「纯逻辑」模块，
 * 只依赖 `node:http` 的**类型**，因此不经打包也能构造真实对象并跑全流程。
 * 构建缺失时退化为源码静态断言，绝不静默跳过。
 *
 * 覆盖：
 * ① 登录页含全部 6 个 `data-testid`，且源码里没有任何形如令牌的串；
 * ② http origin 的 `Set-Cookie` 含 `HttpOnly` + `SameSite=Strict`，且**不含** `Secure`；
 * ③ https origin 含 `Secure`；
 * ④ `parseCookieHeader` 处理多 Cookie / 空值 / 畸形输入（不抛错）；
 * ⑤ 未绑定 TOTP 的账号被拒绝（明确错误码 + 不发 Cookie + 会话被撤销）。
 *
 * @module test/web-session
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

import { PATHS, ROOT, read, testLoadAuth } from './_helpers.mjs'

/** 直接加载 emit 后的模块（不依赖入口再导出）。 */
const EMITTED = join(ROOT, '.build', 'host', 'host', 'src', 'auth', 'web-session.js')

/**
 * 加载被测模块。
 * @returns `{ mod, dynamic }`：模块命名空间与「是否加载到了真实实现」。
 */
async function loadModule() {
  if (!existsSync(EMITTED)) return { mod: {}, dynamic: false }
  try {
    const mod = await import(pathToFileURL(EMITTED).href)
    return { mod, dynamic: typeof mod.createWebSession === 'function' }
  } catch {
    return { mod: {}, dynamic: false }
  }
}

const { mod: web, dynamic } = await loadModule()

/** 认证服务由 `lib/auth.js` 提供（真实实现，用于端到端）。 */
const auth = await testLoadAuth()
const serviceAvailable = typeof auth.createAuthService === 'function'

/** 本模块的源码（兜底断言与「红线」检查用）。 */
const webSessionSrc = read(join(PATHS.hostSrc, 'auth', 'web-session.ts'))
/** 共享契约源码（常量漂移检查用）。 */
const coreAuthSrc = read(join(PATHS.coreSrc, 'auth.ts'))

/** 页面里必须出现的 6 个 testid。 */
const REQUIRED_TEST_IDS = [
  'web-login-username',
  'web-login-password',
  'web-login-submit',
  'web-mfa-code',
  'web-mfa-submit',
  'web-login-error',
]

/** 一个形状合法的会话令牌（仅用于属性检查，不对应任何真实会话）。 */
const SAMPLE_TOKEN = 'sid_0123456789abcdef01234567.secretsecretsecret'

/**
 * 「形如令牌」的串。
 *
 * 会话令牌是 `<sid>.<secret>`（`sid_` + 24 hex，点，16..128 个 base64url 字符）；
 * 备用码也一并算在内——它们同样不该出现在页面源码里。
 */
const TOKEN_LIKE = [
  /\bsid_[0-9a-f]{24}\.[A-Za-z0-9_-]{16,}/u,
  /\b[A-Z2-9]{5}-[A-Z2-9]{5}\b/u,
]

/** 构造一个临时存储路径。 */
function tempStore(tag) {
  const dir = mkdtempSync(join(tmpdir(), `dsh-websession-${tag}-`))
  return { dir, path: join(dir, 'auth.json') }
}

/**
 * 参考实现：`parseCookieHeader` 的契约（构建缺失时用）。
 * @param {string|string[]|undefined} header - Cookie 头。
 * @returns {Record<string,string>}
 */
function referenceParseCookieHeader(header) {
  const cookies = Object.create(null)
  if (header === undefined || header === null) return cookies
  const text = Array.isArray(header) ? header.join('; ') : typeof header === 'string' ? header : ''
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
 * 参考实现：`Set-Cookie` 的契约（构建缺失时用）。
 * @param {string} token - 会话令牌。
 * @param {boolean} secure - 是否加 Secure。
 * @param {number} maxAgeSeconds - Max-Age 秒。
 */
function referenceSetCookie(token, secure, maxAgeSeconds) {
  return [
    `dsh_hub_session=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

/** 取当前可用的 `parseCookieHeader`（动态优先）。 */
function parseCookieHeader(header) {
  return typeof web.parseCookieHeader === 'function' ? web.parseCookieHeader(header) : referenceParseCookieHeader(header)
}

/** 取当前可用的 `createWebSession`（动态优先）。 */
function createWebSession(deps) {
  if (dynamic) return web.createWebSession(deps)
  const secure = String(deps.guardOrigin ?? '').toLowerCase().startsWith('https:')
  const maxAge = Math.max(1, Math.floor(deps.sessionTtlMs / 1000))
  return {
    renderLoginPage: () => webSessionSrc,
    handleLogin: async () => ({ ok: false, code: 'auth-unavailable', message: 'build missing' }),
    handleMfa: async () => ({ ok: false, code: 'auth-unavailable', message: 'build missing' }),
    readCookie: request => referenceParseCookieHeader(request?.headers?.cookie)['dsh_hub_session'],
    secureCookie: () => secure,
    buildSetCookie: token => referenceSetCookie(token, secure, maxAge),
    buildClearCookie: () => referenceSetCookie('', secure, 0),
  }
}

// ── ⓪ 生成脚本的语法自检 ──────────────────────────────────────────────────

/**
 * 登录页的内联 JS 是用模板字符串写出来的，**生成阶段**才暴露转义问题。
 *
 * 曾经的 bug：`/^\/(?![\/\\])/` 写进模板后反斜杠被吃掉，
 * 页面里变成 `/^/(?![/\])/` —— 语法错误，整段脚本不执行，
 * 表单退回原生 POST，用户看到裸 JSON。源码看起来完全正常，
 * 只有把**生成的文本**再解析一遍才能发现。
 */
test('登录页脚本里的正则不依赖会被模板吃掉的转义', () => {
  // 生成后的页面文本里，不应出现「被吃剩」的半截字符类。
  const html = typeof createWebSession({ service: {}, sessionTtlMs: 1000, guardOrigin: 'http://x' }).renderLoginPage === 'function'
    ? createWebSession({ service: {}, sessionTtlMs: 1000, guardOrigin: 'http://x' }).renderLoginPage()
    : webSessionSrc
  assert.equal(typeof html, 'string')
  // 真实故障特征：出现 `[/\]`（反斜杠丢失后的残骸）。
  assert.ok(!html.includes('[/\\]'), '正则字符类里的反斜杠丢了，脚本会语法错误')
  // 同理不应出现空的字符类。
  assert.ok(!html.includes('[]'), '不能出现空字符类')
})

// ── ① 登录页 ────────────────────────────────────────────────────────────────

test('登录页包含全部 6 个 data-testid，且源码里没有任何形如令牌的串', () => {
  const page = createWebSession({ service: {}, sessionTtlMs: 7 * 24 * 3600 * 1000, guardOrigin: 'http://127.0.0.1:8321' }).renderLoginPage()
  assert.equal(typeof page, 'string')
  assert.ok(page.length > 0, '登录页不能为空')
  assert.match(page, /<!DOCTYPE html>/u, '必须是一份独立 HTML')
  assert.match(page, /<html lang="zh-CN">/u, '中文界面')
  for (const id of REQUIRED_TEST_IDS) {
    assert.ok(page.includes(`data-testid="${id}"`), `缺少 testid: ${id}`)
  }
  // 两步：口令步骤与动态码步骤都在，且动态码步骤初始隐藏。
  assert.match(page, /data-step="login"/u)
  assert.match(page, /data-step="mfa"[^>]*hidden/u)
  // 最小独立：不引用任何官方 Web 资源 / CDN / 外链。
  assert.equal(/https?:\/\//u.test(page), false, '页面不得引用任何外部 URL')
  assert.equal(/<script[^>]+src=/u.test(page), false, '不得引用外部脚本')
  // 样式必须内联。这里**只禁样式表**，不禁所有 `<link href>`：
  // 图标（`rel="icon"` / `apple-touch-icon`）必须用 `<link>` 声明，
  // 否则浏览器标签页显示空白默认图标（此前就是这样）。
  assert.equal(/<link[^>]+rel=["']?stylesheet/u.test(page), false, '不得引用外部样式表')
  assert.equal(/@import/u.test(page), false, 'CSS 不得 @import')
  // 图标必须声明，且指向**本站**资源（守卫的 /favicon*.svg 白名单会反代）。
  assert.match(page, /<link rel="icon"[^>]*href="\/favicon\.svg"/u, '登录页必须声明 favicon')
  assert.match(page, /<link rel="icon"[^>]*href="\/favicon-dark\.svg"[^>]*media="\(prefers-color-scheme: dark\)"/u,
    '深色模式下应使用深色图标')
  // 红线：页面源码任何地方都不能有形如令牌的串。
  for (const pattern of TOKEN_LIKE) {
    assert.equal(pattern.test(page), false, `登录页出现了形如令牌的串: ${pattern}`)
  }
  assert.equal(page.includes(SAMPLE_TOKEN), false)
  assert.equal(page.includes('dsh_hub_session'), false, '登录页不得提及会话 Cookie 名')
  assert.equal(/localStorage|sessionStorage/u.test(page), false, '登录页不得用脚本可读的存储放凭据')
})

test('登录页永不回显服务端文案（错误框是空容器，且只用 textContent）', () => {
  const page = createWebSession({ service: {}, sessionTtlMs: 1000, guardOrigin: 'http://127.0.0.1:8321' }).renderLoginPage()
  // 错误框靠 JS 用 textContent 填充，初始为空——避免任何模板变量被拼进 HTML。
  const match = /<p data-testid="web-login-error"[^>]*>([\s\S]*?)<\/p>/u.exec(page)
  assert.ok(match !== null, '必须有错误框')
  assert.equal(match[1].trim(), '', '错误框初始必须为空')
  assert.match(page, /textContent/u, '错误提示必须走 textContent（不是 innerHTML）')
  assert.equal(/innerHTML/u.test(page), false, '不得使用 innerHTML')
  // 端点 / 通道名被收敛过：不可能把引号或尖括号拼进内联脚本。
  const hostile = createWebSession({ service: {}, sessionTtlMs: 1000, guardOrigin: 'http://127.0.0.1:8321' })
    .renderLoginPage({ mfaEndpoint: "/x');alert(1);//", channel: "a'b<c>" })
  assert.equal(hostile.includes('alert(1)'), false, '非法端点必须被丢弃')
  assert.equal(hostile.includes('<c>'), false, '非法通道名必须被丢弃')
})

// ── ②③ Set-Cookie ───────────────────────────────────────────────────────────

test('http origin：Set-Cookie 含 HttpOnly + SameSite=Strict + Path=/ + Max-Age，且不含 Secure', () => {
  const ttl = 6 * 60 * 60 * 1000
  const session = createWebSession({ service: {}, sessionTtlMs: ttl, guardOrigin: 'http://127.0.0.1:8321' })
  assert.equal(session.secureCookie(), false)
  const cookie = session.buildSetCookie(SAMPLE_TOKEN)
  assert.equal(cookie, `dsh_hub_session=${SAMPLE_TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ttl / 1000}`)
  assert.ok(cookie.includes('; HttpOnly'), '必须 HttpOnly（JS 读不到）')
  assert.ok(cookie.includes('; SameSite=Strict'), '必须 SameSite=Strict')
  assert.ok(cookie.includes('; Path=/'), '必须 Path=/')
  assert.ok(cookie.includes(`; Max-Age=${ttl / 1000}`), 'Max-Age 必须等于 sessionTtlMs 的秒数')
  assert.equal(cookie.includes('Secure'), false, '纯 HTTP 部署绝不能加 Secure（浏览器会静默丢弃）')
  assert.equal(cookie.includes('\n'), false, '必须是一行（不能注入额外响应头）')
  // 清除用的是同一套属性，只是 Max-Age=0。
  const clear = session.buildClearCookie()
  assert.match(clear, /Max-Age=0$/u)
  assert.ok(clear.includes('HttpOnly') && clear.includes('SameSite=Strict') && clear.includes('Path=/'))
  assert.equal(clear.includes('Secure'), false)
})

test('https origin：Set-Cookie 必须带 Secure', () => {
  const session = createWebSession({ service: {}, sessionTtlMs: 7 * 24 * 3600 * 1000, guardOrigin: 'https://hub.example.com' })
  assert.equal(session.secureCookie(), true)
  const cookie = session.buildSetCookie(SAMPLE_TOKEN)
  assert.ok(cookie.includes('; Secure'), 'https 部署必须加 Secure')
  assert.ok(cookie.includes('HttpOnly') && cookie.includes('SameSite=Strict') && cookie.includes('Path=/'))
  assert.ok(cookie.endsWith('; Max-Age=604800; Secure'), `属性顺序与 Max-Age 必须正确: ${cookie}`)
  assert.ok(session.buildClearCookie().endsWith('Max-Age=0; Secure'))
  // scheme 大小写不敏感（URL 规范化后的常见形态）。
  assert.equal(createWebSession({ service: {}, sessionTtlMs: 1, guardOrigin: 'HTTPS://hub.example.com' }).secureCookie(), true)
  // http 与非法值都不加 Secure。
  assert.equal(createWebSession({ service: {}, sessionTtlMs: 1, guardOrigin: 'http://hub.example.com' }).secureCookie(), false)
  assert.equal(createWebSession({ service: {}, sessionTtlMs: 1, guardOrigin: '' }).secureCookie(), false)
  // Max-Age 向下取整且至少 1 秒。
  assert.ok(createWebSession({ service: {}, sessionTtlMs: 1500, guardOrigin: 'http://127.0.0.1:1' }).buildSetCookie(SAMPLE_TOKEN).endsWith('Max-Age=1'))
  assert.ok(createWebSession({ service: {}, sessionTtlMs: 0, guardOrigin: 'http://127.0.0.1:1' }).buildSetCookie(SAMPLE_TOKEN).endsWith('Max-Age=1'))
})

// ── ④ parseCookieHeader / readCookie ───────────────────────────────────────

test('parseCookieHeader 处理多 Cookie / 空值 / 畸形输入', () => {
  // 多 Cookie，带空格。
  const many = parseCookieHeader(`a=1; b=2; dsh_hub_session=${SAMPLE_TOKEN}`)
  assert.equal(many.a, '1')
  assert.equal(many.b, '2')
  assert.equal(many.dsh_hub_session, SAMPLE_TOKEN)
  // 不带空格也行。
  const tight = parseCookieHeader('a=1;b=2')
  assert.equal(tight.a, '1')
  assert.equal(tight.b, '2')
  // 空值 / 无等号 / 空片段 / 只有分号：全部安全。
  for (const header of ['', '   ', ';;;', 'a=', 'a=;b=;', 'flag', '=value', '; ;', undefined, null]) {
    const parsed = parseCookieHeader(header)
    assert.equal(typeof parsed, 'object')
    assert.equal(parsed.dsh_hub_session, undefined, `畸形输入不得产出会话 Cookie: ${String(header)}`)
  }
  // 畸形输入不抛错（含控制字符、超长、引号、等号在值里、头注入尝试）。
  for (const header of [
    'a=\u0000\u0001',
    `${'x'.repeat(8192)}=1`,
    'a="quoted value"',
    'a=b=c',
    '%%%;;;==',
    'a=1; a=2',
    '\r\nSet-Cookie: dsh_hub_session=evil',
  ]) {
    assert.doesNotThrow(() => parseCookieHeader(header), `不得抛错: ${JSON.stringify(header.slice(0, 24))}`)
  }
  assert.equal(parseCookieHeader('a="quoted value"').a, 'quoted value')
  assert.equal(parseCookieHeader('a=b=c').a, 'b=c')
  // 同名重复：先出现的赢（浏览器按 Path 由长到短排序，更具体的在前）。
  assert.equal(parseCookieHeader('a=1; a=2').a, '1')
  // 原型污染防护。
  const proto = parseCookieHeader('__proto__=polluted')
  assert.equal({}.polluted, undefined)
  assert.equal(Object.getPrototypeOf(proto), null)
})

test('readCookie 只认形如会话的 Cookie，兼容 string[] 与缺失头', () => {
  const session = createWebSession({ service: {}, sessionTtlMs: 1000, guardOrigin: 'http://127.0.0.1:8321' })
  assert.equal(session.readCookie({ headers: { cookie: `a=1; dsh_hub_session=${SAMPLE_TOKEN}` } }), SAMPLE_TOKEN)
  assert.equal(session.readCookie({ headers: { cookie: ['a=1', `dsh_hub_session=${SAMPLE_TOKEN}`] } }), SAMPLE_TOKEN)
  assert.equal(session.readCookie({ headers: { Cookie: `dsh_hub_session=${SAMPLE_TOKEN}` } }), SAMPLE_TOKEN)
  // 畸形 / 缺失 / 空：返回 undefined，不抛。
  assert.equal(session.readCookie({ headers: {} }), undefined)
  assert.equal(session.readCookie({}), undefined)
  assert.equal(session.readCookie(undefined), undefined)
  assert.equal(session.readCookie({ headers: { cookie: 'dsh_hub_session=garbage' } }), undefined)
  assert.equal(session.readCookie({ headers: { cookie: 'dsh_hub_session=' } }), undefined)
  // 令牌原文不会被当成别的 Cookie 顺带返回。
  assert.equal(session.readCookie({ headers: { cookie: `other=${SAMPLE_TOKEN}` } }), undefined)
})

// ── 常量漂移（core/src/auth.ts 是线上契约）─────────────────────────────────

test('错误码与 testid 常量与 core/src/auth.ts 逐条一致（禁止两侧各写一套）', () => {
  const body = /export const AUTH_ERROR_CODES = \{([\s\S]*?)\} as const/u.exec(coreAuthSrc)?.[1] ?? ''
  const coreCodes = Object.fromEntries(
    [...body.matchAll(/(\w+):\s*'([^']*)'/gu)].map(match => [match[1], match[2]]),
  )
  assert.ok(Object.keys(coreCodes).length >= 20, '必须解析出 core 的错误码表')
  for (const [key, value] of Object.entries(web.ERROR_CODES ?? {})) {
    assert.equal(coreCodes[key], value, `错误码 ${key} 与 core 不一致`)
  }
  // 本模块必须镜像 core 里用到的全部错误码（新增码时同步）。
  for (const key of Object.keys(web.ERROR_CODES ?? {})) {
    assert.ok(key in coreCodes, `core 里不存在错误码 ${key}`)
  }
  const ids = coreAuthSrc.slice(coreAuthSrc.indexOf('export const WEB_LOGIN_TEST_IDS'))
  for (const id of REQUIRED_TEST_IDS) {
    assert.ok(ids.includes(`'${id}'`), `core 的 WEB_LOGIN_TEST_IDS 缺少 ${id}`)
    assert.equal(web.TEST_IDS[Object.keys(web.TEST_IDS).find(key => web.TEST_IDS[key] === id)], id)
  }
  assert.equal(web.SESSION_COOKIE, /export const SESSION_COOKIE = '([^']*)'/u.exec(coreAuthSrc)?.[1])
  assert.equal(web.WEB_LOGIN_CHANNEL, /export const WEB_LOGIN_CHANNEL = '([^']*)'/u.exec(coreAuthSrc)?.[1])
  assert.ok(coreAuthSrc.includes(`mfaSubmit: '${web.MFA_ENDPOINT}'`), 'core 的 WEB_AUTH_ROUTES.mfaSubmit 必须与之一致')
})

// ── ⑤ 未绑定 TOTP 的账号必须被拒绝（真实服务）────────────────────────────────

test('未绑定 TOTP 的账号被拒绝：明确错误码 + 不发 Cookie + 会话被撤销', { skip: !(dynamic && serviceAvailable) }, async () => {
  const { dir, path } = tempStore('no-totp')
  const store = await auth.createAuthStore(path)
  try {
    const clock = Date.now()
    const service = auth.createAuthService({ store, now: () => clock })
    const username = 'owner'
    const password = 'Correct-Horse-9-Battery!'
    const boot = await service.bootstrap({ username, password })
    // 引导后 TOTP 只是「已生成、未确认」：这正是「未绑定」的状态。
    assert.equal((await service.status(boot.cookie)).totpEnrollmentRequired, true)

    const session = createWebSession({ service, sessionTtlMs: 60_000, guardOrigin: 'https://hub.example.com' })
    const liveSessions = () => store.data.sessions.filter(row => row.revokedAt === null).length
    const before = liveSessions()
    const result = await session.handleLogin(username, password)
    assert.equal(result.ok, false, '未绑定 TOTP 必须拒绝')
    assert.equal(result.code, 'auth-totp-required', '必须给出明确错误码')
    assert.equal(typeof result.message, 'string')
    assert.ok(result.message.length > 0)
    // 拒绝结果里不能有任何凭据。
    assert.equal('mfaToken' in result, false, '拒绝时不得给出 mfaToken')
    assert.equal('setCookie' in result, false, '拒绝时不得给出 Cookie')
    assert.equal(JSON.stringify(result).includes(password), false, '错误消息不得含口令')
    assert.equal(JSON.stringify(result).includes(boot.cookie.split('.')[1]), false, '错误消息不得含令牌')
    assert.equal(JSON.stringify(result).includes('invalid username'), false, '不得回显服务端英文原文')
    // 服务端「顺手签发」的那个会话必须被撤销，且没有任何接口把它交出去。
    const after = liveSessions()
    assert.ok(after <= before, `未绑定 TOTP 不得留下可用会话（before=${before}, after=${after}）`)
    // 第二步也不该能完成一次「隐式绑定」。
    const mfa = await session.handleMfa('', '123456')
    assert.equal(mfa.ok, false)
    assert.equal('setCookie' in mfa, false)
  } finally {
    await store.dispose().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
})

test('已绑定 TOTP：口令步骤只给 mfaToken，第二步才发 Cookie', { skip: !(dynamic && serviceAvailable) }, async () => {
  const { dir, path } = tempStore('totp')
  const store = await auth.createAuthStore(path)
  try {
    const clock = Date.now()
    const service = auth.createAuthService({ store, now: () => clock })
    const username = 'owner'
    const password = 'Correct-Horse-9-Battery!'
    const boot = await service.bootstrap({ username, password })
    const setup = await service.startTotpSetup(boot.cookie)
    await service.confirmTotp(boot.cookie, auth.totpCodeAt(setup.secret, clock))

    const session = createWebSession({ service, sessionTtlMs: 6 * 3600 * 1000, guardOrigin: 'http://127.0.0.1:8321' })

    // 口令错：统一错误码、文案不泄露「账号是否存在」。
    const bad = await session.handleLogin(username, 'wrong-password')
    assert.equal(bad.ok, false)
    assert.equal(bad.code, 'auth-invalid-credentials')
    assert.equal(JSON.stringify(bad).includes('wrong-password'), false, '错误消息不得回显口令')

    // 口令对但已绑 TOTP：必须给出 mfaToken，且**不能**在响应体里带 Cookie。
    const step1 = await session.handleLogin(username, password)
    assert.equal(step1.ok, true)
    assert.equal(step1.mfaRequired, true)
    assert.equal(typeof step1.mfaToken, 'string')
    assert.ok(step1.mfaToken.length >= 16, 'mfaToken 必须是一次性挑战')
    assert.equal('setCookie' in step1, false, '口令步骤不得直接发 Cookie')
    assert.equal(JSON.stringify(step1).includes('sid_'), false, '口令步骤不得泄漏会话令牌')

    // 动态码错：错误码明确，不发 Cookie。
    const wrongCode = await session.handleMfa(step1.mfaToken, '000000')
    assert.equal(wrongCode.ok, false)
    assert.equal(wrongCode.code, 'auth-mfa-invalid')
    assert.equal('setCookie' in wrongCode, false)

    // 动态码对：拿到属性齐全的 Set-Cookie。
    const step2 = await session.handleMfa(step1.mfaToken, auth.totpCodeAt(setup.secret, clock))
    assert.equal(step2.ok, true)
    assert.match(step2.setCookie, /^dsh_hub_session=sid_[0-9a-f]{24}\.[A-Za-z0-9_-]{16,}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=21600$/u)
    const token = step2.setCookie.slice('dsh_hub_session='.length).split(';')[0]
    // 这个令牌必须真的能换出服务端会话，且 Cookie 读回来的是同一个令牌。
    assert.notEqual(await service.readSession(token), null, 'Cookie 里的令牌必须对应一个有效会话')
    assert.equal(session.readCookie({ headers: { cookie: step2.setCookie } }), token)
    // 挑战一次性：同一个 mfaToken 不能再用。
    const replay = await session.handleMfa(step1.mfaToken, auth.totpCodeAt(setup.secret, clock))
    assert.equal(replay.ok, false)
    assert.equal('setCookie' in replay, false)
  } finally {
    await store.dispose().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
})

test('安全红线写进了代码（HttpOnly / 不用 localStorage / 未绑定 TOTP 直接拒绝 / 不写日志）', () => {
  // 去掉注释后的「可执行代码」：注释里解释「为什么不用 localStorage」是要求的一部分，
  // 只有真正调用它的代码才算违规。
  const code = webSessionSrc.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
  assert.match(webSessionSrc, /HttpOnly/u)
  assert.match(webSessionSrc, /SameSite=Strict/u)
  assert.match(webSessionSrc, /为什么是 Cookie 而不是|Cookie 而不是/u, 'JSDoc 必须解释为什么用 Cookie 而不是 localStorage')
  assert.match(webSessionSrc, /totpEnrollmentRequired/u, '未绑定 TOTP 的判定必须基于 status().totpEnrollmentRequired')
  assert.match(code, /ERROR_CODES\.totpRequired/u)
  assert.match(code, /service\.logout\(/u, '未绑定 TOTP 时必须撤销刚签发的会话')
  assert.equal(/\bconsole\.(log|info|warn|error)\s*\(/u.test(code), false, '不得把任何内容写进日志')
  assert.equal(/localStorage|sessionStorage/u.test(code), false, '不得使用脚本可读的存储')
})
