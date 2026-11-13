/**
 * 验证「断开并切回本机」的完整语义。
 *
 * 覆盖 2026-11-12 报告的缺陷：点断开 → 页面刷新 → 毫无变化。
 *
 * 断言链：
 *  1. 初始为 cloud（carrier-mode.json 有 token）
 *  2. 模拟 onDetach：写 { mode: 'local' } 到磁盘
 *  3. 磁盘读到 mode=local 且 exists=true（"用户显式断开"）
 *  4. carrier 判定 active=false（否决 localStorage 的残留 cloud）
 *  5. 恢复 cloud，确认能连回去
 *
 * @module scripts/verify-detach-semantics.mjs
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { registerAlias } from '../test/panel-alias-loader.mjs'

await registerAlias()
const carrier = await import('../.build/client/client/src/carrier.js')

const MODE_FILE = join(homedir(), '.dsh', 'remote-hub', 'carrier-mode.json')
const backup = existsSync(MODE_FILE) ? readFileSync(MODE_FILE, 'utf8') : null

/** 用真实磁盘内容模拟 admin.carrier 的返回。 */
function diskMode() {
  if (!existsSync(MODE_FILE)) return { mode: 'local', explicit: false }
  try {
    const parsed = JSON.parse(readFileSync(MODE_FILE, 'utf8'))
    if (parsed.mode === 'cloud' && typeof parsed.origin === 'string' && typeof parsed.token === 'string') {
      return { mode: 'cloud', origin: parsed.origin, token: parsed.token, ...(parsed.deviceLabel ? { deviceLabel: parsed.deviceLabel } : {}) }
    }
    return { mode: 'local', explicit: true }
  } catch {
    return { mode: 'local', explicit: true }
  }
}

/** localStorage 桩：残留上次连接的 cloud。 */
function staleStorage() {
  const store = new Map()
  return {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, value) },
    removeItem: key => { store.delete(key) },
    _seed(value) { store.set('remote-hub.mode', JSON.stringify(value)) },
  }
}

const checks = []
const record = (label, ok) => { checks.push([label, ok]) }

try {
  // 初始：cloud
  const initial = JSON.parse(readFileSync(MODE_FILE, 'utf8'))
  record('前置：当前是 cloud 模式', initial.mode === 'cloud')

  // ── 场景 A：用户点「断开并切回本机」 ─────────────────────────
  writeFileSync(MODE_FILE, JSON.stringify({ mode: 'local' }, null, 2) + '\n')
  const afterDetach = diskMode()
  record('断开后磁盘 mode=local', afterDetach.mode === 'local')
  record('断开后 exists=true（显式断开标记）', afterDetach.explicit === true)

  // localStorage 里残留 cloud（真实场景：上次连接留下的）
  const stale = staleStorage()
  stale._seed({ mode: 'cloud', origin: 'http://192.168.0.17:8443', token: 'x'.repeat(43) })

  const globalObject = {}
  const result = await carrier.installCarrierResolvingMode({
    readMode: () => ({ mode: 'cloud', origin: 'http://192.168.0.17:8443', token: 'x'.repeat(43) }),
    fetchMode: async () => diskMode(),
    globalObject,
  })
  record('断开后 carrier 不激活', result.active === false)
  record('断开后不注入 __DSH_TRANSPORT__', globalObject.__DSH_TRANSPORT__ === undefined)

  // ── 场景 B：重新连接 ────────────────────────────────────────
  if (backup !== null) {
    writeFileSync(MODE_FILE, backup)
    const restored = diskMode()
    record('恢复 cloud 后磁盘读到 cloud', restored.mode === 'cloud')

    const g2 = {}
    const r2 = await carrier.installCarrierResolvingMode({
      readMode: () => ({ mode: 'local' }),
      fetchMode: async () => diskMode(),
      globalObject: g2,
    })
    record('重新连接后 carrier 激活', r2.active === true)
    record('重新连接后 transport 指向远端', g2.__DSH_TRANSPORT__?.streamBaseUrl === restored.origin)
  }
} finally {
  if (backup !== null) writeFileSync(MODE_FILE, backup)
  else if (existsSync(MODE_FILE)) unlinkSync(MODE_FILE)
}

console.log('=== 断开语义验证 ===\n')
let allOk = true
for (const [label, ok] of checks) {
  allOk = allOk && ok
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
}
console.log(`\n结论：${allOk ? '✅ 断开能真正切回本机，重连能真正接管' : '❌ 存在缺陷'}`)
process.exit(allOk ? 0 : 1)
