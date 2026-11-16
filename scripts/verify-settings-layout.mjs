/**
 * 设置页（登录与账号）实机校验：页头横向留白对齐 + 两个列表的「显示部分」行为。
 *
 * 通过 CDP 驱动真实浏览器：登出 → 打开设置 → 登录（账号口令 → 两步验证）
 * → 量几何 → 展开两个列表 → 点「显示全部」→ 再量。
 *
 * 用法：`node scripts/verify-settings-layout.mjs <target> <token>`
 * 环境变量：`SANDBOX_PASSWORD`（必填）、`SANDBOX_TOTP_SECRET`（必填）、
 *   `CDP_PORT`（默认 9222）、`SANDBOX_ORIGIN`（默认 http://127.0.0.1:3091）。
 *
 * @module scripts/verify-settings-layout
 */
import { WebSocket } from 'ws'

const [, , target, token] = process.argv
const PORT = Number(process.env.CDP_PORT ?? 9222)
const ORIGIN = process.env.SANDBOX_ORIGIN ?? 'http://127.0.0.1:3091'
const PASSWORD = process.env.SANDBOX_PASSWORD
const SECRET = process.env.SANDBOX_TOTP_SECRET

if (target === undefined || token === undefined || PASSWORD === undefined || SECRET === undefined) {
  console.error('usage: SANDBOX_PASSWORD=... SANDBOX_TOTP_SECRET=... node scripts/verify-settings-layout.mjs <target> <token>')
  process.exit(2)
}

/** 与认证服务同源的 TOTP 实现（`lib/auth.js`）。 */
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
/** 在页面里求值并取回 JSON 结果。 */
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 400))
  return result.result.value
}
/** 等待。 */
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

/** 用原生 setter 填受控输入（避免 Ctrl+A 被快捷键吞掉）。 */
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
  p.scrollTop = 0
  const pr = p.getBoundingClientRect()
  const at = (el) => Math.round(el.getBoundingClientRect().left - pr.left)
  const sticky = p.querySelector('.rh-page-sticky')
  const header = {
    pageWidth: Math.round(pr.width),
    containerPad: getComputedStyle(p).paddingLeft,
    shellPad: getComputedStyle(p.querySelector('.rh-shell')).paddingLeft,
    stickyLeft: at(sticky),
    titleLeft: at(p.querySelector('[data-testid=account-title]')),
    stepsLeft: at(p.querySelector('[data-testid=account-steps]')),
    cardLeft: at(p.querySelector('[data-testid=local-account]')),
  }
  for (const sectionId of ['clients-list', 'peer-accounts']) {
    const section = p.querySelector('[data-testid=' + sectionId + ']')
    const toggle = section && section.querySelector('[data-testid=section-toggle]')
    if (toggle && toggle.getAttribute('aria-expanded') === 'false') { toggle.click(); await sleep(400) }
  }
  const readList = (sectionId, rowId, showAllId) => {
    const section = p.querySelector('[data-testid=' + sectionId + ']')
    if (!section) return null
    return {
      rows: section.querySelectorAll('[data-testid=' + rowId + ']').length,
      hasShowAll: !!section.querySelector('[data-testid=' + showAllId + ']'),
      moreText: section.querySelector('.rh-list-more')
        ? section.querySelector('.rh-list-more').innerText.replace(/\\n/g, ' | ')
        : null,
    }
  }
  const before = {
    clients: readList('clients-list', 'trusted-client', 'clients-show-all'),
    peers: readList('peer-accounts', 'peer-account', 'peers-show-all'),
  }
  for (const key of ['clients-show-all', 'peers-show-all']) {
    const button = p.querySelector('[data-testid=' + key + ']')
    if (button) { button.click(); await sleep(500) }
  }
  const after = {
    clients: readList('clients-list', 'trusted-client', 'clients-show-all'),
    peers: readList('peer-accounts', 'peer-account', 'peers-show-all'),
  }
  return { header, before, after }
})()`)

socket.close()

const header = result && result.header
const aligned = header !== null && header !== undefined
  && header.titleLeft === header.cardLeft
  && header.stepsLeft === header.cardLeft
const failures = []
if (opened !== 'ok') failures.push(`settings did not open (${opened})`)
if (result === null) failures.push('account page missing after login')
if (!aligned) failures.push(`header not aligned with cards: ${JSON.stringify(header)}`)

console.log(JSON.stringify({ opened, ...result, aligned, failures }, null, 2))
if (failures.length > 0) process.exitCode = 1
