/**
 * 页面侧接管自检：诊断卡必须能直接回答「carrier 生效了吗」。
 *
 * 这是整机接管排障的关键可见性——重启 DSH 后若侧栏仍是本机数据，
 * 用户需要一眼看出 transport 是否被注入、WS 指向哪里。
 *
 * @module test/takeover-diagnostic.test.mjs
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

/** 按 data-testid 收集节点。 */
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
    guard: {
      host: '127.0.0.1', port: 8443, origin: 'http://192.168.0.106:8443',
      protocolVersion: 1, singleController: true,
    },
    guardError: null,
    devices: [],
    loading: false,
    autoReissue: true,
    pairIssueToken: 'pin',
    originDraft: '',
    secretDraft: '',
    deviceFilter: 'all',
    stats: null,
    statsError: null,
    config: null,
    configDraft: null,
    configSaving: false,
    configSavedAt: null,
    busy: null,
    error: null,
    issued: null,
    issuedCode: null,
    now: 1_000_000,
    injection: { hasPin: true, instanceId: 'hub_x', pid: 1, injectedAt: '', protocolVersion: 1 },
    diagnostic: null,
    logs: [],
    retry: { attempts: 0, nextRetryAt: null },
    ...overrides,
  }
}

const noopActions = new Proxy({}, { get: () => () => {} })

describe('整机接管诊断可见性', () => {
  it('cloud 模式 + transport 已注入 → 显示「已生效」与 WS 目标', () => {
    globalThis.__DSH_TRANSPORT__ = {
      fetch: () => {},
      createWebSocket: () => {},
      streamBaseUrl: 'http://192.168.0.17:8443',
      ownsHost: true,
    }
    const tree = renderRemoteHubPage(baseState({
      mode: { mode: 'cloud', origin: 'http://192.168.0.17:8443', token: 't', deviceLabel: 'v4debian' },
    }), noopActions)

    const takeover = byTestId(tree, 'diag-takeover')
    assert.equal(takeover.length, 1, '必须有接管状态行')
    const text = collectText(takeover[0]).join('')
    assert.match(text, /已生效/u)

    const base = byTestId(tree, 'diag-stream-base')
    assert.equal(collectText(base[0]).join(''), 'http://192.168.0.17:8443')
    delete globalThis.__DSH_TRANSPORT__
  })

  it('cloud 模式但 transport 未注入 → 明确显示「未生效」', () => {
    delete globalThis.__DSH_TRANSPORT__
    const tree = renderRemoteHubPage(baseState({
      mode: { mode: 'cloud', origin: 'http://192.168.0.17:8443', token: 't' },
    }), noopActions)
    const text = collectText(byTestId(tree, 'diag-takeover')[0]).join('')
    assert.match(text, /未生效/u, '必须能看出 transport 没被注入')
  })

  it('local 模式 → 显示「本机模式」', () => {
    delete globalThis.__DSH_TRANSPORT__
    const tree = renderRemoteHubPage(baseState(), noopActions)
    const text = collectText(byTestId(tree, 'diag-takeover')[0]).join('')
    assert.match(text, /本机模式/u)
  })
})
