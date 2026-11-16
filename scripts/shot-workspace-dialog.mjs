import { writeFileSync } from 'node:fs'
import { WebSocket } from 'ws'

const [, , target, outPath] = process.argv
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

// 关闭残留对话框，再重新打开目录选择并截图。
const opened = await evaluate(`
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  for (const dialog of [...document.querySelectorAll('[role=dialog]')]) {
    const closer = dialog.querySelector('button[aria-label*="关闭"], button[aria-label*="Close"]')
    if (closer !== null) closer.click()
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await sleep(300)
  }
  await sleep(600)
  const entry = [...document.querySelectorAll('button, [role=menuitem]')]
    .find(el => /添加工作区|新增工作区|选择工作区|Add workspace/.test(el.innerText || el.getAttribute('aria-label') || ''))
  if (entry === undefined) return { opened: false }
  entry.click()
  for (let i = 0; i < 20; i++) {
    await sleep(300)
    for (const dialog of [...document.querySelectorAll('[role=dialog]')]) {
      if (/目录|文件夹/.test(dialog.innerText || '')) return { opened: true, label: dialog.getAttribute('aria-label') }
    }
  }
  return { opened: false }
})()`)

await new Promise(resolve => setTimeout(resolve, 900))
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(outPath, Buffer.from(shot.data, 'base64'))
console.log(JSON.stringify({ opened, outPath }, null, 2))
socket.close()
