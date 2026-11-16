/**
 * 「仅首次登录可改一次账号名」实机校验。
 *
 * 校验点：
 *   1. 未用过改名机会时，设置页出现「修改账号名」入口；
 *   2. 走一次改名（行内 2FA），账号名变化；
 *   3. 之后再刷新，入口消失；
 *   4. 服务端也拒绝第二次改名（`auth-forbidden`）。
 *
 * 用法：`node scripts/verify-rename.mjs <target> <token> <newName>`
 * 环境变量：`SANDBOX_PASSWORD`、`SANDBOX_TOTP_SECRET`、`CDP_PORT`、`SANDBOX_ORIGIN`。
 *
 * @module scripts/verify-rename
 */
import { WebSocket } from 'ws'

const [, , target, token, newName = 'hub-admin'] = process.argv
const PORT = Number(process.env.CDP_PORT ?? 9222)
const ORIGIN = process.env.SANDBOX_ORIGIN ?? 'http://127.0.0.1:3091'
const PASSWORD = process.env.SANDBOX_PASSWORD
const SECRET = process.env.SANDBOX_TOTP_SECRET
const USER = process.env.SANDBOX_USER ?? 'admin'

if (target === undefined || token === undefined || PASSWORD === undefined || SECRET === undefined) {
  console.error('usage: SANDBOX_PASSWORD=... SANDBOX_TOTP_SECRET=... node scripts/verify-rename.mjs <target> <token> [newName]')
  process.exit(2)
}

const { totpCodeAt } = await import('../lib/auth.js')

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
/** 发一条 CDP 命令。 */
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const rpcId = ++id
  pending.set(rpcId, { resolve, reject })
  socket.send(JSON.stringify({ id: rpcId, method, params }))
})
/** 在页面里求值。 */
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

/** 填受控输入。 */
const fill = (selector, value) => evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return 'missing'
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return 'ok'
})()`)

/** 登录（账号口令 → 动态码）。 */
const login = async (username) => {
  await fill('[data-testid=login-username]', username)
  await fill('[data-testid=login-password]', PASSWORD)
  await evaluate(`document.querySelector('[data-testid=login-submit]').click()`)
  await sleep(2200)
  await sleep(1200)
  await fill('[data-testid=mfa-code]', totpCodeAt(SECRET, Date.now()))
  await evaluate(`document.querySelector('[data-testid=mfa-submit]').click()`)
  await sleep(2800)
  return evaluate(`(() => {
    const p = document.querySelector('[data-testid=account-page]')
    return p ? p.getAttribute('data-phase') : 'no page'
  })()`)
}

await send('Page.navigate', { url: `${ORIGIN}/?token=${token}` })
await sleep(6000)
await evaluate(`fetch('remote-auth/logout',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:'{}'}).then(()=>true)`)
await evaluate('location.reload()')
await sleep(6000)

const opened = await openSettings()
const phase = await login(USER)

// 展开「本机账号」卡片，看改名入口是否存在。
const before = await evaluate(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const p = document.querySelector('[data-testid=account-page]')
  const toggle = p.querySelector('[data-testid=local-account] [data-testid=section-toggle]')
  if (toggle && toggle.getAttribute('aria-expanded') === 'false') { toggle.click(); await sleep(400) }
  return {
    hasRenameOpen: !!p.querySelector('[data-testid=rename-open]'),
    user: (p.querySelector('[data-testid=account-user]') || {}).innerText ?? null,
  }
})()`)

let afterRename = null
if (before.hasRenameOpen === true) {
  await evaluate(`document.querySelector('[data-testid=rename-open]').click()`)
  await sleep(400)
  await fill('[data-testid=rename-username]', newName)
  await evaluate(`document.querySelector('[data-testid=rename-submit]').click()`)
  await sleep(800)
  await fill('[data-testid=rename-verify-password]', PASSWORD)
  await fill('[data-testid=rename-verify-code]', totpCodeAt(SECRET, Date.now()))
  await evaluate(`document.querySelector('[data-testid=rename-verify-submit]').click()`)
  await sleep(3000)
  afterRename = await evaluate(`(() => {
    const p = document.querySelector('[data-testid=account-page]')
    if (!p) return null
    return {
      hasRenameOpen: !!p.querySelector('[data-testid=rename-open]'),
      user: (p.querySelector('[data-testid=account-user]') || {}).innerText ?? null,
      title: (p.querySelector('.rh-section-title') || {}).innerText ?? null,
    }
  })()`)
}

// 服务端应拒绝第二次改名（直接用接口验证）。
const second = await evaluate(`(async () => {
  const status = await (await fetch('remote-auth/status', { credentials: 'same-origin' })).json()
  const response = await fetch('remote-auth/accounts', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'rename', accountId: status.session.accountId, username: ${JSON.stringify(`${newName}-again`)} }),
  })
  return { status: response.status, body: await response.json().catch(() => null), renameAllowed: status.usernameRenameAllowed }
})()`)

socket.close()

const failures = []
if (opened !== 'ok') failures.push(`settings did not open (${opened})`)
if (phase !== 'ready') failures.push(`login did not reach ready (${phase})`)
if (before.hasRenameOpen !== true) failures.push('rename entry missing even though it was never used')
if (afterRename === null) failures.push('rename flow was not executed')
else {
  if (afterRename.hasRenameOpen !== false) failures.push('rename entry still visible after using it once')
  if (!String(afterRename.user ?? '').includes(newName)) failures.push(`rename did not take effect (${afterRename.user})`)
}
if (second.renameAllowed !== false) failures.push('status still advertises rename after use')
if (second.status < 400) failures.push(`server accepted a second rename (status ${second.status})`)

console.log(JSON.stringify({ opened, phase, before, afterRename, second, failures }, null, 2))
if (failures.length > 0) process.exitCode = 1
