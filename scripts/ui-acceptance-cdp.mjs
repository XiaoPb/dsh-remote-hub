/**
 * UI 验收用的 CDP 驱动（模块化，供 ui-acceptance-*.mjs 复用）。
 *
 * 为什么单独一份：`scripts/cdp.mjs` 是**每命令一个进程**的 CLI，而验收需要
 * 在一次会话里连续操作（登录 → 翻页 → 改视口 → 截图），反复起进程既慢又会让
 * 状态丢失。这里把「连一条 CDP 连接 + 一组常用动作」做成可 await 的对象。
 *
 * 约束：
 * - 只用 Node 内置 + 仓库已声明的 `ws`；
 * - 不碰网络凭据：所有 token 从启动方传入的环境变量读，不落盘、不打印；
 * - 每个断言都读**真实 DOM/CSSOM**，不做源码文本推断。
 *
 * @module scripts/ui-acceptance-cdp
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { WebSocket } from 'ws'

/** 睡眠。 */
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 连一个 CDP 目标。
 * @param {string} webSocketDebuggerUrl - 调试地址。
 * @returns {Promise<{send: (method: string, params?: object) => Promise<any>, close: () => void}>}
 */
export function connectCdp(webSocketDebuggerUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 })
    let id = 0
    const pending = new Map()
    const listeners = new Map()
    socket.on('open', () => {
      resolve({
        send(method, params = {}) {
          const rpcId = ++id
          return new Promise((res, rej) => {
            pending.set(rpcId, { res, rej })
            socket.send(JSON.stringify({ id: rpcId, method, params }))
          })
        },
        /** 订阅一个 CDP 事件（可多个监听者）。 */
        on(method, handler) {
          const list = listeners.get(method) ?? []
          list.push(handler)
          listeners.set(method, list)
        },
        off(method, handler) {
          const list = listeners.get(method) ?? []
          listeners.set(method, list.filter(item => item !== handler))
        },
        close() { socket.close() },
      })
    })
    socket.on('message', data => {
      const msg = JSON.parse(String(data))
      if (msg.id === undefined) {
        for (const handler of listeners.get(msg.method) ?? []) handler(msg.params)
        return
      }
      const entry = pending.get(msg.id)
      if (entry === undefined) return
      pending.delete(msg.id)
      if (msg.error !== undefined) entry.rej(new Error(`${msg.error.message ?? JSON.stringify(msg.error)} (${msg.error.code ?? '?'})`))
      else entry.res(msg.result)
    })
    socket.on('error', reject)
  })
}

/**
 * 找目标页面（按 exact URL 前缀或 title 过滤），返回第一个 page 类型。
 * @param {number} port - 调试端口。
 * @param {(item: object) => boolean} [filter] - 过滤函数。
 * @returns {Promise<object>} 目标描述。
 */
export async function findPage(port, filter = () => true) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  const list = await response.json()
  const pages = list.filter(item => item.type === 'page' && filter(item))
  if (pages.length === 0) throw new Error(`no matching page target on port ${port} (saw ${list.length} targets)`)
  return pages[0]
}

/**
 * 把驱动对象裹上一层便于验收脚本使用的语义动作。
 * @param {string} webSocketDebuggerUrl - 目标调试地址。
 * @returns {Promise<object>} page 驱动。
 */
