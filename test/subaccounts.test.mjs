/**
 * 区块 G（子账号管理）+ 归属账号 + TOTP 绑定二维码。
 *
 * 依据 `dev/ui-redesign/plan-optimization.md §3 / §7 / §9.3` 与
 * `plan-settings.md §2.7 G`：
 * - 区块 G 只对 admin 会话渲染；子账号视角**不存在该区块**（不是 disabled）；
 * - 新建 → 一次性口令只显示一次；禁用/删除/调上限走行内 2FA；删除有二次确认；
 * - 客户端行显示「账号 <username>」；设备行同源字段；
 * - TOTP 绑定时渲染二维码（`totp-qr`），`totp-secret` / `totp-otpauth` 保留。
 *
 * @module test/subaccounts.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

import { registerAlias } from './panel-alias-loader.mjs'

await registerAlias()

const CORE_FILES = ['index', 'protocol', 'auth', 'roles', 'device', 'capabilities', 'capabilities-redlines', 'version-drift', 'redact', 'carrier-contract']
const RHUI_FILES = ['index', 'tokens', 'components', 'format', 'qr-code', 'i18n']
/** `rhui/i18n.js` 的双语字典（相对 `rhui/locales/`）。 */
const RHUI_LOCALE_FILES = ['zh-CN', 'en']

/**
 * 把 `.build/client` 的 AccountPage 与它的相对依赖镜像到临时目录后加载
 * （与 `auth-client.test.mjs` 同一手法，避免在 node 里解析 .tsx）。
 * @returns 模块命名空间。
 */
async function loadAccountPage() {
  const staging = new URL('../.build/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1')
  const directory = join(staging, `tmp-subaccounts-${process.pid}-${Date.now()}`)
  const coreDir = join(directory, 'core', 'src')
  await mkdir(coreDir, { recursive: true })
  for (const name of CORE_FILES) {
    try {
      await writeFile(join(coreDir, `${name}.js`),
        await readFile(new URL(`../.build/client/core/src/${name}.js`, import.meta.url), 'utf8'), 'utf8')
    } catch { /* 可选 core 文件缺失时跳过 */ }
  }
  const rewrite = (text, prefix) => text.replace(/from '@core\/([^']+)'/gu, (_m, rest) => `from '${prefix}/${rest}'`)
  const mirror = async (relative) => {
    const source = await readFile(new URL(`../.build/client/client/src/${relative}`, import.meta.url), 'utf8')
    const depth = relative.split('/').length - 1
    const target = join(directory, relative)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, rewrite(source, `${'../'.repeat(depth)}core/src`), 'utf8')
  }
  for (const name of RHUI_FILES) await mirror(`rhui/${name}.js`)
  // i18n 的字典拆在 `rhui/locales/` 下，单独镜像（否则 `rhui/i18n.js` 解析失败）。
  for (const name of RHUI_LOCALE_FILES) await mirror(`rhui/locales/${name}.js`)
  await mirror('panel/qr.js')
  await mirror('auth/AccountPage.js')
  return import(pathToFileURL(join(directory, 'auth', 'AccountPage.js')).href)
}

const page = await loadAccountPage()
const { renderToStaticMarkup } = await import('react-dom/server')

/** 渲染成 HTML 字符串。 */
async function render(state, actions = {}) {
  const merged = {
    onSubmitBootstrap() {}, onSubmitLogin() {}, onSubmitMfa() {}, onChangePassword() {},
    onSetPasswordPolicy() {}, onForgetPeer() {}, onEscalationChange() {}, onEscalationSubmit() {},
    onEscalationCancel() {}, onStartTotp() {}, onTotpChange() {}, onConfirmTotp() {}, onDisableTotp() {},
    onCancelTotp() {}, onTrustClient() {}, onRevokeClient() {}, onSetRole() {}, onSetCeiling() {},
    onLogout() {}, onRefresh() {},
    ...actions,
  }
  return renderToStaticMarkup(page.renderAccountPage(state, merged, page.initialDraft(), () => {}))
}

/**
 * 遍历 React 元素树，收集 `data-testid`。
 *
 * 为什么不只用 `renderToStaticMarkup` 的字符串：它会把 `ThemeStyle` 注入的
 * 4 万字符 CSS 一起序列化，断言既脆弱（CI 上曾截断）又可能误命中注释里的字样。
 * @param node - React 节点。
 * @param testid - 目标 testid。
 * @param out - 累加器。
 * @returns 匹配元素数组。
 */
function findByTestId(node, testid, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findByTestId(child, testid, out)
    return out
  }
  if (node.props === undefined) return out
  if (node.props['data-testid'] === testid) out.push(node)
  for (const key of Object.keys(node.props)) findByTestId(node.props[key], testid, out)
  return out
}

