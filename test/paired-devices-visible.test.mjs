/**
 * 回归：已配对设备必须出现在「云端设备」区域。
 *
 * 2026-11-12 实机疑问：「配对之后云端设备区看不到已配对设备」。
 * 根因不是持久化位置（两端都是 `~/.dsh/remote-hub/`），而是三个概念被混为一谈：
 * - 「本机 · 被控端」= 本机 `devices.json`（谁连过**我**）——主动连出去时理应为空；
 * - 「连接其他设备 · 主控端」= localStorage `remote-hub.mode`（我连了**谁**）；
 * - 出站配对结果不在 `devices.json` 里。
 *
 * 本测试锁定：
 * 1. 有入站设备时，设备卡栅格必须渲染出这些设备；
 * 2. 空表时显示空态而不是崩溃；
 * 3. cloud 模式时主控端卡片显示 origin 与设备名。
 *
 * @module test/paired-devices-visible.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { registerAlias } from './panel-alias-loader.mjs'

await registerAlias()
const { renderRemoteHubPage } = await import('../.build/client/client/src/panel/RemoteHubPage.js')

/**
 * 采集节点树里的文本。
 *
 * ⚠️ 必须跳过样式表：`ThemeStyle(RH_CSS)` 注入的是一整份 CSS 字符串，
 * 里面含有「平台」「后台」等字样，会让 `includes('台')` 之类的断言假命中。
 */
function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    const text = String(node)
    if (!text.includes('--rh-') && text.length < 400) out.push(text)
    return out
  }
  if (Array.isArray(node)) { for (const child of node) collectText(child, out); return out }
  if (typeof node === 'object' && node.props) {
    collectText(node.props.children, out)
    // 组件常把可见文案放在 props 里：
    //  - `Section` 的 title 可能是 React 元素（内嵌 Pill / 计数），需要递归；
    //  - `EmptyState` 的 title / desc、`Button` 的 title 等是字符串。
    for (const key of ['title', 'desc', 'label', 'ariaLabel', 'placeholder', 'summary']) {
      const value = node.props[key]
      if (typeof value === 'string' && !value.includes('--rh-') && value.length < 400) out.push(value)
      else if (typeof value === 'object' && value !== null) collectText(value, out)
    }
  }
  return out
}

/** 按 data-testid 收集。 */
function byTestId(node, testid, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) byTestId(child, testid, out); return out }
  if (node.props?.['data-testid'] === testid) out.push(node)
  byTestId(node.props?.children, testid, out)
  return out
}

/** 最小可渲染状态。 */
function baseState(overrides = {}) {
  return {
    mode: { mode: 'local' },
    role: 'control',
    guard: {
      host: '127.0.0.1', port: 8443, origin: 'http://192.168.0.106:8443',
      protocolVersion: 1, singleController: true,
    },
    guardError: null,
    devices: [],
    stats: null,
    config: null,
    configDraft: null,
    configSaving: false,
    configSavedAt: null,
    busy: null,
    error: null,
    now: 1_000_000,
    loading: false,
    pairIssueToken: 'issue-token',
    originDraft: 'http://127.0.0.1:8443',
    deviceFilter: 'all',
    statsError: null,
    injection: { hasPin: true, instanceId: 'hub_x', pid: 1, injectedAt: '', protocolVersion: 1 },
    diagnostic: null,
    logs: [],
    retry: { attempts: 0, nextRetryAt: null },
    // 2026-11-17：云端设备页的设备来源是**出站配对目标**。
    outboundTargets: [],
    ...overrides,
  }
}

const noopActions = new Proxy({}, { get: () => () => {} })

describe('已配对设备可见性', () => {
  // 2026-11-17 重构后语义：
  //   云端设备页 = **本机主动连出去**的设备（state.outboundTargets）；
  //   入站设备（谁连进了本机，state.devices）归设置页「登录与账号」。
  it('入站设备不再出现在云端设备页（归设置页）', () => {
    const tree = renderRemoteHubPage(baseState({
      devices: [
        {
          deviceId: 'dev_aaa', label: 'win-lead-client', role: 'control',
          createdAt: '2026-11-11T16:55:26.624Z', lastSeenAt: '2026-11-11T16:55:33.344Z', revokedAt: null,
        },
      ],
    }), noopActions)
    const texts = collectText(tree)
    assert.ok(!texts.some(text => text.includes('win-lead-client')), '入站设备名不应出现在运行页')
    // 主卡描述里明确告知：已信任的接入设备在设置页管理。
    assert.ok(texts.some(text => text.includes('已信任的接入设备在「设置 → 登录与账号」里管理')), '应引导到设置页管理')
  })

  it('已配对（出站）目标出现在设备卡栅格', () => {
    const target = {
      id: 'dev_out_1', origin: 'http://192.168.0.20:8443', token: 't'.repeat(20),
      label: 'living-room-pc', role: 'control', pairedAt: 1_700_000_000_000, lastConnectedAt: 1_700_000_100_000,
    }
    const tree = renderRemoteHubPage(baseState({ outboundTargets: [target] }), noopActions)
    const texts = collectText(tree)
    // outboundTargetTitle 会优先用 origin 作为标题，label 只在存在时作为副标题。
    assert.ok(texts.some(text => text.includes('192.168.0.20:8443')), '目标地址必须渲染出来')
    assert.ok(texts.some(text => text.includes('1 台')), '已配对数必须为 1')
  })

  it('空出站目标显示「去连接新设备」引导', () => {
    const tree = renderRemoteHubPage(baseState({ outboundTargets: [] }), noopActions)
    const texts = collectText(tree)
    assert.ok(texts.some(text => text.includes('0 台')))
    assert.ok(texts.some(text => text.includes('连接新设备') || text.includes('在上方')))
  })

  it('cloud 模式：主控端卡片显示目标 origin 与设备名', () => {
    const tree = renderRemoteHubPage(baseState({
      mode: {
        mode: 'cloud',
        origin: 'http://192.168.0.17:8443',
        token: 'x'.repeat(43),
        deviceLabel: 'v4debian',
      },
    }), noopActions)
    const texts = collectText(tree)
    assert.ok(texts.some(text => text.includes('192.168.0.17:8443')), '必须显示目标地址')
    assert.ok(texts.some(text => text.includes('v4debian')), '必须显示目标设备名')
  })
})
