/**
 * 本地插件页的可见性判定（`lifecycle.ts`）。
 *
 * 需求：「主要在连接云端设备时显示与操作本地插件」；断开后撤下。
 * 判据必须与侧栏「云端设备」图标的绿点一致，否则会出现「有绿点却没有本地插件页」的错位。
 *
 * @module test/local-plugin-lifecycle
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

/**
 * 加载编译后的 `lifecycle.js`（把 `@core/...` 改写成相对路径）。
 * @returns 模块命名空间。
 */
async function loadLifecycle() {
  const source = readFileSync(new URL('../.build/client/client/src/local-plugin-manager/lifecycle.js', import.meta.url), 'utf8')
  const directory = await mkdtemp(join(tmpdir(), 'lpm-lifecycle-'))
  const coreDir = join(directory, 'core', 'src')
  await mkdir(coreDir, { recursive: true })
  const target = join(directory, 'lifecycle.mjs')
  await writeFile(target, source.replace(/from '@core\/([^']+)'/gu, (_match, rest) => `from './core/src/${rest}'`), 'utf8')
  const mod = await import(pathToFileURL(target).href)
  await rm(directory, { recursive: true, force: true }).catch(() => {})
  return mod
}

const { isTakeoverActive, watchTakeover } = await loadLifecycle()

/** 构造一个带有接管状态的假全局。 */
function globalsOf({ active, streamBaseUrl }) {
  return {
    __DSH_REMOTE_HUB_CARRIER__: { active },
    __DSH_TRANSPORT__: { streamBaseUrl },
  }
}

test('只在「carrier 激活 + transport 指向云端」时可见', () => {
  assert.equal(isTakeoverActive(globalsOf({ active: true, streamBaseUrl: 'http://192.168.0.17:8443' })), true)
  assert.equal(isTakeoverActive(globalsOf({ active: false, streamBaseUrl: 'http://192.168.0.17:8443' })), false)
  assert.equal(isTakeoverActive(globalsOf({ active: true, streamBaseUrl: '' })), false)
  assert.equal(isTakeoverActive(globalsOf({ active: true })), false)
  assert.equal(isTakeoverActive({}), false)
  // 与侧栏图标的判据同源：没有 carrier 全局时一律 false（不猜测）。
  assert.equal(isTakeoverActive({ __DSH_TRANSPORT__: { streamBaseUrl: 'http://x' } }), false)
})

test('watchTakeover 只在状态翻转时回调，并在释放后停止', async () => {
  const globalObject = globalsOf({ active: false, streamBaseUrl: '' })
  const seen = []
  let tick = 0
  const stop = watchTakeover(active => { seen.push(active) }, {
    globalObject,
    intervalMs: 1000,
    setInterval: (callback) => { tick = callback; return 1 },
    clearInterval: () => {},
  })
  assert.deepEqual(seen, [false])
  // 状态未变：不回调。
  tick()
  assert.deepEqual(seen, [false])
  // 进入接管。
  globalObject.__DSH_REMOTE_HUB_CARRIER__ = { active: true }
  globalObject.__DSH_TRANSPORT__ = { streamBaseUrl: 'http://192.168.0.17:8443' }
  tick()
  assert.deepEqual(seen, [false, true])
  // 断开接管。
  globalObject.__DSH_REMOTE_HUB_CARRIER__ = { active: false }
  tick()
  assert.deepEqual(seen, [false, true, false])
  // 释放后不再回调。
  stop()
  globalObject.__DSH_REMOTE_HUB_CARRIER__ = { active: true }
  tick()
  assert.deepEqual(seen, [false, true, false])
})

test('缺失 addEventListener 的环境（Node / vm 沙箱）不会抛错', () => {
  const globalObject = globalsOf({ active: true, streamBaseUrl: 'http://x' })
  const stop = watchTakeover(() => {}, {
    globalObject,
    intervalMs: 1000,
    setInterval: () => 1,
    clearInterval: () => {},
  })
  assert.doesNotThrow(() => stop())
})
