#!/usr/bin/env node
/**
 * dsh-remote-hub-pair — 无界面 host 的配对 CLI。
 *
 * 服务器上没有 GUI 页面可注入 pairIssueToken，所以插件把它以 0600 写在
 * `~/.dsh/remote-hub/pair-issue-pin`。本命令读 pin，调守卫的**回环**签发端点，
 * 把 QR 票据 / 8 位短码打到 stdout —— 这是无界面环境对接手机/浏览器 client 的
 * 唯一入口。绝不经隧道；pin 与票据都只出现在本机。
 *
 * 用法：
 *   dsh-remote-hub-pair --code [--role control] [--label <设备名>]
 *   dsh-remote-hub-pair --qr   [--role control]
 *   dsh-remote-hub-pair --port 8443 --code
 *
 * 输出（stdout，每行一个 `key: value`，便于脚本解析）：
 *   path: code
 *   secret: 7K3M9XQ2
 *   role: control
 *   expires-at: 2026-11-11T12:00:00.000Z
 *   guard-origin: http://127.0.0.1:8443
 *   redeem-hint: POST /remote/pair {"code":"...","clientLabel":"..."}
 *
 * @module dsh-remote-hub/pair-cli
 */
import { readFile } from 'node:fs/promises'
import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'

// Inlined from core/src/protocol.ts on purpose: this bin ships standalone in
// the published package (`files` carries bin/ but not src/), so it must not
// import anything outside node builtins. Keep in sync with GUARD_ROUTES /
// HUB_PROTOCOL_HEADER / PAIR_ISSUE_HEADER (contract-check asserts this).
const GUARD_ROUTES = {
  health: '/remote/health',
  pairTicket: '/remote/pair/ticket',
  pairCode: '/remote/pair/code',
  pair: '/remote/pair',
  rpc: '/remote/rpc',
}
const HUB_PROTOCOL_HEADER = 'x-hub-protocol'
const PAIR_ISSUE_HEADER = 'x-pair-issue-token'

const ROLE_NAMES = ['read-only', 'control', 'full']

function parseArgv(argv) {
  const out = { role: 'control', port: 8443, mode: null, label: null, lan: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--code') out.mode = 'code'
    else if (arg === '--qr' || arg === '--ticket') out.mode = 'qr'
    else if (arg === '--lan') out.lan = true
    else if (arg === '--role') {
      const value = argv[i + 1]
      if (value === undefined || !ROLE_NAMES.includes(value)) {
        fail(`--role must be one of ${ROLE_NAMES.join(', ')}`)
      }
      out.role = value
      i += 1
    } else if (arg === '--port') {
      const value = Number(argv[i + 1])
      if (!Number.isInteger(value) || value < 1 || value > 65_535) fail('--port must be an integer 1..65535')
      out.port = value
      i += 1
    } else if (arg === '--label') {
      out.label = argv[i + 1]
      i += 1
    } else if (arg === '--help' || arg === '-h') out.help = true
    else fail(`unknown argument ${JSON.stringify(arg)}`)
  }
  return out
}

function fail(message) {
  process.stderr.write(`dsh-remote-hub-pair: ${message}\n`)
  process.exit(2)
}

async function readPin() {
  const path = join(homedir(), '.dsh', 'remote-hub', 'pair-issue-pin')
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    fail(
      `pair-issue-pin not found at ${path}. The host plugin writes it at startup; `
      + 'check that dsh --profile host is running and the plugin loaded.',
    )
  }
  const pin = raw.trim()
  if (pin === '') fail(`${path} is empty`)
  return pin
}

