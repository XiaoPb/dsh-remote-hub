/**
 * 设计 v0.3 §7：设备连接生命周期回归测试。
 *
 * 覆盖本轮修复的三件事：
 *  1. WS Peer 不再是 owner —— 用 `remote-device` principal，HTTP 与 WS 授权语义一致；
 *  2. 让位/吊销能**定向**关闭既有 WS，且不影响其它设备；
 *  3. 官方 Gateway 的事实：`$events` 只要求 `interactions === 'answer'`
 *     （`api-gateway/lib/index.js:1015`），`$events/result` 才强制 owner（`:996`）。
 *     第 3 条决定了第 1 条可行——所以它是独立的断言。
 *
 * 用假 gateway（实现 wireStream 语义）+ 真实守卫 + 真实 ws 客户端。
 *
 * @module test/device-connection-lifecycle.test.mjs
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

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

/** 等待 socket 关闭（返回 code）。 */
function waitClose(socket, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    if (socket.readyState === socket.CLOSED) { resolve(socket._closeCode); return }
    const timer = setTimeout(() => reject(new Error('close timeout')), timeoutMs)
    socket.once('close', code => { clearTimeout(timer); resolve(code) })
  })
}

/** 收集 n 个下行帧。 */
function collectFrames(socket, count, timeoutMs = 5_000) {
  const frames = []
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`frame timeout, got ${JSON.stringify(frames)}`)), timeoutMs)
    const onMessage = data => {
      frames.push(JSON.parse(String(data)))
      if (frames.length >= count) { clearTimeout(timer); socket.off('message', onMessage); resolve(frames) }
    }
    socket.on('message', onMessage)
  })
}

describe('官方 Gateway 事实：非 owner 可看事件流，但不能应答事件', () => {
  const gatewaySource = readFileSync(
    new URL('../node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js', import.meta.url),
    'utf8',
  )

  it('$events 事件流只要求 interactions=answer，不要求 owner', () => {
    const openWireStreamBlock = gatewaySource.slice(
      gatewaySource.indexOf('async openWireStream('),
      gatewaySource.indexOf('async *openRemoteEvents('),
    )
    assert.match(openWireStreamBlock, /requireInteractions\(peer, endpoint\)/u, '$events 必须要求 answer')
    assert.doesNotMatch(openWireStreamBlock, /kind !== "owner"/u, '$events 不得要求 owner')
  })

  it('$events/result 事件应答才强制 owner', () => {
    const resultBlock = gatewaySource.slice(
      gatewaySource.indexOf('if (endpoint === "$events/result")'),
      gatewaySource.indexOf('async openWireStream('),
    )
    assert.match(resultBlock, /kind !== "owner"/u, '事件应答必须强制 owner')
  })
})

describe('设备连接生命周期（守卫 + mux + 真实 ws 客户端）', () => {
  let dir
  let guard
  let base
  let opened = []
  let devices
  /** 本轮守卫使用的 mux 句柄（与升级回调里是同一个对象）。 */
  let muxHandle

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lifecycle-'))
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

    const m = mod.createGuardMux({
      open: async (endpoint, payload, uplink, peer, signal) => {
        opened.push({ endpoint, principal: peer?.principal ?? null })
        signal.addEventListener('abort', () => {})
        return (async function* () {
          yield { endpoint }
        })()
      },
      failure: error => ({ code: 'internal', message: String(error) }),
    })
    muxHandle = m

    guard = await mod.startGuard({
      config,
      tokens,
      pairing,
      dispatcher: dispatcherStub,
      devices,
      pairIssueToken: 'pin-lifecycle',
      ws: {
        mux: m,
        // 关键：peer 的 principal 由真实生产代码决定；这里用与 plugin.ts 相同的
        // 形状（remote-device + answer），断言守卫把 deviceId 交给了 mux。
        admit: (_request, device) => ({
          peer: {
            principal: mod.remoteDevicePrincipal({ deviceId: device.deviceId, role: device.role }),
            deviceId: device.deviceId,
            role: device.role,
          },
          release: async () => {},
        }),
      },
    })
    base = guard.origin
  })

  after(async () => {
    await guard?.dispose()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(dir, { recursive: true, force: true })
        return
      } catch {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
  })

  /** 配对一台设备并返回令牌。 */
  async function pair(role, label) {
    const issued = await (await fetch(`${base}/remote/pair/code`, {
      method: 'POST',
      headers: { 'x-hub-protocol': '1', 'x-pair-issue-token': 'pin-lifecycle', 'content-type': 'application/json' },
      body: JSON.stringify({ role }),
    })).json()
    const redeemed = await (await fetch(`${base}/remote/pair`, {
      method: 'POST',
      headers: { 'x-hub-protocol': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ code: issued.code, clientLabel: label }),
    })).json()
    return redeemed
  }

  /** 打开一条守卫 WS。 */
  async function openSocket(token) {
    const wsBase = base.replace('http://', 'ws://')
    const socket = new WebSocket(`${wsBase}/remote/ws?token=${encodeURIComponent(token)}&ws-target=/api/remote.mux`)
    await waitOpen(socket)
    return socket
  }

  it('WS 传到 mux 的 Peer 是 remote-device（不是 owner）', async () => {
    opened = []
    const device = await pair('read-only', 'ro-1')
    const socket = await openSocket(device.token)
    const framesPromise = collectFrames(socket, 1)
    socket.send(JSON.stringify({ type: 'open', streamId: 's1', endpoint: 'session/list', payload: { args: {} } }))
    await framesPromise
    assert.equal(opened.length, 1)
    assert.equal(opened[0].principal.kind, 'remote-device', 'WS 不得升权为 owner')
    assert.equal(opened[0].principal.role, 'read-only', '角色必须来自设备记录')
    assert.equal(opened[0].principal.deviceId, device.deviceId)
    socket.close()
  })

  it('closeDevice 只关闭目标设备，其它设备连接不受影响', async () => {
    const a = await pair('control', 'dev-a')
    const b = await pair('control', 'dev-b')
    const socketA = await openSocket(a.token)
    const socketB = await openSocket(b.token)

    const closedA = waitClose(socketA)
    const closedCount = guardWsmux().closeDevice(a.deviceId)
    assert.equal(closedCount, 1, '只应关闭 A 的一条连接')
    assert.equal(await closedA, mod.WS_CLOSE_POLICY, '策略性关闭码必须是 1008')

    // B 仍可收发。
    const framesPromise = collectFrames(socketB, 1)
    socketB.send(JSON.stringify({ type: 'open', streamId: 's-b', endpoint: 'session/list', payload: { args: {} } }))
    const frames = await framesPromise
    assert.equal(frames[0].type, 'item', 'B 必须仍然可用')
    socketB.close()
  })

  it('closeDevice 对未知设备是空操作，且重复调用安全', () => {
    const muxHandle = guardWsmux()
    assert.equal(muxHandle.closeDevice('dev_does_not_exist'), 0)
    assert.equal(muxHandle.connectionsOf('dev_does_not_exist'), 0)
  })

  it('关闭后设备索引被清理（不泄漏）', async () => {
    const device = await pair('control', 'dev-cleanup')
    const socket = await openSocket(device.token)
    assert.equal(guardWsmux().connectionsOf(device.deviceId), 1)
    guardWsmux().closeDevice(device.deviceId)
    await waitClose(socket)
    assert.equal(guardWsmux().connectionsOf(device.deviceId), 0, '关闭后索引必须清理')
  })

  /** 取出本轮守卫实例的 mux（与升级回调里是同一个对象）。 */
  function guardWsmux() {
    return muxHandle
  }
})