/**
 * 收集元素树里的可见文本（跳过样式表字符串）。
 * @param node - React 节点。
 * @param out - 累加器。
 * @returns 文本数组。
 */
function collectText(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    const text = String(node)
    if (!text.includes('--rh-') && text.length < 400) out.push(text)
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (node.props === undefined) return out
  for (const key of Object.keys(node.props)) collectText(node.props[key], out)
  return out
}

/** 空动作集（结构断言不触发副作用）。 */
function noopActions() {
  return {
    onSubmitBootstrap() {}, onSubmitLogin() {}, onSubmitMfa() {}, onChangePassword() {},
    onSetPasswordPolicy() {}, onForgetPeer() {}, onEscalationChange() {}, onEscalationSubmit() {},
    onEscalationCancel() {}, onStartTotp() {}, onTotpChange() {}, onConfirmTotp() {}, onDisableTotp() {},
    onCancelTotp() {}, onTrustClient() {}, onRevokeClient() {}, onSetRole() {}, onSetCeiling() {},
    onLogout() {}, onRefresh() {},
  }
}

/** 带子账号状态的基础 ready 状态。 */
function readyState(overrides = {}) {
  const base = {
    phase: 'ready',
    expanded: {
      'local-account': true,
      'trust-section': true,
      'totp-section': true,
      'password-policy-section': true,
      'clients-list': true,
      'peer-accounts': true,
      'sub-accounts': true,
    },
    policy: 'strong',
    peers: [],
    escalation: null,
    totp: null,
    totpDraft: { code: '', password: '' },
    binding: null,
    enrollment: null,
    notice: null,
    busy: false,
    mfaToken: null,
    subAccounts: {
      accounts: null,
      creating: false,
      draft: { username: '', password: '', roleCeiling: 'read-only' },
      created: null,
      pending: null,
      confirmingDelete: null,
      error: null,
    },
    status: {
      ready: true,
      bootstrapped: true,
      mfaEnabled: true,
      totpEnabled: true,
      username: 'admin',
      passwordPolicy: 'strong',
      session: {
        accountId: 'acc_admin', username: 'admin', role: 'admin',
        createdAt: new Date().toISOString(), expiresAt: Date.now() + 1000, lastMfaAt: Date.now(),
      },
      clients: [],
    },
  }
  return { ...base, ...overrides }
}

const SUB_ROWS = [
  {
    accountId: 'acc_ops', username: 'ops-admin', isAdmin: false, roleCeiling: 'control',
    disabledAt: null, lastLoginAt: Date.now() - 2 * 3600_000, createdAt: Date.now() - 86_400_000,
  },
  {
    accountId: 'acc_guest', username: 'guest-view', isAdmin: false, roleCeiling: 'read-only',
    disabledAt: Date.now() - 3600_000, lastLoginAt: null, createdAt: Date.now() - 86_400_000,
  },
]

test('区块 G 对 admin 渲染；子账号视角完全不渲染', async () => {
  const admin = await render(readyState({ subAccounts: { ...readyState().subAccounts, accounts: SUB_ROWS } }))
  assert.match(admin, /data-testid="sub-accounts"/u)
  assert.match(admin, /ops-admin/u)
  assert.match(admin, /guest-view/u)
  assert.match(admin, /data-testid="sub-account"/u)
  assert.match(admin, /data-testid="sub-account-disable"/u)
  assert.match(admin, /data-testid="sub-account-enable"/u)
  assert.match(admin, /data-testid="sub-account-delete"/u)

  const subscriber = readyState({ subAccounts: { ...readyState().subAccounts, accounts: SUB_ROWS } })
  subscriber.status = {
    ...subscriber.status,
    session: {
      accountId: 'acc_ops', username: 'ops-admin', role: 'control',
      createdAt: new Date().toISOString(), expiresAt: Date.now() + 1000, lastMfaAt: null,
    },
  }
  const markup = await render(subscriber)
  assert.doesNotMatch(markup, /data-testid="sub-accounts"/u, '子账号视角不得出现区块 G')
  // 本机账号区块会显示自己的用户名；但不能列出**其它**子账号。
  assert.match(markup, /当前账号：ops-admin/u, '自己的账号照常显示')
  assert.doesNotMatch(markup, /guest-view/u, '子账号视角不得出现其它子账号的用户名')
})

