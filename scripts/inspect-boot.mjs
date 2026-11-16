/** 看 `__DSH_BOOT__` 注入的内容形状（判断守卫能否自行生成）。 */
import { WebSocket } from 'ws'

const target = process.argv[2]
const origin = process.argv[3] ?? 'http://127.0.0.1:3091'
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
  if (result.exceptionDetails !== undefined) return { error: JSON.stringify(result.exceptionDetails).slice(0, 300) }
  return result.result.value
}

const info = await evaluate(`(async () => {
  const response = await fetch(${JSON.stringify(`${origin}/`)}, { credentials: 'same-origin' })
  const text = await response.text()
  const index = text.indexOf('__DSH_BOOT__')
  const window = text.slice(Math.max(0, index - 40), index + 700)
  const keys = window.match(/"([a-zA-Z]+)":/g)
  return {
    snippet: window.replace(/\\s+/g, ' ').slice(0, 640),
    keys: [...new Set((keys ?? []).map(k => k.replace(/"/g, '')))].slice(0, 24),
  }
})()`)
console.log(JSON.stringify(info, null, 2))
socket.close()
