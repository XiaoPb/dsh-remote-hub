/**
 * 用真实的 carrier-mode.json 走一遍 installCarrier，验证产出的 transport。
 *
 * 这是重启 DSH 之前能做的最强验证：不依赖浏览器，直接用构建产物
 * + 真实令牌 + 真实远端地址，断言 transport 的每个字段都指向远端。
 *
 * @module scripts/verify-carrier-transport
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { registerAlias } from '../test/panel-alias-loader.mjs'

await registerAlias()
const carrier = await import('../.build/client/client/src/carrier.js')

const mode = JSON.parse(readFileSync(join(homedir(), '.dsh', 'remote-hub', 'carrier-mode.json'), 'utf8'))
const globalObject = {}
const result = carrier.installCarrier({
  readMode: () => mode,
  globalObject,
  // 不真正建连，只记录 URL
  webSocketImpl: url => { globalObject.__lastWsUrl = url; return { close() {} } },
})

console.log(`active: ${result.active}`)
const t = globalObject.__DSH_TRANSPORT__
console.log(`fetch:            ${typeof t?.fetch}`)
console.log(`createWebSocket: ${typeof t?.createWebSocket}`)
console.log(`streamBaseUrl:   ${t?.streamBaseUrl}`)
console.log(`ownsHost:        ${t?.ownsHost}`)
console.log(`openStream:      ${t?.openStream === undefined ? 'undefined (正确)' : '存在（错误）'}`)

// 模拟官方两次调用
t.createWebSocket(new URL('/api/remote.mux'.slice(1), t.streamBaseUrl).href)
const wsUrl = new URL(globalObject.__lastWsUrl)
console.log(`\nWS 目标: ${wsUrl.protocol}//${wsUrl.host}${wsUrl.pathname}`)
console.log(`  token:     ${wsUrl.searchParams.get('token') === mode.token ? '正确' : '错误'}`)
console.log(`  ws-target: ${wsUrl.searchParams.get('ws-target')}`)

const ok = result.active
  && typeof t.fetch === 'function'
  && typeof t.createWebSocket === 'function'
  && t.streamBaseUrl === mode.origin
  && t.ownsHost === true
  && t.openStream === undefined
  && wsUrl.host === new URL(mode.origin).host
  && wsUrl.pathname === '/remote/ws'
  && wsUrl.searchParams.get('token') === mode.token

console.log(`\n结论：${ok ? '✅ transport 全部字段正确指向远端' : '❌ 存在偏差'}`)
process.exit(ok ? 0 : 1)
