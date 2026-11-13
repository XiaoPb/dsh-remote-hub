/**
 * 用本机把远端守卫的配对凭据兑换成长期设备令牌，并持久化。
 *
 * 协议与页面「连接其他设备」完全一致（`POST {guard}/remote/pair`），
 * 只是不依赖 client bundle（那半边是 CJS，只在渲染进程里跑）。
 *
 * 用法：
 *   node scripts/pair-outbound.mjs --origin http://192.168.0.17:8443 --code PQ1EE2K6
 *
 * 凭据窗口只有 15 秒：本脚本应在取到 code 后立即执行。
 *
 * **重要：写入位置**
 * 页面「主控端」卡片读的是浏览器 localStorage 的 `remote-hub.mode`
 * （`{ mode, origin, token, deviceLabel }`），这个值只能由渲染进程写。
 * 本脚本因此同时写两个地方：
 *   1. `~/.dsh/remote-hub/outbound.json` —— 机器可读的记录（0600）；
 *   2. `~/.dsh/remote-hub/carrier-mode.json` —— 与 localStorage 同形的快照，
 *      供后续在页面里「导入」或在无 UI 环境核对状态。
 *
 * @module dsh-remote-hub/scripts/pair-outbound
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 读取命令行参数。 */
function parseArgv(argv) {
  const out = { origin: null, code: null, ticket: null, label: 'lead-client' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--origin') { out.origin = argv[i + 1]; i += 1 }
    else if (arg === '--code') { out.code = argv[i + 1]; i += 1 }
    else if (arg === '--ticket') { out.ticket = argv[i + 1]; i += 1 }
    else if (arg === '--label') { out.label = argv[i + 1]; i += 1 }
    else throw new Error(`unknown argument ${arg}`)
  }
  if (out.origin === null) throw new Error('--origin is required')
  if (out.code === null && out.ticket === null) throw new Error('--code or --ticket is required')
  return out
}

const args = parseArgv(process.argv.slice(2))
const origin = args.origin.replace(/\/+$/u, '')

const response = await fetch(`${origin}/remote/pair`, {
  method: 'POST',
  headers: { 'x-hub-protocol': '1', 'content-type': 'application/json' },
  body: JSON.stringify({
    ...(args.code === null ? {} : { code: args.code }),
    ...(args.ticket === null ? {} : { ticket: args.ticket }),
    clientLabel: args.label,
  }),
})

const text = await response.text()
let parsed
try {
  parsed = JSON.parse(text)
} catch {
  throw new Error(`guard returned non-JSON (${response.status}): ${text.slice(0, 200)}`)
}
if (response.status !== 200 || typeof parsed.token !== 'string') {
  const code = parsed?.result?.error?.code ?? parsed?.error?.code ?? 'unknown'
  throw new Error(`guard refused (${response.status}, code ${code})`)
}

const dir = join(homedir(), '.dsh', 'remote-hub')
await mkdir(dir, { recursive: true })
const file = join(dir, 'outbound.json')
await writeFile(file, `${JSON.stringify({
  version: 1,
  origin,
  deviceId: parsed.deviceId,
  role: parsed.role,
  token: parsed.token,
  pairedAt: new Date().toISOString(),
}, null, 2)}\n`, { mode: 0o600 })

// 与 localStorage `remote-hub.mode` 同形的快照：页面「主控端」卡片消费的形状。
const carrierFile = join(dir, 'carrier-mode.json')
await writeFile(carrierFile, `${JSON.stringify({
  mode: 'cloud',
  origin,
  token: parsed.token,
  deviceLabel: args.label,
}, null, 2)}\n`, { mode: 0o600 })

process.stdout.write('ok: true\n')
process.stdout.write(`origin: ${origin}\n`)
process.stdout.write(`device-id: ${parsed.deviceId}\n`)
process.stdout.write(`role: ${parsed.role}\n`)
process.stdout.write(`token-length: ${parsed.token.length}\n`)
process.stdout.write(`persisted: ${file}\n`)
process.stdout.write(`carrier-mode: ${carrierFile}\n`)
