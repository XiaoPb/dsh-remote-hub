/**
 * 「首次登录前不落库」实机验证。
 *
 * 1. 登录 → 强制改密 → 账号**此时才**出现在 auth.db（且只有哈希）；
 * 2. pending-admin.json 已被删除；
 * 3. 子账号创建后**立即**落库（不走延迟路径）。
 *
 * 用法：`node scripts/verify-deferred-commit.mjs <target> <token> <initialPassword> <newPassword>`
 * 环境变量：`DB_PATH`（默认沙箱 auth.db 路径）、`CDP_PORT`、`SANDBOX_ORIGIN`。
 *
 * @module scripts/verify-deferred-commit
 */
import { existsSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { WebSocket } from 'ws'

const [, , target, token, initialPassword, newPassword = 'Sandbox-Admin-2026!'] = process.argv
const PORT = Number(process.env.CDP_PORT ?? 9222)
const ORIGIN = process.env.SANDBOX_ORIGIN ?? 'http://127.0.0.1:3091'
const DIR = process.env.HUB_DIR
  ?? 'E:\\dsh-box-data\\dsh-box-files\\data\\sandboxes\\testhub\\home\\remote-hub'

if (target === undefined || token === undefined || initialPassword === undefined) {
  console.error('usage: node scripts/verify-deferred-commit.mjs <target> <token> <initialPassword> [newPassword]')
  process.exit(2)
}

/** 读账号表（只读，短连接）。 */
function readAccounts() {
  const db = new DatabaseSync(`${DIR}\\auth.db`)
  try {
    return db.prepare('SELECT account_id, username, password_hash FROM accounts').all()
  } finally {
    db.close()
  }
}

const before = readAccounts()

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
const phase = () => evaluate(`(() => {
  const p = document.querySelector('[data-testid=account-page]')
  return p ? p.getAttribute('data-phase') : 'no page'
})()`)

await send('Page.navigate', { url: `${ORIGIN}/?token=${token}` })
await sleep(6500)
const opened = await evaluate(`(async () => {
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

const phases = [['initial', await phase()]]
if ((await phase()) === 'login') {
  await fill('[data-testid=login-username]', 'admin')
  await fill('[data-testid=login-password]', initialPassword)
  await click('[data-testid=login-submit]')
  await sleep(2600)
  phases.push(['after-login', await phase()])
}

const afterLogin = readAccounts()
const pendingFileAfterLogin = existsSync(`${DIR}\\pending-admin.json`)

if ((await phase()) === 'change-password') {
  await fill('[data-testid=current-password]', initialPassword)
  await fill('[data-testid=new-password]', newPassword)
  await click('[data-testid=change-password-submit]')
  await sleep(2800)
  phases.push(['after-change', await phase()])
}

const afterChange = readAccounts()
const pendingFileAfterChange = existsSync(`${DIR}\\pending-admin.json`)
const initialFileAfterChange = existsSync(`${DIR}\\initial-password`)

// 改密后应进入 ready；此时创建一个子账号，验证它「创建即落库」。
let subAccount = null
if ((await phase()) === 'ready') {
  const role = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const p = document.querySelector('[data-testid=account-page]')
    if (!p) return 'no page'
    const toggle = p.querySelector('[data-testid=sub-accounts] [data-testid=section-toggle]')
    if (toggle && toggle.getAttribute('aria-expanded') === 'false') { toggle.click(); await sleep(400) }
    return p.querySelector('[data-testid=sub-accounts]') ? 'ok' : 'no sub-accounts block'
  })()`)
  subAccount = { section: role }
  if (role === 'ok') {
    await click('[data-testid=sub-account-create-open]')
    await sleep(400)
    await fill('[data-testid=sub-account-username]', 'deferred-probe')
    await click('[data-testid=sub-account-create]')
    await sleep(2500)
    subAccount.created = await evaluate(`(() => {
      const p = document.querySelector('[data-testid=account-page]')
      return {
        rows: [...p.querySelectorAll('[data-testid=sub-account]')].map(r => r.getAttribute('data-username')),
        error: p.querySelector('[data-testid=sub-account-error]')
          ? p.querySelector('[data-testid=sub-account-error]').innerText
          : null,
      }
    })()`)
  }
}

const afterSubCreate = readAccounts()
socket.close()

const failures = []
if (before.length !== 0) failures.push(`auth.db already had ${before.length} account(s) before first sign-in`)
if (afterLogin.length !== 1) failures.push(`account was not committed on first sign-in (${afterLogin.length})`)
if (pendingFileAfterLogin !== false) failures.push('pending-admin.json still exists right after the first sign-in')
if (afterChange.length !== 1) failures.push(`account missing after the forced change (${afterChange.length})`)
if (pendingFileAfterChange !== false || initialFileAfterChange !== false) {
  failures.push('plaintext credential files were not removed after the forced password change')
}
const stored = afterChange[0]
if (stored !== undefined) {
  const hash = String(stored.password_hash)
  if (!hash.startsWith('scrypt$')) failures.push('stored credential is not a scrypt hash')
  if (hash.includes(newPassword)) failures.push('stored credential contains the plaintext password')
}
if (subAccount?.created !== undefined && !(subAccount.created.rows ?? []).includes('deferred-probe')) {
  failures.push(`sub-account was not created (${JSON.stringify(subAccount.created)})`)
}
if (afterSubCreate.length !== 2) {
  failures.push(`sub-account is not committed immediately (${afterSubCreate.length} accounts)`)
}

console.log(JSON.stringify({
  opened,
  phases,
  before: before.length,
  afterLogin: afterLogin.map(row => ({ username: row.username, prefix: String(row.password_hash).slice(0, 7) })),
  pendingFileAfterLogin,
  afterChange: afterChange.map(row => ({ username: row.username, prefix: String(row.password_hash).slice(0, 7) })),
  pendingFileAfterChange,
  initialFileAfterChange,
  subAccount,
  afterSubCreate: afterSubCreate.map(row => row.username),
  failures,
}, null, 2))
if (failures.length > 0 || opened !== 'ok') process.exitCode = 1
