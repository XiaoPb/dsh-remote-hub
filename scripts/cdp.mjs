/**
 * Edge/Chrome CDP 驱动：真实操作页面（点击、输入、读取 DOM、截图）。
 *
 * 为什么需要它：只用 HTTP 探针验证 RPC 会漏掉整层 UI 缺陷（页面上根本点不到、
 * 断开后不能重连等）。本脚本通过 DevTools 协议驱动**真实浏览器**，操作结果以
 * DOM 实际状态为准。
 *
 * 用法（需先以 --remote-debugging-port=9222 启动 Edge）：
 *   node scripts/cdp.mjs --target <target-id|exact-url> open <url>
 *   node scripts/cdp.mjs --target <target-id|exact-url> text [selector]
 *   node scripts/cdp.mjs --target <target-id|exact-url> click "<text>"|--selector <css>
 *   node scripts/cdp.mjs type --selector <css> --value <text>
 *   node scripts/cdp.mjs eval "<js>"
 *   node scripts/cdp.mjs shot <file.png>
 *   node scripts/cdp.mjs wait "<text>" [timeoutMs]
 *
 * @module scripts/cdp
 */
import { writeFileSync } from 'node:fs'
import { WebSocket } from 'ws'
import { safeTargetUrl, selectPageTarget } from './cdp-target.mjs'

const PORT = Number(process.env.CDP_PORT ?? 9222)

/** Resolve a page using --target <target-id|exact-url>; refuse ambiguous tabs. */
async function selectedPage() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  const list = await res.json()
  const args = process.argv.slice(2)
  const targetIndex = args.indexOf('--target')
  let selector
  if (targetIndex !== -1) {
    selector = args[targetIndex + 1]
    if (!selector) throw new Error('--target requires a page target id or exact URL')
    args.splice(targetIndex, 2)
  }
  const page = selectPageTarget(list, selector)
  process.argv.splice(2, process.argv.length - 2, ...args)
  process.stderr.write(`CDP target: ${page.id} ${safeTargetUrl(page.url)}\n`)
  return page
}

/**
 * 建一条 CDP 连接。
 * @param {string} url - webSocketDebuggerUrl。
 * @returns {Promise<{send: Function, close: Function}>} 连接。
 */
function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    let id = 0
    const pending = new Map()
    socket.on('open', () => {
      resolve({
        send(method, params = {}) {
          const rpcId = ++id
          return new Promise((res, rej) => {
            pending.set(rpcId, { res, rej })
            socket.send(JSON.stringify({ id: rpcId, method, params }))
          })
        },
        close() { socket.close() },
      })
    })
    socket.on('message', data => {
      const msg = JSON.parse(String(data))
      if (msg.id === undefined) return
      const entry = pending.get(msg.id)
      if (entry === undefined) return
      pending.delete(msg.id)
      if (msg.error !== undefined) entry.rej(new Error(JSON.stringify(msg.error)))
      else entry.res(msg.result)
    })
    socket.on('error', reject)
  })
}

const page = await selectedPage()
const [, , command, ...rest] = process.argv
const cdp = await connect(page.webSocketDebuggerUrl)

