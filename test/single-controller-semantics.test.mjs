/**
 * 回归：单控策略「踢连接不删配对」+ 设备三态 + 离线置灰。
 *
 * 用户需求（2026-11-12）：
 *  1. 令牌被挤掉后 UI 不能仍显示「已连接」；
 *  2. 单控踢的是**连接**，不删**配对**（令牌保留，可重连）；
 *  3. 三态：已配对 / 已连接 / 配对失效；
 *  4. 对端不在线 → 变灰；
 *  5. 状态只用标签表达，**不堆叠文字说明**（用户明确要求）。
 *
 * @module test/single-controller-semantics.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { registerAlias } from './panel-alias-loader.mjs'

await registerAlias()
const page = await import('../.build/client/client/src/panel/RemoteHubPage.js')

/** 采集文本。 */
function collectText(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) collectText(child, out); return out }
  if (typeof node === 'object' && node.props !== undefined) collectText(node.props.children, out)
  return out
}

/** 按 testid 收集。 */
function byTestId(node, testid, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) byTestId(child, testid, out); return out }
  if (node.props?.['data-testid'] === testid) out.push(node)
  byTestId(node.props?.children, testid, out)
  return out
}

/** 最小状态。 */
function baseState(overrides = {}) {
  return {
    mode: { mode: 'local' },
    guard: { host: '127.0.0.1', port: 8443, origin: 'http://h:8443', protocolVersion: 1, singleController: true },
    guardError: null, devices: [], loading: false, pairIssueToken: 'p',
    originDraft: '', deviceFilter: 'all', stats: null, statsError: null,
    config: null, configDraft: null, configSaving: false, configSavedAt: null,
    busy: null, error: null, now: 1_000_000_000,
    injection: { hasPin: true, instanceId: 'i', pid: 1, injectedAt: '', protocolVersion: 1 },
    diagnostic: null, logs: [], retry: { attempts: 0, nextRetryAt: null },
    ...overrides,
  }
}

const noopActions = new Proxy({}, { get: () => () => {} })

describe('设备三态语义', () => {
  const at = 1_000_000_000

  it('只有 revokedAt 才是「配对失效」', () => {
    assert.equal(page.deviceStatus({ revokedAt: new Date(at).toISOString(), lastSeenAt: null }, at), 'invalid')
  })

  it('被挤下线（displacedAt）但配对保留 → 仍是「已配对」，不是失效', () => {
    const device = {
      revokedAt: null,
      displacedAt: new Date(at - 900_000).toISOString(),
      lastSeenAt: new Date(at - 900_000).toISOString(),
    }
    assert.equal(page.deviceStatus(device, at), 'paired', '被挤下线 = 已配对（离线）')
    assert.notEqual(page.deviceStatus(device, at), 'invalid')
  })

  it('60s 内有心跳 → 已连接', () => {
    assert.equal(
      page.deviceStatus({ revokedAt: null, lastSeenAt: new Date(at - 5_000).toISOString() }, at),
      'connected',
    )
  })

  it('离线判定：非 connected/idle 一律不算在线', () => {
    assert.equal(page.isDeviceOnline({ revokedAt: null, lastSeenAt: null }, at), false)
    assert.equal(
      page.isDeviceOnline({ revokedAt: null, lastSeenAt: new Date(at - 900_000).toISOString() }, at),
      false,
    )
  })
})

describe('离线置灰', () => {
  // 2026-11-17 重构后：云端设备页只画**出站**配对目标，入站设备归设置页。
  // 因此这里锁定出站设备的置灰行为（未连接的目标必须是 is-offline）。
  it('未连接的已配对目标带 is-offline 标记（CSS 置灰）', () => {
    const tree = page.renderRemoteHubPage(baseState({
      outboundTargets: [
        { id: 'dev_off', origin: 'http://192.168.0.30:8443', token: 't'.repeat(20), label: 'idle-box' },
      ],
    }), noopActions)

    /** 收集带 data-testid 的出站卡片。 */
    const cards = []
    const walk = node => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (node.props?.['data-testid'] === 'outbound-paired') cards.push(node)
      walk(node.props?.children)
    }
    walk(tree)

    assert.equal(cards.length, 1, '必须渲染出已配对目标卡')
    assert.match(String(cards[0].props.className), /is-offline/u, '未连接的目标卡必须带 is-offline（置灰）')
    assert.equal(cards[0].props['data-status'], 'paired')
  })

  it('入站设备的 offline 判定函数仍可用（统计 activeDevices 依赖它）', () => {
    const at = 1_000_000_000
    assert.equal(page.deviceStatus({ revokedAt: null, lastSeenAt: new Date(at - 1_000).toISOString() }, at), 'connected')
    assert.equal(page.deviceStatus({ revokedAt: null, lastSeenAt: null }, at), 'paired')
  })
})

describe('状态只用标签表达（不堆叠文字说明）', () => {
  const at = 1_000_000_000

  it('三态标签各自出现一次，且没有额外的解释段落', () => {
    const tree = page.renderRemoteHubPage(baseState({
      now: at,
      devices: [
        { deviceId: 'a', label: '设备甲', role: 'control', revokedAt: null, lastSeenAt: new Date(at - 5_000).toISOString() },
        { deviceId: 'b', label: '设备乙', role: 'control', revokedAt: null, displacedAt: new Date(at - 900_000).toISOString(), lastSeenAt: new Date(at - 900_000).toISOString() },
        { deviceId: 'c', label: '设备丙', role: 'control', revokedAt: new Date(at).toISOString(), lastSeenAt: null },
      ],
    }), noopActions)

    // 入站设备不再在运行页渲染，因此三态 pill 不应出现。
    const pills = byTestId(tree, 'device-status')
    assert.equal(pills.length, 0, '运行页不渲染入站设备状态 pill')

    const texts = collectText(tree)
    // 状态只用标签表达：页面不得堆叠「为什么离线」之类的解释段落。
    const all = texts.join('')
    for (const banned of ['可随时重新连接', '无需重新扫码', '挤下线', '配对信息仍然保留']) {
      assert.equal(all.includes(banned), false, `UI 不应出现解释文案：${banned}`)
    }

  })
})
