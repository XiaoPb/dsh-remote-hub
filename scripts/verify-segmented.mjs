/**
 * 分段控件（Segmented）配色实测：选中项与悬停态都必须跟随宿主 token，不能变成纯黑。
 *
 * 用法：`node scripts/verify-segmented.mjs <target> <token>`
 * 环境变量：`SANDBOX_PASSWORD`、`SANDBOX_TOTP_SECRET`、`CDP_PORT`、`SANDBOX_ORIGIN`。
 *
 * @module scripts/verify-segmented
 */
import { WebSocket } from 'ws'

const [, , target, token] = process.argv
const PORT = Number(process.env.CDP_PORT ?? 9222)
const ORIGIN = process.env.SANDBOX_ORIGIN ?? 'http://127.0.0.1:3091'
const PASSWORD = process.env.SANDBOX_PASSWORD
const SECRET = process.env.SANDBOX_TOTP_SECRET

if (target === undefined || token === undefined || PASSWORD === undefined || SECRET === undefined) {
  console.error('usage: SANDBOX_PASSWORD=... SANDBOX_TOTP_SECRET=... node scripts/verify-segmented.mjs <target> <token>')
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

// 展开「信任本浏览器」卡片，里面就有 只读 / 可操作 / 完全控制 分段控件。
const measured = await evaluate(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const p = document.querySelector('[data-testid=account-page]')
  if (!p) return null
  const toggle = p.querySelector('[data-testid=trust-section] [data-testid=section-toggle]')
  if (toggle && toggle.getAttribute('aria-expanded') === 'false') { toggle.click(); await sleep(500) }
  const seg = p.querySelector('[data-testid=trust-section] .rh-seg')
  if (!seg) return { missing: true }
  const buttons = [...seg.querySelectorAll('.rh-seg-btn')]
  const pressed = buttons.find(b => b.getAttribute('aria-pressed') === 'true')
  const idle = buttons.find(b => b.getAttribute('aria-pressed') !== 'true')
  const read = (el, withHover = false) => {
    if (!el) return null
    const style = getComputedStyle(el)
    return {
      text: el.innerText.trim(),
      background: style.backgroundColor,
      color: style.color,
      border: style.borderTopColor,
    }
  }
  const result = {
    tokens: {
      accent: getComputedStyle(p).getPropertyValue('--rh-accent').trim(),
      accentFg: getComputedStyle(p).getPropertyValue('--rh-accent-fg').trim(),
      accentHover: getComputedStyle(p).getPropertyValue('--rh-accent-hover').trim(),
      strong: getComputedStyle(p).getPropertyValue('--rh-strong').trim(),
    },
    selected: read(pressed),
    idle: read(idle),
  }
  // 悬停选中项：直接加一个同规则的检查（用 :hover 的匹配无法脚本化，改为读取规则表）
  const sheets = [...document.styleSheets].flatMap(sheet => { try { return [...sheet.cssRules] } catch { return [] } })
  const flatten = (rules, out = []) => {
    for (const rule of rules) {
      if (rule.cssRules) flatten([...rule.cssRules], out)
      else if (rule.selectorText) out.push(rule)
    }
    return out
  }
  const all = flatten(sheets)
  const hoverRule = all.find(rule => rule.selectorText && rule.selectorText.includes('.rh-seg-btn[aria-pressed="true"]:hover'))
  result.hoverRule = hoverRule ? hoverRule.style.background || hoverRule.style.backgroundColor : null
  const genericHover = all.find(rule => rule.selectorText === '.rh-seg-btn:hover:not(:disabled)')
  result.genericHover = genericHover ? genericHover.style.color : null
  return result
})()`)

// 真实悬停：把鼠标移到选中项上，再读一次颜色。
const box = await evaluate(`(() => {
  const p = document.querySelector('[data-testid=account-page]')
  const seg = p && p.querySelector('[data-testid=trust-section] .rh-seg')
  const pressed = seg && [...seg.querySelectorAll('.rh-seg-btn')].find(b => b.getAttribute('aria-pressed') === 'true')
  if (!pressed) return null
  const r = pressed.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
})()`)
let hovered = null
if (box !== null) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
  await sleep(500)
  hovered = await evaluate(`(() => {
    const p = document.querySelector('[data-testid=account-page]')
    const seg = p.querySelector('[data-testid=trust-section] .rh-seg')
    const pressed = [...seg.querySelectorAll('.rh-seg-btn')].find(b => b.getAttribute('aria-pressed') === 'true')
    const style = getComputedStyle(pressed)
    return { text: pressed.innerText.trim(), background: style.backgroundColor, color: style.color }
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })
}

socket.close()

const failures = []
if (opened !== 'ok') failures.push(`settings did not open (${opened})`)
if (measured === null || measured.missing === true) failures.push('segmented control not found')
else {
  if (measured.selected.background === 'rgb(17, 20, 24)') failures.push('selected segment is still solid black')
  if (hovered !== null && hovered.background === 'rgb(17, 20, 24)') failures.push('hovered selected segment turned solid black')
}

console.log(JSON.stringify({ opened, measured, hovered, failures }, null, 2))
if (failures.length > 0) process.exitCode = 1
