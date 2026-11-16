/**
 * 首次登录向导（含改名）+ 管理员行只读 + 受信状态自愈，一次性实机校验。
 *
 * 断言：
 *   1. 初始口令登录后，第 2 步「改口令」同屏出现改名输入框，保存后账号名生效；
 *   2. 第 3 步强制绑定 TOTP，绑定前设置面 403 `auth-totp-required`；
 *   3. 进入设置页后，管理员那一行**没有**禁用/改上限/删除按钮；
 *   4. 本浏览器未受信时，「信任本浏览器」区块必须出现；
 *   5. 改名用完即失效（服务端拒绝第二次）。
 *
 * 用法：`node scripts/verify-first-login-full.mjs <target> <token> <initialPassword> <newName> <newPassword>`
 *
 * @module scripts/verify-first-login-full
 */
import { WebSocket } from 'ws'
import { totpCodeAt } from '../lib/auth.js'

const [, , target, token, initialPassword, newName, newPassword] = process.argv
const PORT = Number(process.env.CDP_PORT ?? 9222)
const ORIGIN = process.env.SANDBOX_ORIGIN ?? 'http://127.0.0.1:3091'

if ([target, token, initialPassword, newName, newPassword].some(value => value === undefined)) {
  console.error('usage: node scripts/verify-first-login-full.mjs <target> <token> <initialPassword> <newName> <newPassword>')
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
const snap = () => evaluate(`(() => {
  const p = document.querySelector('[data-testid=account-page]')
  if (!p) return { phase: 'no page' }
  const steps = p.querySelector('[data-testid=account-steps]')
  return {
    phase: p.getAttribute('data-phase'),
    step: steps ? steps.getAttribute('data-step') : null,
    hasRenameInput: !!p.querySelector('[data-testid=rename-username]'),
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

const trail = [['initial', await snap()]]

// 1) 初始口令登录
await fill('[data-testid=login-username]', 'admin')
await fill('[data-testid=login-password]', initialPassword)
await click('[data-testid=login-submit]')
await sleep(2600)
trail.push(['after-login', await snap()])

// 2) 改口令 + 改名（同屏）
await fill('[data-testid=current-password]', initialPassword)
await fill('[data-testid=new-password]', newPassword)
await fill('[data-testid=rename-username]', newName)
await sleep(300)
await click('[data-testid=change-password-submit]')
await sleep(3500)
// 改名与改密是同一次提交：等页面切到下一步再断言。
for (let i = 0; i < 40; i++) {
  if ((await snap()).phase !== 'change-password') break
  await sleep(200)
}
trail.push(['after-change+rename', await snap()])

// 3) 绑定 TOTP 前：设置面必须 403
const gated = await evaluate(`(async () => {
  const response = await fetch('remote-auth/accounts', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'list' }),
  })
  const body = await response.json().catch(() => null)
  return { status: response.status, code: body ? body.code : null }
})()`)

// 4) 强制绑定 TOTP
let secret = null
await click('[data-testid=totp-start]')
await sleep(1300)
secret = await evaluate(`(() => {
  const el = document.querySelector('[data-testid=totp-secret]')
  return el ? el.innerText.trim() : null
})()`)
if (secret !== null) {
  await fill('[data-testid=totp-confirm-code]', totpCodeAt(secret, Date.now()))
  await click('[data-testid=totp-confirm]')
  await sleep(3000)
}
trail.push(['after-totp', await snap()])

// 5) 设置页：管理员行只读 + 信任区可见
const ready = await evaluate(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const p = document.querySelector('[data-testid=account-page]')
  if (!p) return null
  for (const id of ['local-account', 'sub-accounts']) {
    const toggle = p.querySelector('[data-testid=' + id + '] [data-testid=section-toggle]')
    if (toggle && toggle.getAttribute('aria-expanded') === 'false') { toggle.click(); await sleep(300) }
  }
  await sleep(400)
  const adminRow = [...p.querySelectorAll('[data-testid=sub-account]')]
    .find(row => row.getAttribute('data-username') && row.querySelector('.rh-pill'))
  const rowButtons = (row) => row === undefined ? null : [...row.querySelectorAll('button')].map(b => b.innerText.trim())
  return {
    username: (p.querySelector('[data-testid=account-user]') || {}).innerText ?? null,
    hasTrustSection: !!p.querySelector('[data-testid=trust-section]'),
    trustTitle: p.querySelector('[data-testid=trust-section] .rh-section-title')
      ? p.querySelector('[data-testid=trust-section] .rh-section-title').innerText.replace(/\\n/g, ' | ')
      : null,
    accountClient: (p.querySelector('[data-testid=account-client]') || {}).innerText ?? null,
    adminRowButtons: rowButtons(adminRow),
    adminNote: p.querySelector('[data-testid=sub-account-admin-note]')
      ? p.querySelector('[data-testid=sub-account-admin-note]').innerText
      : null,
    hasRenameInput: !!p.querySelector('[data-testid=rename-username]'),
  }
})()`)

// 6) 改名机会用完：服务端拒绝第二次
const secondRename = await evaluate(`(async () => {
  const status = await (await fetch('remote-auth/status', { credentials: 'same-origin' })).json()
  const response = await fetch('remote-auth/accounts', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'rename', accountId: status.session.accountId, username: 'another-name' }),
  })
  const body = await response.json().catch(() => null)
  return { renameAllowed: status.usernameRenameAllowed, status: response.status, code: body ? body.code : null, username: status.username }
})()`)

socket.close()

const failures = []
const phases = trail.map(([, entry]) => entry.phase)
if (phases[0] !== 'login') failures.push(`initial ${phases[0]}`)
if (phases[1] !== 'change-password') failures.push(`after login ${phases[1]}`)
if (trail[1][1].hasRenameInput !== true) failures.push('rename input missing on the password step')
if (phases[2] !== 'enroll-totp') failures.push(`after change expected enroll-totp, got ${phases[2]}`)
if (gated.status !== 403 || gated.code !== 'auth-totp-required') failures.push(`gate ${gated.status}/${gated.code}`)
if (phases[3] !== 'ready') failures.push(`after totp ${phases[3]}`)
if (ready === null) failures.push('settings page missing')
else {
  if (!String(ready.username ?? '').includes(newName)) failures.push(`rename did not stick (${ready.username})`)
  if (ready.hasTrustSection !== true) failures.push('trust section missing while this browser is untrusted')
  if (ready.hasRenameInput === true) failures.push('rename input still present in settings')
  const buttons = ready.adminRowButtons ?? []
  if (buttons.some(label => /禁用|删除|修改上限/.test(label))) {
    failures.push(`admin row still exposes destructive actions: ${JSON.stringify(buttons)}`)
  }
  if (ready.adminNote === null) failures.push('admin row note missing')
}
if (secondRename.renameAllowed !== false) failures.push('rename still advertised after use')
if (secondRename.status < 400) failures.push(`second rename accepted (${secondRename.status})`)

console.log(JSON.stringify({ trail, gated, ready, secondRename, secretFound: secret !== null, failures }, null, 2))
if (failures.length > 0) process.exitCode = 1
