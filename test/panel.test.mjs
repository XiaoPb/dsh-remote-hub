/**
 * 云端设备页测试：槽位注册契约 + 页面内容完整性（回归"空页"）+ 身份区分 +
 * 配对链接/模式切换行为。
 *
 * @module test/panel.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { PATHS, read } from './_helpers.mjs'
import { registerAlias } from './panel-alias-loader.mjs'

const UI_SRC = read(`${PATHS.clientSrc}/ui/index.ts`)
const PLUGIN_SRC = read(`${PATHS.clientSrc}/plugin.ts`)
const INDEX_SRC = read(`${PATHS.clientSrc}/index.ts`)

await registerAlias()

/** 测试用 localStorage 存根。 */
function fakeStorage() {
  const map = new Map()
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: key => { map.delete(key) },
    _map: map,
  }
}

const GUARD = {
  host: '127.0.0.1',
  port: 8443,
  origin: 'http://127.0.0.1:8443',
  protocolVersion: 1,
  singleController: true,
}

function baseState(overrides = {}) {
  return {
    mode: { mode: 'local' },
    outboundTargets: [],
    guard: GUARD,
    guardError: null,
    devices: [],
    loading: false,
    pairIssueToken: 'issue-token',
    role: 'control',
    issued: null,
    issuedCode: null,
    autoReissue: true,
    originDraft: 'http://127.0.0.1:8443',
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
    now: 1_000_000,
    ...overrides,
  }
}

const noopActions = {
  onRefresh() {},
  onRoleChange() {},
  onIssue() {},
  onForgetDevice() {},
  onForgetOutbound() {},
  onRevoke() {},
  onRevokeAll() {},
  onOriginChange() {},
  onSecretChange() {},
  onConnect() {},
  onReconnect() {},
  onDetach() {},
  onCopy() {},
  onScan() {},
  onAutoReissueChange() {},
  onFilterChange() {},
  onConfigChange() {},
  onConfigSave() {},
}

function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) collectText(child, out); return out }
  if (node.props && node.props.children !== undefined) collectText(node.props.children, out)
  return out
}

function collectByTestId(node, testid, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) { for (const child of node) collectByTestId(child, testid, out); return out }
  if (node.props?.['data-testid'] === testid) out.push(node)
  if (node.props?.children !== undefined) collectByTestId(node.props.children, testid, out)
  return out
}

