import { writeFileSync } from 'node:fs'
import { WebSocket } from 'ws'

const [, , target, outPath, origin = 'http://127.0.0.1:3080'] = process.argv
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
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// 打开设置 → 登录与账号 → 展开两步验证卡片并点「开始绑定」。
await send('Page.navigate', { url: `${origin}/?token=${process.argv[4] ?? ''}` })
await sleep(9000)

const opened = await evaluate(`
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const menu = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '账号菜单')
  if (menu !== undefined) { menu.click(); await sleep(700) }
  const settings = [...document.querySelectorAll('[role=menuitem]')].find(e => /设置/.test(e.innerText || ''))
  if (settings !== undefined) { settings.click(); await sleep(2000) }
  const tab = [...document.querySelectorAll('[role=tab],button,a')].find(e => /登录与账号/.test(e.innerText || ''))
  if (tab !== undefined) { tab.click(); await sleep(2500) }
  const pageEl = document.querySelector('[data-testid=account-page]')
  return { phase: pageEl === null ? null : pageEl.getAttribute('data-phase') }
})()`)

console.log(JSON.stringify({ opened }, null, 2))
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(outPath, Buffer.from(shot.data, 'base64'))
console.log(JSON.stringify({ outPath }, null, 2))
socket.close()
