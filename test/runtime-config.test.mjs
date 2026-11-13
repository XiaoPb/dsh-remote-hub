/**
 * 运行时配置存取测试：白名单收敛、持久化、覆盖合并、非法字段拒绝。
 *
 * @module test/runtime-config.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// runtime-config 引用 `@core/index.js`（isRoleName）；先注册别名解析，再动态导入。
await import('./panel-alias-loader.mjs').then(m => m.registerAlias())
const { createRuntimeConfigStore } = await import('../.build/host/host/src/runtime-config.js')

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'rh-cfg-'))
}

const BASE = {
  singleController: true,
  bridgeApprovals: true,
  defaultRole: 'control',
  maxPairAttempts: 5,
  network: 'loopback',
  guardPort: 8443,
  pairQrTtlMs: 120_000,
  pairCodeTtlMs: 600_000,
  tunnelKind: 'none',
}

describe('runtime-config 白名单', () => {
  it('patch 热项生效并落盘 overrides.json', async () => {
    const dir = tempDir()
    try {
      const store = createRuntimeConfigStore({ path: join(dir, 'overrides.json'), current: () => BASE })
      const result = await store.patch({ singleController: false, maxPairAttempts: 8 })
      assert.equal(result.singleController, false)
      assert.equal(result.maxPairAttempts, 8)
      // 冷项保持不变。
      assert.equal(result.guardPort, 8443)
      const onDisk = JSON.parse(readFileSync(join(dir, 'overrides.json'), 'utf8'))
      assert.deepEqual(onDisk, { singleController: false, maxPairAttempts: 8 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('越界字段（冷项/未知）拒绝并给出可读原因', async () => {
    const dir = tempDir()
    try {
      const store = createRuntimeConfigStore({ path: join(dir, 'overrides.json'), current: () => BASE })
      await assert.rejects(
        () => store.patch({ guardPort: 9999 }),
        /read-only or unknown/,
      )
      await assert.rejects(
        () => store.patch({ hackerField: 1 }),
        /read-only or unknown/,
      )
      // 白名单内但类型非法同样拒绝。
      await assert.rejects(() => store.patch({ singleController: 'yes' }), /must be boolean/)
      await assert.rejects(() => store.patch({ defaultRole: 'root' }), /known role/)
      await assert.rejects(() => store.patch({ maxPairAttempts: 0 }), /1\.\.100/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('缺失 overrides 文件 = 无覆盖；get 返回当前配置', async () => {
    const dir = tempDir()
    try {
      const store = createRuntimeConfigStore({ path: join(dir, 'overrides.json'), current: () => BASE })
      const snapshot = await store.get()
      assert.equal(snapshot.singleController, true)
      assert.equal(snapshot.network, 'loopback')
      assert.deepEqual(await store.overrides(), {})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('损坏的 overrides 文件降级为空覆盖（不抛）', async () => {
    const dir = tempDir()
    try {
      const store = createRuntimeConfigStore({ path: join(dir, 'overrides.json'), current: () => BASE })
      const snapshot = await store.get()
      assert.equal(snapshot.singleController, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('onPatched 订阅收到覆盖值', async () => {
    const dir = tempDir()
    try {
      const store = createRuntimeConfigStore({ path: join(dir, 'overrides.json'), current: () => BASE })
      const seen = []
      const off = store.onPatched(overrides => { seen.push({ ...overrides }) })
      await store.patch({ bridgeApprovals: false })
      off()
      await store.patch({ bridgeApprovals: true })
      assert.equal(seen.length, 1)
      assert.equal(seen[0].bridgeApprovals, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
