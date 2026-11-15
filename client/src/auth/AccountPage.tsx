/**
 * 「登录与账号」页：账号引导 / 口令 + MFA / 可信客户端管理 / 角色切换。
 *
 * 与 `RemoteHubPage` 的分工：
 * - 本页只做**身份**（谁在用什么客户端、信任了哪些设备、各自权限上限）；
 * - `RemoteHubPage` 仍是**运行面**（守卫状态、连接目标、隧道、诊断）。
 *
 * 纯渲染函数与组件分离（与仓库既有写法一致），便于测试直接断言 DOM 门控。
 *
 * @module dsh-remote-hub/client/auth/AccountPage
 */
import React from 'react'

import type { AuthStatusResponse, TrustedClientView } from '@core/auth.js'
import { ROLE_LABELS, ROLE_NAMES, type RoleName } from '@core/roles.js'

import type { ClientBinding } from './keyring.js'

/** 页面阶段。 */
export type AccountPhase = 'loading' | 'bootstrap' | 'login' | 'mfa' | 'ready' | 'error'

/** 页面状态。 */
export interface AccountPageState {
  phase: AccountPhase
  status: AuthStatusResponse | null
  /** 本浏览器的客户端绑定（null = 尚未信任本浏览器）。 */
  binding: ClientBinding | null
  /** 一次性引导结果（TOTP 密钥/链接/备用码）。 */
  enrollment: { otpauth: string; backupCodes: readonly string[] } | null
  /** 页面级提示（成功或失败）。 */
  notice: string | null
  busy: boolean
  /** MFA 挑战票据（第二步）。 */
  mfaToken: string | null
}

/** 页面动作。 */
export interface AccountPageActions {
  onSubmitBootstrap(username: string, password: string): void
  onSubmitLogin(username: string, password: string): void
  onSubmitMfa(code: string): void
  onTrustClient(label: string, ceiling: RoleName): void
  onRevokeClient(clientId: string): void
  onSetRole(clientId: string, role: RoleName): void
  onSetCeiling(clientId: string, role: RoleName): void
  onLogout(): void
  onRefresh(): void
}

/** 表单草稿（受控输入）。 */
export interface AccountFormDraft {
  username: string
  password: string
  code: string
  label: string
  ceiling: RoleName
}

/** 初始草稿。 */
export function initialDraft(): AccountFormDraft {
  return { username: '', password: '', code: '', label: '本浏览器', ceiling: 'control' }
}

const labelStyle: React.CSSProperties = { display: 'block', fontSize: 12, color: 'var(--dsw-alias-text-tertiary, #8b949e)', margin: '10px 0 4px' }
const fieldStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2, #30363d)',
  background: 'var(--dsw-alias-bg-layer-2, #0d1117)',
  color: 'inherit',
  fontSize: 13,
}
const buttonStyle: React.CSSProperties = {
  padding: '7px 14px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2, #30363d)',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 12.5,
}
const primaryStyle: React.CSSProperties = {
  ...buttonStyle,
  background: 'var(--dsw-alias-brand-primary, #4d6bfe)',
  borderColor: 'transparent',
  color: '#fff',
}

/** 角色显示名。 */
function roleLabel(role: RoleName): string {
  return ROLE_LABELS[role]?.zh ?? role
}

