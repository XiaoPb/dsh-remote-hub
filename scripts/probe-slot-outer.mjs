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

const info = await evaluate(`(() => {
  const slotEl = document.querySelector('[data-slot="conversation.hero.workspace.directoryFlow"]')
  const parent = slotEl === null ? null : slotEl.parentElement
  return {
    slotOuter: slotEl === null ? null : slotEl.outerHTML.slice(0, 300),
    parentClass: parent === null ? null : parent.className,
    bodyHasWorkspaceUI: document.body.innerText.includes('工作区'),
    buttons: [...document.querySelectorAll('button')].map(b => (b.innerText || '').trim()).filter(Boolean).slice(0, 12),
  }
})()`)

console.log(JSON.stringify(info, null, 2))
socket.close()