export async function openPage(webSocketDebuggerUrl) {
  const cdp = await connectCdp(webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('DOM.enable')

  const page = {
    cdp,
    /**
     * 在页面里求值（支持 awaitPromise + returnByValue）。
     * @param {string} expression - 表达式源码。
     * @returns {Promise<any>} 值。
     */
    async eval(expression) {
      const result = await cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      })
      if (result.exceptionDetails !== undefined) {
        const detail = result.exceptionDetails.exception?.description
          ?? result.exceptionDetails.text
          ?? JSON.stringify(result.exceptionDetails)
        throw new Error(`eval failed: ${String(detail).slice(0, 600)}`)
      }
      return result.result.value
    },
    /**
     * 在页面上下文里执行一个函数（参数走 JSON，避免拼接注入）。
     * @param {Function} fn - 页面里执行的函数（必须自包含）。
     * @param {...any} args - 参数。
     * @returns {Promise<any>} 返回值。
     */
    call(fn, ...args) {
      return page.eval(`(${fn.toString()})(...${JSON.stringify(args)})`)
    },
    /** 读取 `document.querySelector` 的属性/文本快照。 */
    async query(selector, props = ['textContent', 'ariaLabel']) {
      return page.call((sel, keys) => {
        const el = document.querySelector(sel)
        if (el === null) return null
        const out = { tag: el.tagName.toLowerCase() }
        for (const key of keys) {
          if (key === 'textContent') out.text = (el.textContent ?? '').trim()
          else if (key === 'ariaLabel') out.ariaLabel = el.getAttribute('aria-label')
          else out[key] = el.getAttribute(key)
        }
        return out
      }, selector, props)
    },
    /** 截图（可带 clip 或整页）。 */
    async screenshot(path, { fullPage = false } = {}) {
      const params = { format: 'png', captureBeyondViewport: fullPage }
      if (fullPage) {
        const metrics = await cdp.send('Page.getLayoutMetrics')
        const size = metrics.cssContentSize ?? metrics.contentSize
        params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 }
      }
      const shot = await cdp.send('Page.captureScreenshot', params)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, Buffer.from(shot.data, 'base64'))
      return path
    },
    /** 设置视口（width×height，deviceScaleFactor 可调）。 */
    async setViewport(width, height, { deviceScaleFactor = 1, mobile = false } = {}) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile })
    },
    /** 清除视口覆盖。 */
    async resetViewport() {
      await cdp.send('Emulation.clearDeviceMetricsOverride')
    },
    /** 导航并等 load。 */
    async navigate(url, timeout = 30_000) {
      await cdp.send('Page.navigate', { url })
      const started = Date.now()
      while (Date.now() - started < timeout) {
        const ready = await page.eval('document.readyState').catch(() => 'loading')
        if (ready === 'complete') break
        await sleep(200)
      }
      await sleep(500)
    },
    /** 等一个 JS 条件为真。 */
    async waitFor(expression, { timeout = 20_000, interval = 200, label = expression } = {}) {
      const started = Date.now()
      while (Date.now() - started < timeout) {
        const ok = await page.eval(expression).catch(() => false)
        if (ok === true) return true
        await sleep(interval)
      }
      throw new Error(`waitFor timeout (${timeout}ms): ${label}`)
    },
    /**
     * 按选择器真实点击（先滚动到视口中心，再派发鼠标事件）。
     * @returns {Promise<boolean>} 是否点到了可见元素。
     */
    async click(selector) {
      const point = await page.call(sel => {
        const el = document.querySelector(sel)
        if (el === null) return null
        el.scrollIntoView({ block: 'center', inline: 'center' })
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return null
        const x = rect.left + rect.width / 2
        const y = rect.top + rect.height / 2
        const top = document.elementFromPoint(x, y)
        if (top !== null && top !== el && !el.contains(top)) return { blocked: true }
        return { x, y }
      }, selector)
      if (point === null) return false
      if (point.blocked === true) return false
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      await sleep(350)
      return true
    },
    /** 鼠标悬停到元素中心。 */
    async hover(selector) {
      const point = await page.call(sel => {
        const el = document.querySelector(sel)
        if (el === null) return null
        el.scrollIntoView({ block: 'center' })
        const rect = el.getBoundingClientRect()
        return rect.width === 0 ? null : { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      }, selector)
      if (point === null) return false
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
      await sleep(500)
      return true
    },
    /**
     * 用键盘输入文本到一个 input（先聚焦再 insertText，触发 input 事件）。
     */
    async typeInto(selector, text) {
      const ok = await page.call(sel => {
        const el = document.querySelector(sel)
        if (el === null) return false
        el.focus()
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        setter?.call(el, '')
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      }, selector)
      if (!ok) return false
      await cdp.send('Input.insertText', { text })
      await sleep(120)
      return true
    },
    /**
     * 派发一个按键（含修饰键）。
     * @param {string} key - `Tab` / `Enter` / `ArrowRight` / `Shift+Tab` 等。
     */
    async pressKey(key) {
      const parts = key.split('+')
      const name = parts.at(-1)
      const modifiers = parts.slice(0, -1)
      let mask = 0
      for (const modifier of modifiers) {
        if (modifier === 'Shift') mask |= 8
        else if (modifier === 'Control') mask |= 2
        else if (modifier === 'Alt') mask |= 1
        else if (modifier === 'Meta') mask |= 4
        else throw new Error(`unsupported modifier ${modifier}`)
      }
      const MODIFIER_CODES = { Shift: 'ShiftLeft', Control: 'ControlLeft', Alt: 'AltLeft', Meta: 'MetaLeft' }
      const codes = {
        Tab: 'Tab', Enter: 'Enter', Escape: 'Escape', Space: 'Space',
        ArrowRight: 'ArrowRight', ArrowLeft: 'ArrowLeft', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
        Home: 'Home', End: 'End', Backspace: 'Backspace', Delete: 'Delete',
      }
      /** Windows 虚拟键码（导航键必须先带对，否则浏览器的默认动作不生效）。 */
      const KEY_CODE = {
        Tab: 9, Enter: 13, Escape: 27, Space: 32, Backspace: 8, Delete: 46,
        ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35,
      }
      const code = codes[name] ?? (/^[a-zA-Z]$/u.test(name) ? `Key${name.toUpperCase()}` : name)
      const keyText = name === 'Space' ? ' ' : name

      // 按下修饰键
      for (const modifier of modifiers) {
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyDown', key: modifier, code: MODIFIER_CODES[modifier], modifiers: mask,
          windowsVirtualKeyCode: modifier === 'Shift' ? 16 : modifier === 'Control' ? 17 : modifier === 'Alt' ? 18 : 91,
        })
      }
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: keyText,
        code,
        windowsVirtualKeyCode: KEY_CODE[name] ?? name.charCodeAt(0),
        modifiers: mask,
      })
      if (name === 'Enter') {
        await cdp.send('Input.dispatchKeyEvent', { type: 'char', key: '\r', code, text: '\r', unmodifiedText: '\r', modifiers: mask })
      } else if (name === 'Space') {
        await cdp.send('Input.dispatchKeyEvent', { type: 'char', key: ' ', code, text: ' ', unmodifiedText: ' ', modifiers: mask })
      }
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: keyText, code, modifiers: mask,
      })
      // 松开修饰键
      for (const modifier of modifiers.toReversed()) {
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: modifier, code: MODIFIER_CODES[modifier], modifiers: 0 })
      }
      await sleep(180)
    },
    /** 当前焦点元素的描述。 */
    focus() {
      return page.call(() => {
        const el = document.activeElement
        if (el === null) return null
        return {
          tag: el.tagName.toLowerCase(),
          testId: el.getAttribute('data-testid'),
          role: el.getAttribute('role'),
          ariaLabel: el.getAttribute('aria-label'),
          text: (el.textContent ?? '').trim().slice(0, 60),
          value: el.value === undefined ? null : String(el.value).slice(0, 40),
          inRoot: el.closest('[data-testid="account-page"]') !== null,
        }
      })
    },
    /**
     * 把一个 JS 源文件作为 `<script>` 注入页面。
     *
     * 为什么不用 `Runtime.evaluate(source)`：axe-core 这类大体积库里有反引号、
     * `${}`、`</script>` 等字符，直接拼进表达式会被解析成不同的 token
     * （实测报 `SyntaxError: Invalid or unexpected token`）。改成「塞进一个
     * script 元素的 textContent」后由浏览器解析，是纯数据传递，不做字符串插值。
     * @param {string} source - 完整 JS 源码。
     * @param {string} url - 仅用于 SourceMap/调试定位的伪 URL。
     * @returns {Promise<string>} 注入后全局是否出现可用的库（返回类型名）。
     */
    async injectScript(source, url = 'injected.js') {
      const expression = `(() => {
        const el = document.createElement('script')
        el.setAttribute('data-url', ${JSON.stringify(url)})
        el.textContent = ${JSON.stringify(source)}
        document.documentElement.appendChild(el)
        el.remove()
        return typeof globalThis.axe === 'object' ? 'axe' : 'other'
      })()`
      return page.eval(expression)
    },
    /** 关闭连接。 */
    close() { cdp.close() },
  }
  return page
}

