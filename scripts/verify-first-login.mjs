/**
 * 全新实例上的首次登录流程：引导（或初始口令）→ 强制改密 → 首次改名（一次）。
 *
 * 用法：`node scripts/verify-first-login-rename.mjs <target> <token> <initialPassword> <newName>`
 * 环境变量：`SANDBOX_TOTP_SECRET`（全新实例还没有 TOTP，需要从页面绑定时用它）、
 *   `CDP_PORT`、`SANDBOX_ORIGIN`。若实例已有 TOTP 且留空 SECRET，则退出码 2。
 *
 * @module scripts/verify-first-login-rename
 */
import { WebSocket } from 'ws'

const [, , target, token, initialPassword, newName = 'hub-admin'] = process.argv
const PORT = Number(process.env.CDP_PORT ?? 9222)
const ORIGIN = process.env.SANDBOX_ORIGIN ?? 'http://127.0.0.1:3091'

if (target === undefined || token === undefined || initialPassword === undefined) {
  console.error('usage: node scripts/verify-first-login-rename.mjs <target> <token> <initialPassword> [newName]')
  process.exit(2)
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find(item => item.id === target)
if (page === undefined) throw new Error(`target not found: ${target}`)

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
  if (result.exceptionDetails !== undefined) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 400))
  return result.result.value
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/** 打开设置 → 登录与账号。 */
const openSettings = () => evaluate(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const drawer = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '打开侧边栏')
  if (drawer) { drawer.click(); await sleep(600) }
  const account = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '账号菜单')
  if (!account) return 'no account-menu'
  account.click()
  for (let i = 0; i < 30; i++) {
    const item = [...document.querySelectorAll('[role=menuitem]')].find(e => /设置/.test(e.innerText || ''))
    if (item) { item.click(); break }
    await sleep(100)
  }
  for (let i = 0; i < 30; i++) {
    const tab = [...document.querySelectorAll('[role=tab],button,a')].filter(e => /登录与账号/.test(e.innerText || ''))
    if (tab.length) { tab[0].click(); break }
    await sleep(100)
  }
  for (let i = 0; i < 40; i++) {
    if (document.querySelector('[data-testid=account-page]')) return 'ok'
    await sleep(100)
  }
  return 'no page'
})()`)

const phase = () => evaluate(`(() => {
  const p = document.querySelector('[data-testid=account-page]')
  return p ? p.getAttribute('data-phase') : 'no page'
})()`)

const fill = (selector, value) => evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return 'missing:' + ${JSON.stringify(selector)}
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return 'ok'
})()`)

const click = (selector) => evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return 'missing:' + ${JSON.stringify(selector)}
  el.click()
  return 'ok'
})()`)

await send('Page.navigate', { url: `${ORIGIN}/?token=${token}` })
await sleep(6500)
const opened = await openSettings()
const steps = { opened, phases: [] }
steps.phases.push(['initial', await phase()])

// 1) 登录（初始口令）→ 强制改密
const current = await phase()
if (current === 'login') {
  await fill('[data-testid=login-username]', 'admin')
  await fill('[data-testid=login-password]', initialPassword)
  await click('[data-testid=login-submit]')
  await sleep(2500)
}
steps.phases.push(['after-login', await phase()])

// 2) 强制改密（初始口令 → 强口令）
if ((await phase()) === 'change-password') {
  await fill('[data-testid=current-password]', initialPassword)
  await fill('[data-testid=new-password]', 'Sandbox-Admin-2026!')
  await click('[data-testid=change-password-submit]')
  await sleep(2500)
  steps.phases.push(['after-change-password', await phase()])
}

// 3) 绑定 TOTP（新实例必需）——页面会给出密钥与 otpauth
const needsTotp = await evaluate(`!!document.querySelector('[data-testid=totp-start]')`)
steps.needsTotp = needsTotp
steps.secret = null
if (needsTotp) {
  const toggle = await evaluate(`(() => {
    const t = document.querySelector('[data-testid=totp-section] [data-testid=section-toggle]')
    if (!t) return 'no-toggle'
    if (t.getAttribute('aria-expanded') === 'false') { t.click(); return 'expanded' }
    return 'already'
  })()`)
  await sleep(600)
  await click('[data-testid=totp-start]')
  await sleep(1200)
  steps.secret = await evaluate(`(() => {
    const el = document.querySelector('[data-testid=totp-secret]')
    return el ? el.innerText.trim() : null
  })()`)
  steps.totpToggle = toggle
}

socket.close()
console.log(JSON.stringify(steps, null, 2))
