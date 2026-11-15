/**
 * 「登录与账号」页：账号引导 / 口令 + MFA / 可信客户端管理 / 角色切换。
 *
 * 与 `RemoteHubPage` 的分工：
 * - 本页只做**身份**（谁在用什么客户端、信任了哪些设备、各自权限上限）；
 * - `RemoteHubPage` 仍是**运行面**（守卫状态、连接目标、诊断）。
 *
 * 视觉基线：`dev/ui-redesign/design-system.md`（`--rh-*` token + `client/src/rhui` 公共组件）。
 * 状态矩阵与分区（A–F）见 `dev/ui-redesign/plan-settings.md`；`data-testid` 清单
 * （§5）是测试契约，**不得改名或删除**（`test/auth-client.test.mjs` 断言它们）。
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
import { ROLE_NAMES, type RoleName } from '@core/roles.js'

import {
  Button,
  CodeBox,
  Collapse,
  Field,
  Input,
  PasswordInput,
  Notice,
  Pill,
  Section,
  Segmented,
  Select,
  Skeleton,
  ThemeStyle,
  cx,
  formatRelative,
  formatRole,
  roleOptionLabel,
} from '../rhui/index.js'
import { RH_CSS } from '../rhui/tokens.js'
import type { ClientBinding } from './keyring.js'

/** 页面阶段（`data-phase` 的取值）。 */
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
  /** TOTP 绑定流程中的一次性材料（start 之后、确认之前）。 */
  totp: { secret: string; otpauth: string; backupCodes: readonly string[] } | null
  /** TOTP 表单草稿（确认码 / 关闭时所需口令）。 */
  totpDraft: { code: string; password: string }
  /**
   * 待确认的提权：服务端拒绝把上限抬高（要求新鲜 2FA）时记录目标，
   * 页面在该客户端行内展开验证区，验证通过后自动重试。
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
  /** 开始绑定两步验证（返回一次性密钥）。 */
  onStartTotp(): void
  /** 修改 TOTP 表单草稿。 */
  onTotpChange(field: 'code' | 'password', value: string): void
  /** 用 6 位码确认绑定。 */
  onConfirmTotp(): void
  /** 关闭两步验证（口令 + 动态码）。 */
  onDisableTotp(): void
  /** 取消绑定流程。 */
  onCancelTotp(): void
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

/** 页头副标题（所有阶段共用）。 */
const LEAD = '管理本机 DSH 的登录、安全策略与设备信任；之后每个请求都由本客户端的私钥签名，7 天租约自动轮换。'

/**
 * 页头：`account-title` 始终存在（`plan-settings.md §5`）。
 * @param title - 主标题。
 * @returns 页头节点。
 */
function pageHead(title = '登录与账号'): React.ReactElement {
  return React.createElement('header', { className: 'rh-page-head' },
    React.createElement('h1', { className: 'rh-h1', 'data-testid': 'account-title' }, title),
    React.createElement('p', { className: 'rh-lead' }, LEAD))
}

/** 页面根容器：注入 token 样式表 + `data-testid="account-page"`。 */
function pageRoot(
  phase: AccountPhase,
  children: React.ReactNode,
  options: { narrow?: boolean; theme?: 'dark' | 'light' } = {},
): React.ReactElement {
  return React.createElement('div', {
    className: cx('rh-root', 'rh-embed'),
    'data-testid': 'account-page',
    'data-phase': phase,
    'data-rh-scope': '',
    ...(options.theme === undefined ? {} : { 'data-theme': options.theme }),
  },
  ThemeStyle(RH_CSS),
  React.createElement('div', { className: cx('rh-shell', options.narrow !== false && 'rh-narrow') }, children))
}

/**
 * 口令规则清单（标准输入提示）：逐条显示是否满足，并标注当前策略。
 *
 * 判定与 Host 完全同源（`@core/auth` 的 `evaluatePassword`），不会出现
 * 「前端说可以、后端拒绝」。
 * @param value - 待校验的新口令。
 * @param policy - 当前口令策略。
 * @param username - 账号名（用于「不得包含用户名」规则）。
 * @param testId - 清单容器的 testid（设置页为 `password-rules`）。
 * @returns 清单节点。
 */
