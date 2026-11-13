/**
 * 运行指标收集器测试：计数、环形桶滚动、快照不可变性。
 *
 * @module test/metrics.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createMetricsCollector } from '../.build/host/host/src/metrics.js'

const HOUR = 3_600_000
const DAY = 86_400_000

describe('metrics 计数', () => {
  it('各计数器自增并出现在快照', () => {
    const at = new Date('2026-01-10T12:00:00Z').getTime()
    let t = at
    const m = createMetricsCollector(() => t)
    m.countPairIssued()
    m.countPairIssued()
    m.countPairRedeemed()
    m.countPairRejected()
    m.countAuthAccepted()
    m.countAuthAccepted()
    m.countAuthAccepted()
    m.countAuthDenied()
    m.countStreamOpened()
    m.countStreamOpened()
    m.countStreamClosed()
    const s = m.snapshot()
    assert.equal(s.pairIssued, 2)
    assert.equal(s.pairRedeemed, 1)
    assert.equal(s.pairRejected, 1)
    assert.equal(s.authAccepted, 3)
    assert.equal(s.authDenied, 1)
    assert.equal(s.activeStreams, 1)
    assert.equal(s.streamsOpened, 2)
    assert.equal(s.startedAt, new Date(at).toISOString())
  })

  it('snapshot 返回副本（外部修改不影响内部状态）', () => {
    const m = createMetricsCollector(() => 1_000)
    m.countAuthAccepted()
    m.countPairRedeemed()
    const s = m.snapshot()
    s.hourly[23] = 999
    s.daily[6] = 999
    assert.equal(m.snapshot().hourly[23], 1)
    assert.equal(m.snapshot().daily[6], 1)
  })
})

describe('metrics 环形桶', () => {
  it('同一小时内多次计数落同一桶', () => {
    let t = 10 * HOUR
    const m = createMetricsCollector(() => t)
    m.countAuthAccepted()
    t += 60_000
    m.countAuthAccepted()
    const s = m.snapshot()
    assert.equal(s.hourly.filter(v => v > 0).length, 1)
    assert.equal(s.hourly.reduce((a, b) => a + b, 0), 2)
  })

  it('跨小时滚动：旧桶左移，新桶在末尾', () => {
    let t = 10 * HOUR
    const m = createMetricsCollector(() => t)
    m.countAuthAccepted() // 桶 23（10:00 那小时）
    t += HOUR
    m.countAuthAccepted() // 滚动一格
    const s = m.snapshot()
    assert.equal(s.hourly[22], 1, '旧桶左移一格')
    assert.equal(s.hourly[23], 1, '新桶在末尾')
  })

  it('跨天滚动：daily 桶同理', () => {
    let t = 3 * DAY
    const m = createMetricsCollector(() => t)
    m.countPairRedeemed()
    t += DAY
    m.countPairRedeemed()
    const s = m.snapshot()
    assert.equal(s.daily[5], 1)
    assert.equal(s.daily[6], 1)
  })

  it('整窗过期：清零后只记最新桶', () => {
    let t = 0
    const m = createMetricsCollector(() => t)
    m.countAuthAccepted()
    t += 30 * HOUR // 超过 24 桶窗口
    m.countAuthAccepted()
    const s = m.snapshot()
    assert.equal(s.hourly.reduce((a, b) => a + b, 0), 1)
    assert.equal(s.hourly[23], 1)
  })
})
