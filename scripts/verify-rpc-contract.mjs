// 修正版契约验证：端点用 `namespace.method` 形式（带点号）
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const mode = JSON.parse(readFileSync(join(homedir(), '.dsh', 'remote-hub', 'carrier-mode.json'), 'utf8'))
const origin = mode.origin.replace(/\/+$/u, '')

async function call(endpoint) {
  const rpcId = `rpc-${Math.random().toString(36).slice(2, 10)}`
  const message = { type: 'client-request', rpcId, method: endpoint, payload: { args: {} } }
  const response = await fetch(`${origin}/remote/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${mode.token}`,
      'x-hub-protocol': '1',
    },
    body: JSON.stringify(message),
  })
  let json = null
  try { json = await response.json() } catch { /* 非 JSON */ }
  return {
    endpoint,
    status: response.status,
    echoed: json?.rpcId === rpcId,
    type: json?.type ?? '-',
    ok: json?.result?.ok,
    err: json?.result?.error?.code ?? '',
    sample: JSON.stringify(json?.result?.value ?? null).slice(0, 100),
  }
}

console.log(`守卫: ${origin}\n`)
// 三种命名变体对比
const endpoints = [
  'session/list',
  'session.list',
  'workspace/list',
  'workspace.list',
  'project.list',
  'remote.settings.get',
]
let pass = 0
for (const endpoint of endpoints) {
  const r = await call(endpoint)
  const good = r.status === 200 && r.echoed && r.type === 'server-response'
  if (good) pass += 1
  console.log(`${good ? 'PASS' : 'FAIL'}  ${endpoint.padEnd(22)} status=${r.status} echoed=${r.echoed} ok=${r.ok} ${r.err}`)
  if (r.sample !== 'null') console.log(`      ${r.sample}`)
}
console.log(`\n通过 ${pass}/${endpoints.length}`)
