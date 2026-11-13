/**
 * 在真实 Edge 里核对 0.3.2 补齐的权限：逐个 endpoint 经页面 transport 发真实请求，
 * 判定标准是**没有被权限层拒绝**（不是四要素都成功）——很多接口需要有效参数，
 * 参数错误说明已经通过 `decide()` 到达业务层，这正是我们要证明的。
 *
 * 用法：node scripts/verify-audit-endpoints-live.mjs --target <cdp-target-id>
 *
 * @module scripts/verify-audit-endpoints-live
 */
import { WebSocket } from 'ws'

const PORT = Number(process.env.CDP_PORT ?? 9222)
const targetIndex = process.argv.indexOf('--target')
const TARGET = targetIndex >= 0 ? process.argv[targetIndex + 1] : undefined
if (TARGET === undefined) {
  process.stderr.write('usage: node scripts/verify-audit-endpoints-live.mjs --target <cdp-target-id>\n')
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

/**
 * 经页面传输发一次官方 RPC。
 * @param method - endpoint。
 * @param args - payload.args。
 * @returns `{ status, ok, code, message }`。
 */
async function rpc(method, args = {}) {
  const raw = await evaluate(`(async () => {
    const body = { type: 'client-request', rpcId: 'aud-' + Math.random().toString(36).slice(2), method: ${JSON.stringify(method)}, payload: { args: ${JSON.stringify(args)} } }
    const res = await globalThis.__DSH_TRANSPORT__.fetch('api/${method}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    let json = null
    try { json = await res.json() } catch { json = null }
    return JSON.stringify({ status: res.status, ok: json?.result?.ok ?? null, code: json?.result?.error?.code ?? null, message: String(json?.result?.error?.message ?? '').slice(0, 120) })
  })()`)
  if (typeof raw !== 'string' || raw.startsWith('ERROR')) return { status: 0, ok: null, code: 'no-transport', message: String(raw).slice(0, 120) }
  return JSON.parse(raw)
}

const carrier = await evaluate('JSON.stringify({ active: globalThis.__DSH_REMOTE_HUB_CARRIER__?.active ?? null, origin: globalThis.__DSH_TRANSPORT__?.streamBaseUrl ?? null })')
const state = carrier.startsWith('ERROR') ? {} : JSON.parse(carrier)
process.stdout.write(`takeover: active=${String(state.active)} origin=${String(state.origin)}\n\n`)

/** 0.3.2 补齐的 endpoint（只验证「不再被权限拒绝」）。 */
const endpoints = [
  ['llm/discoverModels', { settingsNs: 'llm-deepseek', request: {} }],
  ['agentPresets/list', {}],
  ['agentPresets/read', { name: 'verify-none' }],
  ['commands/list', {}],
  ['commands/execute', { name: 'help' }],
  ['schedule/list', {}],
  ['schedule/view', { taskId: 'verify-none' }],
  ['schedule/deliveryLimits', {}],
  ['session/canOpenWorkspacePath', {}],
  ['skills/list', {}],
  ['messageFeedback/list', {}],
  ['subagents/prompt', {}],
]

let failures = 0
let skipped = 0
for (const [method, args] of endpoints) {
  const result = await rpc(method, args)
  if (result.status === 404) {
    skipped += 1
    process.stdout.write(`SKIP  ${method}  — 宿主未注册该 endpoint\n`)
    continue
  }
  // 权限被拒的判据：明确返回 remote-access/denied。
  const denied = result.code === 'remote-access/denied'
  if (denied) failures += 1
  process.stdout.write(`${denied ? 'FAIL' : 'PASS'}  ${method.padEnd(34)} ${denied ? '被权限拒绝' : `已放行 (${String(result.code ?? 'ok')})`}\n`)
}

process.stdout.write(`\n${endpoints.length - failures - skipped}/${endpoints.length - skipped} endpoints pass the permission layer（跳过 ${skipped}）\n`)
ws.close()
process.exit(failures === 0 ? 0 : 1)
