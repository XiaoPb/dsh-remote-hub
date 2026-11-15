/**
 * 出站卡片事实行实测：列数只能是 4 / 2 / 1，且每项单行、不截断。
 *
 * 用法：`node scripts/verify-fact-grid.mjs <target> <token>`
 * 环境变量：`CDP_PORT`、`SANDBOX_ORIGIN`、`GRID_WIDTHS`。
 *
 * @module scripts/verify-fact-grid
 */
import { WebSocket } from 'ws'

const [, , target, token] = process.argv
const PORT = Number(process.env.CDP_PORT ?? 9222)
const ORIGIN = process.env.SANDBOX_ORIGIN ?? 'http://127.0.0.1:3091'
const WIDTHS = (process.env.GRID_WIDTHS ?? '1440,1300,1240,1120,980,860').split(',').map(Number)

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
  if (result.exceptionDetails !== undefined) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 300))
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
  const { windowId } = await send('Browser.getWindowForTarget')
  await send('Browser.setWindowBounds', { windowId, bounds: { width, height: 1000 } })
  await sleep(1300)
  const measured = await evaluate(`(() => {
    const grid = document.querySelector('[data-testid=outbound-paired-list]')
    if (!grid) return null
    const card = [...grid.children].find(el => el.querySelector('[data-testid=outbound-facts]'))
    if (!card) return null
    const facts = card.querySelector('[data-testid=outbound-facts]')
    const items = [...facts.querySelectorAll('.rh-fact-item')]
    const rows = [...new Set(items.map(item => Math.round(item.getBoundingClientRect().top)))]
    const columns = [...new Set(items.map(item => Math.round(item.getBoundingClientRect().left)))]
    const lines = (el) => {
      const style = getComputedStyle(el)
      const size = Number.parseFloat(style.fontSize)
      const raw = Number.parseFloat(style.lineHeight)
      const lh = Number.isFinite(raw) ? raw : size * 1.35
      return Math.round(el.getBoundingClientRect().height / lh)
    }
    const values = [...facts.querySelectorAll('.rh-fact-value')]
    return {
      innerWidth,
      cardWidth: Math.round(card.getBoundingClientRect().width),
      factWidth: Math.round(facts.getBoundingClientRect().width),
      columns: columns.length,
      rows: rows.length,
      maxValueLines: Math.max(0, ...values.map(lines)),
      truncated: values.filter(node => node.scrollWidth > node.clientWidth + 1).length,
      docOverflow: document.documentElement.scrollWidth > innerWidth + 2,
    }
  })()`)
  results.push({ requested: width, ...(measured ?? { missing: true }) })
}

const { windowId } = await send('Browser.getWindowForTarget')
await send('Browser.setWindowBounds', { windowId, bounds: { width: 1440, height: 1000 } })
socket.close()

const failures = []
for (const row of results) {
  if (row.missing === true) { failures.push(`${row.requested}px: no cards`); continue }
  if (![1, 2, 4].includes(row.columns)) failures.push(`${row.requested}px: ${row.columns} columns (only 4/2/1 allowed)`)
  if (row.maxValueLines > 1) failures.push(`${row.requested}px: fact value wrapped`)
  if (row.truncated > 0) failures.push(`${row.requested}px: ${row.truncated} fact value(s) clipped`)
  if (row.columns * row.rows !== 4) failures.push(`${row.requested}px: ${row.columns}x${row.rows} != 4 items`)
  if (row.docOverflow === true) failures.push(`${row.requested}px: horizontal overflow`)
}
console.log(JSON.stringify({ results, failures }, null, 2))
if (failures.length > 0) process.exitCode = 1
