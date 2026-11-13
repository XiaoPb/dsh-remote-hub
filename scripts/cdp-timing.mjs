/**
 * 页面接管时序诊断：在页面加载**之前**注入探针，观察 connection 何时读 transport。
 *
 * 用法：node scripts/cdp-timing.mjs <url>
 *
 * @module scripts/cdp-timing
 */
import { WebSocket } from 'ws'

const PORT = Number(process.env.CDP_PORT ?? 9222)
const url = process.argv[2]
if (url === undefined) {
  console.error('usage: node cdp-timing.mjs <url>')
  process.exit(2)
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find(t => t.type === 'page')
if (page === undefined) throw new Error('no page target')

const socket = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
await new Promise((resolve, reject) => {
  socket.once('open', resolve)
  socket.once('error', reject)
})
socket.on('message', data => {
  const msg = JSON.parse(String(data))
  if (msg.id === undefined) return
  const entry = pending.get(msg.id)
  if (entry === undefined) return
  pending.delete(msg.id)
  if (msg.error) entry.rej(new Error(JSON.stringify(msg.error)))
  else entry.res(msg.result)
})
const send = (method, params = {}) => new Promise((res, rej) => {
  const rpcId = ++id
  pending.set(rpcId, { res, rej })
  socket.send(JSON.stringify({ id: rpcId, method, params }))
})

// 关键：在**任何页面脚本之前**注入探针（addScriptToEvaluateOnNewDocument）。
const probe = `
(() => {
  window.__TIMING__ = [];
  const at = (tag, extra) => {
    try { window.__TIMING__.push({ tag, t: performance.now(), ...(extra ?? {}) }) } catch {}
  };
  at('probe-installed');

  // 监视 __DSH_TRANSPORT__ 的写入与读取。
  let backing = undefined;
  try {
    Object.defineProperty(globalThis, '__DSH_TRANSPORT__', {
      configurable: true,
      get() { at('transport-read', { hasValue: backing !== undefined }); return backing },
      set(v) { at('transport-write', { keys: v ? Object.keys(v) : null }); backing = v },
    });
    at('transport-proxy-installed');
  } catch (e) { at('transport-proxy-failed', { error: String(e) }) }

  // 监视全局 fetch 的调用，看它们是否走 /remote/rpc。
  const origFetch = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    const s = String(input);
    if (s.includes('/api/') || s.includes('remote')) {
      at('fetch', { url: s.slice(0, 80) });
    }
    return origFetch.apply(this, arguments);
  };
  at('fetch-wrapped');
})();
`

await send('Page.enable')
await send('Runtime.enable')
await send('Page.addScriptToEvaluateOnNewDocument', { source: probe })
await send('Page.navigate', { url })
await new Promise(r => setTimeout(r, 6000))

const result = await send('Runtime.evaluate', {
  expression: 'JSON.stringify(window.__TIMING__ ?? [])',
  returnByValue: true,
})
const timing = JSON.parse(result.result.value)
process.stdout.write(`events: ${timing.length}\n`)
for (const event of timing.slice(0, 60)) {
  process.stdout.write(`${String(Math.round(event.t)).padStart(6)}ms  ${event.tag}  ${JSON.stringify({ ...event, tag: undefined, t: undefined })}\n`)
}
socket.close()