describe('断开后的出站配对目标（保留卡片并支持重连）', () => {
  it('档案规范化 origin；同 Host 的不同配对凭据分别保留', async () => {
    const { readOutboundTargets, writeOutboundTargets, upsertOutboundTarget, OUTBOUND_TARGETS_KEY } = await loadPage()
    const storage = fakeStorage()
    const first = { origin: 'http://192.168.0.17:8443/', token: 'o'.repeat(32), deviceLabel: 'old' }
    const second = { origin: 'http://192.168.0.17:8443', token: 'n'.repeat(32), deviceLabel: 'debian', role: 'control' }
    writeOutboundTargets([first], storage)
    const next = upsertOutboundTarget(readOutboundTargets(storage), second)
    writeOutboundTargets(next, storage)
    assert.equal(storage._map.has(OUTBOUND_TARGETS_KEY), true)
    assert.equal(readOutboundTargets(storage).length, 2, '不同设备 token 必须共存')
    assert.equal(readOutboundTargets(storage)[0].origin, 'http://192.168.0.17:8443')
    assert.deepEqual(upsertOutboundTarget(next, second), next, '同一 origin+token 更新现有配对而不重复')
  })

  it('存储不可写时返回 false，不让调用方误认为目标已持久化', async () => {
    const { writeOutboundTargets } = await loadPage()
    const storage = { getItem() { return null }, setItem() { throw new Error('quota') } }
    assert.equal(writeOutboundTargets([{ origin: 'http://192.168.0.17:8443', token: 'x'.repeat(32) }], storage), false)
  })

  it('断开后配对目标卡显示重连按钮但不泄漏 token', async () => {
    const { renderRemoteHubPage, classifyPairSecret } = await loadPage()
    const token = 'SECRET_TOKEN_MUST_NOT_RENDER'
    const target = {
      origin: 'http://192.168.0.17:8443',
      token,
      deviceLabel: 'debian',
      role: 'control',
      lastConnectedAt: 1234,
    }
    const tree = renderRemoteHubPage(baseState({
      mode: { mode: 'local' },
      outboundTargets: [target],
    }), noopActions)
    const cards = collectByTestId(tree, 'outbound-paired')
    assert.equal(cards.length, 1, '断开后仍须保留一张已配对目标卡')
    assert.equal(cards[0].props['data-origin'], target.origin)
    assert.equal(cards[0].props['data-status'], 'paired')
    assert.equal(collectByTestId(cards[0], 'reconnect').length, 1, '配对卡必须有重连按钮')
    const text = collectText(cards[0]).join(' ')
    assert.ok(text.includes('debian'), '应显示目标名')
    assert.ok(text.includes(target.origin), '应显示目标地址')
    assert.equal(text.includes(token), false, '长期令牌绝不能渲染到 DOM 文案')
    assert.equal(classifyPairSecret(token), null, '保存的长期 token 不是配对输入凭据')
  })

  it('重连按钮回调携带已配对目标（不要求重新扫码）', async () => {
    const { renderRemoteHubPage } = await loadPage()
    const target = {
      origin: 'http://192.168.0.17:8443',
      token: 't'.repeat(43),
      deviceLabel: 'debian',
      role: 'control',
    }
    let received
    const tree = renderRemoteHubPage(baseState({ outboundTargets: [target] }), {
      ...noopActions,
      onReconnect(value) { received = value },
    })
    const button = collectByTestId(tree, 'reconnect')[0]
    assert.ok(button, '重连 action 必须可从卡片触达')
    button.props.onClick()
    assert.deepEqual(received, target)
  })

  it('远端接管时保留其它已配对目标，可直接切换', async () => {
    const { renderRemoteHubPage } = await loadPage()
    const alternate = {
      origin: 'http://192.168.0.17:8443',
      token: 'z'.repeat(32),
      deviceLabel: 'debian-secondary',
    }
    let selected
    const tree = renderRemoteHubPage(baseState({
      mode: { mode: 'cloud', origin: 'http://192.168.0.17:8443', token: 'a'.repeat(32), deviceLabel: 'debian' },
      outboundTargets: [
        { origin: 'http://192.168.0.17:8443', token: 'a'.repeat(32), deviceLabel: 'debian' },
        alternate,
      ],
    }), { ...noopActions, onReconnect(target) { selected = target } })
    assert.equal(collectByTestId(tree, 'outbound-current').length, 1)
    const cards = collectByTestId(tree, 'outbound-paired')
    assert.equal(cards.length, 1, '当前目标不重复显示，但其它目标必须仍可选')
    assert.equal(cards[0].props['data-origin'], alternate.origin)
    collectByTestId(cards[0], 'reconnect')[0].props.onClick()
    assert.deepEqual(selected, alternate)
  })
  it('相同 origin 的不同 token 有不同稳定身份，且 identity 不含明文 token', async () => {
    const { outboundTargetIdentity } = await loadPage()
    const origin = 'http://192.168.0.17:8443'
    const first = { origin, token: 'a'.repeat(32) }
    const second = { origin, token: 'b'.repeat(32) }
    const firstId = outboundTargetIdentity(first)
    const secondId = outboundTargetIdentity(second)
    assert.notEqual(firstId, secondId)
    assert.equal(firstId.includes(first.token), false)
    assert.equal(outboundTargetIdentity(first), firstId)
    const { renderRemoteHubPage } = await loadPage()
    const tree = renderRemoteHubPage(baseState({ outboundTargets: [first, second] }), noopActions)
    const cards = collectByTestId(tree, 'outbound-paired')
    assert.equal(cards.length, 2)
    assert.equal(cards[0].props['data-origin'], cards[1].props['data-origin'])
    const names = cards.map(card => collectText(card).join(' '))
    assert.notEqual(names[0], names[1], '同 Host 配对卡需用非敏感指纹区分')
    assert.equal(names.some(name => name.includes(first.token) || name.includes(second.token)), false)
  })

  it('新配对只在 Host archive 与 carrier 成功后激活 opaque target', async () => {
    const { persistNewPairing } = await loadPage()
    const target = { id: 'a'.repeat(64), origin: 'http://192.168.0.17:8443', deviceLabel: 'debian' }
    const bearer = 'p'.repeat(32)
    let activated
    const archiveFailure = await persistNewPairing({
      saveTarget: async () => { throw new Error('profile storage unavailable') },
      writeCloudMode: async () => 1,
      setCloudMode: () => { activated = true },
    })
    assert.equal(archiveFailure.archiveSaved, false)
    assert.equal(archiveFailure.carrierSaved, false)
    assert.equal(activated, undefined)

    let savedBearer
    const carrierFailure = await persistNewPairing({
      saveTarget: async () => { savedBearer = bearer; return target },
      writeCloudMode: async () => { throw new Error('disk full') },
      setCloudMode: () => { activated = true },
    })
    assert.equal(savedBearer, bearer, 'bearer is sent only to the Host archive endpoint')
    assert.equal(carrierFailure.archiveSaved, true)
    assert.equal(carrierFailure.carrierSaved, false)
    assert.equal(carrierFailure.target.id, target.id)
    assert.equal('token' in carrierFailure.target, false)
    assert.equal(activated, undefined)

    const success = await persistNewPairing({
      saveTarget: async () => target,
      writeCloudMode: async saved => { assert.equal(saved.id, target.id); return 2 },
      setCloudMode: saved => { activated = saved.id },
    })
    assert.equal(success.carrierSaved, true)
    assert.equal(activated, target.id)
  })

  it('断开时档案无法写入仍允许切回本机，carrier 写入失败则不 reload', async () => {
    const { runDetachPersistence } = await loadPage()
    let reloads = 0
    const failure = await runDetachPersistence({
      saveTargets: () => false,
      writeLocalMode: async () => 12,
      reload: () => { reloads++ },
    })
    assert.equal(failure.disconnected, true)
    assert.equal(failure.targetsSaved, false)
    assert.equal(reloads, 1)

    const failedCarrier = await runDetachPersistence({
      saveTargets: () => true,
      writeLocalMode: async () => { throw new Error('disk full') },
      reload: () => { reloads++ },
    })
    assert.equal(failedCarrier.disconnected, false)
    assert.equal(reloads, 1)
  })

  it('同一 origin+token 的配对更新原卡片，不累积重复项', async () => {
    const { upsertOutboundTarget } = await loadPage()
    const token = 'n'.repeat(32)
    const older = { origin: 'http://192.168.0.17:8443/', token, deviceLabel: 'old' }
    const newer = { origin: 'http://192.168.0.17:8443', token, deviceLabel: 'debian' }
    const result = upsertOutboundTarget([older], newer)
    assert.equal(result.length, 1)
    assert.equal(result[0].token, token)
    assert.equal(result[0].deviceLabel, 'debian')
  })
})

