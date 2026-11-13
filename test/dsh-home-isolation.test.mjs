/**
 * 实例隔离与重复加载（2026-11-12 两机/沙箱实测缺陷）。
 *
 * 缺陷 1：插件用 `homedir()` 拼 `~/.dsh`，**忽略 `DSH_HOME`**。
 *   dsh-box 这类工具靠 `DSH_HOME` 隔离档案柜；插件不尊重它，沙箱实例会把
 *   `devices.json` / `host-status.json` / `carrier-mode.json` 写进用户**真实**的
 *   `~/.dsh`——既污染主环境，又让"隔离测试"根本测不到隔离语义。
 *
 * 缺陷 2：同一进程里插件被加载两次（profile/patch 重复 insert）时，
 *   官方 `registerPolicy` 抛 principal kind 冲突。必须让重复装配 fail-closed，
 *   不能沿用另一份装配绑定的设备表/资源集合。
 *
 * @module test/dsh-home-isolation.test.mjs
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

const mod = await import('../lib/index.js')

describe('DSH_HOME 隔离', () => {
  let sandboxHome
  const original = process.env.DSH_HOME

  before(async () => {
    sandboxHome = await mkdtemp(join(tmpdir(), 'dsh-home-'))
    process.env.DSH_HOME = sandboxHome
  })

  after(async () => {
    if (original === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = original
    await rm(sandboxHome, { recursive: true, force: true }).catch(() => {})
  })

  it('dshHome() 返回 DSH_HOME 指定的目录', () => {
    assert.equal(mod.dshHome(), sandboxHome)
  })

  it('expandHome("~/.dsh/...") 落到沙箱内，而不是真实家目录', () => {
    const resolved = mod.expandHome('~/.dsh/remote-hub/devices.json')
    assert.ok(resolved.startsWith(sandboxHome), `必须落在沙箱内，实际 ${resolved}`)
    assert.ok(!resolved.includes(`${sep}.dsh${sep}remote-hub`), '不得再拼出 .dsh 子目录')
  })

  it('expandHome("~/.dsh") 就是 DSH_HOME 本身', () => {
    assert.equal(mod.expandHome('~/.dsh'), sandboxHome)
  })

  it('绝对路径不被改写', () => {
    const absolute = join(sandboxHome, 'custom', 'devices.json')
    assert.equal(mod.expandHome(absolute), absolute)
  })

  it('DSH_HOME 缺失时退回真实 ~/.dsh（不崩、不指向空目录）', () => {
    delete process.env.DSH_HOME
    try {
      const fallback = mod.dshHome()
      assert.ok(fallback.endsWith(`${sep}.dsh`), `应退回 ~/.dsh，实际 ${fallback}`)
    } finally {
      process.env.DSH_HOME = sandboxHome
    }
  })
})

describe('策略重复注册：配置冲突时 fail-closed', () => {
  /**
   * 造一个假的 remoteAccess 服务：第一次注册成功，第二次抛「已有策略」。
   *
   * 注意：`registerDevicePolicy` 走 **`ctx.reflect.get('remoteAccess', false)`**
   * 读实例（见 policy.ts 的注释：reflect.props 只是声明元数据，不是服务对象），
   * 所以桩必须提供 `reflect.get`。
   * @returns {{ctx: any, calls: number[]}} 环境。
   */
  function makeCtx() {
    const calls = []
    let registered = false
    const remoteAccess = {
      registerPolicy() {
        calls.push(1)
        if (registered) throw new Error('remote access: principal kind "remote-device" already has a policy')
        registered = true
        return () => { registered = false }
      },
      invalidate() {},
      allows: () => true,
    }
    const ctx = {
      reflect: { get: name => (name === 'remoteAccess' ? remoteAccess : undefined) },
      remoteAccess,
    }
    return { ctx, calls }
  }

  /** 最小设备表桩。 */
  const devices = {
    get: () => undefined,
    list: () => [],
  }

  it('第二次注册冲突必须抛出，且不能接管或 dispose 首个策略', () => {
    const env = makeCtx()
    const first = mod.registerDevicePolicy(env.ctx, { devices })
    assert.throws(
      () => mod.registerDevicePolicy(env.ctx, { devices }),
      /already has a policy/u,
    )
    first.dispose()
    assert.equal(env.calls.length, 2)
  })

  it('非「已有策略」的注册错误仍然抛出（不吞真实故障）', () => {
    const broken = {
      registerPolicy() { throw new Error('remote access service exploded') },
      invalidate() {},
    }
    const ctx = {
      reflect: { get: name => (name === 'remoteAccess' ? broken : undefined) },
      remoteAccess: broken,
    }
    assert.throws(
      () => mod.registerDevicePolicy(ctx, { devices }),
      /exploded/u,
      '只有"重复注册"才降级，其它错误必须暴露',
    )
  })
})
