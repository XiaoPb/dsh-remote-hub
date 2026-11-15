/**
 * 出站卡片实测：标题/副标题单行、facts 网格按宽度折成 1 行或 2 行（不截断、不折断）。
 *
 * 用法：`node scripts/verify-device-grid.mjs <target> <token>`
 * 环境变量：`CDP_PORT`、`SANDBOX_ORIGIN`、`GRID_WIDTHS`。
 *
 * @module scripts/verify-device-grid
 */
import { WebSocket } from 'ws'

const [, , target, token] = process.argv
const PORT = Number(process.env.CDP_PORT ?? 9222)
const ORIGIN = process.env.SANDBOX_ORIGIN ?? 'http://127.0.0.1:3091'
const WIDTHS = (process.env.GRID_WIDTHS ?? '1440,1240,1100,980,860').split(',').map(Number)

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
await evaluate(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const drawer = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '打开侧边栏')
  if (drawer) { drawer.click(); await sleep(600) }
  const nav = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '云端设备')
  if (nav) { nav.click(); await sleep(2200) }
  return true
})()`)

const results = []
for (const width of WIDTHS) {
  await send('Browser.setWindowBounds', { windowId: (await send('Browser.getWindowForTarget')).windowId, bounds: { width, height: 1000 } })
  await sleep(1200)
  const measured = await evaluate(`(() => {
    const grid = document.querySelector('[data-testid=outbound-paired-list]')
    if (!grid) return null
    const cards = [...grid.children].filter(el => el.getBoundingClientRect().width > 0)
    if (cards.length === 0) return null
    const tops = cards.map(card => Math.round(card.getBoundingClientRect().top))
    const perRow = tops.filter(top => top === tops[0]).length
    const lines = (el) => {
      if (!el) return 0
      const style = getComputedStyle(el)
      const size = Number.parseFloat(style.fontSize)
      const raw = Number.parseFloat(style.lineHeight)
      const lh = Number.isFinite(raw) ? raw : size * 1.35
      return Math.round(el.getBoundingClientRect().height / lh)
    }
    const card = cards[0]
    const facts = [...card.querySelectorAll('.rh-fact-item')]
    const factRows = [...new Set(facts.map(item => Math.round(item.getBoundingClientRect().top)))].length
    // 值是否被截断：scrollWidth > clientWidth 即为截断（单行省略）。
    const truncated = [...card.querySelectorAll('.rh-fact-value')]
      .filter(node => node.scrollWidth > node.clientWidth + 1).length
    const sub = card.querySelector('.rh-dev-sub')
    const subTruncated = sub !== null && sub.scrollWidth > sub.clientWidth + 1
    return {
      innerWidth,
      gridWidth: Math.round(grid.getBoundingClientRect().width),
      perRow,
      cardWidth: Math.round(card.getBoundingClientRect().width),
      nameLines: lines(card.querySelector('.rh-dev-nm')),
      subLines: lines(sub),
      subTruncated,
      facts: facts.length,
      factRows,
      factValueLines: Math.max(0, ...facts.map(item => lines(item.querySelector('.rh-fact-value')))),
      truncatedValues: truncated,
      docOverflow: document.documentElement.scrollWidth > innerWidth + 2,
    }
  })()`)
  results.push({ requested: width, ...(measured ?? { missing: true }) })
}

await send('Browser.setWindowBounds', { windowId: (await send('Browser.getWindowForTarget')).windowId, bounds: { width: 1440, height: 1000 } })
socket.close()

const failures = []
for (const row of results) {
  if (row.missing === true) { failures.push(`${row.requested}px: no cards`); continue }
  if (row.nameLines > 1) failures.push(`${row.requested}px: title wrapped`)
  if (row.subLines > 1) failures.push(`${row.requested}px: subtitle wrapped`)
  if (row.truncatedValues > 0) failures.push(`${row.requested}px: ${row.truncatedValues} fact value(s) truncated`)
  if (row.factRows > 2) failures.push(`${row.requested}px: facts spread over ${row.factRows} rows`)
  if (row.docOverflow === true) failures.push(`${row.requested}px: horizontal overflow`)
  if (row.cardWidth < 380) failures.push(`${row.requested}px: card ${row.cardWidth}px < 380px`)
}
console.log(JSON.stringify({ results, failures }, null, 2))
if (failures.length > 0) process.exitCode = 1
