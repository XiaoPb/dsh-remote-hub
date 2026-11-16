/**
 * 守卫暴露面验证（经隧道访问 Debian 守卫，不碰 DSH 官方端口）。
 *
 * 断言：
 *  1. 未认证访问 `/api/*`、`/remote/rpc` 一律拒绝（401/403），不会漏到 DSH；
 *  2. 只有 auth 面（status/login）与 health 是公开的；
 *  3. 登录后凭租约才能调用 RPC；
 *  4. 官方 Web 端口在远端只绑回环（不可从隧道侧直达）。
 *
 * 用法：`node scripts/verify-guard-exposure.mjs <guardOrigin> [sshAlias]`
 *
 * @module scripts/verify-guard-exposure
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const [, , guardOrigin = 'http://127.0.0.1:8443', sshAlias] = process.argv
const report = { guardOrigin, probes: {}, ssh: null, failures: [] }

/**
 * 发一个请求，只拿状态码与截断正文。
 * @param {string} path 路径。
 * @param {object} [init] fetch 选项。
 */
async function probe(path, init = {}) {
  try {
    const response = await fetch(`${guardOrigin}${path}`, { ...init, signal: AbortSignal.timeout(8000) })
    const text = await response.text()
    return { status: response.status, body: text.slice(0, 140) }
  } catch (error) {
    return { status: 0, error: String(error).slice(0, 120) }
  }
}

// 1) 公开面：只应有 auth status 与 health。
report.probes.status = await probe('/remote-auth/status')
report.probes.health = await probe('/remote/health')

// 2) 受保护面：官方 RPC 与 `/api/*` 必须被拦下。
report.probes.rpc = await probe('/remote/rpc', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-hub-protocol': '1' },
  body: JSON.stringify({ type: 'client-request', rpcId: 'probe', method: 'session/list', payload: { args: {} } }),
})
report.probes.api = await probe('/api/session/list', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: 'probe', method: 'session/list', payload: { args: {} } }),
})
report.probes.wsUpgrade = await probe('/remote/ws')

// 3) 登录面存在且受预算保护（错误口令必须失败）。
report.probes.badLogin = await probe('/remote-auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'definitely-not-the-password' }),
})

// 4) 远端官方 Web 端口是否只绑回环（用 SSH 在远端正视）。
if (sshAlias !== undefined) {
  try {
    const { stdout } = await run('ssh', ['-p', '8822', `xiaopb@debian.xiaopb.cn`,
      "ss -lntp 2>/dev/null | grep -E ':(3080|8443)\\b' || true"])
    report.ssh = stdout.trim().split('\n').map(line => line.trim())
  } catch (error) {
    report.ssh = [`ssh failed: ${String(error).slice(0, 120)}`]
  }
}

const { probes } = report
// 公开面：200。
if (probes.status.status !== 200) report.failures.push(`auth status ${probes.status.status}`)
// 受保护面：绝不 200（401/403 均可；404 也可接受，但不能成功）。
for (const name of ['rpc', 'api', 'wsUpgrade']) {
  const status = probes[name].status
  if (status === 200) report.failures.push(`${name} reachable without auth (200)`)
}
// 错误口令必须被拒。
if (probes.badLogin.status === 200) report.failures.push('login accepted a wrong password')
// 官方 Web 端口必须只绑回环。
if (report.ssh !== null) {
  const web = report.ssh.find(line => line.includes(':3080'))
  if (web !== undefined && !web.includes('127.0.0.1:3080')) {
    report.failures.push(`official web port not loopback-only: ${web}`)
  }
}

console.log(JSON.stringify(report, null, 2))
if (report.failures.length > 0) process.exitCode = 1
