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

// browse 客户端注册插槽时会传 inject = { listDirectory, createDirectory, t }。
// 直接问后端这两个方法，确认它们可用（否则组件渲染会抛错、插槽留空）。
const probe = `
(async () => {
  const call = async (method, args) => {
    const response = await fetch('/api/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: method, method, payload: { args } }),
    })
    const body = await response.json().catch(() => null)
    return { status: response.status, ok: body?.result?.ok ?? null, code: body?.result?.error?.code ?? null, sample: body?.result?.value ? JSON.stringify(body.result.value).slice(0, 100) : null }
  }
  return {
    list: await call('directoryPicker/list', {}),
    create: await call('directoryPicker/createDirectory', { path: '.', name: 'probe-test-dir' }),
  }
})()`

console.log(JSON.stringify(await evaluate(probe), null, 2))
socket.close()
