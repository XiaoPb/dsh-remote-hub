import { WebSocket } from 'ws'

const [, , target] = process.argv
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find(item => item.id === target)
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.on('open', resolve); socket.on('error', reject) })
let id = 0
const pending = new Map()
const events = []
socket.on('message', data => {
  const message = JSON.parse(String(data))
  if (message.method !== undefined) {
    events.push(message)
    return
  }
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

await send('Runtime.enable')
await send('Log.enable')
events.length = 0
await send('Page.reload')
await new Promise(resolve => setTimeout(resolve, 12_000))

const messages = []
for (const event of events) {
  if (event.method === 'Runtime.consoleAPICalled') {
    messages.push(`[${event.params.type}] ${event.params.args.map(a => String(a.value ?? a.description ?? '')).join(' ').slice(0, 220)}`)
  }
  if (event.method === 'Runtime.exceptionThrown') {
    messages.push(`[exception] ${String(event.params.exceptionDetails.text).slice(0, 220)}`)
  }
  if (event.method === 'Log.entryAdded') {
    messages.push(`[log:${event.params.entry.level}] ${String(event.params.entry.text).slice(0, 220)}`)
  }
}

const state = await evaluate(`(() => {
  const out = {}
  for (const name of ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow']) {
    const el = document.querySelector('[data-slot="' + name + '"]')
    out[name] = el === null ? 'absent' : el.children.length
  }
  return out
})()`)

console.log(JSON.stringify({ slots: state, messages: messages.slice(0, 25), total: messages.length }, null, 2))
socket.close()
