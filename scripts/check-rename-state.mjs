/**
 * 自助检查（不改服务端校验）：直接调 `/remote-auth/status` 看 `usernameRenameAllowed`，
 * 确认「改名只用一次」在真实实例上的表现与预期一致。
 *
 * 用法：`node scripts/check-rename-state.mjs <target>`
 */
import { WebSocket } from 'ws'

const target = process.argv[2]
const PORT = Number(process.env.CDP_PORT ?? 9222)
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
  if (result.exceptionDetails !== undefined) return { error: String(result.exceptionDetails).slice(0, 300) }
  return result.result.value
}
console.log(JSON.stringify(await evaluate(`(async () => {
  const status = await (await fetch('remote-auth/status', { credentials: 'same-origin' })).json()
  if (!status.session) return { loggedIn: false }
  const response = await fetch('remote-auth/accounts', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'rename', accountId: status.session.accountId, username: 'should-be-refused' }),
  })
  return {
    loggedIn: true,
    username: status.username,
    renameAllowedFlag: status.usernameRenameAllowed,
    renameStatus: response.status,
    renameBody: await response.json().catch(() => null),
  }
})()`), null, 2))
socket.close()
