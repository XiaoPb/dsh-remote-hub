/**
 * 守卫完整认证链（经隧道）：口令 → 动态码 → 会话 → 登记客户端 → 带租约访问 RPC。
 *
 * 这一步回答的问题：**先 auth 再转接**确实可用，且未认证时一律进不去。
 *
 * 用法：
 *   GUARD_PASSWORD=... GUARD_TOTP_SECRET=... node scripts/verify-guard-session.mjs <guardOrigin>
 *
 * 依赖 `lib/auth.js` 的 TOTP 实现（与本机插件同源），以及 Node 内置 crypto 生成客户端密钥。
 *
 * @module scripts/verify-guard-session
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto'

const guardOrigin = process.argv[2] ?? 'http://127.0.0.1:8443'
const PASSWORD = process.env.GUARD_PASSWORD
const SECRET = process.env.GUARD_TOTP_SECRET
if (PASSWORD === undefined || SECRET === undefined) {
  console.error('usage: GUARD_PASSWORD=... GUARD_TOTP_SECRET=... node scripts/verify-guard-session.mjs <guardOrigin>')
  process.exit(2)
}

const { buildProofPayload, totpCodeAt } = await import('../lib/auth.js')
const report = { guardOrigin, steps: {}, failures: [] }

/**
 * 发请求并把响应解析为 JSON（解析失败时返回原始文本）。
 * @param {string} path 路径。
 * @param {object} [init] fetch 选项。
 */
async function call(path, init = {}) {
  const response = await fetch(`${guardOrigin}${path}`, { ...init, signal: AbortSignal.timeout(10_000) })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 保留文本 */ }
  return { status: response.status, text: text.slice(0, 200), json }
}

// 1) 口令 → MFA 挑战
const login = await call('/remote-auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: PASSWORD }),
})
report.steps.login = { status: login.status, mfaRequired: login.json?.mfaRequired ?? null }
if (login.json?.mfaRequired !== true) {
  report.failures.push(`login did not ask for MFA (${login.status})`)
}

// 2) 动态码 → 会话
const mfa = await call('/remote-auth/mfa', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ mfaToken: login.json?.mfaToken, code: totpCodeAt(SECRET, Date.now()) }),
})
const sessionToken = mfa.json?.sessionToken ?? null
report.steps.mfa = { status: mfa.status, hasSession: sessionToken !== null }
if (mfa.status !== 200) report.failures.push(`mfa ${mfa.status} ${mfa.text}`)

if (sessionToken !== null) {
  // 3) 读状态：应能看到会话
  const status = await call('/remote-auth/status', {
    headers: { authorization: `Bearer ${sessionToken}` },
  })
  report.steps.status = { status: status.status, username: status.json?.username ?? null }
  if (status.json?.username !== 'admin') report.failures.push('status did not report the admin session')

  // 4) 登记一个客户端（拿到租约）→ 用它访问 RPC
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  const enroll = await call('/remote-auth/clients/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({
      label: 'teardown-probe',
      clientType: 'app',
      publicKey: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
      roleCeiling: 'control',
    }),
  })
  report.steps.enroll = { status: enroll.status, hasLease: typeof enroll.json?.lease?.lease === 'string' }
  if (enroll.status !== 200) {
    report.steps.enroll.body = enroll.text
    report.failures.push(`enroll ${enroll.status}`)
  }

  if (typeof enroll.json?.lease?.lease === 'string') {
    const lease = enroll.json.lease.lease
    const clientId = enroll.json.client?.clientId ?? ''
    const keyId = enroll.json.client?.keyId ?? ''
    const generation = enroll.json.lease.generation ?? 1
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: 'authed-probe',
      method: 'session/list',
      payload: { args: {} },
    })
    const path = '/remote/rpc'
    const digest = createHash('sha256').update(body).digest('hex')
    const at = Date.now()
    const probeNonce = 'probe-nonce-0123456789abcdef'
    const audience = new URL(guardOrigin).host.toLowerCase()
    const payload = buildProofPayload({
      method: 'POST',
      path,
      audience,
      timestamp: String(at),
      nonce: probeNonce,
      clientId,
      keyId,
      generation,
      bodyDigest: digest,
    })
    const signature = sign('sha256', Buffer.from(payload, 'utf8'), { key: privateKey, dsaEncoding: 'der' }).toString('base64')

    // 4a) 带租约 + 签名访问 RPC：认证后应能正常转接。
    const rpc = await call(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-protocol': '1',
        authorization: `Bearer ${lease}`,
        'x-hub-client-id': clientId,
        'x-hub-key-id': keyId,
        'x-hub-ts': String(at),
        'x-hub-nonce': probeNonce,
        'x-hub-body-sha256': digest,
        'x-hub-signature': signature,
      },
      body,
    })
    report.steps.rpcWithAuth = { status: rpc.status, head: rpc.text }

    // 4b) 同样的请求去掉租约：必须被拒（证明没有"漏到官方端口"）。
    const anonymous = await call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-protocol': '1' },
      body,
    })
    report.steps.rpcWithoutAuth = { status: anonymous.status }

    if (rpc.status === 401 || rpc.status === 403) {
      report.failures.push(`authenticated rpc rejected (${rpc.status}): ${rpc.text}`)
    }
    if (anonymous.status === 200) report.failures.push('anonymous rpc succeeded')
  }
}

console.log(JSON.stringify(report, null, 2))
if (report.failures.length > 0) process.exitCode = 1
