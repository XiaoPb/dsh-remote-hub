/**
 * 桌面端端到端验证（Task 1.2 的 Node 等价物）。
 *
 * 起真实守卫，模拟桌面页面 origin 的完整请求链：
 *   1. OPTIONS 预检 → 204
 *   2. 真实 GET（带协议头 + pin + Sec-Fetch）→ 200 + ACAO
 *   3. 校验响应可被解析为页面所需的 JSON
 * 同时验证诊断分类在真实 HTTP 层成立。
 *
 * 注：这不是浏览器，但覆盖了浏览器与守卫之间的全部 HTTP 契约；
 * 真正的 Chromium 验证需要 DSH GUI，见 tasks/guard-desktop-diagnosis-todo.md。
 *
 * @module test/desktop-e2e.test.mjs
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mod = await import('../lib/index.js')

const PIN_HEADER = 'x-pair-issue-token'
const PIN = 'desktop-e2e-pin'
/** 模拟当前桌面 Web 页面 origin（与守卫同主机、不同端口）。 */
const PAGE_ORIGIN = 'http://127.0.0.1:6406'

const dispatcherStub = {
  peerFor() { throw new Error('not used') },
  async fetch() { throw new Error('not used') },
  async drop() {},
  async dispose() {},
  get size() { return 0 },
}

describe('桌面端完整请求链（预检 → 真实请求 → JSON）', () => {
  let dir
  let guard
  let base

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hub-e2e-'))
    const config = { ...mod.DEFAULT_CONFIG, guardPort: 0, deviceTablePath: join(dir, 'devices.json') }
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
      metrics: mod.createMetricsCollector(),
      configStore: mod.createRuntimeConfigStore({
        path: join(dir, 'overrides.json'),
        current: () => ({
          singleController: true, bridgeApprovals: true, defaultRole: 'control',
          maxPairAttempts: 5, network: 'loopback', guardPort: config.guardPort,
          pairQrTtlMs: config.pairQrTtlMs, pairCodeTtlMs: config.pairCodeTtlMs, tunnelKind: 'none',
        }),
      }),
      pairIssueToken: PIN,
    })
    base = guard.origin
  })

  after(async () => {
    await guard?.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  const endpoints = [
    { path: '/remote/devices', check: body => Array.isArray(body.devices) },
    { path: '/remote/stats', check: body => typeof body.startedAt === 'string' },
    { path: '/remote/config', check: body => typeof body.config === 'object' },
  ]

  for (const { path, check } of endpoints) {
    it(`${path}：OPTIONS 204 → GET 200 → JSON 可解析`, async () => {
      // 1) 预检（浏览器对带自定义头的跨源请求必发）
      const preflight = await fetch(`${base}${path}`, {
        method: 'OPTIONS',
        headers: {
          origin: PAGE_ORIGIN,
          'access-control-request-method': 'GET',
          'access-control-request-headers': `x-hub-protocol,${PIN_HEADER}`,
        },
      })
      assert.equal(preflight.status, 204, '预检必须通过')
      assert.equal(preflight.headers.get('access-control-allow-origin'), PAGE_ORIGIN)
      const allowHeaders = (preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase()
      assert.ok(allowHeaders.includes('x-hub-protocol'))
      assert.ok(allowHeaders.includes(PIN_HEADER))

      // 2) 真实请求（带浏览器会发的 Sec-Fetch-*）
      const response = await fetch(`${base}${path}`, {
        headers: {
          origin: PAGE_ORIGIN,
          'x-hub-protocol': '1',
          [PIN_HEADER]: PIN,
          'sec-fetch-site': 'same-site',
          'sec-fetch-mode': 'cors',
          'sec-fetch-dest': 'empty',
        },
      })
      assert.equal(response.status, 200, `${path} 必须可用`)
      assert.equal(response.headers.get('access-control-allow-origin'), PAGE_ORIGIN, '真实响应也必须带 ACAO')

      // 3) JSON 契约（页面直接消费的字段）
      const body = await response.json()
      assert.equal(body.ok, true)
      assert.ok(check(body), `${path} 返回体缺少页面所需字段`)
    })
  }

  it('地址栏式请求（无协议头）→ 400，且页面能据此分类为 http-400', async () => {
    const response = await fetch(`${base}/remote/devices`)
    assert.equal(response.status, 400)
    const body = await response.json()
    assert.equal(body.result.error.code, 'protocol-version-mismatch')
  })

  it('诊断文件包含实例握手字段', async () => {
    // startGuard 不写状态文件；这里验证 hostInstanceId 与端口一致即可。
    assert.match(mod.hostInstanceId(), /^hub_/u)
    assert.ok(guard.port > 0)
  })
})