describe('槽位注册契约（官方 inject 包装）', () => {
  it('不再挂载 shell.overlay 面板（会盖住桌面标题栏）', () => {
    assert.equal(PLUGIN_SRC.includes('mountRemotePanel'), false, 'overlay panel must not be mounted')
    assert.equal(PLUGIN_SRC.includes("'shell.overlay'"), false, 'no overlay slot registration in assembly')
  })

  it('sidebar.panellist 导航行 + main 页（id/key 同名 remote-hub，各自独立 inject）', () => {
    assert.ok(PLUGIN_SRC.includes("name: 'sidebar.panellist'") && PLUGIN_SRC.includes("id: 'remote-hub'"))
    assert.ok(PLUGIN_SRC.includes("name: 'main'") && PLUGIN_SRC.includes("key: 'remote-hub'"))
    assert.ok(PLUGIN_SRC.includes("declare('sidebar.panellist'") && PLUGIN_SRC.includes("declare('main'"))
  })

  it('UI 装配仍走延迟子 fiber（slots 未就绪不阻塞 boot）', () => {
    assert.ok(PLUGIN_SRC.includes("injectWhenReady(ctx, ['slots']"))
    assert.ok(/export const inject[^=]*=\s*\[\]/.test(INDEX_SRC))
  })

  it('main 页注册稳定组件（hooks 身份，而非每次重建的箭头函数）', () => {
    assert.ok(PLUGIN_SRC.includes('createRemoteHubPageComponent'))
    assert.ok(PLUGIN_SRC.includes('RemoteHubPage,'))
  })
})

