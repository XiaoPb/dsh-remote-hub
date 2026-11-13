/**
 * 在真实 Edge 里验证内置云端路径 UI（0.3.0）。
 *
 * 检查项（任何一步失败都打印现场状态，而不是静默通过）：
 *   1. 页面已由 Remote Hub 接管（`__DSH_REMOTE_HUB_CARRIER__.active`）；
 *   2. 内置样式已注入（`#remote-paths-styles`）——证明云端路径 UI 来自**本插件**；
 *   3. 「+」菜单里有 `cloud-file` 命令（由内置 UI 注册）；
 *   4. 点击后出现云端文件对话框，且目标主机 = 已配对主机；
 *   5. 目录选择流程列出**目标主机**的真实目录（证明 RPC 链路打通）。
 *
 * 注意：命令面板只响应**真实指针事件**，`element.click()` / `dispatchEvent()`
 * 不会触发 `ui.run`（JSX 层绑的是 pointerdown/pointerup），所以这里用 CDP 的
 * `Input.dispatchMouseEvent` 发真实鼠标事件。
 *
 * 用法：
 *   node scripts/verify-cloud-paths-live.mjs --target <cdp-target-id> [--shot <file.png>]
 *
 * @module scripts/verify-cloud-paths-live
 */
import { writeFileSync } from 'node:fs'

import { WebSocket } from 'ws'

const PORT = Number(process.env.CDP_PORT ?? 9222)
const targetIndex = process.argv.indexOf('--target')
const TARGET = targetIndex >= 0 ? process.argv[targetIndex + 1] : undefined
const shotIndex = process.argv.indexOf('--shot')
const SHOT = shotIndex >= 0 ? process.argv[shotIndex + 1] : undefined
if (TARGET === undefined) {
  process.stderr.write('usage: node scripts/verify-cloud-paths-live.mjs --target <cdp-target-id>\n')
  process.exit(2)
}

const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = pages.find(entry => entry.id === TARGET)
if (page === undefined) {
  process.stderr.write(`CDP target not found: ${TARGET}\n`)
  process.exit(2)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
ws.on('message', raw => {
  const message = JSON.parse(raw.toString())
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
  }
})
await new Promise(resolve => ws.once('open', resolve))

/** 发送一条 CDP 命令。 */
function send(method, params) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise(resolve => pending.set(id, resolve))
}

/** 在页面里求值；异常转成 `ERROR:` 前缀字符串。 */
async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (res.result?.exceptionDetails) {
    return `ERROR: ${String(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text).split('\n')[0]}`
  }
  return res.result?.result?.value
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 用真实鼠标事件点击第一个匹配元素。
 * @param matcher - 在页面里求值得到的谓词源码（参数 `e`）。
 * @returns 结果标签。
 */
async function realClick(matcher) {
  const rect = await evaluate(`(() => {
    const els = Array.from(document.querySelectorAll('button,[role=option],[role=menuitem],[data-remote-directory]'))
    const el = els.find(e => (${matcher})(e))
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
  })()`)
  if (typeof rect !== 'string' || !rect.startsWith('{')) return `not-clickable:${String(rect).slice(0, 80)}`
  const { x, y } = JSON.parse(rect)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  return 'clicked'
}

const steps = []
let failures = 0

/** 记录一步结果。 */
function step(name, ok, detail) {
  steps.push({ name, ok })
  if (!ok) failures += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  — ${String(detail ?? '').slice(0, 300)}`}\n`)
}

// 1. 接管状态
const carrierRaw = await evaluate('JSON.stringify({ active: globalThis.__DSH_REMOTE_HUB_CARRIER__?.active ?? null, origin: globalThis.__DSH_TRANSPORT__?.streamBaseUrl ?? null })')
const carrier = carrierRaw.startsWith('ERROR') ? {} : JSON.parse(carrierRaw)
step('remote takeover active', carrier.active === true, carrierRaw)
step('built-in cloud path styles injected', await evaluate("!!document.getElementById('remote-paths-styles')") === true, 'styles missing')

// 2. 先关掉可能残留的权限提示（官方插件在接管模式下会尝试调用红线 endpoint，
//    提示层会挡住后续点击；这是预期内的降级提示，不是被测对象）。
if (await evaluate("!!document.querySelector('[data-testid=\"remote-permission-close\"]')") === true) {
  await realClick("e => e.getAttribute('data-testid') === 'remote-permission-close'")
  await sleep(400)
}

// 3. 打开「+」菜单，确认 cloud-file 命令
await evaluate("document.querySelector('[aria-label=\"添加文件或调用指令\"]')?.click()")
await sleep(700)
const menu = await evaluate("Array.from(document.querySelectorAll('button,[role=option]')).map(e => (e.innerText||'').replace(/\\n/g,'|').trim())")
step('cloud-file command is registered', Array.isArray(menu) && menu.some(item => String(item).includes('cloud-file')), menu)
step('cloud-file command clicked', await realClick("e => (e.innerText||'').includes('cloud-file')") === 'clicked')
await sleep(2500)

// 4. 云端文件对话框（权限提示层会立刻再冒出，先关一次再判定）
if (await evaluate("!!document.querySelector('[data-testid=\"remote-permission-close\"]')") === true) {
  await realClick("e => e.getAttribute('data-testid') === 'remote-permission-close'")
  await sleep(400)
}
const filesDialog = await evaluate("document.querySelector('[data-testid=\"remote-files-dialog\"]')?.innerText ?? null")
step('cloud files dialog rendered', typeof filesDialog === 'string', await evaluate("document.querySelector('.rhp-mask')?.innerText?.slice(0,200) ?? '(none)'"))
if (carrier.origin) step('cloud files dialog targets the paired host', String(filesDialog).includes(carrier.origin), filesDialog)
await realClick("e => (e.innerText||'').trim() === '取消' && !!e.closest('[data-testid=\"remote-files-dialog\"]')")
await sleep(500)

// 5. 目录浏览流程（走目录根，列出目标主机真实目录）
if (await evaluate("document.querySelector('[data-testid=\"remote-permission-close\"]')") !== null) {
  await realClick("e => e.getAttribute('data-testid') === 'remote-permission-close'")
  await sleep(300)
}
await realClick("e => (e.getAttribute('aria-label') || '').includes('工作区')")
await sleep(3000)
const dirDialog = await evaluate("document.querySelector('[data-testid=\"remote-paths-dialog\"]')?.innerText ?? null")
step('cloud directory dialog rendered', typeof dirDialog === 'string', await evaluate("document.querySelector('.rhp-mask')?.innerText?.slice(0,200) ?? '(none)'"))
const dirs = await evaluate("JSON.stringify(Array.from(document.querySelectorAll('[data-remote-directory]')).map(e => e.getAttribute('data-remote-directory')).slice(0, 12))")
if (carrier.origin) step('cloud directory dialog targets the paired host', String(dirDialog).includes(carrier.origin), dirDialog)
step('cloud directory lists real remote entries', (() => {
  try { return JSON.parse(dirs).length > 0 } catch { return false }
})(), dirs)
process.stdout.write(`      remote entries: ${dirs}\n`)

if (SHOT !== undefined) {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot.result?.data) {
    writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'))
    process.stdout.write(`      screenshot: ${SHOT}\n`)
  }
}

process.stdout.write(`\n${steps.length - failures}/${steps.length} live checks passed\n`)
ws.close()
process.exit(failures === 0 ? 0 : 1)
