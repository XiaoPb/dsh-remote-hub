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

// 先关掉可能开着的面板，再点「选择工作区」，只认目录浏览类对话框。
const probe = `
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  for (const el of [...document.querySelectorAll('[role=dialog]')]) {
    const closer = el.querySelector('button[aria-label*="关闭"], button[aria-label*="Close"]')
    if (closer !== null) closer.click()
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await sleep(300)
  }
  await sleep(500)
  const buttons = [...document.querySelectorAll('button')]
  const target = buttons.find(b => /选择工作区|添加工作区/.test(b.innerText || ''))
  if (target === undefined) return { noButton: true, buttons: buttons.map(b => b.innerText.trim()).slice(0, 10) }
  target.click()
  for (let i = 0; i < 16; i++) {
    await sleep(300)
    const dialogs = [...document.querySelectorAll('[role=dialog]')]
    for (const dialog of dialogs) {
      const text = dialog.innerText || ''
      if (/目录|文件夹|Folder|Directory/.test(text)) {
        return {
          kind: 'directory-dialog',
          label: dialog.getAttribute('aria-label'),
          testid: dialog.getAttribute('data-testid'),
          text: text.slice(0, 200),
          nativeInputs: document.querySelectorAll('input[type=file]').length,
        }
      }
    }
  }
  return {
    kind: 'none',
    dialogs: [...document.querySelectorAll('[role=dialog]')].map(d => (d.getAttribute('aria-label') || '') + ' | ' + (d.innerText || '').slice(0, 60)),
    nativeInputs: document.querySelectorAll('input[type=file]').length,
  }
})()`

console.log(JSON.stringify(await evaluate(probe), null, 2))
socket.close()
