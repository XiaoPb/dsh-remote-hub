/**
 * 在真实 Edge 里验证 0.3.1 的插件权限（Full 直接生效 + 三档可读）。
 *
 * 通过页面自己的 transport 发官方 `client-request` 信封，断言服务端真实裁决，
 * 而不是只看 UI 是否画出来：
 *   1. `pluginInventory/list` —— 三档角色都应可读（用当前配对角色验证）；
 *   2. `pluginManager/listPlugins` / `pluginManager/registries` —— 读取正常；
 *   3. 当前配对是 full 时，确认写入类接口**不再被审批拦截**
 *      （用 `pluginManager/setPluginEnabled` 对一个不存在的插件发请求：
 *       期望是**参数/业务错误**而不是 `remote-access/denied` 或审批拒绝）。
 *
 * 用法：node scripts/verify-plugin-permissions-live.mjs --target <cdp-target-id>
 *
 * @module scripts/verify-plugin-permissions-live
 */
import { WebSocket } from 'ws'

const PORT = Number(process.env.CDP_PORT ?? 9222)
const targetIndex = process.argv.indexOf('--target')
const TARGET = targetIndex >= 0 ? process.argv[targetIndex + 1] : undefined
if (TARGET === undefined) {
  process.stderr.write('usage: node scripts/verify-plugin-permissions-live.mjs --target <cdp-target-id>\n')
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
 * @returns `{ status, ok, code, detail }`。
 */
async function rpc(method, args = {}) {
  const raw = await evaluate(`(async () => {
    const body = { type: 'client-request', rpcId: 'verify-' + Math.random().toString(36).slice(2), method: ${JSON.stringify(method)}, payload: { args: ${JSON.stringify(args)} } }
    const res = await globalThis.__DSH_TRANSPORT__.fetch('api/${method}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    let json = null
    try { json = await res.json() } catch { json = null }
    return JSON.stringify({ status: res.status, ok: json?.result?.ok ?? null, code: json?.result?.error?.code ?? null, message: String(json?.result?.error?.message ?? '').slice(0, 160) })
  })()`)
  if (typeof raw !== 'string' || raw.startsWith('ERROR')) return { status: 0, ok: null, code: 'no-transport', message: String(raw).slice(0, 160) }
  return JSON.parse(raw)
}

// 0. 接管状态与配对角色
const carrier = await evaluate('JSON.stringify({ active: globalThis.__DSH_REMOTE_HUB_CARRIER__?.active ?? null, origin: globalThis.__DSH_TRANSPORT__?.streamBaseUrl ?? null })')
const state = carrier.startsWith('ERROR') ? {} : JSON.parse(carrier)
step('remote takeover active', state.active === true, carrier)
const role = await evaluate(`(async () => {
  const body = { type: 'client-request', rpcId: 'verify-role', method: 'hub/devices', payload: { args: {} } }
  try {
    const res = await globalThis.__DSH_TRANSPORT__.fetch('api/hub/devices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const json = await res.json()
    return JSON.stringify({ status: res.status, ok: json?.result?.ok ?? null, code: json?.result?.error?.code ?? null })
  } catch (error) { return 'ERROR: ' + String(error) }
})()`)
process.stdout.write(`      caller probe (hub/devices): ${role}\n`)

// 1. 插件只读目录（0.3.1 起三档共享）
//    `pluginMarket/*` 只在宿主装了市场插件时才注册，未注册时官方返回 404
//    （「未认领 endpoint」），这不是权限问题，按环境跳过。
for (const method of ['pluginInventory/list', 'pluginManager/listPlugins', 'pluginManager/registries', 'pluginManager/listBundles']) {
  const result = await rpc(method)
  step(`${method} is readable`, result.ok === true, JSON.stringify(result))
}
const market = await rpc('pluginMarket/listIndexes')
if (market.status === 404) {
  process.stdout.write('SKIP  pluginMarket/listIndexes  — 宿主未注册市场插件（404 未认领 endpoint），非权限问题\n')
} else {
  step('pluginMarket/listIndexes is readable', market.ok === true, JSON.stringify(market))
}

// 2. 写入类接口不再被审批拦截（0.3.1 取消逐次审批）
//    用一个**不存在的插件 id**发启停请求：被拒绝只能来自参数/业务校验，
//    不应出现 `remote-access/denied`（角色不足）或因审批超时产生的拒绝。
const writeProbe = await rpc('pluginManager/setPluginEnabled', { pluginId: 'verify-nonexistent-plugin', enabled: false })
const writeDeniedByPolicy = writeProbe.code === 'remote-access/denied'
step(
  'plugin write is not blocked by role or approval',
  writeProbe.code !== null && !writeDeniedByPolicy,
  JSON.stringify(writeProbe),
)
process.stdout.write(`      write probe (setPluginEnabled on a fake id): ${JSON.stringify(writeProbe)}\n`)

process.stdout.write(`\n${steps.length - failures}/${steps.length} live checks passed\n`)
ws.close()
process.exit(failures === 0 ? 0 : 1)