/** 一行客户端卡片。 */
function renderClientRow(
  client: TrustedClientView,
  state: AccountPageState,
  actions: AccountPageActions,
): React.ReactNode {
  const revoked = client.revokedAt !== null
  return React.createElement('div', {
    key: client.clientId,
    'data-testid': 'trusted-client',
    'data-client-id': client.clientId,
    'data-revoked': revoked ? 'true' : 'false',
    style: {
      border: '1px solid var(--dsw-alias-border-l2, #30363d)',
      borderRadius: 10,
      padding: '10px 12px',
      marginBottom: 8,
      opacity: revoked ? 0.55 : 1,
    },
  },
  React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
    React.createElement('strong', { style: { fontSize: 13 } }, client.label),
    React.createElement('code', {
      style: { fontSize: 11, color: 'var(--dsw-alias-text-tertiary, #8b949e)' },
      title: '公钥指纹（仅供人眼核对，不是认证凭据）',
    }, client.fingerprint),
    React.createElement('span', {
      'data-testid': 'client-role',
      style: { fontSize: 11.5, color: 'var(--dsw-alias-text-tertiary, #8b949e)' },
    }, `当前 ${roleLabel(client.activeRole)} / 上限 ${roleLabel(client.roleCeiling)}`),
    revoked ? React.createElement('span', { style: { fontSize: 11.5, color: 'var(--dsw-alias-state-error-primary, #f85149)' } }, '已撤销') : null),
  React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' } },
    React.createElement('select', {
      'data-testid': 'client-role-select',
      value: client.activeRole,
      disabled: revoked || state.busy,
      onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
        actions.onSetRole(client.clientId, event.currentTarget.value as RoleName)
      },
      style: { ...buttonStyle, padding: '5px 8px' },
    }, ROLE_NAMES.map(role => React.createElement('option', { key: role, value: role }, roleLabel(role)))),
    React.createElement('select', {
      'data-testid': 'client-ceiling-select',
      value: client.roleCeiling,
      disabled: revoked || state.busy,
      onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
        actions.onSetCeiling(client.clientId, event.currentTarget.value as RoleName)
      },
      style: { ...buttonStyle, padding: '5px 8px' },
    }, ROLE_NAMES.map(role => React.createElement('option', { key: role, value: role }, `上限 ${roleLabel(role)}`))),
    React.createElement('button', {
      type: 'button',
      'data-testid': 'revoke-client',
      disabled: revoked || state.busy,
      onClick: () => actions.onRevokeClient(client.clientId),
      style: { ...buttonStyle, color: 'var(--dsw-alias-state-error-primary, #f85149)' },
    }, '撤销此客户端')))
}

/**
 * 纯渲染。
 * @param state - 页面状态。
 * @param actions - 页面动作。
 * @param draft - 受控表单草稿。
 * @param setDraft - 草稿更新函数。
 * @returns React 节点。
 */
