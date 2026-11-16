/**
 * 绑定 TOTP（新实例首次登录后必需），完成后重试子账号创建。
 *
 * 用法：`node scripts/verify-sub-account-commit.mjs <target> [username]`
 * 会先用页面给出的密钥完成绑定，再创建子账号并核对 auth.db。
 *
 * @module scripts/verify-sub-account-commit
 */
import { DatabaseSync } from 'node:sqlite'
import { WebSocket } from 'ws'
import { totpCodeAt } from '../lib/auth.js'

const [, , target, username = 'deferred-probe'] = process.argv
const PORT = Number(process.env.CDP_PORT ?? 9222)
const HUB_DIR = process.env.HUB_DIR
  ?? 'E:\\dsh-box-data\\dsh-box-files\\data\\sandboxes\\testhub\\home\\remote-hub'

/** 读账号名列表。 */
function accounts() {
  const db = new DatabaseSync(`${HUB_DIR}\\auth.db`)
  try {
    return db.prepare('SELECT username, substr(password_hash, 1, 7) AS prefix FROM accounts').all()
  } finally {
    db.close()
  }
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

const before = accounts()

// 1) 绑定 TOTP（如果还没绑定）。
const needsTotp = await evaluate(`!!document.querySelector('[data-testid=totp-start]')`)
let secret = null
if (needsTotp === true) {
  await evaluate(`(() => {
    const t = document.querySelector('[data-testid=totp-section] [data-testid=section-toggle]')
    if (t && t.getAttribute('aria-expanded') === 'false') t.click()
    return true
  })()`)
  await sleep(500)
  await click('[data-testid=totp-start]')
  await sleep(1200)
  secret = await evaluate(`(() => {
    const el = document.querySelector('[data-testid=totp-secret]')
    return el ? el.innerText.trim() : null
  })()`)
  if (secret !== null) {
    await fill('[data-testid=totp-confirm-code]', totpCodeAt(secret, Date.now()))
    await click('[data-testid=totp-confirm]')
    await sleep(2500)
  }
}

// 2) 子账号创建（需要新鲜 2FA，此时刚确认过绑定）。
const created = await evaluate(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const p = document.querySelector('[data-testid=account-page]')
  if (!p) return 'no page'
  const toggle = p.querySelector('[data-testid=sub-accounts] [data-testid=section-toggle]')
  if (toggle && toggle.getAttribute('aria-expanded') === 'false') { toggle.click(); await sleep(400) }
  if (!p.querySelector('[data-testid=sub-accounts]')) return 'no sub-accounts block'
  const open = p.querySelector('[data-testid=sub-account-create-open]')
  if (open) { open.click(); await sleep(400) }
  const input = p.querySelector('[data-testid=sub-account-username]')
  if (!input) return 'no username input'
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(username)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(200)
  p.querySelector('[data-testid=sub-account-create]').click()
  await sleep(3000)
  const now = document.querySelector('[data-testid=account-page]')
  const err = now.querySelector('[data-testid=sub-account-error]')
  return {
    rows: [...now.querySelectorAll('[data-testid=sub-account]')].map(r => r.getAttribute('data-username')),
    error: err ? err.innerText : null,
  }
})()`)

await sleep(600)
const after = accounts()
socket.close()

const failures = []
if (typeof created === 'string') failures.push(`ui: ${created}`)
else {
  if (!(created.rows ?? []).includes(username)) failures.push(`row missing (${JSON.stringify(created)})`)
  if (created.error !== null) failures.push(`ui error: ${created.error}`)
}
if (!after.some(row => row.username === username)) failures.push('sub-account is not in auth.db right after creation')
if (!after.every(row => String(row.prefix).startsWith('scrypt$'))) failures.push('an account is stored without a scrypt hash')

console.log(JSON.stringify({ needsTotp, secretFound: secret !== null, before, after, created, failures }, null, 2))
if (failures.length > 0) process.exitCode = 1
