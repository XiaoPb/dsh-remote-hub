/**
 * 列表折叠行为实机校验（可信客户端 / 对端账号）。
 *
 * 校验点：默认只显示 3 条 → 点「显示全部」全出、按钮变「收起」→ 再点回到 3 条。
 *
 * 用法：`node scripts/verify-list-collapse.mjs <target> <token>`
 * 环境变量：`SANDBOX_PASSWORD`、`SANDBOX_TOTP_SECRET`、`CDP_PORT`、`SANDBOX_ORIGIN`。
 *
 * @module scripts/verify-list-collapse
 */
import { WebSocket } from 'ws'

const [, , target, token] = process.argv
const PORT = Number(process.env.CDP_PORT ?? 9222)
const ORIGIN = process.env.SANDBOX_ORIGIN ?? 'http://127.0.0.1:3091'
const PASSWORD = process.env.SANDBOX_PASSWORD
const SECRET = process.env.SANDBOX_TOTP_SECRET

if (target === undefined || token === undefined || PASSWORD === undefined || SECRET === undefined) {
  console.error('usage: SANDBOX_PASSWORD=... SANDBOX_TOTP_SECRET=... node scripts/verify-list-collapse.mjs <target> <token>')
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

await send('Page.navigate', { url: `${ORIGIN}/?token=${token}` })
await sleep(6000)
await evaluate(`fetch('remote-auth/logout',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:'{}'}).then(()=>true)`)
await evaluate('location.reload()')
await sleep(6000)

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

const fill = (selector, value) => evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return 'missing'
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return 'ok'
})()`)

await fill('[data-testid=login-username]', 'admin')
await fill('[data-testid=login-password]', PASSWORD)
await evaluate(`document.querySelector('[data-testid=login-submit]').click()`)
await sleep(2200)
await sleep(1200)
await fill('[data-testid=mfa-code]', totpCodeAt(SECRET, Date.now()))
await evaluate(`document.querySelector('[data-testid=mfa-submit]').click()`)
await sleep(2800)

const result = await evaluate(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const p = document.querySelector('[data-testid=account-page]')
  if (!p) return null
  const read = (sectionId, rowId, buttonId) => {
    const section = p.querySelector('[data-testid=' + sectionId + ']')
    if (!section) return null
    const button = section.querySelector('[data-testid=' + buttonId + ']')
    return {
      rows: section.querySelectorAll('[data-testid=' + rowId + ']').length,
      button: button ? button.innerText.trim() : null,
      more: section.querySelector('.rh-list-more')
        ? section.querySelector('.rh-list-more').innerText.replace(/\\n/g, ' | ')
        : null,
    }
  }
  const sections = [
    ['clients-list', 'trusted-client', 'clients-show-all'],
    ['peer-accounts', 'peer-account', 'peers-show-all'],
  ]
  // 展开两个区块卡片。
  for (const [sectionId] of sections) {
    const toggle = p.querySelector('[data-testid=' + sectionId + '] [data-testid=section-toggle]')
    if (toggle && toggle.getAttribute('aria-expanded') === 'false') { toggle.click(); await sleep(400) }
  }
  const states = {}
  for (const [sectionId, rowId, buttonId] of sections) {
    states[sectionId] = { collapsed: read(sectionId, rowId, buttonId) }
    const expand = p.querySelector('[data-testid=' + buttonId + ']')
    if (expand) { expand.click(); await sleep(600) }
    states[sectionId].expanded = read(sectionId, rowId, buttonId)
    const collapse = p.querySelector('[data-testid=' + buttonId + ']')
    if (collapse) { collapse.click(); await sleep(600) }
    states[sectionId].collapsedAgain = read(sectionId, rowId, buttonId)
  }
  return states
})()`)

socket.close()

const failures = []
for (const [sectionId, state] of Object.entries(result ?? {})) {
  if (state.collapsed === null) { failures.push(`${sectionId}: missing`); continue }
  if (state.collapsed.rows !== 3) failures.push(`${sectionId}: default rows ${state.collapsed.rows} != 3`)
  if (state.collapsed.button !== '显示全部') failures.push(`${sectionId}: collapsed button "${state.collapsed.button}"`)
  if (state.expanded.rows <= 3) failures.push(`${sectionId}: expand did not reveal more rows`)
  if (state.expanded.button !== '收起') failures.push(`${sectionId}: expanded button "${state.expanded.button}" (expected 收起)`)
  if (state.collapsedAgain.rows !== 3) failures.push(`${sectionId}: collapse did not return to 3 rows`)
}

console.log(JSON.stringify({ opened, result, failures }, null, 2))
if (failures.length > 0 || opened !== 'ok') process.exitCode = 1
