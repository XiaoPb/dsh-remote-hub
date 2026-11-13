/**
 * 设计 v0.3 §8 接管事务与恢复：carrier 的持久化与 transport 纯净性。
 *
 * 覆盖两个真实缺陷：
 *  1. 身份失效（401 / `device-revoked`）时，必须先**落盘** `local` 再重载；
 *     只清 localStorage 会让重载后从磁盘再次接管同一个失效目标（401 循环）。
 *  2. 接管 transport **绝不**携带 `openStream`：官方「只有 rpc.open 不存在时才
 *     启动原生 mux」，带上它等于自己关掉长连接。
 *
 * @module test/carrier-recovery.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { registerAlias } from './panel-alias-loader.mjs'

await registerAlias()
const carrier = await import('../.build/client/client/src/carrier.js')

const CLOUD_MODE = {
  mode: 'cloud',
  origin: 'http://192.168.0.17:8443',
  token: 't'.repeat(43),
  deviceLabel: 'v2-linux',
}

/**
 * 构造最小全局与可观测副作用。
 * @param {object} options - 注入项。
 * @returns {object} 环境。
 */
function makeEnv(options = {}) {
  const events = []
  const globals = {}
  if (options.existing !== undefined) globals.__DSH_TRANSPORT__ = options.existing
  return {
    events,
    globals,
    reloaded: { count: 0 },
    fetchInit: {
      reload() { events.push('reload') },
      fallbackMode() { events.push('localStorage-cleared') },
    },
  }
}

/** 构造一个 device-revoked 的 200 信封响应。 */
function revokedResponse() {
  return new Response(JSON.stringify({
    type: 'server-response',
    rpcId: 'r',
    result: { ok: false, error: { code: 'device-revoked', message: 'gone', details: {} } },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('身份失效恢复：先落盘再重载', () => {
  it('device-revoked 时先写磁盘 local，再 reload', async () => {
    const env = makeEnv()
    const order = []
    const result = carrier.createCarrier({
      readMode: () => CLOUD_MODE,
      globalObject: env.globals,
      fetchImpl: async () => revokedResponse(),
      fallbackMode: () => { order.push('localStorage') },
      persistLocal: async () => { order.push('disk') },
      reload: () => { order.push('reload') },
    })
    assert.equal(result.active, true)

    await result.transport.fetch('api/session/list', { method: 'POST', body: '{}' })
    // 让 fallback 的 Promise 链跑完。
    await new Promise(resolve => setTimeout(resolve, 10))

    assert.deepEqual(order, ['localStorage', 'disk', 'reload'],
      '必须先清本地缓存、再落盘，最后重载')
  })

  it('HTTP 401 走同一条持久化路径', async () => {
    const env = makeEnv()
    const order = []
    const result = carrier.createCarrier({
      readMode: () => CLOUD_MODE,
      globalObject: env.globals,
      fetchImpl: async () => new Response('nope', { status: 401 }),
      fallbackMode: () => { order.push('localStorage') },
      persistLocal: async () => { order.push('disk') },
      reload: () => { order.push('reload') },
    })
    await result.transport.fetch('api/session/list', { method: 'POST', body: '{}' })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(order, ['localStorage', 'disk', 'reload'])
  })

  it('落盘失败仍然重载（本次会话必须回到本机）', async () => {
    const env = makeEnv()
    const order = []
    const result = carrier.createCarrier({
      readMode: () => CLOUD_MODE,
      globalObject: env.globals,
      fetchImpl: async () => new Response('nope', { status: 401 }),
      fallbackMode: () => { order.push('localStorage') },
      persistLocal: async () => { throw new Error('disk full') },
      reload: () => { order.push('reload') },
    })
    await result.transport.fetch('api/session/list', { method: 'POST', body: '{}' })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(order, ['localStorage', 'reload'], '落盘失败不能阻塞重载')
  })

  it('fallback 只执行一次（并发 401 不会重复重载）', async () => {
    const env = makeEnv()
    let reloads = 0
    const result = carrier.createCarrier({
      readMode: () => CLOUD_MODE,
      globalObject: env.globals,
      fetchImpl: async () => new Response('nope', { status: 401 }),
      fallbackMode: () => {},
      persistLocal: async () => {},
      reload: () => { reloads += 1 },
    })
    await Promise.all([
      result.transport.fetch('api/a/b', { method: 'POST', body: '{}' }),
      result.transport.fetch('api/a/c', { method: 'POST', body: '{}' }),
    ])
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(reloads, 1, '重载必须幂等')
  })
})

describe('transport 纯净性：不接入 openStream', () => {
  it('即使传入 openStream 也不出现在 transport 上', () => {
    const env = makeEnv()
    const result = carrier.createCarrier({
      readMode: () => CLOUD_MODE,
      globalObject: env.globals,
      openStream: async function* () { yield 1 },
    })
    assert.equal(result.transport.openStream, undefined,
      'openStream 会禁用官方 mux，接管模式绝不能带')
    assert.equal('openStream' in result.transport, false)
  })

  it('默认 transport 只有 fetch / createWebSocket / streamBaseUrl / ownsHost', () => {
    const env = makeEnv()
    const result = carrier.createCarrier({ readMode: () => CLOUD_MODE, globalObject: env.globals })
    assert.deepEqual(Object.keys(result.transport).sort(),
      ['createWebSocket', 'fetch', 'ownsHost', 'streamBaseUrl'].sort())
  })
})