test('新建子账号：内联表单 → 一次性口令只显示一次', async () => {
  const creating = await render(readyState({
    subAccounts: {
      ...readyState().subAccounts,
      creating: true,
      draft: { username: 'ops-review', password: '', roleCeiling: 'read-only' },
    },
  }))
  assert.match(creating, /data-testid="sub-account-username"/u)
  assert.match(creating, /data-testid="sub-account-password-input"/u)
  assert.match(creating, /data-testid="sub-account-ceiling"/u)
  assert.match(creating, /data-testid="sub-account-create"/u)

  const created = await render(readyState({
    subAccounts: {
      ...readyState().subAccounts,
      created: { username: 'ops-review', initialPassword: 'Dsh-3f9a-A9!' },
    },
  }))
  assert.match(created, /data-testid="sub-account-password"/u)
  assert.match(created, /Dsh-3f9a-A9!/u)
  assert.match(created, /只显示这一次/u)
  assert.match(created, /我已保存/u)
})

test('禁用 / 删除 / 调上限：行内 2FA 与删除二次确认', async () => {
  const withAccount = (subAccounts) => readyState({
    subAccounts: { ...readyState().subAccounts, accounts: SUB_ROWS, ...subAccounts },
  })
  const disable = await render(withAccount({
    pending: { accountId: 'acc_ops', action: 'disable', password: '', code: '', error: null },
  }))
  assert.match(disable, /data-testid="sub-account-verify-password"/u)
  assert.match(disable, /data-testid="sub-account-verify-code"/u)
  assert.match(disable, /需要重新验证/u)

  const confirmDelete = await render(withAccount({ confirmingDelete: 'acc_guest' }))
  assert.match(confirmDelete, /data-testid="sub-account-confirm"/u)
  assert.match(confirmDelete, /不可恢复/u)

  const ceiling = await render(withAccount({
    pending: { accountId: 'acc_ops', action: 'ceiling', role: 'full', password: '', code: '', error: null },
  }))
  assert.match(ceiling, /data-testid="sub-account-new-ceiling"/u)
})

test('2FA 失败时错误显示在该行内（不是整页提示）', async () => {
  const markup = await render(readyState({
    subAccounts: {
      ...readyState().subAccounts,
      accounts: SUB_ROWS,
      pending: {
        accountId: 'acc_ops', action: 'disable', password: 'x', code: '123456',
        error: '该操作需要重新进行双因素验证',
      },
    },
  }))
  assert.match(markup, /该操作需要重新进行双因素验证/u)
})

test('客户端行显示归属账号；设备行同源字段（C2）', async () => {
  const clients = [{
    clientId: 'cli_1', keyId: 'k1', label: '本浏览器', clientType: 'browser', fingerprint: 'ab'.repeat(8),
    roleCeiling: 'full', activeRole: 'full', createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
    leaseExpiresAt: Date.now() + 86_400_000, leaseGeneration: 1, revokedAt: null,
    accountId: 'acc_admin', username: 'admin',
  }]
  const state = readyState({ status: { ...readyState().status, clients } })
  // ⚠️ 用元素树断言而不是 renderToStaticMarkup 的字符串：
  // 后者会把 4 万字符的样式表一起序列化，CI 上曾出现截断导致误报
  // （同一提交本地通过、CI 失败，而产品代码无误）。
  const tree = page.renderAccountPage(state, noopActions(), page.initialDraft(), () => {})
  const accountNode = findByTestId(tree, 'client-account')
  assert.equal(accountNode.length, 1, '客户端行必须有归属账号节点')
  assert.match(collectText(accountNode).join(' '), /账号 admin/u, '显示归属账号用户名')
})

test('TOTP 绑定渲染二维码（totp-qr），文本密钥与 otpauth 仍在（C3）', async () => {
  const otpauth = 'otpauth://totp/DSH:admin?secret=JBSWY3DPEHPK3PXP&issuer=DSH'
  const setup = await render(readyState({
    status: { ...readyState().status, totpEnabled: false },
    totp: { secret: 'JBSWY3DPEHPK3PXP', otpauth, backupCodes: ['a8f2-b4d9', 'c3e7-f5a1'] },
  }))
  assert.match(setup, /data-testid="totp-qr"/u, '必须渲染二维码容器')
  assert.match(setup, /<svg/u, '二维码必须是 SVG 矩阵')
  assert.match(setup, /data-testid="totp-secret"/u, '文本密钥必须保留（测试依赖）')
  assert.match(setup, /data-testid="totp-otpauth"/u, 'otpauth 文本必须保留')
  assert.match(setup, /data-testid="totp-backup-codes"/u)
  assert.match(setup, /data-testid="totp-confirm"/u)

  const enabled = await render(readyState({ status: { ...readyState().status, totpEnabled: true } }))
  assert.doesNotMatch(enabled, /data-testid="totp-qr"/u, '已启用后不再渲染绑定二维码')
})
