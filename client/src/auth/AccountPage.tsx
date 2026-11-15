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

import type { AuthStatusResponse, PasswordPolicy, TrustedClientView } from '@core/auth.js'
import {
  PASSWORD_POLICIES,
  evaluatePassword,
  passwordRules,
} from '@core/auth.js'
import { ROLE_LABELS, ROLE_NAMES, type RoleName } from '@core/roles.js'

import type { ClientBinding } from './keyring.js'

/** 页面阶段。 */
export type AccountPhase = 'loading' | 'bootstrap' | 'login' | 'mfa' | 'change-password' | 'ready' | 'error'

/** 一个「对端账号」记录（本机作为控制端信任过的其它设备）。 */
export interface PeerAccountRow {
  id: string
  origin: string
  label?: string
  role?: string
  lastConnectedAt?: number
}

/** 页面状态。 */
export interface AccountPageState {
  phase: AccountPhase
  status: AuthStatusResponse | null
  /** 本浏览器的客户端绑定（null = 尚未信任本浏览器）。 */
  binding: ClientBinding | null
  /** 当前口令策略（设置页可切换，默认强密码）。 */
  policy: PasswordPolicy
  /** 对端账号（出站信任记录）——与本机账号是两套身份。 */
  peers: readonly PeerAccountRow[]
  /**
   * 待确认的提权：服务端拒绝把上限抬高（要求新鲜 2FA）时记录目标，
   * 页面显示「验证以提权」表单，验证通过后自动重试。
   */
  escalation: {
    clientId: string
    role: RoleName
    password: string
    code: string
    error: string | null
  } | null
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
  /** 提交改密（首次强制与主动修改共用）。 */
  onChangePassword(currentPassword: string, newPassword: string): void
  /** 切换口令策略。 */
  onSetPasswordPolicy(policy: PasswordPolicy): void
  /** 移除一条对端账号的信任记录（不影响本机账号）。 */
  onForgetPeer(targetId: string): void
  /** 提权前的重新验证：输入字段变更。 */
  onEscalationChange(field: 'password' | 'code', value: string): void
  /** 提交「验证并提权」。 */
  onEscalationSubmit(): void
  /** 放弃提权。 */
  onEscalationCancel(): void
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
  currentPassword: string
  newPassword: string
}

/** 初始草稿。 */
export function initialDraft(): AccountFormDraft {
  return {
    username: '',
    password: '',
    code: '',
    label: '本浏览器',
    ceiling: 'control',
    currentPassword: '',
    newPassword: '',
  }
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

/** 口令表单字段（强制改密与主动修改共用）。 */
function passwordFields(
  draft: AccountFormDraft,
  setDraft: (next: AccountFormDraft) => void,
): React.ReactNode {
  return React.createElement(React.Fragment, null,
    React.createElement('label', { style: labelStyle }, '当前口令'),
    React.createElement('input', {
      'data-testid': 'current-password',
      type: 'password',
      style: fieldStyle,
      value: draft.currentPassword,
      autoComplete: 'current-password',
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, currentPassword: event.currentTarget.value }),
    }),
    React.createElement('label', { style: labelStyle }, '新口令（至少 8 位，且不同于当前口令）'),
    React.createElement('input', {
      'data-testid': 'new-password',
      type: 'password',
      style: fieldStyle,
      value: draft.newPassword,
      autoComplete: 'new-password',
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, newPassword: event.currentTarget.value }),
    }))
}

/**
 * 口令规则清单（标准输入提示）：逐条显示是否满足，并标注当前策略。
 *
 * 判定与 Host 完全同源（`@core/auth` 的 `evaluatePassword`），不会出现
 * 「前端说可以、后端拒绝」。
 */
