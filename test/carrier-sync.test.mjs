/**
 * 回归：出站状态以磁盘为真源，页面定时同步。
 *
 * 需求（2026-11-12）："根据持久化的文件进行动态加载，定时读取/更新/加载，
 * 不只是启动时读取。"
 *
 * 覆盖三层：
 * 1. `normalizeCarrier` 形状收敛（非法 → local）；
 * 2. `carrierEquals` 去重（避免无意义重写）；
 * 3. host 侧 `readCarrierFile` / `writeCarrierFile` 往返 + 原子写。
 *
 * @module test/carrier-sync.test.mjs
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerAlias } from './panel-alias-loader.mjs'

await registerAlias()
const page = await import('../.build/client/client/src/panel/RemoteHubPage.js')

const mod = await import('../lib/index.js')

describe('出站状态形状收敛（页面侧）', () => {
  const cases = [
    [null, 'local'],
    [undefined, 'local'],
    [{}, 'local'],
    [{ mode: 'cloud' }, 'local'],
    [{ mode: 'cloud', origin: '' }, 'local'],
    [{ mode: 'nonsense' }, 'local'],
  ]
  for (const [input, expected] of cases) {
    it(`非法输入 → ${expected}：${JSON.stringify(input)}`, () => {
      assert.equal(page.normalizeCarrier(input).mode, expected)
    })
  }

  it('合法 token-free cloud hint 保留 targetId 与 deviceLabel', () => {
    const next = page.normalizeCarrier({
      mode: 'cloud',
      origin: 'http://192.168.0.17:8443',
      targetId: 'a'.repeat(64),
      deviceLabel: 'v4debian',
    })
    assert.equal(next.mode, 'cloud')
    assert.equal(next.origin, 'http://192.168.0.17:8443')
    assert.equal(next.targetId, 'a'.repeat(64))
    assert.equal(next.token, undefined)
    assert.equal(next.deviceLabel, 'v4debian')
  })
})

describe('出站状态去重（避免反复覆盖）', () => {
  it('相同 opaque targetId 的 token-free cloud hint 视为等价', () => {
    const a = { mode: 'cloud', origin: 'http://a:1', targetId: 'a'.repeat(64) }
    assert.equal(page.carrierEquals(a, { ...a }), true)
  })

  it('local 与 cloud 不等价', () => {
    assert.equal(page.carrierEquals({ mode: 'local' }, { mode: 'cloud', origin: 'http://a:1', token: 't' }), false)
  })

  it('token-free hints 的 targetId 或 origin 不同即不等价', () => {
    assert.equal(page.carrierEquals(
      { mode: 'cloud', origin: 'http://a:1', targetId: 'a'.repeat(64) },
      { mode: 'cloud', origin: 'http://a:1', targetId: 'b'.repeat(64) },
    ), false)
    assert.equal(page.carrierEquals(
      { mode: 'cloud', origin: 'http://a:1', targetId: 'a'.repeat(64) },
      { mode: 'cloud', origin: 'http://b:2', targetId: 'a'.repeat(64) },
    ), false)
  })
})

describe('出站状态文件读写（host 侧）', () => {
  let dir
  let home
  const originalHome = process.env.HOME
  const originalProfile = process.env.USERPROFILE
  const originalDshHome = process.env.DSH_HOME

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'carrier-'))
    home = dir
    // 插件路径**优先 DSH_HOME**（沙箱隔离），所以要把它一起重定向；
    // 只设 HOME/USERPROFILE 已经不够。
    process.env.DSH_HOME = join(home, '.dsh')
    process.env.HOME = home
    process.env.USERPROFILE = home
  })

  after(async () => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalProfile
    if (originalDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalDshHome
    await rm(dir, { recursive: true, force: true })
  })

  it('文件缺失 → local 且 at=0', async () => {
    const snapshot = await mod.readCarrierFile()
    assert.equal(snapshot.mode.mode, 'local')
    assert.equal(snapshot.at, 0)
  })

  it('写入 cloud 时只落 carrier targetId；读回运行态解析 bearer', async () => {
    const store = mod.createOutboundTargetStore(join(home, '.dsh'))
    const token = 'x'.repeat(43)
    const archived = await store.save({
      origin: 'http://192.168.0.17:8443',
      token,
      deviceLabel: 'v4debian',
    })
    const at = await mod.writeCarrierFile({
      mode: 'cloud',
      origin: archived.origin,
      targetId: archived.id,
      deviceLabel: archived.deviceLabel,
    })
    assert.ok(at > 0, 'mtime 必须有效')
    const file = join(home, '.dsh', 'remote-hub', 'carrier-mode.json')
    const fileText = await readFile(file, 'utf8')
    assert.equal(fileText.includes(token), false, 'bearer must not be duplicated in carrier file')
    const snapshot = await mod.readCarrierFile()
    assert.equal(snapshot.mode.mode, 'cloud')
    assert.equal(snapshot.mode.origin, archived.origin)
    assert.equal(snapshot.mode.targetId, archived.id)
    assert.equal(snapshot.mode.token, token, 'owner API resolves bearer from profile archive into runtime value')
    assert.equal(snapshot.mode.deviceLabel, 'v4debian')
    assert.equal(snapshot.at, at)
  })

  it('迁移旧的 token+targetId carrier 文件后只持久化 opaque id', async () => {
    const store = mod.createOutboundTargetStore(join(home, '.dsh'))
    const token = 'm'.repeat(43)
    const archived = await store.save({ origin: 'http://192.168.0.17:8443', token, deviceLabel: 'remote' })
    const file = join(home, '.dsh', 'remote-hub', 'carrier-mode.json')
    await writeFile(file, JSON.stringify({
      mode: 'cloud', origin: archived.origin, targetId: archived.id, token, deviceLabel: 'remote',
    }))
    const snapshot = await mod.readCarrierFile()
    assert.equal(snapshot.mode.token, token)
    const persisted = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(persisted.targetId, archived.id)
    assert.equal(Object.hasOwn(persisted, 'token'), false)
  })

  it('文件为 0600（凭据不可被他人读）', async () => {
    const file = join(home, '.dsh', 'remote-hub', 'carrier-mode.json')
    const info = await stat(file)
    if (process.platform !== 'win32') {
      assert.equal(info.mode & 0o777, 0o600)
    }
  })


  it('写 local → 清除 cloud 字段', async () => {
    await mod.writeCarrierFile({ mode: 'local' })
    const snapshot = await mod.readCarrierFile()
    assert.equal(snapshot.mode.mode, 'local')
    assert.equal(snapshot.mode.token, undefined, 'token 必须被清除')
  })

  it('磁盘内容损坏 → 收敛到 local（不抛）', async () => {
    const file = join(home, '.dsh', 'remote-hub', 'carrier-mode.json')
    await writeFile(file, '{not json')
    const snapshot = await mod.readCarrierFile()
    assert.equal(snapshot.mode.mode, 'local')
  })

  it('外部改写文件后，读回的是新内容（动态加载的核心）', async () => {
    await mod.writeCarrierFile({ mode: 'local' })
    const before = await mod.readCarrierFile()
    // 模拟 CLI 配对写入
    const file = join(home, '.dsh', 'remote-hub', 'carrier-mode.json')
    await writeFile(file, JSON.stringify({
      mode: 'cloud', origin: 'http://192.168.0.99:8443', token: 'y'.repeat(43), deviceLabel: 'cli-paired',
    }))
    await new Promise(resolve => setTimeout(resolve, 20))
    const after2 = await mod.readCarrierFile()
    assert.equal(after2.mode.mode, 'cloud')
    assert.equal(after2.mode.origin, 'http://192.168.0.99:8443')
    assert.notEqual(after2.at, before.at, 'mtime 变化是页面感知变更的依据')
  })

  it('轮询间隔常量存在且足够快', () => {
    assert.equal(typeof page.CARRIER_POLL_MS, 'number')
    assert.ok(page.CARRIER_POLL_MS <= 5_000, '轮询间隔应 ≤ 5 秒')
  })
})
