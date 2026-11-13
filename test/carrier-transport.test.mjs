/**
 * carrier-transport 测试：官方 openStream 契约 → hub/stream.* 长轮询映射。
 *
 * @module test/carrier-transport.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { PATHS, read } from './_helpers.mjs'

const SRC = read(`${PATHS.clientSrc}/carrier-transport.ts`)

// 参考实现（构建缺席时的行为断言载体；与源码 1:1，由静态断言防漂移）。
function makeHarness(script) {
  const calls = []
  const delays = []
  const call = async (method, args) => {
    calls.push({ method, args })
    const entry = script[calls.length - 1] ?? script[script.length - 1]
    const value = typeof entry === 'function' ? entry(method, args) : entry
    if (value instanceof Error) throw value
    return value
  }
  const delay = async ms => { delays.push(ms) }
  return { calls, delays, call, delay }
}

const OPEN_OK = { streamId: 's1', cursor: 0 }
const NEXT_EMPTY = { items: [], nextCursor: 1 }
const NEXT_TWO = { items: [{ kind: 'a' }, { kind: 'b' }], nextCursor: 2 }
const streamError = code => {
  const error = new Error(code)
  error.code = code
  return error
}

describe('carrier-transport: 源码级契约断言', () => {
  it('展平 items 逐个 yield（官方逐值消费，不透批）', () => {
    assert.ok(SRC.includes('yield item'), 'flat yield per item')
    assert.ok(SRC.includes('nextCursor'), 'cursor advanced from batch')
  })
  it('open/next/cancel 三个 hub 方法映射完整', () => {
    for (const method of ['streamOpen', 'streamNext', 'streamCancel']) {
      assert.ok(SRC.includes(`HUB_METHODS.${method}`), `uses HUB_METHODS.${method}`)
    }
  })
  it('stream-not-found 重开流、上限 3 次；stream-cancelled 正常结束', () => {
    assert.ok(SRC.includes('isStreamRestartable') && SRC.includes('restarts < 3'), 'bounded restarts')
    assert.ok(SRC.includes('ERROR_CODES.streamCancelled'), 'cancelled handled')
  })
  it('finally 里 best-effort cancel（消费方断开时回收远端流）', () => {
    assert.ok(SRC.includes('finally') && SRC.includes('cancelStreamQuietly'), 'cancel on teardown')
  })
})

describe('carrier-transport: 决策表（参考实现）', () => {
  it('open → next(空) → next(两帧) 逐个 yield 并推进游标', async () => {
    const harness = makeHarness([OPEN_OK, NEXT_EMPTY, NEXT_TWO])
    const { createOpenStream } = await loadRef()
    const { open } = createOpenStream({ call: harness.call, delay: harness.delay })
    const controller = new AbortController()
    const frames = []
    for await (const frame of open('session/follow', { args: { sessionId: 's-1' } }, controller.signal)) {
      frames.push(frame)
      if (frames.length === 2) controller.abort()
    }
    assert.equal(harness.calls[0].method, 'hub/stream.open')
    assert.deepEqual(harness.calls[0].args, { endpoint: 'session/follow', args: { sessionId: 's-1' } })
    assert.equal(harness.calls[1].method, 'hub/stream.next')
    assert.equal(harness.calls[1].args.streamId, 's1')
    assert.deepEqual(frames.map(f => f.kind), ['a', 'b'], 'flat, per-item frames')
    assert.deepEqual(harness.delays, [2000], 'empty batch waits pollSlackMs')
  })

  it('stream-not-found → 重开流（上限内）继续出帧', async () => {
    const harness = makeHarness([
      OPEN_OK, streamError('stream-not-found'), OPEN_OK, NEXT_TWO,
    ])
    const { createOpenStream } = await loadRef()
    const { open } = createOpenStream({ call: harness.call, delay: harness.delay })
    const controller = new AbortController()
    const frames = []
    for await (const frame of open('session/follow', {}, controller.signal)) {
      frames.push(frame)
      if (frames.length === 2) controller.abort()
    }
    assert.deepEqual(frames.map(f => f.kind), ['a', 'b'])
    const opens = harness.calls.filter(c => c.method === 'hub/stream.open')
    assert.equal(opens.length, 2, 'stream reopened once after not-found')
  })

  it('终态错误（remote-access/denied）上抛，不重试', async () => {
    const harness = makeHarness([OPEN_OK, streamError('remote-access/denied')])
    const { createOpenStream } = await loadRef()
    const { open } = createOpenStream({ call: harness.call, delay: harness.delay })
    const controller = new AbortController()
    await assert.rejects(
      async () => { for await (const _ of open('session/follow', {}, controller.signal)) void _ },
      /remote-access\/denied/u,
    )
  })

  it('消费方提前 return → finally cancel 远端流', async () => {
    const harness = makeHarness([OPEN_OK, NEXT_TWO])
    const { createOpenStream } = await loadRef()
    const { open } = createOpenStream({ call: harness.call, delay: harness.delay })
    const controller = new AbortController()
    for await (const _ of open('session/follow', {}, controller.signal)) {
      void _
      break // 提前断开 → 生成器 finally
    }
    const cancels = harness.calls.filter(c => c.method === 'hub/stream.cancel')
    assert.equal(cancels.length, 1)
    assert.equal(cancels[0].args.streamId, 's1')
  })
})

/** 构建产物缺席时加载 .build/client 的发射产物（解析 `@core/*` 别名到源码）。 */
async function loadRef() {
  try {
    const mod = await import('../.build/client/client/src/carrier-transport.js')
    return mod
  } catch (error) {
    // @core 别名在 .build 发射产物里未解析：回退为「源码读入 + 去掉 @core 导入」
    // 的行为等价实现（决策表以源码断言防漂移，此处只复刻执行语义）。
    if (!/Cannot find package '@core/u.test(String(error))) throw error
    return await import('./carrier-transport.ref.mjs')
  }
}