describe('主题 token（语义化样式，外部可换肤）', () => {
  const PAGE_SRC = read(`${PATHS.clientSrc}/panel/RemoteHubPage.ts`)

  it('样式只经 --rh-* 语义 token 引用，除二维码白底黑模块与 token 定义外无硬编码色值', () => {
    // 允许：① THEME_CSS 常量内的 token 默认定义（唯一合法的字面色值位置）；
    // ② QR 的 #fff/#000（扫码可用性要求）。其余十六进制色一律禁止。
    const stripped = PAGE_SRC
      .replace(/const THEME_CSS = `[\s\S]*?`/u, '')
      .replace(/#fff\b/g, '').replace(/#000\b/g, '')
    assert.doesNotMatch(stripped, /#[0-9a-fA-F]{3,8}\b/, '发现硬编码色值，请改用 var(--rh-*)')
    assert.match(PAGE_SRC, /const THEME_CSS = `[\s\S]*--rh-accent[\s\S]*?`/u, '缺 token 定义块')
  })

  it('注入主题样式：token 定义 + 明暗两套（data-theme 强制 + 系统偏好自动）', async () => {
    const { renderRemoteHubPage } = await loadPage()
    const tree = renderRemoteHubPage(baseState(), noopActions)
    const styleNodes = collectByTestId(tree, 'remote-hub-page')[0].props.children
      .filter(child => child?.props?.['data-rh-theme'] !== undefined)
    assert.equal(styleNodes.length, 1, '主题 <style> 必须随页面注入')
    const css = String(styleNodes[0].props.children)
    assert.ok(css.includes('--rh-accent'), '缺核心 token 定义')
    assert.ok(css.includes('data-theme="dark"'), '缺 data-theme 暗色强制覆盖')
    assert.ok(css.includes('prefers-color-scheme: dark'), '缺系统暗色偏好自适应')
    assert.ok(css.includes('@media (max-width: 639px)'), '缺手机断点')
    assert.ok(css.includes('@media (max-width: 1023px)'), '缺平板断点')
  })
})

describe('四区结构（参考文档 ①令牌 ②设备 ③统计 ④配置）', () => {
  const SAMPLE_STATS = {
    startedAt: new Date(0).toISOString(),
    pairIssued: 3,
    pairRedeemed: 2,
    pairRejected: 1,
    authAccepted: 42,
    authDenied: 1,
    activeStreams: 1,
    streamsOpened: 4,
    hourly: Array.from({ length: 24 }, (_, i) => (i % 5)),
    daily: Array.from({ length: 7 }, (_, i) => i),
  }
  const SAMPLE_CONFIG = {
    singleController: true,
    bridgeApprovals: true,
    defaultRole: 'control',
    maxPairAttempts: 5,
    network: 'loopback',
    guardPort: 8443,
    pairQrTtlMs: 120_000,
    pairCodeTtlMs: 600_000,
    tunnelKind: 'none',
  }

  it('四个分区 testid 都在（宿主支持全部数据源时）', async () => {
    const { renderRemoteHubPage } = await loadPage()
    const tree = renderRemoteHubPage(baseState({
      stats: SAMPLE_STATS,
      config: SAMPLE_CONFIG,
      configDraft: SAMPLE_CONFIG,
      devices: [GUARD && { deviceId: 'dev_a', label: 'A', role: 'control', createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), revokedAt: null }],
    }), noopActions)
    assert.equal(collectByTestId(tree, 'host-section').length, 1, '① 令牌区')
    assert.equal(collectByTestId(tree, 'devices-section').length, 1, '② 设备区')
    assert.equal(collectByTestId(tree, 'stats-section').length, 1, '③ 统计区')
    assert.equal(collectByTestId(tree, 'config-section').length, 1, '④ 配置区')
  })

  it('③ 统计区：统计卡 + 折线/柱状 + 热力图', async () => {
    const { renderRemoteHubPage } = await loadPage()
    const tree = renderRemoteHubPage(baseState({ stats: SAMPLE_STATS, config: SAMPLE_CONFIG, configDraft: SAMPLE_CONFIG }), noopActions)
    assert.equal(collectByTestId(tree, 'stats-body').length, 1)
    assert.equal(collectByTestId(tree, 'chart-line').length, 1, '折线')
    assert.equal(collectByTestId(tree, 'chart-bar').length, 1, '柱状')
    assert.equal(collectByTestId(tree, 'chart-heat').length, 1, '热力')
    const texts = collectText(tree)
    assert.ok(texts.some(t => t.includes('24h')), '活动图标注时长')
  })

  it('③ 降级：stats=null 显示不支持文案（不渲染图表）', async () => {
    const { renderRemoteHubPage } = await loadPage()
    const tree = renderRemoteHubPage(baseState({ stats: null, config: SAMPLE_CONFIG, configDraft: SAMPLE_CONFIG }), noopActions)
    assert.equal(collectByTestId(tree, 'stats-unsupported').length, 1)
    assert.equal(collectByTestId(tree, 'chart-line').length, 0)
  })

  it('④ 配置区：开关行 + 角色下拉 + 数字输入 + 冷项标注 + 保存按钮', async () => {
    const { renderRemoteHubPage } = await loadPage()
    const tree = renderRemoteHubPage(baseState({ stats: SAMPLE_STATS, config: SAMPLE_CONFIG, configDraft: SAMPLE_CONFIG }), noopActions)
    assert.equal(collectByTestId(tree, 'config-body').length, 1)
    assert.equal(collectByTestId(tree, 'cfg-single').length, 1, '单控开关')
    assert.equal(collectByTestId(tree, 'cfg-bridge').length, 1, '审批桥开关')
    assert.equal(collectByTestId(tree, 'cfg-role').length, 1, '角色下拉')
    assert.equal(collectByTestId(tree, 'cfg-attempts').length, 1, '尝试次数输入')
    assert.equal(collectByTestId(tree, 'config-save').length, 1, '保存按钮')
    const texts = collectText(tree)
    assert.ok(texts.some(t => t.includes('重启后生效')), '冷项标注')
  })

  it('配置默认角色只接受 read-only/control/full，其它值回退 control', async () => {
    const { configuredDefaultRole } = await loadPage()
    assert.equal(configuredDefaultRole('full'), 'full')
    assert.equal(configuredDefaultRole('read-only'), 'read-only')
    assert.equal(configuredDefaultRole('control'), 'control')
    assert.equal(configuredDefaultRole('owner'), 'control')
    assert.equal(configuredDefaultRole(undefined), 'control')
  })


  it('④ 草稿有修改 → 显示未保存胶囊', async () => {
    const { renderRemoteHubPage } = await loadPage()
    const tree = renderRemoteHubPage(baseState({
      stats: SAMPLE_STATS,
      config: SAMPLE_CONFIG,
      configDraft: { ...SAMPLE_CONFIG, singleController: false },
    }), noopActions)
    assert.equal(collectByTestId(tree, 'config-dirty').length, 1)
  })

  it('② 设备区：筛选按钮 + 三态（已连接/已配对/配对失效）', async () => {
    const { renderRemoteHubPage, deviceStatus, isDeviceOnline } = await loadPage()
    const at = 1_000_000_000
    // 三态（2026-11-12）：connected / paired / invalid
    assert.equal(deviceStatus({ revokedAt: null, lastSeenAt: new Date(at - 10_000).toISOString() }, at), 'connected')
    assert.equal(deviceStatus({ revokedAt: null, lastSeenAt: new Date(at - 120_000).toISOString() }, at), 'idle')
    // 超过 10 分钟无心跳 → 已配对（离线），**不是**配对失效
    assert.equal(deviceStatus({ revokedAt: null, lastSeenAt: new Date(at - 900_000).toISOString() }, at), 'paired')
    // 只有 revokedAt 才是配对失效
    assert.equal(deviceStatus({ revokedAt: new Date().toISOString(), lastSeenAt: null }, at), 'invalid')
    assert.equal(deviceStatus({ revokedAt: null, lastSeenAt: null }, at), 'paired')

    // 在线判定
    assert.equal(isDeviceOnline({ revokedAt: null, lastSeenAt: new Date(at - 10_000).toISOString() }, at), true)
    assert.equal(isDeviceOnline({ revokedAt: null, lastSeenAt: null }, at), false)

    const tree = renderRemoteHubPage(baseState(), noopActions)
    assert.equal(collectByTestId(tree, 'device-filter').length, 1)
    const filters = collectByTestId(tree, 'filter')
    assert.ok(filters.length >= 2, '全部/连接本机两个筛选')
  })

  it('② 三态文案与离线置灰', async () => {
    const { renderRemoteHubPage } = await loadPage()
    const at = 1_000_000_000
    const rows = [
      { deviceId: 'a', label: '在线设备', role: 'control', revokedAt: null, lastSeenAt: new Date(at - 5_000).toISOString() },
      { deviceId: 'b', label: '离线设备', role: 'control', revokedAt: null, lastSeenAt: null },
      { deviceId: 'c', label: '失效设备', role: 'control', revokedAt: new Date(at).toISOString(), lastSeenAt: null },
    ]
    const tree = renderRemoteHubPage(baseState({ devices: rows, now: at }), noopActions)
    const pills = collectByTestId(tree, 'device-status')
    const byStatus = new Map(pills.map(pill => [pill.props['data-status'], pill]))
    assert.ok(byStatus.has('connected'), '必须渲染「已连接」')
    assert.ok(byStatus.has('paired'), '必须渲染「已配对」')
    assert.ok(byStatus.has('invalid'), '必须渲染「配对失效」')
    const texts = collectText(tree)
    assert.ok(texts.includes('已连接'))
    assert.ok(texts.includes('已配对'))
    assert.ok(texts.includes('配对失效'))
  })

  it('① 过期自动重签开关存在且默认勾选', async () => {
    const { renderRemoteHubPage } = await loadPage()
    const tree = renderRemoteHubPage(baseState(), noopActions)
    const boxes = collectByTestId(tree, 'auto-reissue')
    assert.equal(boxes.length, 1)
    assert.equal(boxes[0].props.checked, true)
  })
})

describe('页面内容完整性（回归：早期版本只渲染标题+折叠项）', () => {
  it('两个身份分区都在：本机（被控端）/ 连接其他设备（主控端）', async () => {
    const { renderRemoteHubPage } = await loadPage()
    const tree = renderRemoteHubPage(baseState(), noopActions)
    assert.equal(collectByTestId(tree, 'host-section').length, 1, '被控端分区')
    assert.equal(collectByTestId(tree, 'client-section').length, 1, '主控端分区')
  })

  it('守卫状态可见：运行中/地址/协议/单控策略', async () => {
    const { renderRemoteHubPage } = await loadPage()
    const tree = renderRemoteHubPage(baseState(), noopActions)
    const texts = collectText(tree)
    assert.ok(texts.includes('守卫运行中'))
    assert.ok(texts.some(t => t.includes('http://127.0.0.1:8443')))
    // 新布局：协议版本独立展示（minirow 分项「协议版本 → v1」）
    assert.ok(texts.includes('协议版本') && texts.includes('v1'))
    const node = collectByTestId(tree, 'single-controller')[0]
    assert.ok(collectText(node).some(t => t.includes('已启用')))
  })

  it('守卫未运行：显示原因，不显示单控行', async () => {
    const { renderRemoteHubPage } = await loadPage()
    const tree = renderRemoteHubPage(baseState({
      guard: null, guardError: '读取守卫状态失败：fetch failed',
    }), noopActions)
    const texts = collectText(tree)
    assert.ok(texts.includes('守卫未运行'))
    assert.ok(texts.some(t => t.includes('读取守卫状态失败')))
    assert.equal(collectByTestId(tree, 'single-controller').length, 0)
  })

  it('签发区：角色选择 + 生成二维码/短码', async () => {
    const { renderRemoteHubPage } = await loadPage()
    const tree = renderRemoteHubPage(baseState(), noopActions)
    const roles = collectByTestId(tree, 'role')
    assert.equal(roles.length, 3)
    assert.equal(collectByTestId(tree, 'issue-ticket').length, 1)
    assert.equal(collectByTestId(tree, 'issue-code').length, 1)
  })

  it('无签发凭据时给出明确原因（仍是完整文案，不是空白）', async () => {
    const { renderRemoteHubPage } = await loadPage()
    const tree = renderRemoteHubPage(baseState({ pairIssueToken: undefined }), noopActions)
    assert.equal(collectByTestId(tree, 'pair-issue').length, 0)
    assert.equal(collectByTestId(tree, 'pair-issue-unavailable').length, 1)
  })

  it('票据签发 → 渲染二维码 + 链接 + 倒计时', async () => {
    const { renderRemoteHubPage } = await loadPage()
    const tree = renderRemoteHubPage(baseState({
      issued: { kind: 'ticket', value: 'a'.repeat(43), role: 'control', expiresAt: 1_000_000 + 120_000 },
    }), noopActions)
    assert.equal(collectByTestId(tree, 'pair-qr').length, 1, 'QR rendered')
    const texts = collectText(tree)
    assert.ok(texts.some(t => t.includes('#dshrh=')), 'link text')
    assert.ok(texts.some(t => t.includes('剩余 120s')), 'countdown')
    assert.equal(collectByTestId(tree, 'copy-link').length, 1)
  })

  it('短码签发 → 等宽短码 + 复制按钮；二维码显示占位（三件套始终可见）', async () => {
    const { renderRemoteHubPage } = await loadPage()
    const tree = renderRemoteHubPage(baseState({
      issuedCode: { kind: 'code', value: 'ABCD2345', role: 'read-only', expiresAt: 1_000_000 + 600_000 },
    }), noopActions)
    const texts = collectText(tree)
    assert.ok(texts.includes('ABCD2345'))
    assert.equal(collectByTestId(tree, 'copy-code').length, 1)
    // 只签发了短码时，二维码槽位显示占位并引导生成（而不是整块消失）。
    assert.equal(collectByTestId(tree, 'pair-qr').length, 0, 'no QR without ticket')
    assert.equal(collectByTestId(tree, 'qr-placeholder').length, 1, '二维码占位必须可见')
  })

  it('票据 + 短码并存 → 二维码、短码、链接同时展示', async () => {
    const { renderRemoteHubPage } = await loadPage()
    const tree = renderRemoteHubPage(baseState({
      guard: {
        host: '127.0.0.1', port: 8443, origin: 'http://192.168.0.106:8443',
        protocolVersion: 1, singleController: true,
      },
      listenAddress: 'http://192.168.0.106:8443',
      issued: { kind: 'ticket', value: 'a'.repeat(43), role: 'control', expiresAt: 1_000_000 + 15_000 },
      issuedCode: { kind: 'code', value: 'ABCD2345', role: 'control', expiresAt: 1_000_000 + 15_000 },
    }), noopActions)
    assert.equal(collectByTestId(tree, 'pair-qr').length, 1, '二维码')
    assert.equal(collectByTestId(tree, 'qr-placeholder').length, 0, '无占位')
    assert.equal(collectByTestId(tree, 'issued-code').length, 1, '短码')
    assert.equal(collectByTestId(tree, 'issued-link').length, 1, '链接')
    const texts = collectText(tree)
    assert.ok(texts.includes('ABCD2345'), '短码文本')
    // 链接必须使用局域网地址，而不是回环地址。
    assert.ok(texts.some(t => t.includes('192.168.0.106:8443#dshrh=')), '链接用局域网地址')
    assert.equal(texts.some(t => t.includes('127.0.0.1:8443#dshrh=')), false, '不得用回环地址')
  })

  it('已配对设备：每行有「清除配对」，顶部有「清除全部」', async () => {
    const { renderRemoteHubPage } = await loadPage()
    const tree = renderRemoteHubPage(baseState({
      devices: [
        { deviceId: 'd1', label: 'Pixel 9', role: 'control', lastSeenAt: new Date().toISOString(), revokedAt: null },
        { deviceId: 'd2', label: 'Old', role: 'full', lastSeenAt: null, revokedAt: '2026-01-01T00:00:00Z' },
      ],
    }), noopActions)
    const revokes = collectByTestId(tree, 'revoke')
    assert.equal(revokes.length, 1, '只有未吊销设备有清除按钮')
    assert.equal(collectByTestId(tree, 'revoke-all').length, 1)
    const texts = collectText(tree)
    assert.ok(texts.some(t => t.includes('Pixel 9')))
    assert.ok(texts.some(t => t.includes('配对失效')), '已吊销行显示「配对失效」')
  })

  it('已配对设备都提供删除入口，确认后由 Host 撤销并移除设备记录', async () => {
    const { renderRemoteHubPage } = await loadPage()
    const tree = renderRemoteHubPage(baseState({ devices: [
      { deviceId: 'd1', label: 'Active', role: 'control', revokedAt: null, lastSeenAt: new Date().toISOString() },
      { deviceId: 'd2', label: 'Stale', role: 'full', revokedAt: '2026-01-01T00:00:00Z', lastSeenAt: null },
    ] }), noopActions)
    assert.equal(collectByTestId(tree, 'device-delete').length, 2)
  })

  it('守卫诊断使用可换行的响应式网格容器', async () => {
    const { renderRemoteHubPage } = await loadPage()
    const tree = renderRemoteHubPage(baseState({ injection: { hasPin: true, guardOrigin: 'http://127.0.0.1:8443', loopbackOrigin: 'http://127.0.0.1:8443', instanceId: 'instance', pid: 1, injectedAt: '2026-01-01T00:00:00Z', protocolVersion: 1, ageSeconds: 2 } }), noopActions)
    assert.equal(collectByTestId(tree, 'diagnostic-grid').length, 1)
    assert.equal(collectByTestId(tree, 'diagnostic-request-grid').length, 1)
    assert.equal(collectByTestId(tree, 'diag-target-origin').length, 1)
  })

  it('空设备表：引导文案（不是空白）', async () => {
    const { renderRemoteHubPage } = await loadPage()
    const tree = renderRemoteHubPage(baseState(), noopActions)
    assert.equal(collectByTestId(tree, 'devices-empty').length, 1)
  })

  it('主控端：本地模式显示未连接；云端模式显示目标与断开', async () => {
    const { renderRemoteHubPage } = await loadPage()
    const local = renderRemoteHubPage(baseState(), noopActions)
    assert.equal(collectByTestId(local, 'not-connected').length, 1)
    assert.equal(collectByTestId(local, 'detach').length, 0)

    const cloud = renderRemoteHubPage(baseState({
      mode: { mode: 'cloud', origin: 'https://pc.example', token: 't', deviceLabel: 'PC-01' },
    }), noopActions)
    assert.equal(collectByTestId(cloud, 'connected-to').length, 1)
    assert.equal(collectByTestId(cloud, 'detach').length, 1)
    const texts = collectText(cloud)
    assert.ok(texts.some(t => t.includes('☁ PC-01')))
  })

  it('主控端提供「扫码」按钮（拉起摄像头）', async () => {
    const { renderRemoteHubPage } = await loadPage()
    const tree = renderRemoteHubPage(baseState(), noopActions)
    const scan = collectByTestId(tree, 'scan')
    assert.equal(scan.length, 1, 'scan button rendered')
    assert.ok(String(scan[0].props['aria-label']).includes('摄像头'))
  })

  it('非法输入禁用连接并给内联提示', async () => {
    const { renderRemoteHubPage } = await loadPage()
    const tree = renderRemoteHubPage(baseState({ secretDraft: 'xx', originDraft: 'not a url' }), noopActions)
    assert.equal(collectByTestId(tree, 'secret-invalid').length, 1)
    assert.equal(collectByTestId(tree, 'origin-invalid').length, 1)
    assert.equal(collectByTestId(tree, 'connect')[0].props.disabled, true)
  })

  it('错误信息渲染为 alert', async () => {
    const { renderRemoteHubPage } = await loadPage()
    const tree = renderRemoteHubPage(baseState({ error: '连接失败：401' }), noopActions)
    const alerts = collectByTestId(tree, 'page-error')
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0].props.role, 'alert')
  })
})