function passwordChecklist(
  value: string,
  policy: PasswordPolicy,
  username: string,
  testId = 'password-rules',
): React.ReactElement {
  const verdict = evaluatePassword(value, policy, username)
  const failed = new Set(verdict.failures)
  return React.createElement('ul', {
    'data-testid': testId,
    'data-policy': policy,
    'aria-live': 'polite',
    className: 'rh-rules',
  }, passwordRules(policy).map(rule => {
    const ok = !failed.has(rule.id)
    return React.createElement('li', {
      key: rule.id,
      'data-rule': rule.id,
      'data-ok': ok ? 'true' : 'false',
    }, `${ok ? '✓' : '○'} ${rule.zh}`)
  }))
}

/** 口令表单字段（强制改密与主动修改共用；testid 固定）。 */
function passwordFields(
  draft: AccountFormDraft,
  setDraft: (next: AccountFormDraft) => void,
): React.ReactNode {
  return React.createElement(React.Fragment, null,
    React.createElement(Field, {
      label: '当前口令',
      children: React.createElement(PasswordInput, {
        'data-testid': 'current-password',
        type: 'password',
        autoComplete: 'current-password',
        value: draft.currentPassword,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, currentPassword: event.currentTarget.value }),
      }),
    }),
    React.createElement(Field, {
      label: '新口令',
      hint: '至少 8 位，且不同于当前口令',
      children: React.createElement(PasswordInput, {
        'data-testid': 'new-password',
        type: 'password',
        autoComplete: 'new-password',
        value: draft.newPassword,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, newPassword: event.currentTarget.value }),
      }),
    }))
}

/**
 * 一行可信客户端（区块 E）。
 *
 * 行内状态：活跃 → 绿色左边条；离线 → 灰色；已撤销 → `opacity .45` + 红色边条
 * （`plan-settings.md §2.7 E`）。抬上限被要求新鲜 2FA 时，**该行内**展开验证区。
 * @param client - 客户端视图。
 * @param state - 页面状态。
 * @param actions - 页面动作。
 * @returns 行节点。
 */
