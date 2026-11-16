import { WebSocket } from 'ws'

const [, , target] = process.argv
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
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
  if (result.exceptionDetails !== undefined) return { error: JSON.stringify(result.exceptionDetails).slice(0, 400) }
  return result.result.value
}

// 从 boot 清单里找出 browse 与 native 的条目，确认到底挂了哪一个。
const info = await evaluate(`(() => {
  const boot = globalThis.__DSH_BOOT__
  if (!boot || !Array.isArray(boot.entries)) return { noBoot: true }
  const pickers = boot.entries
    .filter(e => /directory-picker/.test(e.id))
    .map(e => ({ id: e.id, url: e.url }))
  // 直接问后端：pick 能力的 kinds
  return { pickers, total: boot.entries.length }
})()`)

const capability = await evaluate(`(async () => {
  const response = await fetch('/api/directoryPicker/list', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'cap', method: 'directoryPicker/list', payload: { args: {} } }),
  })
  const body = await response.json().catch(() => null)
  return body && body.result ? { ok: body.result.ok, code: body.result.error ? body.result.error.code : null } : body
})()`)

console.log(JSON.stringify({ info, capability }, null, 2))
socket.close()
