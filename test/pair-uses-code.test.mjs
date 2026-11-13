/**
 * 端到端验证：短码/票据真的能完成配对并拿到可用令牌。
 *
 * 回答两个问题：
 * 1. 页面生成的短码能否用于配对控制？
 * 2. 无 UI 场景能否通过 CLI 拿到同等凭据？
 *
 * 做法：起真实守卫 → 签发短码 → 用同一套 redeem 路径兑换 → 用拿到的令牌
 * 调需要认证的端点，证明配对结果真的可用于控制。
 *
 * @module test/pair-uses-code.test.mjs
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mod = await import('../lib/index.js')

const dispatcherStub = {
  peerFor() { throw new Error('not used') },
  async fetch() { throw new Error('not used') },
  async drop() {},
  async dispose() {},
  get size() { return 0 },
}

describe('短码 / 票据可用于配对控制', () => {
  let dir
  let guard
  let base
  let devices

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hub-pairuse-'))
    const config = { ...mod.DEFAULT_CONFIG, guardPort: 0, deviceTablePath: join(dir, 'devices.json') }
    devices = await mod.createDeviceStore(config.deviceTablePath)
    const tokens = mod.createTokenService({ devices })
    const pairing = mod.createPairingService({
      config: {
        pairQrTtlMs: config.pairQrTtlMs,
        pairCodeTtlMs: config.pairCodeTtlMs,
        maxPairAttempts: config.maxPairAttempts,
        defaultRole: config.defaultRole,
      },
      tokens,
    })
    guard = await mod.startGuard({
      config, tokens, pairing, dispatcher: dispatcherStub, devices, pairIssueToken: 'pin-xyz',
    })
    base = guard.origin
  })

  after(async () => {
    await guard?.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  const issue = async kind => {
    const response = await fetch(`${base}/remote/pair/${kind === 'code' ? 'code' : 'ticket'}`, {
      method: 'POST',
      headers: { 'x-hub-protocol': '1', 'x-pair-issue-token': 'pin-xyz', 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'control' }),
    })
    assert.equal(response.status, 200)
    return response.json()
  }

  it('短码兑换成功 → 返回长期设备令牌 → 写入设备表（持久化）', async () => {
    const issued = await issue('code')
    assert.equal(typeof issued.code, 'string')
    assert.equal(issued.code.length, 8, '短码必须是 8 位')
    assert.equal(issued.expiresAt - Date.now() <= 15_000, true, 'TTL 必须是 15 秒窗口')

    const redeemed = await fetch(`${base}/remote/pair`, {
      method: 'POST',
      headers: { 'x-hub-protocol': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ code: issued.code, clientLabel: 'phone' }),
    })
    assert.equal(redeemed.status, 200, '短码必须可用于配对')
    const token = await redeemed.json()
    assert.equal(typeof token.token, 'string')
    assert.equal(token.token.length, 43, '返回 43 字符设备令牌')
    assert.equal(token.role, 'control')

    // 持久化：设备表里出现该设备（只存哈希）。
    const rows = devices.list()
    assert.equal(rows.some(row => row.deviceId === token.deviceId && row.revokedAt === null), true)
  })

  it('拿到令牌后可用于认证请求（配对结果真的可用）', async () => {
    const issued = await issue('code')
    const redeemed = await fetch(`${base}/remote/pair`, {
      method: 'POST',
      headers: { 'x-hub-protocol': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ code: issued.code, clientLabel: 'phone2' }),
    })
    const { token } = await redeemed.json()

    // 过期后凭据失效，但令牌仍然有效（这正是「15 秒窗口 + 持久化」的意义）。
    const rpc = await fetch(`${base}/remote/rpc`, {
      method: 'POST',
      headers: {
        'x-hub-protocol': '1',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/list', payload: { args: {} } }),
    })
    // 通过了认证层（不是 401）；具体业务由 dispatcher 桩决定。
    assert.notEqual(rpc.status, 401, '令牌必须被认证层接受')
  })

  it('短码一次性：兑换后再次使用失败', async () => {
    const issued = await issue('code')
    const first = await fetch(`${base}/remote/pair`, {
      method: 'POST',
      headers: { 'x-hub-protocol': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ code: issued.code, clientLabel: 'a' }),
    })
    assert.equal(first.status, 200)
    const replay = await fetch(`${base}/remote/pair`, {
      method: 'POST',
      headers: { 'x-hub-protocol': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ code: issued.code, clientLabel: 'b' }),
    })
    assert.notEqual(replay.status, 200, '短码必须一次性')
  })

  it('CLI（无 UI）能拿到与页面同源的短码/票据', async () => {
    // CLI 从 ~/.dsh/remote-hub/pair-issue-pin 读 pin；用 HOME 重定向到临时目录模拟。
    const home = join(dir, 'home')
    await import('node:fs/promises').then(fs => fs.mkdir(join(home, '.dsh', 'remote-hub'), { recursive: true }))
    await writeFile(join(home, '.dsh', 'remote-hub', 'pair-issue-pin'), 'pin-xyz\n', { mode: 0o600 })

    const runCli = argv => new Promise((resolve, reject) => {
      execFile(process.execPath, [new URL('../bin/dsh-remote-hub-pair.mjs', import.meta.url).pathname.replace(/^\//u, ''), ...argv], {
        env: { ...process.env, HOME: home, USERPROFILE: home },
        timeout: 15_000,
      }, (error, stdout, stderr) => {
        if (error !== null) reject(new Error(`${error.message}\n${stderr}`))
        else resolve(stdout)
      })
    })

    const out = await runCli(['--code', '--port', String(guard.port)])
    assert.match(out, /^secret: [0-9A-HJKMNP-TV-Z]{8}$/mu, 'CLI 必须输出 8 位短码')
    assert.match(out, /^guard-origin: http:\/\/127\.0\.0\.1:/mu)
    assert.match(out, /^redeem-hint: POST .*"code"/mu, 'CLI 必须给出兑换方式')
  })

  it('CLI --lan：输出局域网地址与可直接分享的配对链接', async () => {
    const home = join(dir, 'home2')
    await import('node:fs/promises').then(fs => fs.mkdir(join(home, '.dsh', 'remote-hub'), { recursive: true }))
    await writeFile(join(home, '.dsh', 'remote-hub', 'pair-issue-pin'), 'pin-xyz\n', { mode: 0o600 })
    const runCli = argv => new Promise((resolve, reject) => {
      execFile(process.execPath, [new URL('../bin/dsh-remote-hub-pair.mjs', import.meta.url).pathname.replace(/^\//u, ''), ...argv], {
        env: { ...process.env, HOME: home, USERPROFILE: home },
        timeout: 15_000,
      }, (error, stdout, stderr) => {
        if (error !== null) reject(new Error(`${error.message}\n${stderr}`))
        else resolve(stdout)
      })
    })
    const out = await runCli(['--qr', '--port', String(guard.port), '--lan'])
    assert.match(out, /^secret: [A-Za-z0-9_-]{43}$/mu, 'CLI 必须输出 43 字符票据')
    // 有局域网网卡时必须给出地址；无网卡时至少不报错。
    if (/^lan-address: /mu.test(out)) {
      assert.match(out, /^lan-address: http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/mu)
      assert.match(out, /^pair-link: http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/#dshrh=[A-Za-z0-9_-]{43}$/mu,
        'pair-link 必须是可直接分享的完整链接')
    }
  })
})