export function renderAccountPage(
  state: AccountPageState,
  actions: AccountPageActions,
  draft: AccountFormDraft,
  setDraft: (next: AccountFormDraft) => void,
): React.ReactNode {
  const status = state.status
  const session = status?.session ?? null

  const header = React.createElement('header', { style: { marginBottom: 12 } },
    React.createElement('h1', { 'data-testid': 'account-title', style: { fontSize: 18, margin: 0 } }, '登录与账号'),
    React.createElement('p', { style: { fontSize: 12.5, color: 'var(--dsw-alias-text-tertiary, #8b949e)', margin: '6px 0 0' } },
      '账号与双因素只用于建立信任；之后每个请求都由本客户端的私钥签名，7 天租约在后台自动轮换。'))

  if (state.phase === 'loading') {
    return React.createElement('div', { 'data-testid': 'account-page', 'data-phase': 'loading' },
      header,
      React.createElement('p', { 'data-testid': 'account-loading' }, '正在读取认证状态…'))
  }

  if (state.phase === 'error') {
    return React.createElement('div', { 'data-testid': 'account-page', 'data-phase': 'error' },
      header,
      React.createElement('p', { 'data-testid': 'account-error', role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary, #f85149)' } },
        state.notice ?? '认证服务不可用'),
      React.createElement('button', { type: 'button', onClick: () => actions.onRefresh(), style: buttonStyle }, '重试'))
  }

  if (state.phase === 'bootstrap') {
    return React.createElement('div', { 'data-testid': 'account-page', 'data-phase': 'bootstrap' },
      header,
      React.createElement('p', { 'data-testid': 'bootstrap-hint', style: { fontSize: 12.5 } },
        '还没有账号。首个管理员只能在本机（回环）创建；创建后请立即用认证器完成绑定。'),
      React.createElement('label', { style: labelStyle }, '用户名'),
      React.createElement('input', {
        'data-testid': 'bootstrap-username',
        style: fieldStyle,
        value: draft.username,
        autoComplete: 'username',
        onChange: event => setDraft({ ...draft, username: event.currentTarget.value }),
      }),
      React.createElement('label', { style: labelStyle }, '口令（至少 8 位）'),
      React.createElement('input', {
        'data-testid': 'bootstrap-password',
        type: 'password',
        style: fieldStyle,
        value: draft.password,
        autoComplete: 'new-password',
        onChange: event => setDraft({ ...draft, password: event.currentTarget.value }),
      }),
      React.createElement('button', {
        type: 'button',
        'data-testid': 'bootstrap-submit',
        disabled: state.busy || draft.username.trim() === '' || draft.password.length < 8,
        onClick: () => actions.onSubmitBootstrap(draft.username.trim(), draft.password),
        style: { ...primaryStyle, marginTop: 14 },
      }, state.busy ? '创建中…' : '创建管理员'))
  }

  if (state.phase === 'login') {
    return React.createElement('div', { 'data-testid': 'account-page', 'data-phase': 'login' },
      header,
      React.createElement('label', { style: labelStyle }, '用户名'),
      React.createElement('input', {
        'data-testid': 'login-username',
        style: fieldStyle,
        value: draft.username,
        autoComplete: 'username',
        onChange: event => setDraft({ ...draft, username: event.currentTarget.value }),
      }),
      React.createElement('label', { style: labelStyle }, '口令'),
      React.createElement('input', {
        'data-testid': 'login-password',
        type: 'password',
        style: fieldStyle,
        value: draft.password,
        autoComplete: 'current-password',
        onChange: event => setDraft({ ...draft, password: event.currentTarget.value }),
      }),
      React.createElement('button', {
        type: 'button',
        'data-testid': 'login-submit',
        disabled: state.busy || draft.username.trim() === '' || draft.password === '',
        onClick: () => actions.onSubmitLogin(draft.username.trim(), draft.password),
        style: { ...primaryStyle, marginTop: 14 },
      }, state.busy ? '登录中…' : '登录'),
      state.notice === null ? null : React.createElement('p', {
        'data-testid': 'login-notice',
        role: 'alert',
        style: { color: 'var(--dsw-alias-state-error-primary, #f85149)', fontSize: 12.5 },
      }, state.notice))
  }

  if (state.phase === 'mfa') {
    return React.createElement('div', { 'data-testid': 'account-page', 'data-phase': 'mfa' },
      header,
      React.createElement('p', { style: { fontSize: 12.5 } }, '请输入认证器中的 6 位动态码，或一个一次性备用码。'),
      React.createElement('label', { style: labelStyle }, '验证码'),
      React.createElement('input', {
        'data-testid': 'mfa-code',
        style: fieldStyle,
        value: draft.code,
        autoComplete: 'one-time-code',
        placeholder: '6 位验证码或备用码',
        onChange: event => setDraft({ ...draft, code: event.currentTarget.value }),
      }),
      React.createElement('button', {
        type: 'button',
        'data-testid': 'mfa-submit',
        disabled: state.busy || draft.code.trim() === '',
        onClick: () => actions.onSubmitMfa(draft.code.trim()),
        style: { ...primaryStyle, marginTop: 14 },
      }, state.busy ? '验证中…' : '验证'),
      state.notice === null ? null : React.createElement('p', {
        role: 'alert',
        style: { color: 'var(--dsw-alias-state-error-primary, #f85149)', fontSize: 12.5 },
      }, state.notice))
  }

  // ready
  const clients = status?.clients ?? []
  const active = clients.filter(client => client.revokedAt === null)
  return React.createElement('div', { 'data-testid': 'account-page', 'data-phase': 'ready' },
    header,
    React.createElement('section', { style: { marginBottom: 16 } },
      React.createElement('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
        React.createElement('span', { 'data-testid': 'account-user', style: { fontSize: 13 } },
          `当前账号：${session?.username ?? status?.username ?? '—'}`),
        React.createElement('span', { 'data-testid': 'account-client', style: { fontSize: 12, color: 'var(--dsw-alias-text-tertiary, #8b949e)' } },
          state.binding === null ? '本浏览器尚未受信' : `本浏览器已受信 · ${state.binding.clientId.slice(0, 12)}…`),
        React.createElement('button', { type: 'button', 'data-testid': 'account-refresh', onClick: () => actions.onRefresh(), style: buttonStyle }, '刷新'),
        React.createElement('button', { type: 'button', 'data-testid': 'account-logout', onClick: () => actions.onLogout(), style: buttonStyle }, '退出登录')),
      state.enrollment === null ? null : React.createElement('div', {
        'data-testid': 'enrollment-secret',
        style: { marginTop: 10, padding: 10, border: '1px dashed var(--dsw-alias-border-l2, #30363d)', borderRadius: 8, fontSize: 12 },
      },
      React.createElement('div', null, '用认证器添加这个账号：'),
      React.createElement('code', { style: { display: 'block', wordBreak: 'break-all', margin: '6px 0' } }, state.enrollment.otpauth),
      React.createElement('div', null, `备用码（只显示这一次）：${state.enrollment.backupCodes.join('  ')}`))),

    state.binding === null
      ? React.createElement('section', {
        'data-testid': 'trust-section',
        style: { marginBottom: 16, padding: 10, border: '1px solid var(--dsw-alias-border-l2, #30363d)', borderRadius: 10 },
      },
      React.createElement('strong', { style: { fontSize: 13 } }, '信任本浏览器'),
      React.createElement('p', { style: { fontSize: 12.5, color: 'var(--dsw-alias-text-tertiary, #8b949e)' } },
        '信任会把本浏览器的公钥登记到目标 Host；之后访问 Hub 由私钥签名，不再重复输入 2FA。'),
      React.createElement('label', { style: labelStyle }, '客户端名称'),
      React.createElement('input', {
        'data-testid': 'trust-label',
        style: fieldStyle,
        value: draft.label,
        onChange: event => setDraft({ ...draft, label: event.currentTarget.value }),
      }),
      React.createElement('label', { style: labelStyle }, '允许的最高权限'),
      React.createElement('select', {
        'data-testid': 'trust-ceiling',
        style: fieldStyle,
        value: draft.ceiling,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setDraft({ ...draft, ceiling: event.currentTarget.value as RoleName }),
      }, ROLE_NAMES.map(role => React.createElement('option', { key: role, value: role }, roleLabel(role)))),
      React.createElement('button', {
        type: 'button',
        'data-testid': 'trust-submit',
        disabled: state.busy || draft.label.trim() === '',
        onClick: () => actions.onTrustClient(draft.label.trim(), draft.ceiling),
        style: { ...primaryStyle, marginTop: 12 },
      }, state.busy ? '登记中…' : '信任本浏览器'))
      : null,

    React.createElement('section', null,
      React.createElement('strong', { style: { fontSize: 13 } }, `已信任的客户端（${active.length}）`),
      clients.length === 0
        ? React.createElement('p', { 'data-testid': 'clients-empty', style: { fontSize: 12.5, color: 'var(--dsw-alias-text-tertiary, #8b949e)' } },
          '还没有受信客户端。信任本浏览器后即可免重复 2FA 访问 Hub。')
        : React.createElement('div', { 'data-testid': 'clients-list', style: { marginTop: 8 } },
          clients.map(client => renderClientRow(client, state, actions)))),
    state.notice === null ? null : React.createElement('p', { 'data-testid': 'account-notice', style: { fontSize: 12.5 } }, state.notice))
}