function renderClientRow(
  client: TrustedClientView,
  state: AccountPageState,
  actions: AccountPageActions,
): React.ReactElement {
  const revoked = client.revokedAt !== null
  const escalation = state.escalation ?? null
  const pending = escalation !== null && escalation.clientId === client.clientId
  const online = !revoked && client.lastSeenAt !== null
  return React.createElement('div', {
    key: client.clientId,
    'data-testid': 'trusted-client',
    'data-client-id': client.clientId,
    'data-revoked': revoked ? 'true' : 'false',
    className: cx('rh-item', revoked ? 'is-disabled is-error' : online ? '' : 'is-offline'),
  },
  React.createElement('div', { className: 'rh-item-head' },
    React.createElement('span', { className: 'rh-item-name' }, typeIcon(client.clientType), ' ', client.label),
    revoked
      ? React.createElement(Pill, { tone: 'error', children: '已撤销' })
      : React.createElement(Pill, { tone: online ? 'online' : 'offline', dot: true, children: online ? '在线' : '离线' }),
    React.createElement(Pill, { tone: 'purple', children: formatRole(client.activeRole) }),
    React.createElement('span', {
      'data-testid': 'client-role',
      className: 'rh-pill',
    }, `当前 ${formatRole(client.activeRole)} / 上限 ${formatRole(client.roleCeiling)}`)),
  React.createElement('p', { className: 'rh-meta' },
    `指纹 `,
    React.createElement('code', {
      className: 'rh-inline-code',
      title: '公钥指纹（仅供人眼核对，不是认证凭据）',
    }, client.fingerprint),
    ' · ',
    client.lastSeenAt === null ? '从未活跃' : `最近活跃 ${formatRelative(client.lastSeenAt, Date.now())}`,
    ' · ',
    client.leaseExpiresAt === null || client.leaseExpiresAt === undefined
      ? '无租约'
      : `租约 ${formatRelative(client.leaseExpiresAt, Date.now()).replace('前', '后')}到期`),
  React.createElement('div', { className: 'rh-item-actions' },
    React.createElement(Select, {
      'data-testid': 'client-role-select',
      ariaLabel: `客户端 ${client.label} 的当前角色`,
      value: client.activeRole,
      disabled: revoked || state.busy,
      options: ROLE_NAMES.map(role => ({ value: role, label: roleOptionLabel(role) })),
      onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
        actions.onSetRole(client.clientId, event.currentTarget.value as RoleName)
      },
    }),
    React.createElement(Select, {
      'data-testid': 'client-ceiling-select',
      ariaLabel: `客户端 ${client.label} 的权限上限`,
      value: client.roleCeiling,
      disabled: revoked || state.busy,
      options: ROLE_NAMES.map(role => ({ value: role, label: `上限 ${roleOptionLabel(role)}` })),
      onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
        actions.onSetCeiling(client.clientId, event.currentTarget.value as RoleName)
      },
    }),
    React.createElement(Button, {
      'data-testid': 'revoke-client',
      variant: 'danger',
      size: 'small',
      disabled: revoked || state.busy,
      title: `撤销客户端 ${client.label}`,
      children: '撤销信任',
      onClick: () => actions.onRevokeClient(client.clientId),
    })),
  pending
    ? React.createElement('div', { className: 'rh-inline-panel', 'data-testid': 'escalation' },
      React.createElement('div', { className: 'rh-cfg-title' }, '提升权限需要重新验证'),
      React.createElement('p', { className: 'rh-cfg-desc' },
        `把客户端上限提升到「${formatRole(escalation.role)}」需要重新输入口令与 2FA 验证码；`
        + '重新验证只刷新本次登录的 2FA 窗口，不会签发新会话。'),
      React.createElement('div', { className: 'rh-row', style: { marginTop: 8 } },
        React.createElement(Input, {
          'data-testid': 'escalation-password',
          type: 'password',
          autoComplete: 'current-password',
          ariaLabel: '当前口令',
          value: escalation.password,
          disabled: state.busy,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
            actions.onEscalationChange('password', event.currentTarget.value),
        }),
        React.createElement(Input, {
          'data-testid': 'escalation-code',
          inputMode: 'numeric',
          autoComplete: 'one-time-code',
          ariaLabel: '6 位验证码',
          value: escalation.code,
          disabled: state.busy,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
            actions.onEscalationChange('code', event.currentTarget.value),
        })),
      escalation.error === null
        ? null
        : React.createElement('p', {
          'data-testid': 'escalation-error',
          className: 'rh-field-error',
          style: { margin: '6px 0 0' },
        }, escalation.error),
      React.createElement('div', { className: 'rh-row', style: { marginTop: 10 } },
        React.createElement(Button, {
          'data-testid': 'escalation-submit',
          variant: 'primary',
          size: 'small',
          disabled: state.busy || escalation.password === '' || escalation.code === '',
          children: '验证并提升',
          onClick: () => actions.onEscalationSubmit(),
        }),
        React.createElement(Button, {
          'data-testid': 'escalation-cancel',
          variant: 'ghost',
          size: 'small',
          children: '取消',
          onClick: () => actions.onEscalationCancel(),
        })))
    : null)
}

