/**
 * 守卫设备管理 + 单控策略集成测试。
 *
 * 起一个真实的守卫（127.0.0.1 临时端口），用真实设备表 / 令牌 / 配对服务，
 * 只把 dispatcher 换成桩（设备管理路由不经过 Peer 与 decide()）。
 *
 * @module test/guard-admin.test.mjs
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mod = await import('../lib/index.js')

const PAIR_ISSUE_HEADER = 'x-pair-issue-token'

/** 桩 dispatcher：设备管理路由不会调用它。 */
const dispatcherStub = {
  peerFor() { throw new Error('not used') },
  async fetch() { throw new Error('not used') },
  async drop() {},
  async dispose() {},
  get size() { return 0 },
}

function adminHeaders(token) {
  return { [PAIR_ISSUE_HEADER]: token, 'x-hub-protocol': '1' }
}

async function getDevices(base, token) {
  const response = await fetch(`${base}/remote/devices`, { headers: adminHeaders(token) })
  return { status: response.status, body: await response.json().catch(() => null) }
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    // 守卫对**所有**路由校验 X-Hub-Protocol（含配对端点）。
    headers: { 'content-type': 'application/json', 'x-hub-protocol': '1', ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

describe('守卫设备管理（/remote/devices）', () => {
  let dir
  let guard
  let base

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hub-guard-'))
    const config = {
      ...mod.DEFAULT_CONFIG,
      guardPort: 0, // 临时端口
      deviceTablePath: join(dir, 'devices.json'),
      singleController: true,
    }
    const devices = await mod.createDeviceStore(config.deviceTablePath)
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
      config,
      tokens,
      pairing,
      dispatcher: dispatcherStub,
      devices,
      pairIssueToken: 'test-issue-token',
    })
    base = guard.origin
  })

  after(async () => {
    await guard?.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('缺少 pairIssueToken → 403（不泄露设备表）', async () => {
    const { status } = await getDevices(base, 'wrong')
    assert.equal(status, 403)
  })

  it('正确 token → 200，返回守卫状态与空设备表', async () => {
    const { status, body } = await getDevices(base, 'test-issue-token')
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.singleController, true)
    assert.equal(body.guard.host, '127.0.0.1')
    assert.equal(body.guard.port, guard.port)
    assert.deepEqual(body.devices, [])
  })

  it('配对一台设备后出现在列表；第二台配对触发单控（旧设备被吊销）', async () => {
    // 第一台：签发短码 → 兑换
    const issued1 = await postJson(`${base}/remote/pair/code`, { role: 'control' }, adminHeaders('test-issue-token'))
    assert.equal(issued1.status, 200)
    const redeemed1 = await postJson(`${base}/remote/pair`, { code: issued1.body.code, clientLabel: 'dev-one' })
    assert.equal(redeemed1.status, 200)
    const firstId = redeemed1.body.deviceId
    assert.ok(firstId)

    let snapshot = await getDevices(base, 'test-issue-token')
    assert.equal(snapshot.body.devices.length, 1)
    assert.equal(snapshot.body.devices[0].deviceId, firstId)
    assert.equal(snapshot.body.devices[0].revokedAt, null)

    // 第二台：单控策略应吊销第一台
    const issued2 = await postJson(`${base}/remote/pair/code`, { role: 'read-only' }, adminHeaders('test-issue-token'))
    const redeemed2 = await postJson(`${base}/remote/pair`, { code: issued2.body.code, clientLabel: 'dev-two' })
    assert.equal(redeemed2.status, 200)
    const secondId = redeemed2.body.deviceId

    snapshot = await getDevices(base, 'test-issue-token')
    const first = snapshot.body.devices.find(device => device.deviceId === firstId)
    const second = snapshot.body.devices.find(device => device.deviceId === secondId)
    // 2026-11-12 修订：单控只**踢连接**，不删配对。
    assert.equal(first.revokedAt, null, '旧设备配对保留（不被吊销）')
    assert.notEqual(first.displacedAt, null, '旧设备标记为被挤下线')
    assert.equal(second.revokedAt, null, '新设备保持有效')

    // 被挤下线的设备**令牌仍有效**（可重新连接，无需重新扫码）。
    // 注意：本测试用桩 dispatcher，真正的 RPC 会走到桩并失败；
    // 这里只断言「令牌通过了认证层」——即不是 401。
    const stillValid = await fetch(`${base}/remote/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-protocol': '1',
        authorization: `Bearer ${redeemed1.body.token}`,
      },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/list', payload: { args: {} } }),
    })
    assert.notEqual(stillValid.status, 401, '被挤下线不等于配对失效：令牌必须仍能通过认证')

    // 配对响应告知「踢掉了谁」，供 UI 弹窗
    assert.equal(Array.isArray(redeemed2.body.displacedDevices), true, '必须返回 displacedDevices')
    assert.equal(redeemed2.body.displacedDevices.some(device => device.deviceId === firstId), true)
  })

  it('清除单台配对 → revoked 列表 + 列表标记', async () => {
    const snapshot = await getDevices(base, 'test-issue-token')
    const active = snapshot.body.devices.find(device => device.revokedAt === null)
    assert.ok(active, '有活跃设备可清除')
    const result = await postJson(
      `${base}/remote/devices/revoke`,
      { deviceId: active.deviceId },
      adminHeaders('test-issue-token'),
    )
    assert.equal(result.status, 200)
    assert.deepEqual(result.body.revoked, [active.deviceId])

    const after1 = await getDevices(base, 'test-issue-token')
    const row = after1.body.devices.find(device => device.deviceId === active.deviceId)
    assert.notEqual(row.revokedAt, null)
  })

  it('清除全部配对（all:true）', async () => {
    const issued = await postJson(`${base}/remote/pair/code`, { role: 'full' }, adminHeaders('test-issue-token'))
    await postJson(`${base}/remote/pair`, { code: issued.body.code, clientLabel: 'dev-three' })
    const result = await postJson(`${base}/remote/devices/revoke`, { all: true }, adminHeaders('test-issue-token'))
    assert.equal(result.status, 200)
    const snapshot = await getDevices(base, 'test-issue-token')
    assert.equal(snapshot.body.devices.every(device => device.revokedAt !== null), true)
  })

  it('revoke 缺少参数 → 400；错误 token → 403', async () => {
    const bad = await postJson(`${base}/remote/devices/revoke`, {}, adminHeaders('test-issue-token'))
    assert.equal(bad.status, 400)
    const forbidden = await postJson(`${base}/remote/devices/revoke`, { all: true }, adminHeaders('nope'))
    assert.equal(forbidden.status, 403)
  })
})
