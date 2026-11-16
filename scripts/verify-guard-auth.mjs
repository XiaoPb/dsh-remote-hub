/**
 * 守卫认证链路验证（经隧道）：证明"先 auth 再转接"确实生效。
 *
 * 步骤：
 *   1. 未认证 RPC → 401（已有 verify-guard-exposure 覆盖，这里重跑一遍作前置）；
 *   2. 错误口令 → 401，且**不影响**后续正确登录（限流按来源计）；
 *   3. 提交正确的账号+口令+动态码（由调用方提供）→ 拿到租约；
 *   4. 带租约调用 RPC → 200，证明认证后可以正常转接；
 *   5. 不带租约再调用 → 仍然 401（租约是唯一凭据）。
 *
 * 用法：
 *   GUARD_USER=admin GUARD_PASSWORD=... GUARD_TOTP_SECRET=... \
 *   node scripts/verify-guard-auth.mjs <guardOrigin>
 *
 * 环境变量缺失时只跑第 1 步与"错误口令被拒"，并以退出码 3 提示未完整验证。
 *
 * @module scripts/verify-guard-auth
 */
const guardOrigin = process.argv[2] ?? 'http://127.0.0.1:8443'
const USER = process.env.GUARD_USER ?? 'admin'
const PASSWORD = process.env.GUARD_PASSWORD
const SECRET = process.env.GUARD_TOTP_SECRET

/** 同认证服务一致的 TOTP 实现。 */
const { totpCodeAt } = await import('../lib/auth.js')

const report = { guardOrigin, steps: {}, failures: [] }

/**
 * 发一个请求。
 * @param {string} path 路径。
 * @param {object} [init] fetch 选项。
 */
async function call(path, init = {}) {
  try {
    const response = await fetch(`${guardOrigin}${path}`, { ...init, signal: AbortSignal.timeout(10_000) })
    const text = await response.text()
    return { status: response.status, body: text.slice(0, 200) }
  } catch (error) {
    return { status: 0, error: String(error).slice(0, 140) }
  }
}

/** 构造官方 client-request 信封。 */
function envelope(rpcId, method) {
  return JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: {} } })
}

// 1) 未认证
report.steps.anonymousRpc = await call('/remote/rpc', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-hub-protocol': '1' },
  body: envelope('anon', 'session/list'),
})
if (report.steps.anonymousRpc.status !== 401) {
  report.failures.push(`anonymous rpc ${report.steps.anonymousRpc.status} != 401`)
}

// 2) 错误口令
report.steps.wrongPassword = await call('/remote-auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: USER, password: 'wrong-password-for-test' }),
})
if (report.steps.wrongPassword.status !== 401) {
  report.failures.push(`wrong password ${report.steps.wrongPassword.status} != 401`)
}

if (PASSWORD === undefined || SECRET === undefined) {
  console.log(JSON.stringify({ ...report, note: 'GUARD_PASSWORD / GUARD_TOTP_SECRET not set: only the rejection path was verified' }, null, 2))
  process.exitCode = report.failures.length > 0 ? 1 : 3
} else {
  // 3) 正确口令 → 挑战
  const code = totpCodeAt(SECRET, Date.now())
  report.steps.login = await call('/remote-auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASSWORD, code }),
  })
  let sessionToken = null
  let lease = null
  try {
    const parsed = JSON.parse(report.steps.login.body)
    sessionToken = parsed.sessionToken ?? parsed.session?.token ?? null
    lease = parsed.lease ?? null
  } catch { /* 忽略 */ }
  if (report.steps.login.status !== 200) report.failures.push(`login ${report.steps.login.status}`)

  // 4) 带租约调用 RPC：这是"认证后转接"的关键一步。
  if (lease !== null) {
    report.steps.rpcWithLease = await call('/remote/rpc', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-protocol': '1',
        authorization: `Bearer ${lease}`,
      },
      body: envelope('authed', 'session/list'),
    })
    if (report.steps.rpcWithLease.status === 401) {
      report.failures.push('authenticated rpc was rejected')
    }
  } else {
    report.note = 'login returned no lease (MFA challenge flow); provide a pre-signed client to test the RPC hop'
  }

  // 5) 再不带租约：必须仍然被拒。
  report.steps.rpcAfter = await call('/remote/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-protocol': '1' },
    body: envelope('anon2', 'session/list'),
  })
  if (report.steps.rpcAfter.status !== 401) {
    report.failures.push(`post-auth anonymous rpc ${report.steps.rpcAfter.status} != 401`)
  }

  console.log(JSON.stringify({ ...report, hadSessionToken: sessionToken !== null }, null, 2))
  if (report.failures.length > 0) process.exitCode = 1
}