function passwordChecklist(
  draft: AccountFormDraft,
  policy: PasswordPolicy,
  username: string,
): React.ReactNode {
  const verdict = evaluatePassword(draft.newPassword, policy, username)
  const failed = new Set(verdict.failures)
  return React.createElement('ul', {
    'data-testid': 'password-rules',
    'data-policy': policy,
    'aria-live': 'polite',
    style: { listStyle: 'none', padding: 0, margin: '8px 0 0', fontSize: 12, lineHeight: 1.7 },
  }, passwordRules(policy).map(rule => {
    const ok = !failed.has(rule.id)
    return React.createElement('li', {
      key: rule.id,
      'data-rule': rule.id,
      'data-ok': ok ? 'true' : 'false',
      style: {
        color: ok
          ? 'var(--dsw-alias-state-success-primary, #3fb950)'
          : 'var(--dsw-alias-text-tertiary, #8b949e)',
      },
    }, `${ok ? '✓' : '○'} ${rule.zh}`)
  }))
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
      React.createElement('label', { style: labelStyle }, '口令'),
      React.createElement('input', {
        'data-testid': 'bootstrap-password',
        type: 'password',
        style: fieldStyle,
        value: draft.password,
        autoComplete: 'new-password',
        onChange: event => setDraft({ ...draft, password: event.currentTarget.value }),
      }),
      passwordChecklist(
        { ...draft, newPassword: draft.password },
        state.policy,
        draft.username.trim(),
      ),
      React.createElement('button', {
        type: 'button',
        'data-testid': 'bootstrap-submit',
        disabled: state.busy || draft.username.trim() === ''
          || !evaluatePassword(draft.password, state.policy, draft.username.trim()).ok,
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

  if (state.phase === 'change-password') {
    const verdict = evaluatePassword(draft.newPassword, state.policy, status?.username ?? '')
    const valid = draft.currentPassword !== ''
      && verdict.ok
      && draft.newPassword !== draft.currentPassword
    return React.createElement('div', { 'data-testid': 'account-page', 'data-phase': 'change-password' },
      header,
      React.createElement('p', { 'data-testid': 'change-password-required', style: { fontSize: 12.5 } },
        '这是首次登录，必须先修改初始口令才能继续（只需一次）。改完才能绑定 2FA、信任浏览器与访问 Hub。'),
      passwordFields(draft, setDraft),
      React.createElement('button', {
        type: 'button',
        'data-testid': 'change-password-submit',
        disabled: state.busy || !valid,
        onClick: () => actions.onChangePassword(draft.currentPassword, draft.newPassword),
        style: { ...primaryStyle, marginTop: 14 },
      }, state.busy ? '提交中…' : '保存新口令'),
      passwordChecklist(draft, state.policy, status?.username ?? ''),
      state.notice === null ? null : React.createElement('p', {
        role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary, #f85149)', fontSize: 12.5 },
      }, state.notice))
  }

  // ready
  const clients = status?.clients ?? []
  const active = clients.filter(client => client.revokedAt === null)
  // 兼容早期调用方（未提供该字段即视为无待确认提权）。
  const escalation = state.escalation ?? null
  return React.createElement('div', { 'data-testid': 'account-page', 'data-phase': 'ready' },
    header,
    // 两套账号必须分开显示：本机账号决定「谁能登录这台机器」，
    // 对端账号是本机作为控制端在别的机器上建立的信任。
    React.createElement('section', { 'data-testid': 'local-account', style: { marginBottom: 16 } },
      React.createElement('strong', { style: { fontSize: 13, display: 'block', marginBottom: 6 } }, '本机账号（这台 DSH）'),
      React.createElement('p', { style: { fontSize: 12, color: 'var(--dsw-alias-text-tertiary, #8b949e)', margin: '0 0 8px' } },
        '用于登录这台机器的 DSH Web 与设置页；双因素与口令策略都作用于它。'),
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

    React.createElement('section', {
      'data-testid': 'password-policy-section',
      style: { marginBottom: 16, padding: 10, border: '1px solid var(--dsw-alias-border-l2, #30363d)', borderRadius: 10 },
    },
    React.createElement('strong', { style: { fontSize: 13 } }, '口令策略'),
    React.createElement('p', { style: { fontSize: 12.5, color: 'var(--dsw-alias-text-tertiary, #8b949e)', margin: '4px 0 8px' } },
      '默认仅允许强密码。切换后立即生效：之后设置/修改口令都按新规则校验（已有口令不受影响）。'),
    React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
      PASSWORD_POLICIES.map(policy => React.createElement('button', {
        key: policy,
        type: 'button',
        'data-testid': `policy-${policy}`,
        'data-selected': state.policy === policy ? 'true' : 'false',
        'aria-pressed': state.policy === policy ? 'true' : 'false',
        disabled: state.busy,
        onClick: () => actions.onSetPasswordPolicy(policy),
        style: state.policy === policy ? primaryStyle : buttonStyle,
      }, policy === 'strong' ? '仅允许强密码（推荐）' : '允许基础口令')))),

    React.createElement('section', {
      'data-testid': 'change-password-section',
      style: { marginBottom: 16, padding: 10, border: '1px solid var(--dsw-alias-border-l2, #30363d)', borderRadius: 10 },
    },
    React.createElement('strong', { style: { fontSize: 13 } }, '修改口令'),
    passwordFields(draft, setDraft),
    React.createElement('button', {
      type: 'button',
      'data-testid': 'change-password-apply',
      disabled: state.busy || draft.currentPassword === ''
        || draft.newPassword === draft.currentPassword
        || !evaluatePassword(draft.newPassword, state.policy, status?.username ?? '').ok,
      onClick: () => actions.onChangePassword(draft.currentPassword, draft.newPassword),
      style: { ...buttonStyle, marginTop: 10 },
    }, '保存新口令'),
    passwordChecklist(draft, state.policy, status?.username ?? '')),

    React.createElement('section', { style: { marginTop: 18 } },
      React.createElement('strong', { style: { fontSize: 13 } }, `本机已信任的客户端（${active.length}）`),
      React.createElement('p', { style: { fontSize: 12, color: 'var(--dsw-alias-text-tertiary, #8b949e)', margin: '4px 0 8px' } },
        '这些客户端被允许用本机账号访问 Hub；与下面的对端账号是两套身份。'),
      clients.length === 0
        ? React.createElement('p', { 'data-testid': 'clients-empty', style: { fontSize: 12.5, color: 'var(--dsw-alias-text-tertiary, #8b949e)' } },
          '还没有受信客户端。信任本浏览器后即可免重复 2FA 访问 Hub。')
        : React.createElement('div', { 'data-testid': 'clients-list', style: { marginTop: 8 } },
          clients.map(client => renderClientRow(client, state, actions)))),

    escalation === null ? null : React.createElement('section', {
      'data-testid': 'escalation',
      style: {
        marginTop: 18,
        border: '1px solid var(--dsw-alias-state-warning-primary, #d29922)',
        borderRadius: 10,
        padding: '12px 14px',
      },
    },
    React.createElement('strong', { style: { fontSize: 13, display: 'block' } }, '提升权限需要重新验证'),
    React.createElement('p', { style: { fontSize: 12, color: 'var(--dsw-alias-text-tertiary, #8b949e)', margin: '4px 0 8px' } },
      `把客户端上限提升到「${roleLabel(escalation.role)}」需要重新输入口令与 2FA 验证码；`
      + '重新验证只刷新本次登录的 2FA 窗口，不会签发新会话。'),
    React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
      React.createElement('input', {
        type: 'password',
        'data-testid': 'escalation-password',
        placeholder: '当前口令',
        value: escalation.password,
        disabled: state.busy,
        autoComplete: 'current-password',
        onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
          actions.onEscalationChange('password', event.currentTarget.value),
        style: { ...buttonStyle, flex: '1 1 180px', padding: '8px 10px' },
      }),
      React.createElement('input', {
        type: 'text',
        inputMode: 'numeric',
        'data-testid': 'escalation-code',
        placeholder: '6 位验证码',
        value: escalation.code,
        disabled: state.busy,
        autoComplete: 'one-time-code',
        onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
          actions.onEscalationChange('code', event.currentTarget.value),
        style: { ...buttonStyle, width: 150, padding: '8px 10px' },
      })),
    escalation.error === null
      ? null
      : React.createElement('p', { 'data-testid': 'escalation-error', style: { fontSize: 12, margin: '6px 0 0', color: 'var(--dsw-alias-state-error-primary, #f85149)' } },
        escalation.error),
    React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
      React.createElement('button', {
        type: 'button',
        'data-testid': 'escalation-submit',
        disabled: state.busy || escalation.password === '' || escalation.code === '',
        onClick: () => actions.onEscalationSubmit(),
        style: buttonStyle,
      }, '验证并提升'),
      React.createElement('button', {
        type: 'button',
        'data-testid': 'escalation-cancel',
        onClick: () => actions.onEscalationCancel(),
        style: buttonStyle,
      }, '取消'))),

    React.createElement('section', { 'data-testid': 'peer-accounts', style: { marginTop: 18 } },
      React.createElement('strong', { style: { fontSize: 13, display: 'block' } }, `对端账号（${state.peers.length}）`),
      React.createElement('p', { style: { fontSize: 12, color: 'var(--dsw-alias-text-tertiary, #8b949e)', margin: '4px 0 8px' } },
        '本机作为控制端，在其它设备上建立过的信任。用的是**对端**的账号；与本机账号互不影响。'),
      state.peers.length === 0
        ? React.createElement('p', { 'data-testid': 'peers-empty', style: { fontSize: 12.5, color: 'var(--dsw-alias-text-tertiary, #8b949e)' } },
          '还没有对端账号。在「云端设备 → 连接其他设备」里用对端账号登录并信任本机会出现在这里。')
        : React.createElement('div', { style: { marginTop: 8 } },
          state.peers.map(peer => React.createElement('div', {
            key: peer.id,
            'data-testid': 'peer-account',
            'data-origin': peer.origin,
            style: {
              border: '1px solid var(--dsw-alias-border-l2, #30363d)',
              borderRadius: 10,
              padding: '10px 12px',
              marginBottom: 8,
            },
          },
          React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
            React.createElement('strong', { style: { fontSize: 13 } }, peer.label ?? peer.origin),
            React.createElement('code', { style: { fontSize: 11, color: 'var(--dsw-alias-text-tertiary, #8b949e)' } }, peer.origin),
            peer.role === undefined
              ? null
              : React.createElement('span', { style: { fontSize: 11.5, color: 'var(--dsw-alias-text-tertiary, #8b949e)' } },
                `角色 ${peer.role}`)),
          React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' } },
            React.createElement('span', { style: { fontSize: 11.5, color: 'var(--dsw-alias-text-tertiary, #8b949e)' } },
              peer.lastConnectedAt === undefined ? '从未连接' : `最近连接 ${new Date(peer.lastConnectedAt).toLocaleString()}`),
            React.createElement('button', {
              type: 'button',
              'data-testid': 'forget-peer',
              disabled: state.busy,
              onClick: () => actions.onForgetPeer(peer.id),
              style: { ...buttonStyle, color: 'var(--dsw-alias-state-error-primary, #f85149)' },
            }, '移除信任')))))),
    state.notice === null ? null : React.createElement('p', { 'data-testid': 'account-notice', style: { fontSize: 12.5 } }, state.notice))
}
