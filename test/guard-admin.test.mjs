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
    guard = await mod.startGuard({
      config,
      tokens,
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


  it('revoke 缺少参数 → 400；错误 token → 403', async () => {
    const bad = await postJson(`${base}/remote/devices/revoke`, {}, adminHeaders('test-issue-token'))
    assert.equal(bad.status, 400)
    const forbidden = await postJson(`${base}/remote/devices/revoke`, { all: true }, adminHeaders('nope'))
    assert.equal(forbidden.status, 403)
  })
})
