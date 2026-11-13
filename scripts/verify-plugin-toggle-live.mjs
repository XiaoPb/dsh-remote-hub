/**
 * 在真实 Edge 里做一次**真实的插件启停**，证明 Full 的写入直接生效、不再需要审批。
 *
 * 做法：
 *   1. 取 `pluginManager/listPlugins` 里的某个可切换插件；
 *   2. 通过页面 transport 发 `pluginManager/setPluginEnabled`（改 enabled）；
 *   3. 重新读列表，确认状态变了；再切回原值，保证不改变宿主最终状态。
 *
 * 用法：node scripts/verify-plugin-toggle-live.mjs --target <cdp-target-id>
 *
 * @module scripts/verify-plugin-toggle-live
 */
import { WebSocket } from 'ws'

const PORT = Number(process.env.CDP_PORT ?? 9222)
const targetIndex = process.argv.indexOf('--target')
const TARGET = targetIndex >= 0 ? process.argv[targetIndex + 1] : undefined
if (TARGET === undefined) {
  process.stderr.write('usage: node scripts/verify-plugin-toggle-live.mjs --target <cdp-target-id>\n')
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

const steps = []
let failures = 0

/** 记录一步结果。 */
function step(name, ok, detail) {
  steps.push({ name, ok })
  if (!ok) failures += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  — ${String(detail ?? '').slice(0, 300)}`}\n`)
}

/**
 * 经页面传输发一次官方 RPC。
 * @param method - endpoint。
 * @param args - payload.args。
 * @returns 解析后的 `result`（含 `ok` / `error` / `value`）。
 */
async function rpc(method, args = {}) {
  const raw = await evaluate(`(async () => {
    const body = { type: 'client-request', rpcId: 'toggle-' + Math.random().toString(36).slice(2), method: ${JSON.stringify(method)}, payload: { args: ${JSON.stringify(args)} } }
    const res = await globalThis.__DSH_TRANSPORT__.fetch('api/${method}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const json = await res.json()
    return JSON.stringify(json?.result ?? { ok: null })
  })()`)
  if (typeof raw !== 'string' || raw.startsWith('ERROR')) return { ok: null, error: { code: 'no-transport', message: String(raw) } }
  return JSON.parse(raw)
}

const listed = await rpc('pluginManager/listPlugins')
step('pluginManager/listPlugins works', listed.ok === true, JSON.stringify(listed).slice(0, 300))
const plugins = Array.isArray(listed.value) ? listed.value : []
// 挑一个可切换、非只读、非 remote-hub 自身的插件（避免把自己切掉）。
const target = plugins.find(entry =>
  typeof entry?.entryId === 'string'
  && entry.readOnlyReason === undefined
  && typeof entry.enabled === 'boolean'
  && !String(entry.moduleName ?? '').includes('remote-hub'))
if (target === undefined) {
  process.stdout.write(`SKIP  no toggleable plugin found (candidates: ${JSON.stringify(plugins.map(p => ({ id: p.entryId, enabled: p.enabled, ro: p.readOnlyReason }))).slice(0, 400)})\n`)
  process.stdout.write(`\n${steps.length - failures}/${steps.length} live checks passed\n`)
  ws.close()
  process.exit(failures === 0 ? 0 : 1)
}
process.stdout.write(`      target plugin: ${target.entryId} (enabled=${String(target.enabled)})\n`)

const flipped = await rpc('pluginManager/setPluginEnabled', { id: target.entryId, enabled: !target.enabled })
step('setPluginEnabled accepted without approval', flipped.ok === true, JSON.stringify(flipped).slice(0, 300))

const after = await rpc('pluginManager/listPlugins')
const afterRow = Array.isArray(after.value) ? after.value.find(entry => entry.entryId === target.entryId) : undefined
step('plugin state actually changed', afterRow?.enabled === !target.enabled, JSON.stringify(afterRow ?? {}).slice(0, 300))

const restored = await rpc('pluginManager/setPluginEnabled', { id: target.entryId, enabled: target.enabled })
step('plugin state restored', restored.ok === true, JSON.stringify(restored).slice(0, 300))

process.stdout.write(`\n${steps.length - failures}/${steps.length} live checks passed\n`)
ws.close()
process.exit(failures === 0 ? 0 : 1)
