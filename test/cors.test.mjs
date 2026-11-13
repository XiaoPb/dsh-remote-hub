/**
 * 浏览器跨源访问回归测试（2026-11-11 实机故障）。
 *
 * 故障现象：页面（`127.0.0.1:<webPort>`）调用守卫（`127.0.0.1:8443`）的
 * `/remote/devices`、`/remote/stats`、`/remote/config` 全部 400 Bad Request。
 *
 * 根因（两条，缺一不可）：
 * 1. 浏览器对带自定义头的跨源请求会先发 `OPTIONS` 预检；预检**不携带**
 *    `x-hub-protocol` → 守卫的版本检查直接 400，真实请求根本没发出。
 * 2. 即便补上预检，真实请求的 `Origin`（`127.0.0.1:webPort`）与 `Host`
 *    （`127.0.0.1:8443`）authority 不同 → 来源围栏 403。
 *
 * 本测试用真实守卫 + 真实 HTTP 请求固化这两条回归。
 *
 * @module test/cors.test.mjs
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mod = await import('../lib/index.js')

const PIN_HEADER = 'x-pair-issue-token'
const PIN = 'test-issue-token'
/** 模拟 DSH web 页面的 origin（同主机、不同端口 = 浏览器眼里的跨源）。 */
const PAGE_ORIGIN = 'http://127.0.0.1:7155'

const dispatcherStub = {
  peerFor() { throw new Error('not used') },
  async fetch() { throw new Error('not used') },
  async drop() {},
  async dispose() {},
  get size() { return 0 },
}

describe('浏览器跨源：CORS 预检与回环 Origin', () => {
  let dir
  let guard
  let base

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hub-cors-'))
    const config = {
      ...mod.DEFAULT_CONFIG,
      guardPort: 0,
      deviceTablePath: join(dir, 'devices.json'),
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
    const metrics = mod.createMetricsCollector()
    const configStore = mod.createRuntimeConfigStore({
      path: join(dir, 'overrides.json'),
      current: () => ({
        singleController: config.singleController,
        bridgeApprovals: config.bridgeApprovals,
        defaultRole: config.defaultRole,
        maxPairAttempts: config.maxPairAttempts,
        network: config.network,
        guardPort: config.guardPort,
        pairQrTtlMs: config.pairQrTtlMs,
        pairCodeTtlMs: config.pairCodeTtlMs,
        tunnelKind: 'none',
      }),
    })
    guard = await mod.startGuard({
      config,
      tokens,
      pairing,
      dispatcher: dispatcherStub,
      devices,
      metrics,
      configStore,
      pairIssueToken: PIN,
    })
    base = guard.origin
  })

  after(async () => {
    await guard?.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  for (const path of ['/remote/devices', '/remote/stats', '/remote/config']) {
    it(`预检 OPTIONS ${path}（回环 origin）→ 204 + CORS 允许头`, async () => {
      const response = await fetch(`${base}${path}`, {
        method: 'OPTIONS',
        headers: {
          origin: PAGE_ORIGIN,
          'access-control-request-method': 'GET',
          'access-control-request-headers': `x-hub-protocol,${PIN_HEADER}`,
        },
      })
      assert.equal(response.status, 204, '预检必须成功（否则浏览器永远不会发真实请求）')
      assert.equal(response.headers.get('access-control-allow-origin'), PAGE_ORIGIN)
      assert.match(response.headers.get('access-control-allow-methods') ?? '', /GET/u)
      // 回显请求的自定义头，否则浏览器会拒绝带这些头的真实请求。
      const allowed = (response.headers.get('access-control-allow-headers') ?? '').toLowerCase()
      assert.ok(allowed.includes('x-hub-protocol'), 'allow-headers 必须含 x-hub-protocol')
      assert.ok(allowed.includes(PIN_HEADER), 'allow-headers 必须含 x-pair-issue-token')
    })

    it(`真实 GET ${path}（回环跨端口 origin）→ 200 + Access-Control-Allow-Origin`, async () => {
      // 浏览器对「同主机不同端口」判定为 same-site（不是 cross-site），
      // 所以这里带上浏览器会发的 Sec-Fetch-* 头，忠实复现真实请求。
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
      assert.equal(response.status, 200, `${path} 必须放行本机页面`)
      assert.equal(response.headers.get('access-control-allow-origin'), PAGE_ORIGIN)
      const body = await response.json()
      assert.equal(body.ok, true)
    })
  }

  it('Sec-Fetch-Site: cross-site 一律拒绝（跨站防护不回退）', async () => {
    const response = await fetch(`${base}/remote/devices`, {
      headers: {
        origin: PAGE_ORIGIN,
        'x-hub-protocol': '1',
        [PIN_HEADER]: PIN,
        'sec-fetch-site': 'cross-site',
      },
    })
    assert.equal(response.status, 403)
  })

  it('非回环 origin 的预检 → 404（不宣告 CORS）', async () => {
    const response = await fetch(`${base}/remote/devices`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://evil.example.com',
        'access-control-request-method': 'GET',
        'access-control-request-headers': `${PIN_HEADER}`,
      },
    })
    assert.equal(response.status, 404)
    assert.equal(response.headers.get('access-control-allow-origin'), null)
  })

  it('非回环 origin 的真实请求 → 403（围栏仍然生效）', async () => {
    const response = await fetch(`${base}/remote/devices`, {
      headers: { origin: 'http://evil.example.com', 'x-hub-protocol': '1', [PIN_HEADER]: PIN },
    })
    assert.equal(response.status, 403)
  })

  it('无 Origin 的非浏览器调用（curl/CLI）行为不变 → 200', async () => {
    const response = await fetch(`${base}/remote/devices`, {
      headers: { 'x-hub-protocol': '1', [PIN_HEADER]: PIN },
    })
    assert.equal(response.status, 200)
  })

  it('回环 origin 但缺少 pairIssueToken → 仍然 403（放宽 Origin 不等于放宽凭据）', async () => {
    const response = await fetch(`${base}/remote/devices`, {
      headers: { origin: PAGE_ORIGIN, 'x-hub-protocol': '1' },
    })
    assert.equal(response.status, 403)
  })

  it('回环 origin 访问 /remote/pair（公网兑换端）仍按严格围栏 → 403', async () => {
    // pair 端允许非回环调用方，但 Origin 与 Host 不同 authority 时必须拒绝。
    const response = await fetch(`${base}/remote/pair`, {
      method: 'POST',
      headers: { origin: PAGE_ORIGIN, 'x-hub-protocol': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ABCD2345', clientLabel: 'x' }),
    })
    assert.equal(response.status, 403)
  })
})
