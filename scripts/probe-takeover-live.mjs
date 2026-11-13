/**
 * 真实被控端验收探针：验证 HTTP RPC / WS / 权限矩阵的实际行为。
 *
 * 用途：T01 能力取证与检查点 A 的最小证据。对真实守卫发起调用，
 * 断言的是**官方 Gateway 的真实判定**，不是假 Gateway。
 *
 * 用法：
 *   node scripts/probe-takeover-live.mjs --origin http://192.168.0.17:8443 \
 *     --token <token> --role read-only
 *
 * @module scripts/probe-takeover-live
 */
import { WebSocket } from 'ws'

/**
 * 解析 CLI 参数。
 * @returns {{origin: string, token: string}} 参数。
 */
function parseArgs() {
  const args = process.argv.slice(2)
  /** @type {Record<string, string>} */
  const out = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/u, '')
    out[key] = args[i + 1]
  }
  if (out.origin === undefined || out.token === undefined) {
    throw new Error('usage: --origin <url> --token <token>')
  }
  return { origin: out.origin.replace(/\/+$/u, ''), token: out.token }
}

const { origin, token } = parseArgs()

/**
 * 发一次一元 RPC。
 * @param {string} method - 形如 `session/list`。
 * @param {Record<string, unknown>} args - 参数。
 * @returns {Promise<{status: number, body: any}>} 结果。
 */
async function rpc(method, args) {
  const response = await fetch(`${origin}/remote/rpc`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-hub-protocol': '1',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `probe-${Math.random().toString(36).slice(2, 10)}`,
      method,
      payload: { args },
    }),
  })
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = { raw: text } }
  return { status: response.status, body }
}

/**
 * 打开一条 WS 并发一帧，收集下行帧直到超时。
 * @param {string} endpoint - 流的 endpoint。
 * @param {string} label - 日志标签。
 * @param {unknown} payload - 发给 open 帧的 payload。
 * @returns {Promise<{opened: boolean, frames: unknown[], error?: string}>} 结果。
 */
function wsOpenStream(endpoint, label, payload = { args: {} }) {
  return new Promise(resolve => {
    const url = `${origin.replace('http://', 'ws://').replace('https://', 'wss://')}`
      + `/remote/ws?token=${encodeURIComponent(token)}&ws-target=/api/remote.mux`
    const socket = new WebSocket(url)
    const frames = []
    let opened = false
    const done = error => {
      try { socket.close() } catch { /* 已关闭 */ }
      resolve({ opened, frames, ...(error === undefined ? {} : { error }) })
    }
    const timer = setTimeout(() => done(), 4_000)
    socket.on('open', () => {
      opened = true
      socket.send(JSON.stringify({
        type: 'open', streamId: `probe-${label}`, endpoint, payload,
      }))
    })
    socket.on('message', data => {
      frames.push(JSON.parse(String(data)))
      // $events 首帧 ready 已经足够证明事件通道可用。
      if (frames.length >= 2) { clearTimeout(timer); done() }
    })
    socket.on('error', error => { clearTimeout(timer); done(String(error.message ?? error)) })
    socket.on('unexpected-response', (_req, res) => {
      clearTimeout(timer)
      done(`HTTP ${res.statusCode}`)
    })
  })
}

process.stdout.write(`origin=${origin}\n`)

// ── 1. 只读能力：应当可用 ────────────────────────────────────────────────
const list = await rpc('session/list', { _request: {} })
process.stdout.write(`session/list      status=${list.status} ok=${list.body?.result?.ok} items=${list.body?.result?.value?.items?.length ?? 'n/a'}\n`)

// ── 2. 权限反例：只读设备不得写 ──────────────────────────────────────────
// 参数必须与真实 descriptor 完全一致，否则会先被 schema 拒掉（测不到权限）：
//   session/prompt  → { request: { requestId, sessionId, mode, content[] } }
//   session/create  → { request: {} }
//   workspace/create→ { request: { path, name } }
const prompt = await rpc('session/prompt', {
  request: {
    requestId: `probe-${Math.random().toString(36).slice(2, 10)}`,
    sessionId: 'probe-session',
    mode: 'queue',
    content: [{ type: 'text', text: 'should be denied' }],
  },
})
const promptCode = prompt.body?.result?.error?.code ?? 'none'
process.stdout.write(`session/prompt    status=${prompt.status} ok=${prompt.body?.result?.ok} code=${promptCode}\n`)

const created = await rpc('session/create', { request: {} })
const createCode = created.body?.result?.error?.code ?? 'none'
process.stdout.write(`session/create    status=${created.status} ok=${created.body?.result?.ok} code=${createCode}\n`)

// ── 2b. 工作区创建（写）：只读设备必须被拒 ────────────────────────────────
const wsCreate = await rpc('workspace/create', {
  request: { path: '/home/xiaopb/probe-ws-should-not-exist', name: 'probe-denied' },
})
const wsCreateCode = wsCreate.body?.result?.error?.code ?? 'none'
process.stdout.write(`workspace/create  status=${wsCreate.status} ok=${wsCreate.body?.result?.ok} code=${wsCreateCode}\n`)

// ── 3. 事件流：非 owner 能否拿到 $events ─────────────────────────────────
const events = await wsOpenStream('$events', 'events')
const firstFrame = events.frames[0]
process.stdout.write(
  `WS $events        opened=${events.opened} frames=${events.frames.length} `
  + `type=${firstFrame?.type ?? 'none'} error=${events.error ?? 'none'}\n`,
)
if (firstFrame?.type === 'item') {
  const value = firstFrame.value
  process.stdout.write(`  ready.type=${value?.type} host.home=${value?.host?.home ?? 'n/a'}\n`)
}
if (firstFrame?.type === 'error') {
  process.stdout.write(`  error.code=${firstFrame.error?.code} message=${firstFrame.error?.message}\n`)
}

// ── 4. 权限反例（WS 通道）：只读设备经 WS 写也应被拒 ─────────────────────
// WS 的 payload 必须是 `{ args: {...} }` 包装，args 才是 descriptor 的参数。
const wsWrite = await wsOpenStream('session/prompt', 'write', {
  args: {
    request: {
      requestId: `probe-ws-${Math.random().toString(36).slice(2, 10)}`,
      sessionId: 'probe-session',
      mode: 'queue',
      content: [{ type: 'text', text: 'should be denied over ws' }],
    },
  },
})
const writeFrame = wsWrite.frames[0]
process.stdout.write(
  `WS session/prompt opened=${wsWrite.opened} frames=${wsWrite.frames.length} `
  + `type=${writeFrame?.type ?? 'none'} error=${wsWrite.error ?? 'none'}\n`,
)
if (writeFrame?.type === 'error') {
  process.stdout.write(`  error.code=${writeFrame.error?.code} message=${writeFrame.error?.message}\n`)
}

process.stdout.write('PROBE_DONE\n')
