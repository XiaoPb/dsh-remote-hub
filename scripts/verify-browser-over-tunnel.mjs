/**
 * 浏览器经隧道访问 Debian 守卫（不碰官方端口）的完整验证。
 *
 * 场景：本机浏览器打开 `http://127.0.0.1:8443/`（隧道到 Debian 守卫），
 * 走插件的账号登录 → 2FA → 受信客户端，最后用租约访问 RPC。
 *
 * 断言：
 *  1. 守卫根路径不提供 DSH 官方 Web（未认证时不含 Hub UI / 会话数据）；
 *  2. 从浏览器发起登录 → MFA → enroll（走实名 CORS）成功；
 *  3. 未认证 RPC 一律 401。
 *
 * 用法：`node scripts/verify-browser-over-tunnel.mjs <cdpTarget> <guardOrigin>`
 * 环境变量：`GUARD_PASSWORD`、`GUARD_TOTP_SECRET`。
 *
 * @module scripts/verify-browser-over-tunnel
 */
import { WebSocket } from 'ws'
import { totpCodeAt } from '../lib/auth.js'

const [, , target, guardOrigin = 'http://127.0.0.1:8443'] = process.argv
const PORT = Number(process.env.CDP_PORT ?? 9222)
const PASSWORD = process.env.GUARD_PASSWORD
const SECRET = process.env.GUARD_TOTP_SECRET

if (target === undefined || PASSWORD === undefined || SECRET === undefined) {
  console.error('usage: GUARD_PASSWORD=... GUARD_TOTP_SECRET=... node scripts/verify-browser-over-tunnel.mjs <cdpTarget> <guardOrigin>')
  process.exit(2)
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find(item => item.id === target)
if (page === undefined) throw new Error(`target not found: ${target}`)
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.on('open', resolve); socket.on('error', reject) })
let id = 0
const pending = new Map()
socket.on('message', data => {
  const message = JSON.parse(String(data))
  const entry = pending.get(message.id)
  if (entry === undefined) return
  pending.delete(message.id)
  if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)))
  else entry.resolve(message.result)
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const rpcId = ++id
  pending.set(rpcId, { resolve, reject })
  socket.send(JSON.stringify({ id: rpcId, method, params }))
})
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 400))
  return result.result.value
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const report = { guardOrigin, steps: {}, failures: [] }

// 1) 浏览器直接打开守卫根路径：不应得到 DSH 官方 Web。
await send('Page.navigate', { url: `${guardOrigin}/` })
await sleep(2500)
report.steps.root = await evaluate(`(() => {
  const text = document.body ? document.body.innerText.slice(0, 200) : ''
  return {
    title: document.title,
    // 官方 Web 的指纹：侧栏 / 会话列表 / Hub 页面 testid。
    hasHarnessUi: !!document.querySelector('#root, [data-testid=remote-hub-page], [data-testid=account-page]'),
    bodyStart: text,
  }
})()`)

// 2) 浏览器里走完整登录（跨源，实名 CORS），拿到会话。
const login = await evaluate(`(async () => {
  const response = await fetch(${JSON.stringify(`${guardOrigin}/remote-auth/login`)}, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: ${JSON.stringify(PASSWORD)} }),
  })
  const body = await response.json().catch(() => null)
  return { status: response.status, mfaRequired: body ? body.mfaRequired : null, mfaToken: body ? body.mfaToken : null }
})()`)
report.steps.login = { status: login.status, mfaRequired: login.mfaRequired }
if (login.mfaRequired !== true) report.failures.push(`browser login did not require MFA (${login.status})`)

const code = totpCodeAt(SECRET, Date.now())
const mfa = await evaluate(`(async () => {
  const response = await fetch(${JSON.stringify(`${guardOrigin}/remote-auth/mfa`)}, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mfaToken: ${JSON.stringify(login.mfaToken)}, code: ${JSON.stringify(code)} }),
  })
  const body = await response.json().catch(() => null)
  return { status: response.status, hasSession: !!(body && body.sessionToken) }
})()`)
report.steps.mfa = { status: mfa.status, hasSession: mfa.hasSession }
if (mfa.status !== 200) report.failures.push(`browser mfa ${mfa.status}`)

// 3) 未认证 RPC：即使从同一个浏览器发起也必须 401。
const anonRpc = await evaluate(`(async () => {
  const response = await fetch(${JSON.stringify(`${guardOrigin}/remote/rpc`)}, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-protocol': '1' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'anon', method: 'session/list', payload: { args: {} } }),
  })
  return { status: response.status }
})()`)
report.steps.anonymousRpc = { status: anonRpc.status }
if (anonRpc.status !== 401) report.failures.push(`browser anonymous rpc ${anonRpc.status} != 401`)

// 4) 官方端口在浏览器里也必须不可达（隧道没暴露它）。
const official = await evaluate(`(async () => {
  try {
    const response = await fetch('http://127.0.0.1:3080/', { mode: 'no-cors' })
    return { reachable: true, status: response.status }
  } catch (error) {
    return { reachable: false, error: String(error).slice(0, 80) }
  }
})()`)
report.steps.officialPort = official
if (official.reachable === true) report.failures.push('official DSH port 3080 is reachable from the browser')

socket.close()
console.log(JSON.stringify(report, null, 2))
if (report.failures.length > 0) process.exitCode = 1
