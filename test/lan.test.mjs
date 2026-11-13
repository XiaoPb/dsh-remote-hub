/**
 * 局域网信任域测试：绑定地址断言、来源围栏的私网判定、对端地址判定。
 *
 * 覆盖用户要求：「信任域放宽到本地局域网内正常连接；公网需隧道或 VPN」。
 * 关键不变量：**公网地址永远不会因为 LAN 模式被放行**。
 *
 * @module test/lan.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { registerAlias } from './panel-alias-loader.mjs'

await registerAlias()

const cfg = await import('../.build/host/host/src/config.js')
const fence = await import('../.build/host/host/src/fence.js')

function req(headers, remoteAddress) {
  return { headers, remoteAddress }
}

describe('isPrivateAddress（RFC1918 / 链路本地 / ULA）', () => {
  it('私网段全部识别', () => {
    for (const address of ['10.0.0.5', '172.16.3.4', '172.31.255.254', '192.168.1.10', '169.254.3.7', '127.0.0.1']) {
      assert.equal(cfg.isPrivateAddress(address), true, address)
    }
    for (const address of ['fd12:3456::1', 'fe80::1']) {
      assert.equal(cfg.isPrivateAddress(address), true, address)
    }
  })

  it('公网与非法地址不算私网', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '203.0.113.5', '2001:4860::8888', 'not-an-ip']) {
      assert.equal(cfg.isPrivateAddress(address), false, address)
    }
  })
})

describe('assertBindableHost', () => {
  it('loopback 模式：只接受回环字面量（保持 v0.1 行为）', () => {
    assert.doesNotThrow(() => cfg.assertBindableHost('127.0.0.1', 'loopback'))
    assert.throws(() => cfg.assertBindableHost('0.0.0.0', 'loopback'), /loopback/u)
    assert.throws(() => cfg.assertBindableHost('192.168.1.5', 'loopback'), /loopback/u)
  })

  it('lan 模式：接受 0.0.0.0/:: 与私网字面量，拒绝公网', () => {
    for (const host of ['0.0.0.0', '::', '127.0.0.1', '192.168.1.5', '10.1.2.3', '172.20.0.9']) {
      assert.doesNotThrow(() => cfg.assertBindableHost(host, 'lan'), host)
    }
    for (const host of ['8.8.8.8', '203.0.113.9', 'example.com']) {
      assert.throws(() => cfg.assertBindableHost(host, 'lan'), /private/u, host)
    }
  })

  it('validateConfig：network 参与校验', () => {
    const base = { ...cfg.DEFAULT_CONFIG }
    assert.doesNotThrow(() => cfg.validateConfig({ ...base, network: 'loopback', guardHost: '127.0.0.1' }))
    assert.throws(
      () => cfg.validateConfig({ ...base, network: 'loopback', guardHost: '0.0.0.0' }),
      /loopback/u,
    )
    assert.doesNotThrow(() => cfg.validateConfig({ ...base, network: 'lan', guardHost: '0.0.0.0' }))
    assert.throws(
      () => cfg.validateConfig({ ...base, network: 'lan', guardHost: '8.8.8.8' }),
      /private/u,
    )
  })
})

describe('来源围栏：LAN 模式放宽到私网，公网仍需显式声明', () => {
  const OPTIONS = { publicAuthorities: [], protocol: 'http:', allowPrivate: true }

  it('私网 authority 在 LAN 模式放行', () => {
    for (const host of ['192.168.1.10:8443', '10.0.0.7:8443', '172.16.0.2:8443']) {
      assert.deepEqual(fence.checkSource(req({ host }), OPTIONS), { ok: true }, host)
    }
  })

  it('公网 authority 在 LAN 模式仍被拒绝', () => {
    for (const host of ['8.8.8.8:8443', 'example.com:8443', '203.0.113.9:8443']) {
      const verdict = fence.checkSource(req({ host }), OPTIONS)
      assert.equal(verdict.ok, false, host)
    }
  })

  it('loopback 模式（allowPrivate 缺省）下私网 authority 仍被拒', () => {
    const verdict = fence.checkSource(req({ host: '192.168.1.10:8443' }), {
      publicAuthorities: [],
      protocol: 'http:',
    })
    assert.equal(verdict.ok, false)
  })

  it('隧道公开 authority 仍按显式白名单放行', () => {
    const verdict = fence.checkSource(req({ host: 'hub.example.com' }), {
      publicAuthorities: ['hub.example.com'],
      protocol: 'https:',
    })
    assert.deepEqual(verdict, { ok: true })
  })

  it('跨站标记与不匹配 Origin 在 LAN 模式下同样拒', () => {
    assert.equal(fence.checkSource(req({ host: '192.168.1.10:8443', 'sec-fetch-site': 'cross-site' }), OPTIONS).ok, false)
    assert.equal(fence.checkSource(req({ host: '192.168.1.10:8443', origin: 'http://evil.example' }), OPTIONS).ok, false)
    assert.equal(fence.checkSource(req({ host: '192.168.1.10:8443', origin: 'http://192.168.1.10:8443' }), OPTIONS).ok, true)
  })
})

describe('checkPrivatePeer：公网端口映射的最后防线', () => {
  it('私网/回环对端放行（含 v4-mapped v6）', () => {
    for (const address of ['127.0.0.1', '::1', '192.168.1.20', '::ffff:192.168.1.20', '10.5.6.7']) {
      assert.deepEqual(fence.checkPrivatePeer(address), { ok: true }, address)
    }
  })

  it('公网对端拒绝', () => {
    for (const address of ['8.8.8.8', '::ffff:8.8.8.8', '203.0.113.9', undefined, '']) {
      assert.equal(fence.checkPrivatePeer(address).ok, false, String(address))
    }
  })
})
