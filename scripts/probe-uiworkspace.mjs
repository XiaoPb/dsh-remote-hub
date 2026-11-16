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
  if (result.exceptionDetails !== undefined) return { error: JSON.stringify(result.exceptionDetails).slice(0, 500) }
  return result.result.value
}

// 1) 直接调 listDirectory（browse 客户端用它）看服务是否存在。
const dirProbe = await evaluate(`
(async () => {
  const paths = ['/', '.', '']
  const out = []
  for (const p of paths) {
    const response = await fetch('/api/workspaceFiles/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'wf', method: 'workspaceFiles/list', payload: { args: { path: p } } }),
    })
    const body = await response.json().catch(() => null)
    out.push({ path: p, status: response.status, ok: body?.result?.ok ?? null, code: body?.result?.error?.code ?? null })
  }
  return out
})()`)

// 2) 页面 console 里是否有与 uiWorkspace 相关的告警。
await send('Runtime.enable')
const logs = []
socket.on('message', raw => {
  const message = JSON.parse(String(raw))
  if (message.method === 'Runtime.consoleAPICalled') {
    logs.push(message.params.args.map(a => String(a.value ?? a.description ?? '')).join(' ').slice(0, 200))
  }
})
await send('Page.reload')
await new Promise(r => setTimeout(r, 11_000))

console.log(JSON.stringify({
  dirProbe,
  logs: logs.filter(l => /workspace|picker|slot|service/i.test(l)).slice(0, 10),
  totalLogs: logs.length,
}, null, 2))
socket.close()