describe('纯函数契约', () => {
  it('classifyPairSecret：Crockford 短码 / 票据 / 非法', async () => {
    const { classifyPairSecret } = await loadPage()
    assert.equal(classifyPairSecret('ABCD2345'), 'code')
    assert.equal(classifyPairSecret('ABCDI345'), null)
    assert.equal(classifyPairSecret('a'.repeat(43)), 'ticket')
    assert.equal(classifyPairSecret('short'), null)
  })

  it('normalizeOrigin：接受 http(s) 裸地址，拒绝路径/凭据/非 http', async () => {
    const { normalizeOrigin } = await loadPage()
    assert.equal(normalizeOrigin('http://127.0.0.1:8443'), 'http://127.0.0.1:8443')
    assert.equal(normalizeOrigin('https://pc.example/'), 'https://pc.example')
    assert.equal(normalizeOrigin('ftp://x'), undefined)
    assert.equal(normalizeOrigin('http://user:pw@x'), undefined)
    assert.equal(normalizeOrigin('http://x/path'), undefined)
  })

  it('配对链接可往返：buildPairLink → parsePairLink', async () => {
    const { buildPairLink, parsePairLink } = await loadPage()
    const link = buildPairLink('http://127.0.0.1:8443', 'a'.repeat(43))
    assert.deepEqual(parsePairLink(link), { origin: 'http://127.0.0.1:8443', secret: 'a'.repeat(43) })
    assert.equal(parsePairLink('plain code'), null)
    assert.equal(parsePairLink('http://x#dshrh=nope'), null, '非法票据视为无效')
  })

  it('remainingSeconds：向上取整且不为负', async () => {
    const { remainingSeconds } = await loadPage()
    assert.equal(remainingSeconds(10_000, 0), 10)
    assert.equal(remainingSeconds(10_000, 9_500), 1)
    assert.equal(remainingSeconds(10_000, 12_000), 0)
  })
})