const args = parseArgv(process.argv.slice(2))
if (args.help || args.mode === null) {
  process.stdout.write(`dsh-remote-hub-pair — issue a pairing credential from a headless host

Usage:
  dsh-remote-hub-pair --code [--role control] [--port 8443] [--lan]
  dsh-remote-hub-pair --qr   [--role control] [--port 8443] [--lan]

Options:
  --code          issue an 8-char Crockford short code (TTL 15s, rotates)
  --qr            issue a 43-char QR ticket (TTL 15s, rotates, single use)
  --role <name>   read-only | control | full (default: control)
  --port <n>      guard port (default: 8443)
  --label <text>  device label for the audit row
  --lan           also print LAN IPv4 addresses and a ready-to-share pair-link
  -h, --help      this text

Credentials are short-lived (15 seconds) by design: once a device redeems a
code or ticket, the guard issues a long-lived device token and persists its
hash to the device table, so the paired device keeps working after the
credential window closes. For an automated flow, call this command again to
get a fresh credential right before redeeming.

Reads the 0600 pin file the host plugin wrote at startup:
  ~/.dsh/remote-hub/pair-issue-pin
Then calls the loopback-only issue endpoint and prints the credential.
`)
  process.exit(args.mode === null ? 2 : 0)
}

const pin = await readPin()
const origin = `http://127.0.0.1:${args.port}`
const endpoint = args.mode === 'code' ? GUARD_ROUTES.pairCode : GUARD_ROUTES.pairTicket

let response
try {
  response = await fetch(`${origin}${endpoint}`, {
    method: 'POST',
    headers: {
      [HUB_PROTOCOL_HEADER]: '1',
      [PAIR_ISSUE_HEADER]: pin,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ role: args.role }),
  })
} catch (error) {
  fail(`guard at ${origin} is unreachable: ${error instanceof Error ? error.message : String(error)}`)
}

const text = await response.text()
let parsed
try {
  parsed = JSON.parse(text)
} catch {
  fail(`guard returned non-JSON (status ${response.status}): ${text.slice(0, 200)}`)
}

if (response.status !== 200) {
  const code = parsed?.result?.error?.code ?? parsed?.error?.code ?? 'unknown'
  fail(`guard refused (status ${response.status}, code ${code}); is the pin current?`)
}

const secret = args.mode === 'code' ? parsed.code : parsed.ticket
if (typeof secret !== 'string' || secret === '') fail('guard response did not carry a credential')

/**
 * 枚举本机局域网 IPv4（与 host 侧 `lanAddresses()` 同判据，内联以保持独立可运行）。
 * 只取非内部、非链路本地地址，`192.168.*` 优先。
 * @returns 地址列表。
 */
function lanAddresses() {
  const rows = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      const address = entry.address
      if (address.startsWith('169.254.')) continue
      const rank = address.startsWith('192.168.') ? 0
        : address.startsWith('10.') ? 1
          : /^172\.(1[6-9]|2\d|3[01])\./u.test(address) ? 2 : 3
      rows.push({ address, rank })
    }
  }
  return rows.sort((a, b) => a.rank - b.rank).map(row => row.address)
}

const expiresAt = typeof parsed.expiresAt === 'number' ? new Date(parsed.expiresAt).toISOString() : 'unknown'
const body = args.mode === 'code'
  ? JSON.stringify({ code: secret, clientLabel: args.label ?? 'remote device' })
  : JSON.stringify({ ticket: secret, clientLabel: args.label ?? 'remote device' })

// 其他设备可达的地址：--lan 时给出局域网 IPv4 + 端口（扫码/填写用）。
const lan = args.lan ? lanAddresses() : []
const reachable = lan[0] === undefined ? origin : `http://${lan[0]}:${args.port}`

process.stdout.write(`path: ${args.mode === 'code' ? 'code' : 'qr'}\n`)
process.stdout.write(`secret: ${secret}\n`)
process.stdout.write(`role: ${parsed.role ?? args.role}\n`)
process.stdout.write(`expires-at: ${expiresAt}\n`)
process.stdout.write(`guard-origin: ${origin}\n`)
if (args.lan) {
  for (const address of lan) process.stdout.write(`lan-address: http://${address}:${args.port}\n`)
  // 票据配对的完整链接（与页面二维码内容一致），便于直接抄给另一台设备。
  if (args.mode === 'qr') process.stdout.write(`pair-link: ${reachable}/#dshrh=${secret}\n`)
}
process.stdout.write(`redeem-hint: POST ${reachable}${GUARD_ROUTES.pair} ${body}\n`)

