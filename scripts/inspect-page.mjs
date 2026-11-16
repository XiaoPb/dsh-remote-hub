/**
 * 采集页面的可见结构（不依赖图片），用于确认截图内容是否正确。
 *
 * 当读图工具不可靠时，用它给出可核对的事实：页面标题、侧栏条目、
 * 关键区域的文本与位置。
 *
 * @module scripts/inspect-page
 */
import { WebSocket } from 'ws'

import { login } from './guard-login.mjs'

const origin = process.env.RH_ORIGIN ?? 'http://127.0.0.1:8850'

const session = await login({
  origin,
  username: process.env.RH_USER ?? 'demo',
  password: process.env.RH_PASS ?? 'Demo-Shot-2026!',
  secret: process.env.RH_TOTP ?? 'JBSWY3DPEHPK3PXP',
})
if (session.ok !== true) { console.error('login failed'); process.exit(1) }

const [pair] = session.cookie.split(';')
const separator = pair.indexOf('=')
const name = pair.slice(0, separator)
const value = pair.slice(separator + 1)

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find(item => item.type === 'page')
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
  setTimeout(() => { if (pending.delete(rpcId)) reject(new Error(`timeout: ${method}`)) }, 25000)
})
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) return { error: JSON.stringify(result.exceptionDetails).slice(0, 300) }
  return result.result.value
}

await send('Page.enable')
await send('Network.enable')
await send('Network.setCookie', { name, value, url: `${origin}/` })
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 2, mobile: false })
await send('Page.navigate', { url: `${origin}/` })
await new Promise(resolve => setTimeout(resolve, 12000))

const info = await evaluate(`(() => {
  const buttons = [...document.querySelectorAll('button')]
    .map(b => ({
      label: (b.getAttribute('aria-label') || '').trim(),
      text: (b.innerText || '').trim().slice(0, 24),
      x: Math.round(b.getBoundingClientRect().x),
      y: Math.round(b.getBoundingClientRect().y),
      w: Math.round(b.getBoundingClientRect().width),
    }))
    .filter(b => b.label !== '' || b.text !== '')
    .filter(b => b.w > 0)
    .slice(0, 16)
  return {
    url: location.href,
    title: document.title,
    bodyText: (document.body.innerText || '').trim().slice(0, 260),
    buttons,
    isLoginPage: /远程访问登录|Remote sign-in/.test(document.body.innerText || ''),
  }
})()`)

console.log(JSON.stringify(info, null, 2))
socket.close()
