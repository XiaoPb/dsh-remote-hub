/**
 * 逐个 endpoint 打印原始错误体，定位 `remote-access/denied` 的真实来源。
 *
 * @module scripts/probe-denied-source
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto'

const guardOrigin = process.argv[2] ?? 'http://127.0.0.1:8850'
const USER = process.env.GUARD_USER ?? 'admin'
const PASSWORD = process.env.GUARD_PASSWORD
const SECRET = process.env.GUARD_TOTP_SECRET
const ROLE = process.env.PROBE_ROLE ?? 'full'

const { buildProofPayload, totpCodeAt } = await import('../lib/auth.js')

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
  return { status: response.status, json, text }
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
const match = /^\s*([^=]+)=([^;]+)/u.exec(cookieLine)
const cookie = match === null ? '' : `${match[1]}=${match[2]}`

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const jwk = publicKey.export({ format: 'jwk' })
const enroll = await call('/remote-auth/clients/enroll', {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  // 注意：Bearer 需要 allowHeaderSession，默认关闭；Cookie 才是主路径。
  body: JSON.stringify({
    label: 'denied-probe',
    clientType: 'app',
    publicKey: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
    roleCeiling: ROLE,
  }),
})

const lease = enroll.json?.lease?.lease
const clientId = enroll.json?.client?.clientId ?? ''
const keyId = enroll.json?.client?.keyId ?? ''
const generation = enroll.json?.lease?.generation ?? 1
console.log(JSON.stringify({
  enrollStatus: enroll.status,
  role: ROLE,
  enrolledRole: enroll.json?.client?.roleCeiling ?? null,
  lease: typeof lease,
  enrollBody: typeof lease === 'string' ? undefined : enroll.text,
}, null, 2))

const audience = new URL(guardOrigin).host.toLowerCase()
const results = {}
for (const method of ['session/list', 'settings/describe', 'directoryPicker/list']) {
  const body = JSON.stringify({ type: 'client-request', rpcId: `d-${method}`, method, payload: { args: {} } })
  const digest = createHash('sha256').update(body).digest('hex')
  const at = Date.now()
  const nonce = `d-${method.replace(/\W/gu, '-')}-${at}`
  const payload = buildProofPayload({
    method: 'POST', path: '/remote/rpc', audience,
    timestamp: String(at), nonce, clientId, keyId, generation, bodyDigest: digest,
  })
  const signature = sign('sha256', Buffer.from(payload, 'utf8'), { key: privateKey, dsaEncoding: 'der' }).toString('base64')
  const response = await call('/remote/rpc', {
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
  results[method] = { http: response.status, error: response.json?.result?.error ?? null }
}
console.log(JSON.stringify(results, null, 2))