describe('模式切换行为（createSettingsActions）', () => {
  it('attach 写 cloud 模式并 reload；detach 清回 local', async () => {
    const { createSettingsActions } = await loadPage()
    const storage = fakeStorage()
    let reloads = 0
    const actions = createSettingsActions({ storage, reload: () => { reloads += 1 } })
    actions.attach({ origin: 'http://127.0.0.1:8443', token: 'tok', deviceLabel: 'PC-01' })
    assert.equal(reloads, 1)
    const mode = JSON.parse(storage.getItem('remote-hub.mode'))
    assert.equal(mode.mode, 'cloud')
    assert.equal(mode.deviceLabel, 'PC-01')

    actions.detach()
    assert.equal(reloads, 2)
    assert.equal(storage.getItem('remote-hub.mode'), null)
  })

  it('缺 origin/token 的 attach 不写不 reload', async () => {
    const { createSettingsActions } = await loadPage()
    const storage = fakeStorage()
    let reloads = 0
    const actions = createSettingsActions({ storage, reload: () => { reloads += 1 } })
    actions.attach({ origin: '', token: 'tok' })
    actions.attach({ origin: 'http://x', token: '' })
    assert.equal(reloads, 0)
    assert.equal(storage.getItem('remote-hub.mode'), null)
  })
})

