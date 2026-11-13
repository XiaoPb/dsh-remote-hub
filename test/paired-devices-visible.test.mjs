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

/** 采集节点树里的文本。 */
function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) collectText(child, out); return out }
  if (typeof node === 'object' && node.props) collectText(node.props.children, out)
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
    issued: null,
    issuedCode: null,
    now: 1_000_000,
    loading: false,
    autoReissue: true,
    pairIssueToken: 'issue-token',
    originDraft: 'http://127.0.0.1:8443',
    secretDraft: '',
    deviceFilter: 'all',
    statsError: null,
    injection: { hasPin: true, instanceId: 'hub_x', pid: 1, injectedAt: '', protocolVersion: 1 },
    diagnostic: null,
    logs: [],
    retry: { attempts: 0, nextRetryAt: null },
    ...overrides,
  }
}

const noopActions = new Proxy({}, { get: () => () => {} })

describe('已配对设备可见性', () => {
  it('入站设备出现在设备卡栅格（不是空态）', () => {
    const tree = renderRemoteHubPage(baseState({
      devices: [
        {
          deviceId: 'dev_aaa', label: 'win-lead-client', role: 'control',
          createdAt: '2026-11-11T16:55:26.624Z', lastSeenAt: '2026-11-11T16:55:33.344Z', revokedAt: null,
        },
      ],
    }), noopActions)
    const texts = collectText(tree)
    assert.ok(texts.some(text => text.includes('win-lead-client')), '设备名必须渲染出来')
    assert.ok(texts.some(text => text.includes('1 台')), '已配对数必须为 1')
  })

  it('已吊销设备不计入「已配对」计数', () => {
    const tree = renderRemoteHubPage(baseState({
      devices: [
        {
          deviceId: 'dev_old', label: 'old', role: 'control',
          createdAt: '2026-11-01T00:00:00.000Z', lastSeenAt: null,
          revokedAt: '2026-11-11T16:55:26.629Z',
        },
      ],
    }), noopActions)
    const texts = collectText(tree)
    assert.ok(texts.some(text => text.includes('0 台')), '吊销的设备不算已配对')
  })

  it('空设备表显示空态且不崩溃', () => {
    const tree = renderRemoteHubPage(baseState({ devices: [] }), noopActions)
    const texts = collectText(tree)
    assert.ok(texts.some(text => text.includes('0 台')))
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
