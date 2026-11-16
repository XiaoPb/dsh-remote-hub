/**
 * 生成最终文档截图集。
 *
 * 每个场景独立登录、独立导航、独立截图，文件名带场景名，避免互相覆盖。
 *
 * @module scripts/make-doc-shots
 */
import { writeFileSync } from 'node:fs'
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
const cookieName = pair.slice(0, separator)
const cookieValue = pair.slice(separator + 1)

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
  setTimeout(() => { if (pending.delete(rpcId)) reject(new Error(`timeout: ${method}`)) }, 60000)
})
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) return { error: JSON.stringify(result.exceptionDetails).slice(0, 300) }
  return result.result.value
}

await send('Page.enable')
await send('Network.enable')
await send('Network.setCookie', { name: cookieName, value: cookieValue, url: `${origin}/` })

/**
 * 导航到首页并等界面稳定。
 *
 * @param {number} width - 视口宽。
 * @param {number} height - 视口高。
 */
async function goHome(width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false })
  await send('Page.navigate', { url: `${origin}/` })
  await new Promise(resolve => setTimeout(resolve, 12000))
}

/**
 * 截图并保存。
 *
 * @param {string} name - 文件名（不带扩展名）。
 * @returns {Promise<number>} 字节数。
 */
async function save(name) {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const buffer = Buffer.from(shot.data, 'base64')
  writeFileSync(`docs/images/${name}.png`, buffer)
  return buffer.length
}

/** 打开「添加工作区」的目录选择器。 */
const openWorkspacePicker = `(() => {
  const entry = [...document.querySelectorAll('button')]
    .find(el => /添加工作区|Add workspace/i.test((el.getAttribute('aria-label') || '') + (el.innerText || '')))
  if (entry === undefined) return 'no-entry'
  entry.click()
  return 'clicked'
})()`

/** 打开 设置 → 登录与账号。 */
const openAccountPage = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const settings = [...document.querySelectorAll('button')].find(b => /^设置$|^Settings$/.test((b.innerText || '').trim()))
    ?? [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '') === '设置')
  if (settings === undefined) return 'no-settings'
  settings.click()
  await sleep(2200)
  const tab = [...document.querySelectorAll('[role=tab],button,a')].find(e => /登录与账号|Sign-in|Account/i.test(e.innerText || ''))
  if (tab === undefined) return 'no-tab'
  tab.click()
  await sleep(2600)
  return 'ok'
})()`

import { mkdirSync } from 'node:fs'
mkdirSync('docs/images', { recursive: true })

// ① 登录后的主界面。
await goHome(1280, 860)
console.log('home:', await save('guard-home'))

// ② 新建工作区 → 远程目录选择器。
await goHome(1280, 860)
console.log('picker click:', await evaluate(openWorkspacePicker))
await new Promise(resolve => setTimeout(resolve, 6000))
console.log('workspace-dialog:', await save('workspace-picker'))

// ③ 设置 → 登录与账号。
await goHome(1280, 900)
console.log('account action:', await evaluate(openAccountPage))
await new Promise(resolve => setTimeout(resolve, 1500))
console.log('account-page:', await save('account-page'))

socket.close()