/** 客户端类型图标（`browser` 🖥 / `app` 📱 / `cli` ▮）。 */
function typeIcon(type: string): string {
  if (type === 'app') return '📱'
  if (type === 'cli') return '⌨'
  return '🖥'
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
  const username = session?.username ?? status?.username ?? ''

  if (state.phase === 'loading') {
    return pageRoot('loading', React.createElement(React.Fragment, null,
      pageHead(),
      React.createElement('section', { className: 'rh-card', 'data-testid': 'account-loading', 'aria-busy': 'true' },
        React.createElement(Skeleton, { lines: 3 }))))
  }

  if (state.phase === 'error') {
    return pageRoot('error', React.createElement(React.Fragment, null,
      pageHead(),
      React.createElement(Notice, { tone: 'error', children: React.createElement('span', { 'data-testid': 'account-error' }, state.notice ?? '认证服务不可用') }),
      React.createElement(Button, { variant: 'primary', children: '重试', onClick: () => actions.onRefresh() })))
  }

  if (state.phase === 'bootstrap') {
    return pageRoot('bootstrap', React.createElement(React.Fragment, null,
      pageHead('创建管理员账号'),
      React.createElement(Notice, {
        'data-testid': 'bootstrap-hint',
        tone: 'info',
        children: '还没有账号。首个管理员只能在本机（回环）创建；创建后请立即用认证器完成绑定。',
      }),
      React.createElement(Section, {
        title: '首个管理员',
        desc: '设置用户名与口令。口令策略作用于之后所有账号。',
        children: React.createElement(React.Fragment, null,
          React.createElement(Field, {
            label: '用户名',
            htmlFor: 'rh-bootstrap-username',
            children: React.createElement(Input, {
              'data-testid': 'bootstrap-username',
              autoComplete: 'username',
              value: draft.username,
              name: 'rh-bootstrap-username',
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, username: event.currentTarget.value }),
            }),
          }),
          React.createElement(Field, {
            label: '口令',
            htmlFor: 'rh-bootstrap-password',
            children: React.createElement(PasswordInput, {
              'data-testid': 'bootstrap-password',
              type: 'password',
              autoComplete: 'new-password',
              value: draft.password,
              name: 'rh-bootstrap-password',
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, password: event.currentTarget.value }),
            }),
          }),
          passwordChecklist(draft.password, state.policy, draft.username.trim()),
          React.createElement(Button, {
            'data-testid': 'bootstrap-submit',
            variant: 'primary',
            block: true,
            loading: state.busy,
            disabled: draft.username.trim() === ''
              || !evaluatePassword(draft.password, state.policy, draft.username.trim()).ok,
            children: state.busy ? '创建中…' : '创建管理员',
            onClick: () => actions.onSubmitBootstrap(draft.username.trim(), draft.password),
          })),
      })))
  }

  if (state.phase === 'login') {
    return pageRoot('login', React.createElement(React.Fragment, null,
      pageHead('登录'),
      React.createElement(Section, {
        title: '欢迎回来',
        desc: '登录这台 DSH，继续管理设备与账号。',
        children: React.createElement(React.Fragment, null,
          React.createElement(Field, {
            label: '用户名',
            htmlFor: 'rh-login-username',
            children: React.createElement(Input, {
              'data-testid': 'login-username',
              autoComplete: 'username',
              value: draft.username,
              name: 'rh-login-username',
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, username: event.currentTarget.value }),
            }),
          }),
          React.createElement(Field, {
            label: '口令',
            htmlFor: 'rh-login-password',
            children: React.createElement(PasswordInput, {
              'data-testid': 'login-password',
              type: 'password',
              autoComplete: 'current-password',
              value: draft.password,
              error: state.notice !== null,
              name: 'rh-login-password',
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, password: event.currentTarget.value }),
            }),
          }),
          React.createElement(Button, {
            'data-testid': 'login-submit',
            variant: 'primary',
            block: true,
            loading: state.busy,
            disabled: draft.username.trim() === '' || draft.password === '',
            children: state.busy ? '登录中…' : '登录',
            onClick: () => actions.onSubmitLogin(draft.username.trim(), draft.password),
          }),
          state.notice === null
            ? null
            : React.createElement(Notice, { 'data-testid': 'login-notice', tone: 'error', children: state.notice })),
      })))
  }

  if (state.phase === 'mfa') {
    return pageRoot('mfa', React.createElement(React.Fragment, null,
      pageHead('两步验证'),
      React.createElement(Section, {
        title: '输入动态码',
        desc: '请输入认证器中的 6 位动态码，或一个一次性备用码。',
        children: React.createElement(React.Fragment, null,
          React.createElement(Field, {
            label: '验证码',
            htmlFor: 'rh-mfa-code',
            error: state.notice,
            children: React.createElement(Input, {
              'data-testid': 'mfa-code',
              inputMode: 'numeric',
              autoComplete: 'one-time-code',
              otp: true,
              value: draft.code,
              placeholder: '000000',
              maxLength: 6,
              error: state.notice !== null,
              autoFocus: true,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, code: event.currentTarget.value }),
            }),
          }),
          React.createElement(Button, {
            'data-testid': 'mfa-submit',
            variant: 'primary',
            block: true,
            loading: state.busy,
            disabled: draft.code.trim() === '',
            children: state.busy ? '验证中…' : '验证',
            onClick: () => actions.onSubmitMfa(draft.code.trim()),
          }),
          React.createElement(Collapse, {
            summary: '使用备用码',
            children: React.createElement('p', { className: 'rh-muted', style: { margin: 0 } },
              '把备用码填进上面的验证码框即可（格式 xxxx-xxxx）。'),
          })),
      })))
  }

  if (state.phase === 'change-password') {
    const verdict = evaluatePassword(draft.newPassword, state.policy, username)
    const valid = draft.currentPassword !== '' && verdict.ok && draft.newPassword !== draft.currentPassword
    return pageRoot('change-password', React.createElement(React.Fragment, null,
      pageHead('设置新口令'),
      React.createElement(Notice, {
        'data-testid': 'change-password-required',
        tone: 'warning',
        children: '这是首次登录，必须先修改初始口令才能继续（只需一次）。改完才能绑定 2FA、信任浏览器与访问 Hub。',
      }),
      React.createElement(Section, {
        title: '修改口令',
        desc: '仅这一次强制执行；之后可在本页随时修改。',
        children: React.createElement(React.Fragment, null,
          passwordFields(draft, setDraft),
          passwordChecklist(draft.newPassword, state.policy, username),
          React.createElement(Button, {
            'data-testid': 'change-password-submit',
            variant: 'primary',
            block: true,
            loading: state.busy,
            disabled: !valid,
            children: state.busy ? '提交中…' : '保存新口令',
            onClick: () => actions.onChangePassword(draft.currentPassword, draft.newPassword),
          }),
          state.notice === null ? null : React.createElement(Notice, { tone: 'error', children: state.notice })),
      })))
  }

  // ── ready：区块 A–F（plan-settings.md §2.7）────────────────────────────────
  const clients = status?.clients ?? []
  const active = clients.filter(client => client.revokedAt === null)
  const totpEnabled = status?.totpEnabled === true
  const totp = state.totp ?? null
  const totpDraft = state.totpDraft ?? { code: '', password: '' }
  const trusted = state.binding !== null

  const localAccount = React.createElement(Section, {
    'data-testid': 'local-account',
    title: '本机账号（这台 DSH）',
    desc: '用于登录这台机器的 DSH Web 与设置页；双因素与口令策略都作用于它。',
    actions: React.createElement(React.Fragment, null,
      React.createElement(Button, { 'data-testid': 'account-refresh', size: 'small', children: '刷新', onClick: () => actions.onRefresh() }),
      React.createElement(Button, { 'data-testid': 'account-logout', variant: 'ghost', size: 'small', children: '退出登录', onClick: () => actions.onLogout() })),
    children: React.createElement(React.Fragment, null,
      React.createElement('div', { className: 'rh-row' },
        React.createElement('span', { 'data-testid': 'account-user', className: 'rh-item-name' },
          `当前账号：${username === '' ? '—' : username}`),
        React.createElement(Pill, {
          tone: trusted ? 'online' : 'offline',
          dot: true,
          children: React.createElement('span', { 'data-testid': 'account-client' },
            trusted ? `本浏览器已受信 · ${state.binding?.clientId.slice(0, 12) ?? ''}…` : '本浏览器尚未受信'),
        })),
      state.enrollment === null
        ? null
        : React.createElement('div', { 'data-testid': 'enrollment-secret', style: { marginTop: 12 } },
          React.createElement(Notice, {
            tone: 'warning',
            children: React.createElement(React.Fragment, null,
              React.createElement('div', null, '用认证器添加这个账号：'),
              React.createElement(CodeBox, { style: { margin: '6px 0' }, children: state.enrollment.otpauth }),
              React.createElement('div', null, `备用码（只显示这一次）：${state.enrollment.backupCodes.join('  ')}`)),
          }))),
  })

  const trustSection = state.binding === null
    ? React.createElement(Section, {
      'data-testid': 'trust-section',
      title: '信任本浏览器',
      desc: '信任后访问 Hub 由私钥签名，不再重复输入两步验证码。',
      children: React.createElement(React.Fragment, null,
        totpEnabled
          ? null
          : React.createElement(Notice, { tone: 'warning', children: '请先绑定两步验证再信任浏览器。' }),
        React.createElement(Field, {
          label: '客户端名称',
          children: React.createElement(Input, {
            'data-testid': 'trust-label',
            value: draft.label,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, label: event.currentTarget.value }),
          }),
        }),
        React.createElement(Field, {
          label: '允许的最高权限',
          children: React.createElement(Segmented, {
            'data-testid': 'trust-ceiling',
            ariaLabel: '允许的最高权限',
            value: draft.ceiling,
            options: ROLE_NAMES.map(role => ({ value: role, label: roleOptionLabel(role) })),
            onChange: value => setDraft({ ...draft, ceiling: value as RoleName }),
          }),
        }),
        React.createElement(Button, {
          'data-testid': 'trust-submit',
          variant: 'primary',
          loading: state.busy,
          disabled: draft.label.trim() === '',
          children: state.busy ? '登记中…' : '信任本浏览器',
          onClick: () => actions.onTrustClient(draft.label.trim(), draft.ceiling),
        })),
    })
    : null

  const totpSection = React.createElement(Section, {
    'data-testid': 'totp-section',
    title: React.createElement(React.Fragment, null,
      '两步验证',
      React.createElement(Pill, {
        tone: totpEnabled ? 'online' : totp === null ? 'offline' : 'warning',
        dot: true,
        children: totpEnabled ? '已启用' : totp === null ? '未启用' : '绑定中',
      })),
    desc: '信任浏览器与跨机登记公钥都要求先绑定两步验证；绑定后登录需要输入动态码。',
    children: totpEnabled
      ? React.createElement(React.Fragment, null,
        React.createElement(Notice, { tone: 'warning', children: '关闭两步验证需要当前口令和当前动态码。' }),
        React.createElement('div', { className: 'rh-row' },
          React.createElement(Input, {
            'data-testid': 'totp-disable-password',
            type: 'password',
            ariaLabel: '当前口令',
            placeholder: '当前口令',
            value: totpDraft.password,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
              actions.onTotpChange('password', event.currentTarget.value),
          }),
          React.createElement(Input, {
            'data-testid': 'totp-disable-code',
            inputMode: 'numeric',
            ariaLabel: '6 位动态码',
            placeholder: '6 位动态码',
            maxLength: 6,
            value: totpDraft.code,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
              actions.onTotpChange('code', event.currentTarget.value),
          }),
          React.createElement(Button, {
            'data-testid': 'totp-disable',
            variant: 'danger',
            disabled: state.busy || totpDraft.password === '' || totpDraft.code === '',
            children: '关闭两步验证',
            onClick: () => actions.onDisableTotp(),
          })))
      : totp === null
        ? React.createElement(Button, {
          'data-testid': 'totp-start',
          variant: 'primary',
          disabled: state.busy,
          children: '开始绑定两步验证',
          onClick: () => actions.onStartTotp(),
        })
        : React.createElement(React.Fragment, null,
          React.createElement('p', { className: 'rh-muted', style: { margin: '0 0 10px' } },
            '用认证器 App 导入下面的密钥（或扫码），然后填 6 位动态码确认；备用码只显示这一次。'),
          React.createElement('div', { className: 'rh-qr-wrap' },
            React.createElement('div', { className: 'rh-qr-copy' },
              React.createElement('div', { className: 'rh-k' }, '认证器密钥'),
              React.createElement('div', { style: { margin: '4px 0 10px' } },
                React.createElement(CodeBox, { 'data-testid': 'totp-secret', children: totp.secret })),
              React.createElement(Collapse, {
                summary: 'otpauth 链接',
                children: React.createElement('code', { 'data-testid': 'totp-otpauth' }, totp.otpauth),
              }),
              React.createElement('div', { className: 'rh-k', style: { marginTop: 12 } }, '备用码（只显示这一次，请妥善保存）'),
              React.createElement('div', {
                'data-testid': 'totp-backup-codes',
                className: 'rh-code',
                style: { marginTop: 4, wordBreak: 'break-all' },
                }, totp.backupCodes.join('  '))),
          React.createElement('div', { className: 'rh-row', style: { marginTop: 12 } },
            React.createElement(Input, {
              'data-testid': 'totp-confirm-code',
              inputMode: 'numeric',
              ariaLabel: '6 位动态码',
              placeholder: '6 位动态码',
              maxLength: 6,
              value: totpDraft.code,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                actions.onTotpChange('code', event.currentTarget.value),
            }),
            React.createElement(Button, {
              'data-testid': 'totp-confirm',
              variant: 'primary',
              disabled: state.busy || totpDraft.code === '',
              children: '确认绑定',
              onClick: () => actions.onConfirmTotp(),
            }),
            React.createElement(Button, {
              'data-testid': 'totp-cancel',
              variant: 'ghost',
              children: '取消',
              onClick: () => actions.onCancelTotp(),
            })),
          state.notice === null ? null : React.createElement(Notice, { tone: 'error', children: state.notice }))),
  })

  const policySection = React.createElement(Section, {
    'data-testid': 'password-policy-section',
    title: '口令管理',
    desc: '口令策略切换后立即生效：之后设置/修改口令都按新规则校验（已有口令不受影响）。',
    children: React.createElement(React.Fragment, null,
      React.createElement('div', { className: 'rh-k', style: { marginBottom: 6 } }, '口令策略'),
      React.createElement(Segmented, {
        ariaLabel: '口令策略',
        value: state.policy,
        disabled: state.busy,
        options: PASSWORD_POLICIES.map(policy => ({
          value: policy,
          label: policy === 'strong' ? '仅允许强密码（推荐）' : '允许基础口令',
          testId: `policy-${policy}`,
        })),
        onChange: value => actions.onSetPasswordPolicy(value as PasswordPolicy),
      }),
      React.createElement('hr', { className: 'rh-divider' }),
      React.createElement('div', { className: 'rh-cfg-title', style: { marginBottom: 8 } }, '修改口令'),
      passwordFields(draft, setDraft),
      passwordChecklist(draft.newPassword, state.policy, username),
      React.createElement(Button, {
        'data-testid': 'change-password-apply',
        variant: 'primary',
        disabled: state.busy || draft.currentPassword === ''
          || draft.newPassword === draft.currentPassword
          || !evaluatePassword(draft.newPassword, state.policy, username).ok,
        children: '保存新口令',
        onClick: () => actions.onChangePassword(draft.currentPassword, draft.newPassword),
      })),
  })

  const clientsSection = React.createElement(Section, {
    'data-testid': 'clients-list',
    title: `可信客户端（${active.length}）`,
    desc: '这些客户端被允许用本机账号访问 Hub；提高上限不会改变浏览器当前角色，受信浏览器需重新信任后才会以新权限运行。',
    children: clients.length === 0
      ? React.createElement('p', { 'data-testid': 'clients-empty', className: 'rh-muted', style: { margin: 0 } },
        '还没有受信客户端。信任本浏览器后即可免重复 2FA 访问 Hub。')
      : React.createElement('div', null, clients.map(client => renderClientRow(client, state, actions))),
  })

  const peersSection = React.createElement(Section, {
    'data-testid': 'peer-accounts',
    title: `对端账号（${state.peers.length}）`,
    desc: '本机作为控制端，在其它设备上建立过的信任。用的是对端的账号；与本机账号互不影响。',
    children: state.peers.length === 0
      ? React.createElement('p', { 'data-testid': 'peers-empty', className: 'rh-muted', style: { margin: 0 } },
        '还没有对端账号。在「云端设备 → 连接其他设备」里用对端账号登录并信任本机会出现在这里。')
      : React.createElement('div', null,
        state.peers.map(peer => React.createElement('div', {
          key: peer.id,
          'data-testid': 'peer-account',
          'data-origin': peer.origin,
          className: 'rh-item is-offline',
        },
        React.createElement('div', { className: 'rh-item-head' },
          React.createElement('span', { className: 'rh-item-name' }, peer.label ?? peer.origin),
          peer.role === undefined ? null : React.createElement(Pill, { tone: 'purple', children: formatRole(peer.role) })),
        React.createElement('p', { className: 'rh-meta' },
          React.createElement('code', { className: 'rh-inline-code' }, peer.origin),
          ' · ',
          peer.lastConnectedAt === undefined
            ? '从未连接'
            : `最近连接 ${formatRelative(peer.lastConnectedAt, Date.now())}`),
        React.createElement('div', { className: 'rh-item-actions' },
          React.createElement(Button, {
            'data-testid': 'forget-peer',
            variant: 'danger',
            size: 'small',
            disabled: state.busy,
            title: `移除对端信任 ${peer.label ?? peer.origin}`,
            children: '移除信任',
            onClick: () => actions.onForgetPeer(peer.id),
          }))))),
  })

  return pageRoot('ready', React.createElement(React.Fragment, null,
    pageHead(),
    // 两套账号必须分开显示：本机账号决定「谁能登录这台机器」，
    // 对端账号是本机作为控制端在别的机器上建立的信任。
    localAccount,
    trustSection,
    totpSection,
    policySection,
    clientsSection,
    peersSection,
    state.notice === null
      ? null
      : React.createElement(Notice, { 'data-testid': 'account-notice', tone: 'info', children: state.notice })))
}