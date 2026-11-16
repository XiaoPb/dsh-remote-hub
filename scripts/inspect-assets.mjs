/** 检查官方 Web 的静态资源是否可无状态获取（守卫反代可行性）。 */
import { WebSocket } from 'ws'

const target = process.argv[2]
const origin = process.argv[3] ?? 'http://127.0.0.1:3091'
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
  if (result.exceptionDetails !== undefined) return { error: String(result.exceptionDetails.text).slice(0, 200) }
  return result.result.value
}

const info = await evaluate(`(async () => {
  const out = {}
  for (const path of ['/assets/index-BgUyXZcc.js', '/manifest.webmanifest', '/favicon.svg']) {
    try {
      const response = await fetch(${JSON.stringify(origin)} + path)
      const body = await response.arrayBuffer()
      out[path] = { status: response.status, bytes: body.byteLength, type: response.headers.get('content-type') }
    } catch (error) {
      out[path] = { error: String(error).slice(0, 80) }
    }
  }
  return out
})()`)
console.log(JSON.stringify(info, null, 2))
socket.close()
