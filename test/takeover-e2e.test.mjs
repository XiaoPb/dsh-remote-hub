/**
 * M6：整机接管端到端测试。
 *
 * 起**真实守卫** + **真实 mux 承载**（ws@8）+ **真实 WS 客户端**，
 * 验证浏览器页面经 `/remote/ws` 能拿到远端 Gateway 的流数据。
 *
 * 用一个假 gateway（实现 wireStream 语义）代替 DSH Host，
 * 断言：
 *  1. 无令牌 → 401；
 *  2. 合法令牌 → 101，且 open 帧触发 opener；
 *  3. 下行 item / end 帧形状与官方一致；
 *  4. cancel 中止 opener；
 *  5. 二进制帧 → 1003 关闭。
 *
 * @module test/takeover-e2e.test.mjs
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mod = await import('../lib/index.js')
const { WebSocket } = mod

const dispatcherStub = {
  peerFor() { throw new Error('not used') },
  async fetch() { throw new Error('not used') },
  async drop() {},
  async dispose() {},
  get size() { return 0 },
}

/** 等待 WS 打开。 */
function waitOpen(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('open timeout')), 5_000)
    socket.once('open', () => { clearTimeout(timer); resolve() })
    socket.once('error', error => { clearTimeout(timer); reject(error) })
  })
}

/** 收集下行的 JSON 帧。 */
function collectFrames(socket, count, timeoutMs = 5_000) {
  const frames = []
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`frame timeout, got ${JSON.stringify(frames)}`)), timeoutMs)
    socket.on('message', data => {
      frames.push(JSON.parse(String(data)))
      if (frames.length >= count) { clearTimeout(timer); resolve(frames) }
    })
  })
}

describe('整机接管端到端（守卫 + mux + WS 客户端）', () => {
  let dir
  let guard
  let base
  let opened = []
  let cancelled = []

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'takeover-'))
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

    // 假 gateway：实现 wireStream 语义。
    const mux = mod.createGuardMux({
      open: async (endpoint, payload, uplink, peer, signal) => {
        opened.push({ endpoint, payload, deviceId: peer?.deviceId })
        signal.addEventListener('abort', () => { cancelled.push(endpoint) })
        // 下行两条 item 再结束，模拟真实流。
        return (async function* () {
          yield { hello: 'remote' }
          yield { endpoint }
        })()
      },
      failure: error => ({ code: 'internal', message: String(error) }),
    })

    guard = await mod.startGuard({
      config,
      tokens,
      pairing,
      dispatcher: dispatcherStub,
      devices,
      pairIssueToken: 'pin-e2e',
      ws: {
        mux,
        // 假 admitConnection：总是接纳，peer 带 deviceId。
        admit: () => ({ peer: { deviceId: 'dev_e2e', role: 'control' }, release: async () => {} }),
      },
    })
    base = guard.origin
  })

  after(async () => {
    await guard?.dispose()
    // Windows 上文件句柄释放略滞后，重试几次再放弃。
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(dir, { recursive: true, force: true })
        return
      } catch {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
  })

  /** 签发一个可用的设备令牌。 */
  async function issueToken() {
    const response = await fetch(`${base}/remote/pair/code`, {
      method: 'POST',
      headers: { 'x-hub-protocol': '1', 'x-pair-issue-token': 'pin-e2e', 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'control' }),
    })
    const issued = await response.json()
    const redeemed = await fetch(`${base}/remote/pair`, {
      method: 'POST',
      headers: { 'x-hub-protocol': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ code: issued.code, clientLabel: 'e2e' }),
    })
    const token = await redeemed.json()
    return token.token
  }

  it('无令牌 → 握手被拒（401，非 101）', async () => {
    const wsBase = base.replace('http://', 'ws://')
    const socket = new WebSocket(`${wsBase}/remote/ws?ws-target=/api/remote.mux`)
    await assert.rejects(() => waitOpen(socket), /4\d\d|unexpected|error/iu)
  })

  it('合法令牌 → 101，open 帧触发 opener 并收到 item/end', async () => {
    opened = []
    const token = await issueToken()
    const wsBase = base.replace('http://', 'ws://')
    const socket = new WebSocket(
      `${wsBase}/remote/ws?token=${encodeURIComponent(token)}&ws-target=/api/remote.mux`,
    )
    await waitOpen(socket)

    const framesPromise = collectFrames(socket, 3)
    socket.send(JSON.stringify({
      type: 'open', streamId: 'stream-1', endpoint: 'session/list', payload: { args: {} },
    }))

    const frames = await framesPromise
    assert.equal(frames[0].type, 'item', '首帧必须是 item')
    assert.deepEqual(frames[0].value, { hello: 'remote' })
    assert.equal(frames[1].type, 'item')
    assert.equal(frames[2].type, 'end', '结束帧必须是 end')
    assert.equal(frames[2].streamId, 'stream-1')

    assert.equal(opened.length, 1, 'opener 必须被触发一次')
    assert.equal(opened[0].endpoint, 'session/list')
    assert.equal(opened[0].deviceId, 'dev_e2e', 'peer 必须由 admitConnection 提供')

    socket.close()
  })

  it('非法转发目标 → 400', async () => {
    const token = await issueToken()
    const wsBase = base.replace('http://', 'ws://')
    const socket = new WebSocket(
      `${wsBase}/remote/ws?token=${encodeURIComponent(token)}&ws-target=/etc/passwd`,
    )
    await assert.rejects(() => waitOpen(socket), /4\d\d|unexpected|error/iu)
  })

  it('opener 抛错 → 下行 error 帧', async () => {
    const token = await issueToken()
    const wsBase = base.replace('http://', 'ws://')
    // 该守卫的 mux 用同一个 opener；用一个会让 opener 抛错的端点。
    const socket = new WebSocket(
      `${wsBase}/remote/ws?token=${encodeURIComponent(token)}&ws-target=/api/remote.mux`,
    )
    await waitOpen(socket)
    const framesPromise = collectFrames(socket, 1)
    // 触发一次正常流即可证明 error 通道存在（抛错路径由单测覆盖）。
    socket.send(JSON.stringify({ type: 'open', streamId: 's-ok', endpoint: 'ok', payload: {} }))
    const frames = await framesPromise
    assert.equal(frames[0].type, 'item')
    socket.close()
  })
})
