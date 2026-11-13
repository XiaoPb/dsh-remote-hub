/**
 * M3：守卫 `/remote/ws` 路由测试（A3 形态：校验 + 认领 + 移交）。
 *
 * 守卫**不**做字节转发（架构说明 §10.9）：
 * 只验证「决定是否放行」，放行后把 socket 交给 Host 的 wireStream。
 *
 * @module test/guard-ws.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const ws = await import('../lib/index.js')

/** 造一个假 socket，记录写出去的字节。 */
function fakeSocket() {
  const written = []
  return {
    written,
    ended: false,
    destroyed: false,
    write(chunk) { written.push(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk)); return true },
    end(chunk) { if (chunk !== undefined) written.push(String(chunk)); this.ended = true },
    destroy() { this.destroyed = true },
    on() {},
    removeListener() {},
  }
}

/** 造一个合法的升级请求。 */
function upgradeRequest(url) {
  return {
    url,
    headers: {
      upgrade: 'websocket',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
    },
  }
}

/** 组装一个带记录的 deps。 */
function makeDeps(overrides = {}) {
  const log = []
  const handoffs = []
  const deps = {
    authenticate: async token => (token === 'good-token' ? { deviceId: 'dev_x', role: 'control' } : null),
    handoff: input => { handoffs.push(input) },
    onEvent: event => { log.push(event) },
    ...overrides,
  }
  return { deps, log, handoffs }
}

describe('路由形状', () => {
  it('路径固定为 /remote/ws', () => {
    const { deps } = makeDeps()
    const handle = ws.createGuardWsRoute(deps)
    assert.equal(handle.route.path, '/remote/ws')
    assert.equal(typeof handle.route.handler, 'function')
  })
})

describe('鉴权', () => {
  it('缺令牌 → 401，不调用 handoff', async () => {
    const { deps, handoffs, log } = makeDeps()
    const { route } = ws.createGuardWsRoute(deps)
    const socket = fakeSocket()
    route.handler(upgradeRequest('/remote/ws'), socket, Buffer.alloc(0))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(socket.destroyed, true)
    assert.match(socket.written.join(''), /401/u)
    assert.equal(handoffs.length, 0, '未授权不得移交')
    assert.equal(log.at(-1).outcome, 'unauthorized')
  })

  it('非法令牌 → 401', async () => {
    const { deps, handoffs } = makeDeps()
    const { route } = ws.createGuardWsRoute(deps)
    const socket = fakeSocket()
    route.handler(upgradeRequest('/remote/ws?token=bad-token'), socket, Buffer.alloc(0))
    await new Promise(resolve => setImmediate(resolve))
    assert.match(socket.written.join(''), /401/u)
    assert.equal(handoffs.length, 0)
  })

  it('合法令牌 → 移交给 Host（携带 peer）', async () => {
    const { deps, handoffs, log } = makeDeps()
    const { route } = ws.createGuardWsRoute(deps)
    const socket = fakeSocket()
    route.handler(upgradeRequest('/remote/ws?token=good-token'), socket, Buffer.alloc(0))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(handoffs.length, 1, '必须移交一次')
    assert.equal(handoffs[0].deviceId, 'dev_x')
    assert.equal(handoffs[0].target, '/api/remote.mux', '默认目标')
    assert.equal(log.at(-1).outcome, 'accepted')
  })

  it('令牌不进日志（安全）', async () => {
    const { deps, log } = makeDeps()
    const { route } = ws.createGuardWsRoute(deps)
    route.handler(upgradeRequest('/remote/ws?token=good-token'), fakeSocket(), Buffer.alloc(0))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(JSON.stringify(log).includes('good-token'), false, '日志不得包含令牌')
  })
})

describe('转发目标白名单', () => {
  it('非 /api 前缀 → 400，不移交', async () => {
    const { deps, handoffs } = makeDeps()
    const { route } = ws.createGuardWsRoute(deps)
    const socket = fakeSocket()
    route.handler(
      upgradeRequest('/remote/ws?token=good-token&ws-target=/etc/passwd'),
      socket,
      Buffer.alloc(0),
    )
    await new Promise(resolve => setImmediate(resolve))
    assert.match(socket.written.join(''), /400/u)
    assert.equal(handoffs.length, 0, '非法目标不得移交')
  })

  it('合法的 /api/xxx 目标被接受', async () => {
    const { deps, handoffs } = makeDeps()
    const { route } = ws.createGuardWsRoute(deps)
    route.handler(
      upgradeRequest('/remote/ws?token=good-token&ws-target=/api/remote.mux'),
      fakeSocket(),
      Buffer.alloc(0),
    )
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(handoffs[0].target, '/api/remote.mux')
  })
})

describe('握手合法性', () => {
  it('非 upgrade 请求 → 400', async () => {
    const { deps, handoffs } = makeDeps()
    const { route } = ws.createGuardWsRoute(deps)
    const socket = fakeSocket()
    route.handler(
      { url: '/remote/ws?token=good-token', headers: {} },
      socket,
      Buffer.alloc(0),
    )
    await new Promise(resolve => setImmediate(resolve))
    assert.match(socket.written.join(''), /400/u)
    assert.equal(handoffs.length, 0)
  })

  it('缺 Sec-WebSocket-Key → 400', async () => {
    const { deps, handoffs } = makeDeps()
    const { route } = ws.createGuardWsRoute(deps)
    const socket = fakeSocket()
    route.handler(
      { url: '/remote/ws?token=good-token', headers: { upgrade: 'websocket' } },
      socket,
      Buffer.alloc(0),
    )
    await new Promise(resolve => setImmediate(resolve))
    assert.match(socket.written.join(''), /400/u)
    assert.equal(handoffs.length, 0)
  })
})

describe('移交失败处理', () => {
  it('handoff 抛错 → 500，不泄漏内部错误', async () => {
    const { deps } = makeDeps({
      handoff: () => { throw new Error('internal detail leak') },
    })
    const { route } = ws.createGuardWsRoute(deps)
    const socket = fakeSocket()
    route.handler(upgradeRequest('/remote/ws?token=good-token'), socket, Buffer.alloc(0))
    await new Promise(resolve => setImmediate(resolve))
    const written = socket.written.join('')
    assert.match(written, /500/u)
    assert.equal(written.includes('internal detail leak'), false, '不得泄漏内部错误细节')
  })
})
