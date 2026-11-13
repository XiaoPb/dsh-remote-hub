/**
 * 注入握手契约测试（Task 2.3）。
 *
 * 页面要能确认「我连的是当前守卫实例」。host 注入必须包含：
 * instanceId / pid / injectedAt / protocolVersion / guardOrigin / loopbackOrigin。
 * pin 只用于内部请求，**不得**出现在任何可复制的诊断输出里。
 *
 * @module test/injection-contract.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const mod = await import('../lib/index.js')

describe('注入握手字段', () => {
  it('hostInstanceId 稳定且形如 hub_<pid36>_<ts36>_<rand>', () => {
    const first = mod.hostInstanceId()
    const second = mod.hostInstanceId()
    assert.equal(first, second, '同一进程内实例 id 必须稳定')
    assert.match(first, /^hub_[0-9a-z]+_[0-9a-z]+_[0-9a-z]+$/u)
    assert.ok(first.includes(process.pid.toString(36)), '实例 id 应包含 pid（便于对照进程）')
  })

  it('HOST_STATUS_FILE 常量导出（页面/脚本据此定位诊断文件）', () => {
    assert.equal(mod.HOST_STATUS_FILE, 'host-status.json')
  })

  it('page 侧 InjectionDiagnostic 字段齐全（类型契约由 tsconfig 保证，这里验证渲染不抛）', async () => {
    const { registerAlias } = await import('./panel-alias-loader.mjs')
    await registerAlias()
    const page = await import('../.build/client/client/src/panel/RemoteHubPage.js')
    const state = {
      mode: { mode: 'local' },
      guard: null,
      guardError: '守卫连接失败',
      devices: [],
      loading: false,
      pairIssueToken: 'pin',
      role: 'control',
      issued: null,
      issuedCode: null,
      autoReissue: true,
      originDraft: '',
      secretDraft: '',
      deviceFilter: 'all',
      stats: null,
      statsError: null,
      config: null,
      configDraft: null,
      configSaving: false,
      configSavedAt: null,
      injection: {
        hasPin: true,
        guardOrigin: 'http://127.0.0.1:8443',
        loopbackOrigin: 'http://127.0.0.1:8443',
        instanceId: mod.hostInstanceId(),
        pid: process.pid,
        injectedAt: new Date().toISOString(),
        protocolVersion: 1,
        ageSeconds: 0,
      },
      diagnostic: null,
      retry: { attempts: 0, nextRetryAt: null },
      busy: null,
      error: null,
      now: Date.now(),
    }
    const actions = {
      onRefresh() {}, onRoleChange() {}, onIssue() {}, onRevoke() {}, onRevokeAll() {},
      onOriginChange() {}, onSecretChange() {}, onConnect() {}, onDetach() {}, onCopy() {},
      onScan() {}, onAutoReissueChange() {}, onFilterChange() {}, onConfigChange() {}, onConfigSave() {},
    }
    const tree = page.renderRemoteHubPage(state, actions)
    const serialized = JSON.stringify(tree)
    assert.ok(serialized.includes('guard-diagnostic'), '诊断卡必须渲染')
    assert.equal(serialized.includes('"pin"'), false, '诊断输出不得包含 pin 值')
  })
})
