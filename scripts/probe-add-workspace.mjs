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

// 找「添加工作区」入口（当前已有默认工作区，按钮文案会变）。
const probe = `
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const candidates = [...document.querySelectorAll('button, [role=menuitem]')]
    .map(el => ({ el, text: (el.innerText || el.getAttribute('aria-label') || '').trim() }))
    .filter(x => x.text !== '')
  const add = candidates.find(x => /添加工作区|新增工作区|Add workspace|Select workspace|选择工作区/.test(x.text))
  const listing = { available: candidates.slice(0, 14).map(x => x.text) }
  if (add === undefined) return { kind: 'no-entry', ...listing }
  add.el.click()
  for (let i = 0; i < 20; i++) {
    await sleep(300)
    for (const dialog of [...document.querySelectorAll('[role=dialog]')]) {
      const text = dialog.innerText || ''
      if (/目录|文件夹|Folder|Directory/.test(text)) {
        return {
          kind: 'directory-dialog',
          label: dialog.getAttribute('aria-label'),
          text: text.slice(0, 200),
          nativeInputs: document.querySelectorAll('input[type=file]').length,
        }
      }
    }
  }
  return {
    kind: 'none',
    dialogs: [...document.querySelectorAll('[role=dialog]')].map(d => d.getAttribute('aria-label')),
    nativeInputs: document.querySelectorAll('input[type=file]').length,
  }
})()`

console.log(JSON.stringify(await evaluate(probe), null, 2))
socket.close()