// ─────────────────────────────────────────────────────────────────────────────
// 颜色与对比度：WCAG 2.x 相对亮度 + 对比度比
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 解析 `rgb(r,g,b)` / `rgba(...)` / `#rrggbb` 为 `[r,g,b,a]`。
 * @param {string} color - 颜色字符串。
 * @returns {[number, number, number, number]} 通道值。
 */
export function parseColor(color) {
  const text = color.trim()
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/iu.exec(text)
  if (hex !== null) {
    const int = Number.parseInt(hex[1], 16)
    const alpha = hex[2] === undefined ? 1 : Number.parseInt(hex[2], 16) / 255
    return [(int >> 16) & 255, (int >> 8) & 255, int & 255, alpha]
  }
  const fn = /^rgba?\(([^)]+)\)$/u.exec(text)
  if (fn !== null) {
    const parts = fn[1].split(/[,\s/]+/u).filter(Boolean).map(Number)
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1]
  }
  throw new Error(`unsupported color: ${text}`)
}

/** 把颜色复合到不透明背景上（`over` 在 `under` 之上）。 */
export function composite(over, under) {
  const alpha = over[3]
  return [0, 1, 2].map(index => over[index] * alpha + under[index] * (1 - alpha)).concat(1)
}

/** WCAG 相对亮度。 */
export function relativeLuminance(color) {
  const [r, g, b] = color.slice(0, 3).map(channel => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** 对比度比（1–21）。 */
export function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground)
  const b = relativeLuminance(background)
  const light = Math.max(a, b)
  const dark = Math.min(a, b)
  return (light + 0.05) / (dark + 0.05)
}

/** 取两位小数的对比度。 */
export function contrast2(foreground, background) {
  return Math.round(contrastRatio(foreground, background) * 100) / 100
}
