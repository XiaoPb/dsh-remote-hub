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
    guardError: null, devices: [], loading: false, autoReissue: true, pairIssueToken: 'p',
    originDraft: '', secretDraft: '', deviceFilter: 'all', stats: null, statsError: null,
    config: null, configDraft: null, configSaving: false, configSavedAt: null,
    busy: null, error: null, issued: null, issuedCode: null, now: 1_000_000_000,
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
  it('未在线设备带 offline 标记（CSS 置灰）', () => {
    const at = 1_000_000_000
    const tree = page.renderRemoteHubPage(baseState({
      now: at,
      devices: [
        { deviceId: 'on', label: '在线', role: 'control', revokedAt: null, lastSeenAt: new Date(at - 1_000).toISOString() },
        { deviceId: 'off', label: '离线', role: 'control', revokedAt: null, lastSeenAt: null },
      ],
    }), noopActions)

    /** 收集带 data-device-id 的卡片。 */
    const cards = []
    const walk = node => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (node.props?.['data-device-id'] !== undefined) cards.push(node)
      walk(node.props?.children)
    }
    walk(tree)

    const online = cards.find(card => card.props['data-device-id'] === 'on')
    const offline = cards.find(card => card.props['data-device-id'] === 'off')
    assert.equal(online.props['data-online'], 'true')
    assert.equal(offline.props['data-online'], 'false')
    assert.match(String(offline.props.className), /offline/u, '离线卡片必须带 offline 类（置灰）')
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

    const pills = byTestId(tree, 'device-status')
    const statuses = pills.map(pill => pill.props['data-status']).sort()
    assert.deepEqual(statuses, ['connected', 'invalid', 'paired'], '三态各渲染一次')

    const texts = collectText(tree)
    assert.ok(texts.includes('已连接'))
    assert.ok(texts.includes('已配对'))
    assert.ok(texts.includes('配对失效'))

    // 不应出现任何解释性长文案
    const all = texts.join('')
    for (const banned of ['可随时重新连接', '无需重新扫码', '挤下线', '配对信息仍然保留']) {
      assert.equal(all.includes(banned), false, `UI 不应出现解释文案：${banned}`)
    }
  })
})
