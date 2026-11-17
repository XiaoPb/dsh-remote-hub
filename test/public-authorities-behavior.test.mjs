/**
 * 「信任的公网地址」行为测试：**真的调用** `createRuntimeConfigStore`。
 *
 * 上一个测试（`public-authorities.test.mjs`）锁的是源码契约；这里锁的是**行为**：
 * 把非法输入喂进去，确认它确实被拒绝、错误文案能指出原因，以及
 * `restartPending` 的语义正确。
 *
 * 为什么两者都要：源码断言无法发现「函数写了但没接进 patch 路径」，
 * 行为测试无法说明「为什么这样设计」。缺一不可。
 *
 * @module test/public-authorities-behavior.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { registerAlias } from './panel-alias-loader.mjs'

await registerAlias()
const { createRuntimeConfigStore, CONFIG_COLD_WRITABLE_KEYS } = await import(
  '../.build/host/host/src/runtime-config.js'
)

/** 临时目录（每个测试用随机文件名，互不干扰）。 */
let dir

/** 造一个指向临时目录的 store，`current` 模拟"当前运行中的配置"。 */
function makeStore(current = {}) {
  return createRuntimeConfigStore({
    path: join(dir, `overrides-${Math.random().toString(36).slice(2)}.json`),
    current: () => ({
      guardPort: 8443,
      network: 'lan',
      publicAuthorities: [],
      ...current,
    }),
  })
}

before(async () => { dir = await mkdtemp(join(tmpdir(), 'rh-pubauth-')) })
after(async () => { await rm(dir, { recursive: true, force: true }) })

describe('publicAuthorities：归类', () => {
  it('在冷字段列表里（重启生效）', () => {
    assert.ok(CONFIG_COLD_WRITABLE_KEYS.includes('publicAuthorities'))
  })
})

describe('publicAuthorities：合法输入', () => {
  it('接受普通域名并原样保存', async () => {
    const store = makeStore()
    const snapshot = await store.patch({ publicAuthorities: ['dsh.xiaopb.cn'] })
    assert.deepEqual(snapshot.publicAuthorities, ['dsh.xiaopb.cn'])
  })

  it('接受带端口的 authority', async () => {
    const store = makeStore()
    const snapshot = await store.patch({ publicAuthorities: ['dsh.example.com:8443'] })
    assert.deepEqual(snapshot.publicAuthorities, ['dsh.example.com:8443'])
  })

  it('去重（大小写不敏感）并保持首次出现的顺序', async () => {
    const store = makeStore()
    const snapshot = await store.patch({
      publicAuthorities: ['a.example.com', 'A.EXAMPLE.COM', 'b.example.com'],
    })
    assert.deepEqual(snapshot.publicAuthorities, ['a.example.com', 'b.example.com'])
  })

  it('接受空数组（清空白名单）', async () => {
    const store = makeStore({ publicAuthorities: ['old.example.com'] })
    const snapshot = await store.patch({ publicAuthorities: [] })
    assert.deepEqual(snapshot.publicAuthorities, [])
  })
})

describe('publicAuthorities：非法输入必须被拒绝', () => {
  const cases = [
    ['通配符', ['*.example.com'], /wildcard/u],
    ['裸星号', ['*'], /wildcard/u],
    ['带 scheme', ['https://dsh.example.com'], /bare host/u],
    ['带路径', ['dsh.example.com/path'], /bare host/u],
    ['带 userinfo', ['user@dsh.example.com'], /bare host/u],
    ['空字符串项', [''], /empty entries/u],
    ['非字符串项', [123], /must be strings/u],
    ['非数组', 'dsh.example.com', /must be an array/u],
    ['回环 IPv4', ['127.0.0.1'], /loopback address and is always allowed/u],
    ['回环 localhost', ['localhost'], /loopback address and is always allowed/u],
    ['回环 IPv6', ['[::1]'], /loopback address and is always allowed/u],
    ['私网 192.168', ['192.168.1.5'], /private\/LAN address/u],
    ['私网 10.x', ['10.0.0.7'], /private\/LAN address/u],
    ['私网 172.16', ['172.16.0.9'], /private\/LAN address/u],
    ['IPv6 ULA', ['[fd12:3456::1]'], /private\/LAN address/u],
  ]

  for (const [name, value, matcher] of cases) {
    it(`拒绝：${name}`, async () => {
      const store = makeStore()
      await assert.rejects(
        () => store.patch({ publicAuthorities: value }),
        (error) => {
          assert.match(String(error.message), matcher, `文案应匹配 ${matcher}`)
          return true
        },
      )
    })
  }

  it('拒绝后不落盘（原子性：失败不产生半个文件）', async () => {
    const path = join(dir, 'atomic.json')
    const store = createRuntimeConfigStore({
      path,
      current: () => ({ guardPort: 8443, network: 'lan', publicAuthorities: [] }),
    })
    await assert.rejects(() => store.patch({ publicAuthorities: ['*'] }))
    const { readFile: rf } = await import('node:fs/promises')
    await assert.rejects(() => rf(path, 'utf8'), '失败后不应留下 overrides 文件')
  })
})

describe('publicAuthorities：restartPending 语义', () => {
  it('写入与运行中不同 => 待重启', async () => {
    const store = makeStore({ publicAuthorities: [] })
    const snapshot = await store.patch({ publicAuthorities: ['dsh.xiaopb.cn'] })
    assert.equal(snapshot.restartPending, true)
  })

  it('写入与运行中相同 => 不待重启（数组按内容比较）', async () => {
    // 这是回归点：旧实现用 `!==` 比数组，引用不同 => 永远 true。
    const store = makeStore({ publicAuthorities: ['dsh.xiaopb.cn'] })
    const snapshot = await store.patch({ publicAuthorities: ['dsh.xiaopb.cn'] })
    assert.equal(snapshot.restartPending, false, '内容相同就不该报待重启')
  })

  it('顺序不同视为不同（顺序影响匹配优先级）', async () => {
    const store = makeStore({ publicAuthorities: ['a.example.com', 'b.example.com'] })
    const snapshot = await store.patch({ publicAuthorities: ['b.example.com', 'a.example.com'] })
    assert.equal(snapshot.restartPending, true)
  })
})

describe('publicAuthorities：持久化', () => {
  it('写入后重新加载仍能读到', async () => {
    const path = join(dir, 'persist.json')
    const first = createRuntimeConfigStore({
      path,
      current: () => ({ guardPort: 8443, network: 'lan', publicAuthorities: [] }),
    })
    await first.patch({ publicAuthorities: ['dsh.xiaopb.cn'] })

    const second = createRuntimeConfigStore({
      path,
      current: () => ({ guardPort: 8443, network: 'lan', publicAuthorities: [] }),
    })
    assert.deepEqual(await second.overrides(), { publicAuthorities: ['dsh.xiaopb.cn'] })

    const raw = JSON.parse(await readFile(path, 'utf8'))
    assert.deepEqual(raw.publicAuthorities, ['dsh.xiaopb.cn'])
  })
})
