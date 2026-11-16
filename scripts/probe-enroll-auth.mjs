/**
 * 对照实验：enroll 到底认 Cookie 还是 Bearer。
 *
 * 这决定浏览器模式该怎么拿租约（方案 §4.1 的前提）。
 *
 * @module scripts/probe-enroll-auth
 */
const guardOrigin = process.argv[2] ?? 'http://127.0.0.1:8850'
const USER = process.env.GUARD_USER ?? 'admin'
const PASSWORD = process.env.GUARD_PASSWORD
const SECRET = process.env.GUARD_TOTP_SECRET

const { totpCodeAt } = await import('../lib/auth.js')

/**
 * 发请求。
 * @param {string} path 路径。
 * @param {object} init 选项。
 */
async function call(path, init = {}) {
  const response = await fetch(`${guardOrigin}${path}`, { ...init, signal: AbortSignal.timeout(15_000) })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 文本 */ }
  return { status: response.status, json, text, setCookie: response.headers.getSetCookie?.() ?? [] }
}

const login = await call('/remote-auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASSWORD }),
})
const mfa = await call('/remote-auth/mfa', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ mfaToken: login.json?.mfaToken, code: totpCodeAt(SECRET, Date.now()) }),
})
const cookieLine = (mfa.setCookie ?? [])[0] ?? ''
const cookieMatch = /^\s*([^=]+)=([^;]+)/u.exec(cookieLine)
const cookie = cookieMatch === null ? '' : `${cookieMatch[1]}=${cookieMatch[2]}`
// 会话令牌就是 Cookie 的值；同时用它作 Bearer 对照。
const token = cookieMatch?.[2] ?? ''

const { privateKey, publicKey } = (await import('node:crypto')).generateKeyPairSync('ec', { namedCurve: 'P-256' })
const jwk = publicKey.export({ format: 'jwk' })
const payloadBase = {
  label: 'auth-probe',
  clientType: 'app',
  publicKey: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
  roleCeiling: 'full',
}

const byCookie = await call('/remote-auth/clients/enroll', {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(payloadBase),
})
const byBearer = await call('/remote-auth/clients/enroll', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ ...payloadBase, label: 'auth-probe-bearer' }),
})
// 对照：status 接口对两种方式的反应。
const statusCookie = await call('/remote-auth/status', { headers: { cookie } })
const statusBearer = await call('/remote-auth/status', { headers: { authorization: `Bearer ${token}` } })

console.log(JSON.stringify({
  hasCookie: cookie !== '',
  hasToken: token !== '',
  enrollByCookie: { status: byCookie.status, code: byCookie.json?.code ?? null },
  enrollByBearer: { status: byBearer.status, code: byBearer.json?.code ?? null, hasLease: typeof byBearer.json?.lease?.lease === 'string' },
  statusByCookie: { status: statusCookie.status, session: statusCookie.json?.session !== null },
  statusByBearer: { status: statusBearer.status, session: statusBearer.json?.session !== null },
}, null, 2))
