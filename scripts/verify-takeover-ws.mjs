/**
 * 真实环境验证：本机连远端守卫的 /remote/ws，跑通整机接管的长连接。
 *
 * 用已配对的设备令牌连接远端守卫的 WS 端点，发送一个 open 帧，
 * 验证能收到 item / end 帧。
 *
 * @module scripts/verify-takeover-ws
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { WebSocket } from 'ws'

const mode = JSON.parse(readFileSync(join(homedir(), '.dsh', 'remote-hub', 'outbound.json'), 'utf8'))
const origin = mode.origin.replace(/\/+$/u, '')
const wsUrl = `${origin.replace(/^http/, 'ws')}/remote/ws?token=${encodeURIComponent(mode.token)}&ws-target=/api/remote.mux`

console.log(`连接: ${origin}/remote/ws`)
console.log(`设备: ${mode.deviceId}\n`)

const socket = new WebSocket(wsUrl)
const frames = []

const done = new Promise(resolve => {
  const timer = setTimeout(() => resolve('timeout'), 15_000)

  socket.on('open', () => {
    console.log('✅ 握手成功（101）')
    // 用一个真实的 stream 端点（官方 `account/watch`：mode='stream'，无参数）。
    socket.send(JSON.stringify({
      type: 'open',
      streamId: 'probe-1',
      endpoint: 'account/watch',
      payload: { args: {} },
    }))
  })

  socket.on('message', data => {
    const frame = JSON.parse(String(data))
    frames.push(frame)
    console.log(`   ← ${frame.type}${frame.error === undefined ? '' : ` ${JSON.stringify(frame.error).slice(0, 80)}`}`)
    if (frame.type === 'end' || frame.type === 'error') {
      clearTimeout(timer)
      resolve('done')
    }
  })

  socket.on('error', error => {
    clearTimeout(timer)
    console.log(`❌ 连接失败: ${error.message}`)
    resolve('error')
  })

  socket.on('close', (code, reason) => {
    clearTimeout(timer)
    console.log(`   连接关闭: ${code} ${String(reason).slice(0, 60)}`)
    resolve('closed')
  })
})

const outcome = await done
try { socket.close() } catch { /* 已关闭 */ }

console.log(`\n收到 ${frames.length} 帧，结果: ${outcome}`)
if (frames.length > 0) {
  console.log('结论：✅ 整机接管的 WebSocket 链路可用')
  process.exit(0)
}
console.log('结论：❌ 未收到任何帧')
process.exit(1)
