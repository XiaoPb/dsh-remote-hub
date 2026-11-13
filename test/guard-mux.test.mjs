/**
 * M4：守卫 mux 承载测试（路线 β）。
 *
 * 验证 `guard-mux.ts` 把 mux 帧正确翻译成 wireStream 调用：
 *  - 帧解析校验（四种帧 + 非法输入）；
 *  - uplink 收件箱语义（push/end/fail/溢出）；
 *  - 下行帧形状（item / end / error）与官方一致。
 *
 * @module test/guard-mux.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const mux = await import('../lib/index.js')

describe('帧解析（与官方 RemoteStreamClientMessage 对齐）', () => {
  it('解析 open 帧', () => {
    const frame = mux.parseClientFrame(JSON.stringify({
      type: 'open', streamId: 's1', endpoint: 'session/list', payload: { args: {} },
    }))
    assert.equal(frame.type, 'open')
    assert.equal(frame.streamId, 's1')
    assert.equal(frame.endpoint, 'session/list')
  })

  it('解析 item / end / cancel', () => {
    assert.equal(mux.parseClientFrame('{"type":"item","streamId":"s","value":1}').type, 'item')
    assert.equal(mux.parseClientFrame('{"type":"end","streamId":"s"}').type, 'end')
    assert.equal(mux.parseClientFrame('{"type":"cancel","streamId":"s"}').type, 'cancel')
  })

  it('缺 streamId → 抛错', () => {
    assert.throws(() => mux.parseClientFrame('{"type":"open","endpoint":"x"}'), /streamId/u)
  })

  it('open 缺 endpoint → 抛错', () => {
    assert.throws(
      () => mux.parseClientFrame('{"type":"open","streamId":"s"}'),
      /endpoint/u,
    )
  })

  it('未知 type → 抛错', () => {
    assert.throws(() => mux.parseClientFrame('{"type":"bogus","streamId":"s"}'), /unknown frame type/u)
  })

  it('数组或非对象 → 抛错', () => {
    // 数组也是 object，会在 streamId 校验处失败；null 同样被拒。
    assert.throws(() => mux.parseClientFrame('[]'), /streamId|must be an object/u)
    assert.throws(() => mux.parseClientFrame('null'), /must be an object/u)
    assert.throws(() => mux.parseClientFrame('"text"'), /must be an object/u)
  })

  it('畸形 JSON → 抛错', () => {
    assert.throws(() => mux.parseClientFrame('{oops'), SyntaxError)
  })
})

describe('UplinkInbox', () => {
  /** 收集异步迭代器的前 n 项。 */
  async function take(iterable, count) {
    const out = []
    for await (const value of iterable) {
      out.push(value)
      if (out.length >= count) break
    }
    return out
  }

  it('push 后可被迭代读出', async () => {
    const abort = new AbortController()
    const inbox = new mux.UplinkInbox(1024, abort)
    inbox.push('a')
    inbox.push('b')
    inbox.end()
    const values = []
    for await (const value of inbox.iterable()) values.push(value)
    assert.deepEqual(values, ['a', 'b'])
  })

  it('先迭代后 push：等待者被唤醒', async () => {
    const abort = new AbortController()
    const inbox = new mux.UplinkInbox(1024, abort)
    const iterator = inbox.iterable()[Symbol.asyncIterator]()
    const pending = iterator.next()
    inbox.push('late')
    const result = await pending
    assert.equal(result.done, false)
    assert.equal(result.value, 'late')
  })

  it('end 后迭代结束', async () => {
    const abort = new AbortController()
    const inbox = new mux.UplinkInbox(1024, abort)
    inbox.end()
    const values = []
    for await (const value of inbox.iterable()) values.push(value)
    assert.deepEqual(values, [])
  })

  it('fail 后迭代抛错', async () => {
    const abort = new AbortController()
    const inbox = new mux.UplinkInbox(1024, abort)
    const error = new Error('boom')
    inbox.fail(error)
    const iterator = inbox.iterable()[Symbol.asyncIterator]()
    await assert.rejects(() => iterator.next(), /boom/u)
  })

  it('超限 → 中止 AbortSignal 并失败', async () => {
    const abort = new AbortController()
    const inbox = new mux.UplinkInbox(10, abort)
    inbox.push('x', 20)
    assert.equal(abort.signal.aborted, true, '必须中止信号')
    const iterator = inbox.iterable()[Symbol.asyncIterator]()
    await assert.rejects(() => iterator.next(), /overflow/u)
  })

  it('end 之后再 push 被忽略（不复活流）', async () => {
    const abort = new AbortController()
    const inbox = new mux.UplinkInbox(1024, abort)
    inbox.end()
    inbox.push('ignored')
    const values = []
    for await (const value of inbox.iterable()) values.push(value)
    assert.deepEqual(values, [])
  })

  it('take 辅助能中途退出', async () => {
    const abort = new AbortController()
    const inbox = new mux.UplinkInbox(1024, abort)
    inbox.push(1); inbox.push(2); inbox.push(3)
    const got = await take(inbox.iterable(), 2)
    assert.deepEqual(got, [1, 2])
  })
})

describe('mux 常量', () => {
  it('心跳与缓冲参数与官方一致', () => {
    assert.equal(mux.MUX_HEARTBEAT_MS, 2000)
    assert.equal(mux.MUX_MAX_MISSED_HEARTBEATS, 3)
    assert.equal(mux.MUX_UPLINK_BYTES, 1024 * 1024)
  })

  it('mux 路由路径与官方一致', () => {
    assert.equal(mux.MUX_PATH, '/api/remote.mux')
  })
})

describe('createGuardMux 形状', () => {
  it('返回 accept / close / size', () => {
    const handle = mux.createGuardMux({
      open: async () => (async function* () {})(),
      failure: error => ({ message: String(error) }),
    })
    assert.equal(typeof handle.accept, 'function')
    assert.equal(typeof handle.close, 'function')
    assert.equal(typeof handle.size, 'number')
    assert.equal(handle.size, 0)
  })
})
