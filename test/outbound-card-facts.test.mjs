import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerAlias } from './panel-alias-loader.mjs'
await registerAlias()
const { renderRemoteHubPage } = await import('../.build/client/client/src/panel/RemoteHubPage.js')
function text(node) {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join(' ')
  return text(node.props?.children)
}
const state = {
  mode: { mode: 'local' }, outboundTargets: [{ id: 'a'.repeat(64), origin: 'http://example.test', role: 'full', pairedAt: 1700000000000, lastConnectedAt: 1700000001000 }],
  guard: null, guardError: null, devices: [], loading: false, role: 'control', issued: null, issuedCode: null, autoReissue: false,
  originDraft: '', secretDraft: '', deviceFilter: 'all', stats: null, statsError: null, config: null, configDraft: null, configSaving: false,
  configSavedAt: null, busy: null, error: '连接失败：配对凭据已过期', now: Date.now(),
}
test('outbound card exposes recorded role and pairing time, and failures have readable text', () => {
  const result = text(renderRemoteHubPage(state, {}))
  assert.ok(result.includes('授权角色：'))
  assert.ok(result.includes('完全控制'))
  assert.ok(result.includes('配对时间：'))
  assert.ok(result.includes('最近连接：'))
  assert.ok(result.includes('连接失败：配对凭据已过期'))
})
test('legacy unknown pairing metadata is explicitly unknown', () => {
  const result = text(renderRemoteHubPage({ ...state, outboundTargets: [{ id: 'b'.repeat(64), origin: 'http://example.test' }] }, {}))
  assert.ok(result.includes('未知（需重新配对确认）'))
  assert.ok(result.includes('未知（旧配对未记录）'))
})
