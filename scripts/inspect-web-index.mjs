/** 取官方 Web 的 index HTML 结构（脚本/样式引用），用于评估守卫能否反代。 */
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
  const srcs = []
  const re = /(?:src|href)="([^"]+)"/g
  let match
  while ((match = re.exec(text)) !== null) srcs.push(match[1])
  const bootMatch = text.match(/__DSH_BOOT__\\s*=\\s*([\\s\\S]{0,200})/)
  return {
    status: response.status,
    length: text.length,
    assets: srcs.slice(0, 10),
    hasBoot: /__DSH_BOOT__/.test(text),
    bootHead: bootMatch ? bootMatch[1].slice(0, 160) : null,
    hasHubGlobal: /__DSH_REMOTE_HUB__/.test(text),
  }
})()`)
console.log(JSON.stringify(info, null, 2))
socket.close()
