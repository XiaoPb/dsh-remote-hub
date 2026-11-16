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
  if (result.exceptionDetails !== undefined) return { error: JSON.stringify(result.exceptionDetails).slice(0, 300) }
  return result.result.value
}

// 截获所有 console 输出与未捕获异常，再重载页面，看 browse 插件装配时报了什么。
await send('Runtime.enable')
await send('Log.enable')
const logs = []
socket.on('message', raw => {
  const message = JSON.parse(String(raw))
  if (message.method === 'Runtime.consoleAPICalled') {
    logs.push(message.params.args.map(a => String(a.value ?? a.description ?? '')).join(' ').slice(0, 160))
  }
  if (message.method === 'Runtime.exceptionThrown') {
    logs.push(`EXC ${String(message.params.exceptionDetails.text).slice(0, 160)}`)
  }
})

await send('Page.navigate', { url: 'http://127.0.0.1:8850/' })
await new Promise(r => setTimeout(r, 12_000))

const slots = await evaluate(`(() => {
  const out = {}
  for (const name of ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow']) {
    const el = document.querySelector('[data-slot="' + name + '"]')
    out[name] = el === null ? 'absent' : el.children.length
  }
  return out
})()`)

console.log(JSON.stringify({
  slots,
  relevantLogs: logs.filter(l => /directory|picker|uiWorkspace|browse|slot/i.test(l)).slice(0, 12),
  totalLogs: logs.length,
}, null, 2))
socket.close()
