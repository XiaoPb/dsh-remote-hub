/**
 * 首次登录向导全流程实机验证（全新实例）。
 *
 * 期望顺序：登录（初始口令）→ 强制改密 → **强制绑定 TOTP** → 进入设置页 ready。
 * 中途不得直接进 ready；绑定之前服务端也要拒绝设置面。
 *
 * 用法：`node scripts/verify-first-login-wizard.mjs <target> <token> <initialPassword> [newPassword]`
 * 环境变量：`SANDBOX_TOTP_SECRET`（绑定后写入，用于后续断言）、`CDP_PORT`、`SANDBOX_ORIGIN`。
 *
 * @module scripts/verify-first-login-wizard
 */
import { WebSocket } from 'ws'
import { totpCodeAt } from '../lib/auth.js'

const [, , target, token, initialPassword, newPassword = 'Svlt-9Qwm-2Xvt!'] = process.argv
const PORT = Number(process.env.CDP_PORT ?? 9222)
const ORIGIN = process.env.SANDBOX_ORIGIN ?? 'http://127.0.0.1:3091'

if (target === undefined || token === undefined || initialPassword === undefined) {
  console.error('usage: node scripts/verify-first-login-wizard.mjs <target> <token> <initialPassword> [newPassword]')
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
const snapshot = () => evaluate(`(() => {
  const p = document.querySelector('[data-testid=account-page]')
  if (!p) return { phase: 'no page' }
  const steps = p.querySelector('[data-testid=account-steps]')
  return {
    phase: p.getAttribute('data-phase'),
    step: steps ? steps.getAttribute('data-step') : null,
    title: (p.querySelector('[data-testid=account-title]') || {}).innerText ?? null,
    hasRename: !!p.querySelector('[data-testid=rename-open]'),
    hasStart: !!p.querySelector('[data-testid=totp-start]'),
    hasConfirm: !!p.querySelector('[data-testid=totp-confirm]'),
  }
})()`)

await send('Page.navigate', { url: `${ORIGIN}/?token=${token}` })
await sleep(6500)
await evaluate(`(async () => {
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

const trail = [['initial', await snapshot()]]

// 1) 用初始口令登录
await fill('[data-testid=login-username]', 'admin')
await fill('[data-testid=login-password]', initialPassword)
await click('[data-testid=login-submit]')
await sleep(2600)
trail.push(['after-login', await snapshot()])

// 2) 强制改密
await fill('[data-testid=current-password]', initialPassword)
await fill('[data-testid=new-password]', newPassword)
await click('[data-testid=change-password-submit]')
await sleep(2800)
trail.push(['after-change-password', await snapshot()])

// 3) 绑定前：服务端必须拒绝设置面
const gated = await evaluate(`(async () => {
  const response = await fetch('remote-auth/accounts', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'list' }),
  })
  const body = await response.json().catch(() => null)
  return { status: response.status, code: body ? body.code : null }
})()`)

// 4) 强制绑定页：开始绑定 → 确认
let secret = null
const beforeBind = await snapshot()
if ((await snapshot()).phase === 'enroll-totp') {
  await click('[data-testid=totp-start]')
  await sleep(1200)
  secret = await evaluate(`(() => {
    const el = document.querySelector('[data-testid=totp-secret]')
    return el ? el.innerText.trim() : null
  })()`)
  if (secret !== null) {
    await fill('[data-testid=totp-confirm-code]', totpCodeAt(secret, Date.now()))
    await click('[data-testid=totp-confirm]')
    await sleep(2800)
  }
}
trail.push(['after-totp', await snapshot()])
const afterBind = await snapshot()

// 5) 绑定后：设置面放行
const allowed = await evaluate(`(async () => {
  const response = await fetch('remote-auth/accounts', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'list' }),
  })
  return { status: response.status }
})()`)

socket.close()

const failures = []
const phases = trail.map(([, snap]) => snap.phase)
if (phases[0] !== 'login') failures.push(`initial phase ${phases[0]} != login`)
if (phases[1] !== 'change-password') failures.push(`after login expected change-password, got ${phases[1]}`)
if (phases[2] !== 'enroll-totp') failures.push(`after forced change expected enroll-totp, got ${phases[2]} (must NOT skip 2FA)`)
if (phases[3] !== 'ready') failures.push(`after TOTP expected ready, got ${phases[3]}`)
if (gated.status < 400) failures.push(`settings were reachable before TOTP (status ${gated.status})`)
if (gated.code !== 'auth-totp-required') failures.push(`unexpected gate code ${gated.code}`)
if (allowed.status !== 200) failures.push(`settings not reachable after TOTP (status ${allowed.status})`)
if (secret === null) failures.push('no TOTP secret was shown on the forced enrollment page')

console.log(JSON.stringify({
  trail,
  beforeBind,
  afterBind,
  gated,
  allowed,
  secretFound: secret !== null,
  failures,
}, null, 2))
if (failures.length > 0) process.exitCode = 1
