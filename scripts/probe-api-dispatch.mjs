/**
 * P0 探针：`remote-device` 身份经真实守卫链路能拿到多少数据。
 *
 * 方案 A 的**证伪闸门**。守卫托管浏览器后，浏览器的一切请求都会以
 * `remote-device` 身份派发到 Gateway。若该身份连会话列表都拿不到，方案要调整。
 *
 * 本脚本走**真实 HTTP**：登录 → MFA → 登记客户端 → 用租约+签名逐个调用
 * endpoint，记录每一项的 ok / 错误码。这正是守卫 `/api/*` 将来要走的同一条
 * 派发路径（`createSharedFetchHandler('/api')` + `createPeer(remote-device)`）。
 *
 * 用法：
 *   GUARD_PASSWORD=... GUARD_TOTP_SECRET=... \
 *   node scripts/probe-api-dispatch.mjs <guardOrigin>
 *
 * @module scripts/probe-api-dispatch
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto'

const guardOrigin = process.argv[2] ?? 'http://127.0.0.1:8443'
const PASSWORD = process.env.GUARD_PASSWORD
const SECRET = process.env.GUARD_TOTP_SECRET
const USER = process.env.GUARD_USER ?? 'admin'

if (PASSWORD === undefined || SECRET === undefined) {
  console.error('usage: GUARD_PASSWORD=... GUARD_TOTP_SECRET=... node scripts/probe-api-dispatch.mjs <guardOrigin>')
  process.exit(2)
}

const { buildProofPayload, totpCodeAt } = await import('../lib/auth.js')

/** 探针覆盖的 endpoint：读、写、以及**应当被拒**的红线。 */
const ENDPOINTS = [
  { method: 'session/list', args: {}, expect: 'ok' },
  { method: 'session/search', args: { query: '' }, expect: 'any' },
  { method: 'directoryPicker/list', args: {}, expect: 'ok' },
  // 肯定在 ENDPOINT_TABLE 里的只读端点：用来区分「405 = 名字不对」与「权限拒绝」。
  { method: 'settings/describe', args: {}, expect: 'ok' },
  { method: 'pluginManager/listBundles', args: {}, expect: 'ok' },
  { method: 'directoryPicker/pick', args: {}, expect: 'denied' },
]

const report = { guardOrigin, endpoints: {}, failures: [] }

/**
 * 发一个 JSON 请求。
 * @param {string} path 路径。
 * @param {object} init fetch 选项。
 * @returns {Promise<{status: number, json: any, text: string}>} 响应。
 */
async function call(path, init = {}) {
  const response = await fetch(`${guardOrigin}${path}`, { ...init, signal: AbortSignal.timeout(15_000) })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 保留文本 */ }
  return { status: response.status, json, text: text.slice(0, 300), setCookie: response.headers.getSetCookie?.() ?? [] }
}

// 登录 → MFA → 会话
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
/** 从 Set-Cookie 里取出会话令牌（Cookie 名为 HttpOnly，值即令牌）。 */
function tokenFromSetCookie(setCookie) {
  for (const line of setCookie) {
    const match = /^\s*([^=]+)=([^;]+)/u.exec(line)
    if (match !== null) return { name: match[1].trim(), value: match[2].trim() }
  }
  return null
}
const sessionCookie = tokenFromSetCookie(mfa.setCookie ?? [])
const sessionToken = sessionCookie?.value ?? mfa.json?.sessionToken ?? null
report.sessionCookieName = sessionCookie?.name ?? null
report.auth = { login: login.status, mfa: mfa.status, hasSession: sessionToken !== null }

if (sessionToken === null) {
  report.failures.push(`login/mfa failed: ${login.text} ${mfa.text}`)
} else {
  // 登记一个临时客户端（control 角色，模拟远程浏览器）
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  const enroll = await call('/remote-auth/clients/enroll', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `${sessionCookie.name}=${sessionCookie.value}`,
    },
    body: JSON.stringify({
      label: 'p0-probe',
      clientType: 'app',
      publicKey: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
      roleCeiling: 'full',
    }),
  })
  report.auth.enroll = enroll.status

  const lease = enroll.json?.lease?.lease
  const clientId = enroll.json?.client?.clientId ?? ''
  const keyId = enroll.json?.client?.keyId ?? ''
  const generation = enroll.json?.lease?.generation ?? 1
  if (typeof lease !== 'string') {
    report.failures.push(`enroll failed: ${enroll.text}`)
  } else {
    const audience = new URL(guardOrigin).host.toLowerCase()
    // 逐个 endpoint 打一遍
    for (const endpoint of ENDPOINTS) {
      const body = JSON.stringify({
        type: 'client-request',
        rpcId: `probe-${endpoint.method}`,
        method: endpoint.method,
        payload: { args: endpoint.args },
      })
      const digest = createHash('sha256').update(body).digest('hex')
      const at = Date.now()
      const nonce = `probe-${endpoint.method.replace(/\W/gu, '-')}-${at}`
      const payload = buildProofPayload({
        method: 'POST', path: '/remote/rpc', audience,
        timestamp: String(at), nonce, clientId, keyId, generation, bodyDigest: digest,
      })
      const signature = sign('sha256', Buffer.from(payload, 'utf8'), { key: privateKey, dsaEncoding: 'der' }).toString('base64')
      const result = await call('/remote/rpc', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-protocol': '1',
          authorization: `Bearer ${lease}`,
          'x-hub-client-id': clientId,
          'x-hub-key-id': keyId,
          'x-hub-ts': String(at),
          'x-hub-nonce': nonce,
          'x-hub-body-sha256': digest,
          'x-hub-signature': signature,
        },
        body,
      })
      const errorCode = result.json?.result?.error?.code ?? null
      const ok = result.json?.result?.ok === true
      report.endpoints[endpoint.method] = {
        http: result.status,
        ok,
        errorCode,
        expected: endpoint.expect,
        verdict: endpoint.expect === 'ok'
          ? (ok ? 'PASS' : (errorCode === 'remote-access/denied' ? 'DENIED' : 'FAIL'))
          : (errorCode === 'remote-access/denied' || ok === false ? 'PASS' : 'LEAKED'),
      }
    }
  }
}

for (const [method, entry] of Object.entries(report.endpoints)) {
  const expected = entry.expected
  if (expected === 'ok' && entry.verdict !== 'PASS') {
    report.failures.push(`${method} expected usable, got ${entry.verdict} (${entry.errorCode ?? entry.http})`)
  }
  if (expected === 'denied' && entry.verdict !== 'PASS') {
    report.failures.push(`RED LINE: ${method} was NOT denied (${entry.errorCode ?? entry.http})`)
  }
}

console.log(JSON.stringify(report, null, 2))
if (report.failures.length > 0) process.exitCode = 1
