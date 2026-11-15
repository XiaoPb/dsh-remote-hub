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

  it('未知字段拒绝；冷项可写但标记需重启', async () => {
    const dir = tempDir()
    try {
      const store = createRuntimeConfigStore({ path: join(dir, 'overrides.json'), current: () => BASE })
      await assert.rejects(
        () => store.patch({ hackerField: 1 }),
        /read-only or unknown/,
      )
      // 冷项（端口/网络）现在可写：写在 overrides 里，但运行值不变，直到重启。
      const patched = await store.patch({ guardPort: 9443, network: 'lan' })
      assert.equal(patched.guardPort, 9443, '快照展示的是待生效值')
      assert.equal(patched.restartPending, true, '必须显式标记「重启后生效」')
      // 白名单内但类型非法同样拒绝。
      await assert.rejects(() => store.patch({ singleController: 'yes' }), /must be boolean/)
      await assert.rejects(() => store.patch({ defaultRole: 'root' }), /known role/)
      await assert.rejects(() => store.patch({ maxPairAttempts: 0 }), /1\.\.100/)
      await assert.rejects(() => store.patch({ guardPort: 70_000 }), /1\.\.65535/)
      await assert.rejects(() => store.patch({ network: 'public' }), /loopback or lan/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('冷项覆盖与运行值一致时不再提示重启', async () => {
    const dir = tempDir()
    try {
      const store = createRuntimeConfigStore({ path: join(dir, 'overrides.json'), current: () => BASE })
      await store.patch({ guardPort: BASE.guardPort })
      assert.equal((await store.get()).restartPending, false)
      await store.patch({ guardPort: 9443 })
      assert.equal((await store.get()).restartPending, true)
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
