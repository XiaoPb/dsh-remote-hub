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
  if (result.exceptionDetails !== undefined) return { error: JSON.stringify(result.exceptionDetails).slice(0, 400) }
  return result.result.value
}

// 在账号页里找「两步验证」区块并展开/开始绑定，然后量一下二维码的实际尺寸。
const info = await evaluate(`
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const clickText = async (pattern) => {
    const el = [...document.querySelectorAll('button,summary,[role=button]')]
      .find(e => pattern.test(e.innerText || ''))
    if (el === undefined) return false
    el.click()
    await sleep(1600)
    return true
  }
  await clickText(/两步验证/)
  await clickText(/开始绑定|绑定两步验证|启用/)
  await sleep(2200)

  const qr = document.querySelector('[data-testid=totp-qr]')
  if (qr === null) {
    return { found: false, text: document.body.innerText.slice(-260) }
  }
  const rect = qr.getBoundingClientRect()
  const viewBox = qr.getAttribute('viewBox')
  const modules = viewBox === null ? null : Number(viewBox.split(' ')[2]) - 4
  return {
    found: true,
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    viewBox,
    modules,
    pxPerModule: modules === null ? null : +(rect.width / modules).toFixed(2),
    shapeRendering: getComputedStyle(qr).shapeRendering,
  }
})()`)

console.log(JSON.stringify(info, null, 2))
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(outPath, Buffer.from(shot.data, 'base64'))
console.log('shot:', outPath)
socket.close()
