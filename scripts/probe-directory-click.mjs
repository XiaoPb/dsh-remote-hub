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

const result = await evaluate(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const button = [...document.querySelectorAll('button')].find(x => /选择工作区/.test(x.innerText || ''))
  if (!button) return { noButton: true, buttons: [...document.querySelectorAll('button')].map(b => b.innerText.trim()).slice(0, 8) }
  button.click()
  for (let i = 0; i < 12; i++) {
    await sleep(400)
    if (document.querySelector('[data-testid=remote-paths-dialog]')) {
      return { dialog: true, at: i * 400, text: document.querySelector('[data-testid=remote-paths-dialog]').innerText.slice(0, 160) }
    }
  }
  const slot = document.querySelector('[data-slot="conversation.hero.workspace.directoryFlow"]')
  return {
    dialog: false,
    slotChildren: slot === null ? 'absent' : slot.children.length,
    nativeInputs: document.querySelectorAll('input[type=file]').length,
  }
})()`)
console.log(JSON.stringify(result, null, 2))
socket.close()