describe('守卫诊断（Task 1.1）', () => {
  const INJECTED = {
    hasPin: true,
    guardOrigin: 'http://127.0.0.1:8443',
    loopbackOrigin: 'http://127.0.0.1:8443',
    instanceId: 'hub_abc_123_xyz',
    pid: 22800,
    injectedAt: '2026-11-11T15:15:29.000Z',
    protocolVersion: 1,
    ageSeconds: 12,
  }

  it('诊断卡存在，且守卫不可用时默认展开', async () => {
    const { renderRemoteHubPage } = await loadPage()
    const tree = renderRemoteHubPage(baseState({ guard: null, guardError: '守卫连接失败' }), noopActions)
    const card = collectByTestId(tree, 'guard-diagnostic')
    assert.equal(card.length, 1)
    assert.equal(card[0].props.open, true, '守卫不可用时应展开，便于排障')
  })

  it('诊断卡显示注入握手：pin 状态 / 实例 / pid，且不泄漏凭据', async () => {
    const { renderRemoteHubPage } = await loadPage()
    const tree = renderRemoteHubPage(baseState({ injection: INJECTED }), noopActions)
    const texts = collectText(tree)
    assert.ok(texts.includes('已注入'))
    assert.ok(texts.includes('hub_abc_123_xyz'))
    assert.ok(texts.includes('22800'))
    assert.equal(JSON.stringify(tree).includes('secret-pin'), false, '不得渲染凭据内容')
  })

  it('诊断卡显示最近一次管理请求与自动重试状态', async () => {
    const { renderRemoteHubPage } = await loadPage()
    const tree = renderRemoteHubPage(baseState({
      injection: INJECTED,
      diagnostic: {
        path: '/remote/devices', method: 'GET', origin: 'http://127.0.0.1:8443',
        pageOrigin: 'http://127.0.0.1:6406', status: 0, kind: 'preflight-failed', at: 1_000_000,
      },
      retry: { attempts: 3, nextRetryAt: 1_006_000 },
    }), noopActions)
    const texts = collectText(tree)
    assert.ok(texts.some(t => t.includes('/remote/devices')), '最近请求路径')
    assert.ok(texts.some(t => t.includes('preflight-failed')), '错误分类')
    assert.ok(texts.some(t => t.includes('第 3 次')), '重试次数')
  })

  it('describeGuardFailure 把各类错误翻译成可操作文案', async () => {
    const { describeGuardFailure } = await loadPage()
    assert.match(describeGuardFailure({ kind: 'missing-injection' }), /未注入/u)
    assert.match(describeGuardFailure({ kind: 'preflight-failed', path: '/remote/devices' }), /预检/u)
    assert.match(describeGuardFailure({ kind: 'cors-blocked' }), /Access-Control-Allow-Origin/u)
    assert.match(describeGuardFailure({ kind: 'http-403', path: '/remote/stats' }), /403/u)
    assert.match(describeGuardFailure(new Error('plain')), /plain/u)
  })
})

describe('carrier-contract 模式读取（fail-closed）', () => {
  it('损坏 JSON / 非 cloud 回落 local；cloud localStorage 仅是无令牌 hint', async () => {
    const { readCarrierMode, writeCarrierMode } = await import('../.build/host/core/src/carrier-contract.js')
    assert.equal(readCarrierMode(fakeStorage()).mode, 'local')
    const broken = fakeStorage()
    broken.setItem('remote-hub.mode', '{not json')
    assert.equal(readCarrierMode(broken).mode, 'local')
    const hintOnly = fakeStorage()
    writeCarrierMode({ mode: 'cloud', origin: 'http://x', token: 's'.repeat(32), deviceLabel: 'remote' }, hintOnly)
    const stored = JSON.parse(hintOnly.getItem('remote-hub.mode'))
    assert.equal(stored.token, undefined, 'bearer must not persist in browser localStorage')
    assert.deepEqual(readCarrierMode(hintOnly), { mode: 'cloud', origin: 'http://x', deviceLabel: 'remote' })
  })
})

async function loadPage() {
  try {
    return await import('../.build/client/client/src/panel/RemoteHubPage.js')
  } catch (error) {
    assert.fail(`RemoteHubPage 加载失败：${error.message}`)
  }
}