try {
  if (command === 'open') {
    await cdp.send('Page.navigate', { url: rest[0] })
    await new Promise(r => setTimeout(r, 2500))
    process.stdout.write('opened\n')
  } else if (command === 'key') {
    const chord = rest[0].split('+')
    const modifiers = chord.slice(0, -1)
    const key = chord.at(-1)
    let mask = 0
    for (const modifier of modifiers) {
      if (modifier === 'Control') mask |= 2
      else if (modifier === 'Shift') mask |= 8
      else if (modifier === 'Alt') mask |= 1
      else if (modifier === 'Meta') mask |= 4
      else throw new Error(`unsupported key modifier: ${modifier}`)
    }
    const codes = { Control: 'ControlLeft', Shift: 'ShiftLeft', Alt: 'AltLeft', Meta: 'MetaLeft' }
    for (const modifier of modifiers) await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: modifier, code: codes[modifier], modifiers: mask })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, modifiers: mask })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, modifiers: mask })
    for (const modifier of modifiers.toReversed()) await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: modifier, code: codes[modifier], modifiers: mask & ~({ Control: 2, Shift: 8, Alt: 1, Meta: 4 }[modifier]) })
    process.stdout.write('KEY_SENT\n')

  } else if (command === 'text') {
    const selector = rest[0] ?? 'body'
    const result = await cdp.send('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)})?.innerText ?? '(no element)'`,
      returnByValue: true,
    })
    process.stdout.write(`${result.result.value}\n`)
  } else if (command === 'click') {
    // 按可见文本点击（最贴近真人操作）；--selector 则按 CSS。
    const bySelector = rest[0] === '--selector' ? rest[1] : undefined
    const byText = bySelector === undefined ? rest[0] : undefined
    const expression = `(() => {
      const selector = ${JSON.stringify(bySelector ?? null)}
      const wanted = ${JSON.stringify(byText ?? null)}
      const candidates = selector ? [...document.querySelectorAll(selector)]
        : [...document.querySelectorAll('button,a,[role=button],[role=menuitem],[role=option]')].filter(el => (el.innerText ?? '').trim() === wanted)
      for (const el of candidates) {
        if (el.disabled || el.closest('[inert]') || el.getAttribute('aria-disabled') === 'true') continue
        const dialog = [...document.querySelectorAll('[role=dialog][aria-modal=true]')].filter(d => d.getClientRects().length).at(-1)
        if (dialog && !dialog.contains(el)) continue
        el.scrollIntoView({block:'center'})
        const r = el.getBoundingClientRect()
        if (!r.width || !r.height) continue
        const x = r.left + r.width / 2, y = r.top + r.height / 2
        const top = document.elementFromPoint(x,y)
        if (top && (top === el || el.contains(top))) return {x,y}
      }
      return null
    })()`
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true })
    const point = result.result.value
    if (!point) {
      process.stdout.write('BLOCKED_OR_NOT_FOUND\n')
      process.exitCode = 1
    } else {
      await cdp.send('Input.dispatchMouseEvent', {type:'mousePressed', ...point, button:'left', clickCount:1})
      await cdp.send('Input.dispatchMouseEvent', {type:'mouseReleased', ...point, button:'left', clickCount:1})
      process.stdout.write('CLICKED\n')
    }
    await new Promise(r => setTimeout(r, 1200))
  } else if (command === 'type') {
    const selector = rest[rest.indexOf('--selector') + 1]
    const envIndex = rest.indexOf('--value-env')
    const value = envIndex >= 0
      ? process.env[rest[envIndex + 1]] ?? ''
      : rest[rest.indexOf('--value') + 1]
    const locate = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el || el.disabled || el.closest('[inert]')) return null
        const dialog = [...document.querySelectorAll('[role=dialog][aria-modal=true]')].filter(d => d.getClientRects().length).at(-1)
        if (dialog && !dialog.contains(el)) return null
        el.scrollIntoView({block:'center'})
        const r = el.getBoundingClientRect()
        return r.width && r.height ? {x:r.left+r.width/2,y:r.top+r.height/2} : null
      })()`,
      returnByValue: true,
    })
    const point = locate.result.value
    if (!point) throw new Error(`input target not found or blocked: ${selector}`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', modifiers: 2 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft' })
    await cdp.send('Input.insertText', { text: value })
    process.stdout.write('TYPED\n')
  } else if (command === 'eval') {
    const result = await cdp.send('Runtime.evaluate', {
      expression: rest.join(' '), returnByValue: true, awaitPromise: true,
    })
    process.stdout.write(`${JSON.stringify(result.result.value, null, 2)}\n`)
  } else if (command === 'shot') {
    const result = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(rest[0], Buffer.from(result.data, 'base64'))
    process.stdout.write(`saved ${rest[0]}\n`)
  } else if (command === 'wait') {
    const text = rest[0]
    const timeout = Number(rest[1] ?? 15_000)
    const started = Date.now()
    let found = false
    while (Date.now() - started < timeout) {
      const result = await cdp.send('Runtime.evaluate', {
        expression: `document.body.innerText.includes(${JSON.stringify(text)})`,
        returnByValue: true,
      })
      if (result.result.value === true) { found = true; break }
      await new Promise(r => setTimeout(r, 400))
    }
    process.stdout.write(found ? 'FOUND\n' : 'TIMEOUT\n')
    if (!found) process.exitCode = 1
  } else {
    process.stdout.write(`unknown command: ${command}\n`)
    process.exitCode = 2
  }
} finally {
  cdp.close()
}
