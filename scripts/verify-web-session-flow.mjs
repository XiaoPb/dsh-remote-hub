/**
 * P2 实测：浏览器登录 → Cookie 会话 → /api 数据面通。
 *
 * @module scripts/verify-web-session-flow
 */
import { WebSocket } from 'ws'

const [, , target, guardOrigin = 'http://127.0.0.1:8850', user = 'admin', password, secret] = process.argv
const PORT = Number(process.env.CDP_PORT ?? 9222)

const { totpCodeAt } = await import('../lib/auth.js')

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find(item => item.id === target)
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
  if (result.exceptionDetails !== undefined) return { error: String(result.exceptionDetails.text).slice(0, 200) }
  return result.result.value
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const report = { steps: {} }

// 1) 在浏览器里走完登录（走真实的 same-origin fetch，Cookie 由浏览器保存）。
report.steps.login = await evaluate(`(async () => {
  const response = await fetch(${JSON.stringify(`${guardOrigin}/remote-web/login`)}, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ${JSON.stringify(user)}, password: ${JSON.stringify(password)} }),
  })
  const body = await response.json()
  return { status: response.status, mfaRequired: body.mfaRequired === true, mfaToken: body.mfaToken }
})()`)

if (report.steps.login.mfaRequired !== true) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(1)
}

report.steps.mfa = await evaluate(`(async () => {
  const response = await fetch(${JSON.stringify(`${guardOrigin}/remote-web/mfa`)}, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mfaToken: ${JSON.stringify(report.steps.login.mfaToken)}, code: ${JSON.stringify(totpCodeAt(secret, Date.now()))} }),
  })
  return { status: response.status, body: await response.json() }
})()`)

await sleep(600)

// 2) 带上 Cookie 调 /api：应当 200 且有数据。
report.steps.api = await evaluate(`(async () => {
  const response = await fetch(${JSON.stringify(`${guardOrigin}/api/session/list`)}, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'web-probe', method: 'session/list', payload: { args: {} } }),
  })
  const text = await response.text()
  let body = null
  try { body = JSON.parse(text) } catch {}
  return {
    status: response.status,
    ok: body ? body.result && body.result.ok === true : false,
    error: body && body.result && body.result.error ? body.result.error.code : null,
    head: text.slice(0, 140),
  }
})()`)

// 3) 匿名请求必须仍然 401。
report.steps.anonymous = await evaluate(`(async () => {
  const response = await fetch('/api/session/list', { method: 'POST', credentials: 'omit',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'anon', method: 'session/list', payload: { args: {} } }) })
  return { status: response.status }
})()`)

socket.close()
console.log(JSON.stringify(report, null, 2))
if (report.steps.mfa.status !== 200) process.exitCode = 2
