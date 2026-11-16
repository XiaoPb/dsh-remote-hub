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

import type { AccountView, AuthStatusResponse, PasswordPolicy, TrustedClientView } from '@core/auth.js'
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
  QrCode,
  ROLE_OPTIONS,
  Section,
  Segmented,
  Select,
  Skeleton,
  ThemeStyle,
  cx,
  formatRelative,
  formatRole,
  formatRoleCeiling,
  roleOptionLabel,
} from '../rhui/index.js'
import { RH_CSS } from '../rhui/tokens.js'
import { t } from '../rhui/i18n.js'
import type { ClientBinding } from './keyring.js'

/** 页面阶段（`data-phase` 的取值）。 */
export type AccountPhase = 'loading' | 'bootstrap' | 'login' | 'mfa' | 'change-password' | 'enroll-totp' | 'ready' | 'error'

/** 一个「对端账号」记录（本机作为控制端信任过的其它设备）。 */
export interface PeerAccountRow {
  id: string
  origin: string
  label?: string
  role?: string
  lastConnectedAt?: number
}

/** 子账号行内待确认的操作（同一时刻只有一行展开验证区）。 */
export interface SubAccountPending {
  accountId: string
  /** 待执行的动作；`ceiling` 需要同时给出目标角色。 */
  action: 'disable' | 'enable' | 'delete' | 'ceiling'
  role?: RoleName
  /** 输入的新鲜 2FA 材料（禁用/删除/抬上限要求）。 */
  password: string
  code: string
  /** 行内错误（2FA 失败等）。 */
  error: string | null
}

/** 子账号区块 G 的状态（仅 admin 会话可见）。 */
export interface SubAccountsState {
  /** 列表；null = 尚未加载（或非 admin 不请求）。 */
  accounts: readonly AccountView[] | null
  /** 新建表单是否展开。 */
  creating: boolean
  /** 新建表单草稿。 */
  draft: { username: string; password: string; roleCeiling: RoleName }
  /** 创建成功结果（一次性口令，只显示到用户点「我已保存」）。 */
  created: { username: string; initialPassword: string | null } | null
  /** 正在等待行内确认的操作。 */
  pending: SubAccountPending | null
  /** 删除二次确认是否展开（行内红色确认区）。 */
  confirmingDelete: string | null
  error: string | null
}

/** 子账号区块的初始状态。 */
export function initialSubAccounts(): SubAccountsState {
  return {
    accounts: null,
    creating: false,
    draft: { username: '', password: '', roleCeiling: 'read-only' },
    created: null,
    pending: null,
    confirmingDelete: null,
    error: null,
  }
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
   * 各区块的展开状态（设置页每张卡片默认收起，点标题右上角的按钮展开）。
   *
   * 键是区块 id（`local-account` / `totp-section` / `sub-accounts` …）。
   * 缺省（旧调用方）时按「全部收起」处理。
   */
  expanded?: Readonly<Record<string, boolean>>
  /**
   * 改名流程：还没点开时为 false/null；填好新名字等 2FA 时 `pending` 非空。
   *
   * 首次绑定完成即可把默认的 `admin` 改成自己的名字。
   */
  renameOpen?: boolean
  /** 等待新鲜 2FA 的改名请求（口令 + 动态码）。 */
  renamePending?: { username: string; password: string; code: string; error: string | null } | null
  /** 改名输入框的草稿（缺省取当前账号名）。 */
  renameDraft?: string  /** 子账号管理（区块 G，admin only）。
   *
   * 缺省（旧调用方）时按「非 admin / 未加载」渲染，不出现区块 G。
   */
  subAccounts?: SubAccountsState
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
  /**
   * 展开 / 收起某个区块（设置页每张卡片默认收起）。
   * @param sectionId - 区块的 `data-testid`（如 `totp-section`）。
   */
  onToggleSection?(sectionId: string): void
  /** 打开 / 关闭改名表单。 */
  onRenameOpen?(open: boolean): void
  /** 修改改名草稿。 */
  onRenameDraftChange?(value: string): void
  /** 提交改名（需要新鲜 2FA 时由 mount 打开验证面板）。 */
  onRenameSubmit?(username: string): void
  /** 修改验证面板里的口令 / 动态码。 */
  onRenamePendingChange?(field: 'password' | 'code', value: string): void
  /** 验证并执行改名。 */
  onRenameConfirm?(): void
  /** 取消验证面板。 */
  onRenameCancel?(): void
  // ── 区块 G：子账号（admin only）───────────────────────────────────────────
  /** 展开 / 收起新建表单。 */
  onSubCreateOpen?(open: boolean): void
  /** 修改新建表单草稿。 */
  onSubDraftChange?(field: 'username' | 'password' | 'roleCeiling', value: string): void
  /** 提交新建（口令留空 = 服务端生成一次性口令）。 */
  onSubCreate?(): void
  /** 创建成功的一次性口令已保存，可以收起。 */
  onSubCreatedDismiss?(): void
  /** 行内「禁用 / 启用 / 删除 / 抬上限」：先展开确认或 2FA 区。 */
  onSubRequest?(accountId: string, action: 'disable' | 'enable' | 'delete' | 'ceiling', role?: RoleName): void
  /** 行内验证区输入变更。 */
  onSubPendingChange?(field: 'password' | 'code', value: string): void
  /** 提交行内 2FA 并执行动作。 */
  onSubConfirm?(): void
  /** 取消行内确认。 */
  onSubCancel?(): void
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

/** 登录流程步骤（从 locale 取文案）。 */

/** 「可信客户端」折叠时默认展示的条数（其余收进「显示全部」）。 */
const CLIENTS_PREVIEW = 3

/** `state.expanded` 里表示「客户端列表已全部展开」的键。 */
const CLIENTS_SHOW_ALL_KEY = 'clients-show-all'

/** `state.expanded` 里表示「对端账号列表已全部展开」的键。 */
const PEERS_SHOW_ALL_KEY = 'peers-show-all'

/**
 * 页头：`account-title` 始终存在（`plan-settings.md §5`）。
 *
 * 标题随阶段变化（登录 / 两步验证 / 设置新口令 / 登录与账号），但 testid 不变。
 * 副标题只在登录前的阶段显示：进入 ready 后顶部已经有账号 pill、步骤条和
 * 区块摘要，再放一整段说明会把 top 区域撑空。
 * @param title - 主标题。
 * @param lead - 是否显示副标题。
 * @returns 页头节点。
 */
function pageHead(title?: string, lead = false): React.ReactElement {
  const resolvedTitle = title ?? t('pageTitle')
  return React.createElement('header', { className: cx('rh-page-head', !lead && 'is-compact') },
    React.createElement('div', { className: 'rh-page-head-row' },
      React.createElement('h1', { className: 'rh-h1', 'data-testid': 'account-title' }, resolvedTitle),
      lead ? null : React.createElement('span', { className: 'rh-page-head-hint' }, t('pageHint'))),
    lead ? React.createElement('p', { className: 'rh-lead' }, t('pageLead')) : null)
}

/** 登录流程步骤（从 locale 取文案）。 */
const STEPS: readonly { key: 'login' | 'password' | 'enroll' | 'ready'; labelKey: 'stepCredentials' | 'stepPassword' | 'stepEnroll' | 'stepReady' }[] = [
  { key: 'login', labelKey: 'stepCredentials' },
  { key: 'password', labelKey: 'stepPassword' },
  { key: 'enroll', labelKey: 'stepEnroll' },
  { key: 'ready', labelKey: 'stepReady' },
]

/**
 * 当前阶段落在哪一步：`bootstrap` / `change-password` 属于第一步（还没进门），
 * `mfa` 是第二步，其余（`ready`）是第三步。`loading` / `error` 不显示步骤条。
 * @param phase - 页面阶段。
 * @returns 步骤索引；null = 不显示。
 */
function stepIndex(phase: AccountPhase): number | null {
  if (phase === 'loading' || phase === 'error') return null
  if (phase === 'mfa') return 1
  // 首次登录向导：改初始口令 → 绑定两步验证 → 进设置。两步都是必走的。
  if (phase === 'change-password') return 1
  if (phase === 'enroll-totp') return 2
  if (phase === 'ready') return 3
  return 0
}

/**
 * 步骤条：一次只走一步（输入账号口令 → 两步验证 → 进入设置）。
 * @param phase - 页面阶段。
 * @param busy - 是否进行中（决定哪一步是 active）。
 * @returns 步骤条节点。
 */
function stepBar(phase: AccountPhase): React.ReactElement | null {
  const current = stepIndex(phase)
  if (current === null) return null
  return React.createElement('ol', {
    className: 'rh-steps',
    'data-testid': 'account-steps',
    'data-step': String(current + 1),
    'aria-label': t('stepBarLabel'),
  }, STEPS.map((step, index) => React.createElement('li', {
    key: step.key,
    className: cx(
      'rh-step',
      index < current && 'is-done',
      index === current && 'is-current',
    ),
    'data-step-key': step.key,
    'aria-current': index === current ? 'step' : undefined,
  },
  React.createElement('span', { className: 'rh-step-no' }, index < current ? '✓' : String(index + 1)),
  React.createElement('span', { className: 'rh-step-label' }, t(step.labelKey)))))
}

/**
 * 页面根容器：注入 token 样式表 + 自带的滚动容器 + `data-testid="account-page"`。
 *
 * 滚动：设置页宿主（DSH Settings 弹窗）高度不可控，内容又很长（ready 态约 3600px），
 * 所以页面自己成为**唯一**滚动容器（`rh-root rh-scroll`），页头与步骤条吸顶。
 * @param phase - 页面阶段。
 * @param children - 内容。
 * @param options - 主题与宽度。
 * @returns 根节点。
 */
function pageRoot(
  phase: AccountPhase,
  children: React.ReactNode,
  options: { narrow?: boolean; theme?: 'dark' | 'light'; title?: string; lead?: boolean } = {},
): React.ReactElement {
  return React.createElement('div', {
    className: cx('rh-root', 'rh-scroll', 'rh-settings'),
    'data-testid': 'account-page',
    'data-phase': phase,
    'data-rh-scope': '',
    ...(options.theme === undefined ? {} : { 'data-theme': options.theme }),
  },
  ThemeStyle(RH_CSS),
  React.createElement('div', { className: cx('rh-shell', options.narrow !== false && 'rh-narrow') },
    React.createElement('div', { className: 'rh-page-sticky' },
      pageHead(options.title, options.lead === true),
      stepBar(phase)),
    React.createElement('div', { className: 'rh-page-body', 'data-testid': 'account-body' }, children)))
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
      label: t('currentPasswordLabel'),
      children: React.createElement(PasswordInput, {
        'data-testid': 'current-password',
        type: 'password',
        autoComplete: 'current-password',
        value: draft.currentPassword,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, currentPassword: event.currentTarget.value }),
      }),
    }),
    React.createElement(Field, {
      label: t('newPasswordLabel'),
      hint: t('newPasswordHint'),
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
      ? React.createElement(Pill, { tone: 'error', children: t('clientStatusRevoked') })
      : React.createElement(Pill, { tone: online ? 'online' : 'offline', dot: true, children: online ? t('clientStatusOnline') : t('clientStatusOffline') }),
    React.createElement(Pill, { tone: 'purple', children: formatRole(client.activeRole) }),
    React.createElement('span', {
      'data-testid': 'client-role',
      className: 'rh-pill',
    }, `${formatRole(client.activeRole)} / ${t('roleCeilingPrefix')}${formatRole(client.roleCeiling)}`)),
  React.createElement('p', { className: 'rh-meta' },
    client.username === undefined || client.username === null
      ? null
      : React.createElement(React.Fragment, null,
        React.createElement('span', { 'data-testid': 'client-account' }, t('clientAccount', { username: client.username })),
        ' · '),
    React.createElement('span', { title: t('clientFingerprintTitle') },
      `${t('clientFingerprint')} `,
      React.createElement('code', {
        className: 'rh-inline-code',
      }, client.fingerprint)),
    ' · ',
    client.lastSeenAt === null ? t('clientNeverActive') : `${t('clientLastSeen')} ${formatRelative(client.lastSeenAt, Date.now())}`,
    ' · ',
    client.leaseExpiresAt === null || client.leaseExpiresAt === undefined
      ? t('clientLeaseNone')
      : `${t('clientLease')} ${formatRelative(client.leaseExpiresAt, Date.now()).replace(t('timeJustNow'), '')} ${t('clientLeaseExpiry')}`),
  React.createElement('div', { className: 'rh-item-actions' },
    // 两个下拉框并排两列（plan-settings §2.7 E）；撤销按钮在右侧独立。
    React.createElement('div', { className: 'rh-select-pair' },
      React.createElement(Select, {
        'data-testid': 'client-role-select',
        ariaLabel: t('clientRoleLabel', { label: client.label }),
        value: client.activeRole,
        disabled: revoked || state.busy,
        options: ROLE_NAMES.map(role => ({ value: role, label: roleOptionLabel(role) })),
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
          actions.onSetRole(client.clientId, event.currentTarget.value as RoleName)
        },
      }),
      React.createElement(Select, {
        'data-testid': 'client-ceiling-select',
        ariaLabel: t('clientCeilingLabel', { label: client.label }),
        value: client.roleCeiling,
        disabled: revoked || state.busy,
        options: ROLE_NAMES.map(role => ({ value: role, label: `${t('clientCeilingPrefix')}${roleOptionLabel(role)}` })),
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
          actions.onSetCeiling(client.clientId, event.currentTarget.value as RoleName)
        },
      })),
    React.createElement(Button, {
      'data-testid': 'revoke-client',
      variant: 'danger',
      size: 'small',
      disabled: revoked || state.busy,
      title: t('clientRevokeTitle', { label: client.label }),
      children: t('clientRevoke'),
      onClick: () => actions.onRevokeClient(client.clientId),
    })),
  pending
    ? React.createElement('div', { className: 'rh-inline-panel', 'data-testid': 'escalation' },
      React.createElement('div', { className: 'rh-cfg-title' }, t('escalationTitle')),
      React.createElement('p', { className: 'rh-cfg-desc' },
        t('escalationDesc', { role: formatRole(escalation.role) })),
      React.createElement('div', { className: 'rh-row', style: { marginTop: 8 } },
        React.createElement(Input, {
          'data-testid': 'escalation-password',
          type: 'password',
          autoComplete: 'current-password',
          ariaLabel: t('escalationPasswordLabel'),
          value: escalation.password,
          disabled: state.busy,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
            actions.onEscalationChange('password', event.currentTarget.value),
        }),
        React.createElement(Input, {
          'data-testid': 'escalation-code',
          inputMode: 'numeric',
          autoComplete: 'one-time-code',
          ariaLabel: t('escalationCodeLabel'),
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
          children: t('escalationSubmit'),
          onClick: () => actions.onEscalationSubmit(),
        }),
        React.createElement(Button, {
          'data-testid': 'escalation-cancel',
          variant: 'ghost',
          size: 'small',
          children: t('cancel'),
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

/** 一次行内动作的本地化名（用于按钮 aria-label 与文案）。 */
function subActionLabel(action: 'disable' | 'enable' | 'delete' | 'ceiling'): string {
  if (action === 'disable') return t('subActionDisable')
  if (action === 'enable') return t('subActionEnable')
  if (action === 'delete') return t('subActionDelete')
  return t('subActionCeiling')
}

/**
 * 一行子账号（区块 G）。
 *
 * 行内状态：正常 / 已禁用（整行淡化）；`未绑定两步验证` 用橙色标签提示。
 * 禁用 / 删除 / 调上限需要新鲜 2FA → 服务端回 `auth-mfa-required` 时**该行内**
 * 展开验证区（与提权同一组件样式）。删除必须二次确认（展开红色确认区）。
 *
 * @param account - 账号视图。
 * @param state - 页面状态。
 * @param actions - 页面动作。
 * @param sub - 区块 G 状态。
 * @returns 行节点。
 */
function renderSubAccountRow(
  account: AccountView,
  state: AccountPageState,
  actions: AccountPageActions,
  sub: SubAccountsState,
): React.ReactElement {
  const disabled = account.disabledAt !== null
  const pending = sub.pending !== null && sub.pending.accountId === account.accountId ? sub.pending : null
  const confirming = sub.confirmingDelete === account.accountId
  const request = (action: 'disable' | 'enable' | 'delete' | 'ceiling', role?: RoleName): void => {
    actions.onSubRequest?.(account.accountId, action, role)
  }
  return React.createElement('div', {
    key: account.accountId,
    'data-testid': 'sub-account',
    'data-account-id': account.accountId,
    'data-username': account.username,
    'data-disabled': disabled ? 'true' : 'false',
    className: cx('rh-item', disabled ? 'is-disabled is-offline' : account.lastLoginAt === null ? 'is-offline' : ''),
  },
  React.createElement('div', { className: 'rh-item-head' },
    React.createElement('span', { className: 'rh-item-name' }, typeIcon('user'), ' ', account.username),
    React.createElement(Pill, { tone: 'purple', children: formatRoleCeiling(account.roleCeiling) }),
    account.isAdmin ? React.createElement(Pill, { tone: 'info', children: 'Admin' }) : null,
    React.createElement(Pill, { tone: disabled ? 'error' : 'online', dot: true, children: disabled ? t('subDisable') : t('subEnable') })),
  React.createElement('p', { className: 'rh-meta' },
    account.lastLoginAt === null
      ? t('peerNeverConnected')
      : `${t('peerLastConnected')} ${formatRelative(account.lastLoginAt, Date.now())}`),
  // 管理员这一行是**只读**的：不支持禁用 / 改上限 / 删除。
  // 否则一次误操作就能把自己锁在门外（服务端同样拒绝这些请求）。
  account.isAdmin
    ? React.createElement('p', { className: 'rh-meta', 'data-testid': 'sub-account-admin-note', style: { margin: '6px 0 0' } },
      t('subAdminNote'))
    : React.createElement('div', { className: 'rh-item-actions' },
      disabled
        ? React.createElement(Button, {
          'data-testid': 'sub-account-enable',
          size: 'small',
          disabled: state.busy,
          title: t('subEnableTitle', { username: account.username }),
          children: t('subEnable'),
          onClick: () => request('enable'),
        })
        : React.createElement(Button, {
          'data-testid': 'sub-account-disable',
          variant: 'danger',
          size: 'small',
          disabled: state.busy,
          title: t('subDisableTitle', { username: account.username }),
          children: t('subDisable'),
          onClick: () => request('disable'),
        }),
      React.createElement(Button, {
        'data-testid': 'sub-account-set-ceiling',
        size: 'small',
        disabled: state.busy || disabled,
        title: t('subCeilingTitle', { username: account.username }),
        children: t('subSetCeiling'),
        onClick: () => request('ceiling'),
      }),
      React.createElement(Button, {
        'data-testid': 'sub-account-delete',
        variant: 'danger',
        size: 'small',
        disabled: state.busy,
        title: t('subDeleteTitle', { username: account.username }),
        children: t('subDelete'),
        onClick: () => request('delete'),
      })),
  // 删除二次确认（红色）；管理员不会进入这个分支。
  confirming && account.isAdmin !== true
    ? React.createElement('div', { className: 'rh-inline-panel is-danger' },
      React.createElement(Notice, { tone: 'error' },
        t('subDeleteWarning', { username: account.username })),
      React.createElement('div', { className: 'rh-row' },
        React.createElement(Button, {
          'data-testid': 'sub-account-confirm',
          variant: 'danger',
          size: 'small',
          children: t('subDeleteConfirm'),
          onClick: () => request('delete'),
        }),
        React.createElement(Button, {
          variant: 'ghost',
          size: 'small',
          children: t('cancel'),
          onClick: () => actions.onSubCancel?.(),
        })))
    : null,
  // 行内 2FA（禁用 / 启用 / 删除 / 抬上限共用）
  pending === null || pending.action === 'enable'
    ? null
    : React.createElement('div', { className: 'rh-inline-panel' },
      React.createElement('div', { className: 'rh-cfg-title' },
        t('subVerifyTitle', { action: subActionLabel(pending.action), username: account.username })),
      pending.action === 'ceiling'
        ? React.createElement(Segmented, {
          'data-testid': 'sub-account-new-ceiling',
          ariaLabel: t('subNewCeilingLabel'),
          value: pending.role ?? account.roleCeiling,
          options: ROLE_OPTIONS.map(option => ({ value: option.value, label: option.label })),
          onChange: value => actions.onSubRequest?.(account.accountId, 'ceiling', value as RoleName),
        })
        : null,
      React.createElement('div', { className: 'rh-row', style: { marginTop: 8 } },
        React.createElement(PasswordInput, {
          'data-testid': 'sub-account-verify-password',
          ariaLabel: t('subVerifyPasswordLabel'),
          autoComplete: 'current-password',
          placeholder: t('subVerifyPasswordLabel'),
          value: pending.password,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
            actions.onSubPendingChange?.('password', event.currentTarget.value),
        }),
        React.createElement(Input, {
          'data-testid': 'sub-account-verify-code',
          ariaLabel: t('subVerifyCodeLabel'),
          inputMode: 'numeric',
          autoComplete: 'one-time-code',
          placeholder: t('subVerifyCodeLabel'),
          maxLength: 6,
          value: pending.code,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
            actions.onSubPendingChange?.('code', event.currentTarget.value),
        })),
      pending.error === null
        ? null
        : React.createElement('p', { className: 'rh-field-error', style: { margin: '6px 0 0' } }, pending.error),
      React.createElement('div', { className: 'rh-row', style: { marginTop: 10 } },
        React.createElement(Button, {
          'data-testid': 'sub-account-verify',
          variant: 'primary',
          size: 'small',
          loading: state.busy,
          disabled: pending.password === '' || pending.code === '',
          children: t('subVerifySubmit'),
          onClick: () => actions.onSubConfirm?.(),
        }),
        React.createElement(Button, {
          variant: 'ghost',
          size: 'small',
          children: t('cancel'),
          onClick: () => actions.onSubCancel?.(),
        }))))
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
      React.createElement('section', {
        className: 'rh-card',
        'data-testid': 'account-loading',
        'aria-busy': 'true',
        'aria-live': 'polite',
        'aria-label': t('loadingAccount'),
      },
        React.createElement(Skeleton, { lines: 3 }),
        React.createElement('span', { className: 'sr-only' }, t('loadingAccountSr')))))
  }

  if (state.phase === 'error') {
    return pageRoot('error', React.createElement(React.Fragment, null,
      React.createElement(Notice, { tone: 'error', children: React.createElement('span', { 'data-testid': 'account-error' }, state.notice ?? t('serviceUnavailable')) }),
      React.createElement(Button, { variant: 'primary', children: t('retry'), onClick: () => actions.onRefresh() })))
  }

  if (state.phase === 'bootstrap') {
    return pageRoot('bootstrap', React.createElement(React.Fragment, null,
      React.createElement(Notice, {
        'data-testid': 'bootstrap-hint',
        tone: 'info',
        children: t('bootstrapHint'),
      }),
      React.createElement(Section, {
        title: t('bootstrapSectionTitle'),
        desc: t('bootstrapSectionDesc'),
        children: React.createElement(React.Fragment, null,
          React.createElement(Field, {
            label: t('subUsernameLabel'),
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
            label: t('newPasswordLabel'),
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
            children: state.busy ? t('bootstrapSubmitting') : t('bootstrapSubmit'),
            onClick: () => actions.onSubmitBootstrap(draft.username.trim(), draft.password),
          })),
      })), { title: t('bootstrapTitle'), lead: true })
  }

  if (state.phase === 'login') {
    return pageRoot('login', React.createElement(React.Fragment, null,
      React.createElement(Section, {
        title: t('loginSectionTitle'),
        desc: t('loginSectionDesc'),
        children: React.createElement(React.Fragment, null,
          React.createElement(Field, {
            label: t('subUsernameLabel'),
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
            label: t('currentPasswordLabel'),
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
            children: state.busy ? t('loginSubmitting') : t('loginSubmit'),
            onClick: () => actions.onSubmitLogin(draft.username.trim(), draft.password),
          }),
          state.notice === null
            ? null
            : React.createElement(Notice, { 'data-testid': 'login-notice', tone: 'error', children: state.notice })),
      })), { title: t('loginTitle'), lead: true })
  }

  if (state.phase === 'mfa') {
    return pageRoot('mfa', React.createElement(React.Fragment, null,
      React.createElement(Section, {
        title: t('mfaSectionTitle'),
        desc: t('mfaSectionDesc'),
        children: React.createElement(React.Fragment, null,
          React.createElement(Field, {
            label: t('mfaCodeLabel'),
            htmlFor: 'rh-mfa-code',
            error: state.notice,
            children: React.createElement(Input, {
              'data-testid': 'mfa-code',
              inputMode: 'numeric',
              autoComplete: 'one-time-code',
              otp: true,
              value: draft.code,
              placeholder: t('mfaCodePlaceholder'),
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
            children: state.busy ? t('mfaSubmitting') : t('mfaSubmit'),
            onClick: () => actions.onSubmitMfa(draft.code.trim()),
          }),
          React.createElement(Collapse, {
            summary: t('mfaBackupCodeToggle'),
            children: React.createElement('p', { className: 'rh-muted', style: { margin: 0 } },
              t('mfaBackupCodeHint')),
          })),
      })), { title: t('mfaTitle'), lead: true })
  }

  // 改名机会只有一次（管理员首次登录），与改密同屏出现，所以声明要提前。
  const renameAllowed = status?.usernameRenameAllowed === true
  const renameDraft = state.renameDraft ?? username

  if (state.phase === 'change-password') {
    const verdict = evaluatePassword(draft.newPassword, state.policy, username)
    const valid = draft.currentPassword !== '' && verdict.ok && draft.newPassword !== draft.currentPassword
    const renameReady = !renameAllowed || (
      renameDraft.trim().length >= 3
      && renameDraft.trim() !== username
      && !/\s/u.test(renameDraft.trim())
    )
    return pageRoot('change-password', React.createElement(React.Fragment, null,
      React.createElement(Notice, {
        'data-testid': 'change-password-required',
        tone: 'warning',
        children: t('changePasswordRequired'),
      }),
      React.createElement(Section, {
        title: t('changePasswordSectionTitle'),
        desc: t('changePasswordSectionDesc'),
        children: React.createElement(React.Fragment, null,
          passwordFields(draft, setDraft),
          passwordChecklist(draft.newPassword, state.policy, username),
          renameAllowed
            ? React.createElement(React.Fragment, null,
              React.createElement('hr', { className: 'rh-divider' }),
              React.createElement(Field, {
                label: t('renameLabel'),
                hint: t('renameHint'),
                children: React.createElement(Input, {
                  'data-testid': 'rename-username',
                  value: renameDraft,
                  autoComplete: 'off',
                  onChange: (event: React.ChangeEvent<HTMLInputElement>) => actions.onRenameDraftChange?.(event.currentTarget.value),
                }),
              }))
            : null,
          React.createElement(Button, {
            'data-testid': 'change-password-submit',
            variant: 'primary',
            block: true,
            loading: state.busy,
            disabled: !valid || !renameReady,
            children: state.busy ? t('changePasswordSubmitting') : (renameAllowed ? t('changePasswordSubmitWithRename') : t('changePasswordSubmit')),
            onClick: () => actions.onChangePassword(draft.currentPassword, draft.newPassword),
          }),
          state.notice === null ? null : React.createElement(Notice, { tone: 'error', children: state.notice })),
      })), { title: t('changePasswordTitle'), lead: true })
  }

  // 首次登录第 3 步需要 TOTP 草稿（与 ready 态共用同一份状态）。
  const totpDraft = state.totpDraft ?? { code: '', password: '' }

  // ── 首次登录第 3 步：绑定两步验证（必走；服务端未绑定时同样拒绝设置面）──────
  if (state.phase === 'enroll-totp') {
    const enrollment = state.totp ?? null
    return pageRoot('enroll-totp', React.createElement(React.Fragment, null,
      React.createElement(Notice, {
        'data-testid': 'totp-enrollment-required',
        tone: 'warning',
        children: t('enrollTotpRequired'),
      }),
      React.createElement(Section, {
        title: t('enrollTotpSectionTitle'),
        desc: t('enrollTotpSectionDesc'),
        children: enrollment === null
          ? React.createElement(React.Fragment, null,
            React.createElement(Button, {
              'data-testid': 'totp-start',
              variant: 'primary',
              block: true,
              loading: state.busy,
              children: state.busy ? t('enrollTotpStarting') : t('enrollTotpStart'),
              onClick: () => actions.onStartTotp(),
            }),
            state.notice === null ? null : React.createElement(Notice, { tone: 'error', children: state.notice }))
          : React.createElement(React.Fragment, null,
            React.createElement('div', { className: 'rh-qr-wrap' },
              React.createElement('div', { className: 'rh-qr-col' },
                React.createElement(QrCode, {
                  text: enrollment.otpauth,
                  tooLong: t('totpQrTooLong'),
                  label: t('totpQrLabel'),
                  'data-testid': 'totp-qr',
                })),
              React.createElement('div', { className: 'rh-qr-info' },
                React.createElement('div', { className: 'rh-k' }, t('totpSecretLabel')),
                React.createElement(CodeBox, { 'data-testid': 'totp-secret' }, enrollment.secret),
                React.createElement('div', { className: 'rh-k', style: { marginTop: 8 } }, t('totpOtpauthLabel')),
                React.createElement('details', null,
                  React.createElement('summary', { className: 'rh-linkish' }, t('totpOtpauthToggle')),
                  React.createElement(CodeBox, { 'data-testid': 'totp-otpauth' }, enrollment.otpauth)),
                React.createElement('div', { className: 'rh-k', style: { marginTop: 8 } }, t('totpBackupCodesLabel')),
                React.createElement(CodeBox, { 'data-testid': 'totp-backup-codes' }, enrollment.backupCodes.join('  ')))),
            React.createElement(Field, {
              label: t('totpCodeLabel'),
              children: React.createElement(Input, {
                'data-testid': 'totp-confirm-code',
                inputMode: 'numeric',
                autoComplete: 'one-time-code',
                maxLength: 6,
                value: totpDraft.code,
                onChange: (event: React.ChangeEvent<HTMLInputElement>) => actions.onTotpChange('code', event.currentTarget.value),
              }),
            }),
            React.createElement(Button, {
              'data-testid': 'totp-confirm',
              variant: 'primary',
              block: true,
              disabled: state.busy || totpDraft.code === '',
              children: t('totpConfirm'),
              onClick: () => actions.onConfirmTotp(),
            })),
        ...(state.notice === null || enrollment === null
          ? []
          : [React.createElement(Notice, { key: 'notice', tone: 'error', children: state.notice })]),
      })), { title: t('enrollTotpTitle'), lead: true })
  }

  // ── ready：区块 A–F（plan-settings.md §2.7）────────────────────────────────
  const clients = status?.clients ?? []
  // 排序：在线（最近有活动）优先 → 离线 → 按最近活动时间倒序 → 按名称。
  // 已撤销的不再展示（Host 保留一天后连记录一起清除）。
  const active = clients
    .filter(client => client.revokedAt === null)
    .slice()
    .sort((a, b) => {
      const aOnline = a.lastSeenAt !== null && a.lastSeenAt !== undefined
      const bOnline = b.lastSeenAt !== null && b.lastSeenAt !== undefined
      if (aOnline !== bOnline) return aOnline ? -1 : 1
      const aSeen = a.lastSeenAt === null || a.lastSeenAt === undefined ? 0 : Date.parse(a.lastSeenAt) || 0
      const bSeen = b.lastSeenAt === null || b.lastSeenAt === undefined ? 0 : Date.parse(b.lastSeenAt) || 0
      if (aSeen !== bSeen) return bSeen - aSeen
      return a.label.localeCompare(b.label, 'zh-Hans-CN')
    })
  // 列表过长时默认只显示前若干台，其余折叠到「显示全部」。
  const showAllClients = (state.expanded ?? {})[CLIENTS_SHOW_ALL_KEY] === true
  const visibleClients = showAllClients ? active : active.slice(0, CLIENTS_PREVIEW)

  // 对端账号同样折叠：最近连接的在前，其余收进「显示全部」。
  const peers = state.peers ?? []
  const sortedPeers = peers.slice().sort((a, b) => {
    const aAt = a.lastConnectedAt === undefined ? 0 : a.lastConnectedAt
    const bAt = b.lastConnectedAt === undefined ? 0 : b.lastConnectedAt
    if (aAt !== bAt) return bAt - aAt
    return (a.label ?? a.origin).localeCompare(b.label ?? b.origin, 'zh-Hans-CN')
  })
  const showAllPeers = (state.expanded ?? {})[PEERS_SHOW_ALL_KEY] === true
  const visiblePeers = showAllPeers ? sortedPeers : sortedPeers.slice(0, CLIENTS_PREVIEW)
  const totpEnabled = status?.totpEnabled === true
  const totp = state.totp ?? null
  const trusted = state.binding !== null

  const localAccount = React.createElement(Section, {
    'data-testid': 'local-account',
    collapsible: true,
    expanded: (state.expanded ?? {})['local-account'] === true,
    onToggle: () => actions.onToggleSection?.('local-account'),
    summary: username === '' ? null : username,
    title: t('localAccountTitle'),
    desc: t('localAccountDesc'),
    actions: React.createElement(React.Fragment, null,
      React.createElement(Button, { 'data-testid': 'account-refresh', size: 'small', children: t('localAccountRefresh'), onClick: () => actions.onRefresh() }),
      React.createElement(Button, { 'data-testid': 'account-logout', variant: 'ghost', size: 'small', children: t('localAccountLogout'), onClick: () => actions.onLogout() })),
    children: React.createElement(React.Fragment, null,
      React.createElement('div', { className: 'rh-row' },
        React.createElement('span', { 'data-testid': 'account-user', className: 'rh-item-name' },
          `${t('localAccountUser')}${username === '' ? t('localAccountUserEmpty') : username}`),
        React.createElement(Pill, {
          tone: trusted ? 'online' : 'offline',
          dot: true,
          children: React.createElement('span', { 'data-testid': 'account-client' },
            trusted ? `${t('localAccountTrusted')} · ${state.binding?.clientId.slice(0, 12) ?? ''}…` : t('localAccountNotTrusted')),
        })),
      state.enrollment === null
        ? null
        : React.createElement('div', { 'data-testid': 'enrollment-secret', style: { marginTop: 12 } },
          React.createElement(Notice, {
            tone: 'warning',
            children: React.createElement(React.Fragment, null,
              React.createElement('div', null, t('enrollmentQrHint')),
              React.createElement(CodeBox, { style: { margin: '6px 0' }, children: state.enrollment.otpauth }),
              React.createElement('div', null, `${t('enrollmentBackupHint')} ${state.enrollment.backupCodes.join('  ')}`)),
          }))),
  })

  const trustSection = state.binding === null
    ? React.createElement(Section, {
      'data-testid': 'trust-section',
    collapsible: true,
    expanded: (state.expanded ?? {})['trust-section'] === true,
    onToggle: () => actions.onToggleSection?.('trust-section'),
    summary: trusted ? t('totpEnabled') : t('totpDisabled'),
      title: t('trustSectionTitle'),
      desc: t('trustSectionDesc'),
      children: React.createElement(React.Fragment, null,
        totpEnabled
          ? null
          : React.createElement(Notice, { tone: 'warning', children: t('trustRequiresTotp') }),
        React.createElement(Field, {
          label: t('trustLabelField'),
          children: React.createElement(Input, {
            'data-testid': 'trust-label',
            value: draft.label,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, label: event.currentTarget.value }),
          }),
        }),
        React.createElement(Field, {
          label: t('trustCeilingField'),
          children: React.createElement(Segmented, {
            'data-testid': 'trust-ceiling',
            ariaLabel: t('trustCeilingField'),
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
          children: state.busy ? t('trustSubmitting') : t('trustSubmit'),
          onClick: () => actions.onTrustClient(draft.label.trim(), draft.ceiling),
        })),
    })
    : null

  const totpSection = React.createElement(Section, {
    'data-testid': 'totp-section',
    collapsible: true,
    expanded: (state.expanded ?? {})['totp-section'] === true,
    onToggle: () => actions.onToggleSection?.('totp-section'),
    summary: totpEnabled ? t('totpEnabled') : t('totpDisabled'),
    title: React.createElement(React.Fragment, null,
      t('totpSectionTitle'),
      React.createElement(Pill, {
        tone: totpEnabled ? 'online' : totp === null ? 'offline' : 'warning',
        dot: true,
        children: totpEnabled ? t('totpEnabled') : totp === null ? t('totpDisabled') : t('totpEnrolling'),
      })),
    desc: t('totpSectionDesc'),
    children: totpEnabled
      ? React.createElement(React.Fragment, null,
        React.createElement(Notice, { tone: 'warning', children: t('totpDisableWarning') }),
        React.createElement('div', { className: 'rh-row' },
          React.createElement(Input, {
            'data-testid': 'totp-disable-password',
            type: 'password',
            ariaLabel: t('totpDisablePasswordLabel'),
            placeholder: t('totpDisablePasswordLabel'),
            value: totpDraft.password,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
              actions.onTotpChange('password', event.currentTarget.value),
          }),
          React.createElement(Input, {
            'data-testid': 'totp-disable-code',
            inputMode: 'numeric',
            ariaLabel: t('totpDisableCodeLabel'),
            placeholder: t('totpDisableCodeLabel'),
            maxLength: 6,
            value: totpDraft.code,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
              actions.onTotpChange('code', event.currentTarget.value),
          }),
          React.createElement(Button, {
            'data-testid': 'totp-disable',
            variant: 'danger',
            disabled: state.busy || totpDraft.password === '' || totpDraft.code === '',
            children: t('totpDisable'),
            onClick: () => actions.onDisableTotp(),
          })))
      : totp === null
        ? React.createElement(Button, {
          'data-testid': 'totp-start',
          variant: 'primary',
          disabled: state.busy,
          children: t('totpStartBind'),
          onClick: () => actions.onStartTotp(),
        })
        : React.createElement(React.Fragment, null,
          React.createElement('p', { className: 'rh-muted', style: { margin: '0 0 10px' } },
            t('totpBindHint')),
          React.createElement('div', { className: 'rh-qr-wrap' },
            React.createElement('div', { className: 'rh-qr-col' },
              React.createElement(QrCode, {
                'data-testid': 'totp-qr',
                text: totp.otpauth,
                label: t('totpBindQrLabel'),
                tooLong: t('totpBindQrTooLong'),
              })),
            React.createElement('div', { className: 'rh-qr-copy' },
              React.createElement('div', { className: 'rh-k' }, t('totpBindSecretLabel')),
              React.createElement('div', { style: { margin: '4px 0 10px' } },
                React.createElement(CodeBox, { 'data-testid': 'totp-secret', children: totp.secret })),
              React.createElement(Collapse, {
                summary: t('totpOtpauthLabel'),
                children: React.createElement('code', { 'data-testid': 'totp-otpauth' }, totp.otpauth),
              }),
              React.createElement('div', { className: 'rh-k', style: { marginTop: 12 } }, t('totpBackupCodesLabel')),
              React.createElement('div', {
                'data-testid': 'totp-backup-codes',
                className: 'rh-code',
                style: { marginTop: 4, wordBreak: 'break-all' },
                }, totp.backupCodes.join('  '))),
          React.createElement('div', { className: 'rh-row', style: { marginTop: 12 } },
            React.createElement(Input, {
              'data-testid': 'totp-confirm-code',
              inputMode: 'numeric',
              ariaLabel: t('totpCodeLabel'),
              placeholder: t('totpCodePlaceholder'),
              maxLength: 6,
              value: totpDraft.code,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                actions.onTotpChange('code', event.currentTarget.value),
            }),
            React.createElement(Button, {
              'data-testid': 'totp-confirm',
              variant: 'primary',
              disabled: state.busy || totpDraft.code === '',
              children: t('totpConfirmCode'),
              onClick: () => actions.onConfirmTotp(),
            }),
            React.createElement(Button, {
              'data-testid': 'totp-cancel',
              variant: 'ghost',
              children: t('cancelBind'),
              onClick: () => actions.onCancelTotp(),
            })),
          state.notice === null ? null : React.createElement(Notice, { tone: 'error', children: state.notice }))),
  })

  const policySection = React.createElement(Section, {
    'data-testid': 'password-policy-section',
    collapsible: true,
    expanded: (state.expanded ?? {})['password-policy-section'] === true,
    onToggle: () => actions.onToggleSection?.('password-policy-section'),
    summary: state.policy === 'strong' ? t('policyStrong') : t('policyBasic'),
    title: t('policyTitle'),
    desc: t('policyDesc'),
    children: React.createElement(React.Fragment, null,
      React.createElement('div', { className: 'rh-k', style: { marginBottom: 6 } }, t('policyLabel')),
      React.createElement(Segmented, {
        ariaLabel: t('policyLabel'),
        value: state.policy,
        disabled: state.busy,
        options: PASSWORD_POLICIES.map(policy => ({
          value: policy,
          label: policy === 'strong' ? t('policyOptionStrong') : t('policyOptionBasic'),
          testId: `policy-${policy}`,
        })),
        onChange: value => actions.onSetPasswordPolicy(value as PasswordPolicy),
      }),
      React.createElement('hr', { className: 'rh-divider' }),
      React.createElement('div', { className: 'rh-cfg-title', style: { marginBottom: 8 } }, t('changePasswordTitle2')),
      passwordFields(draft, setDraft),
      passwordChecklist(draft.newPassword, state.policy, username),
      React.createElement(Button, {
        'data-testid': 'change-password-apply',
        variant: 'primary',
        disabled: state.busy || draft.currentPassword === ''
          || draft.newPassword === draft.currentPassword
          || !evaluatePassword(draft.newPassword, state.policy, username).ok,
        children: t('savePassword'),
        onClick: () => actions.onChangePassword(draft.currentPassword, draft.newPassword),
      })),
  })

  const clientsSection = React.createElement(Section, {
    'data-testid': 'clients-list',
    collapsible: true,
    expanded: (state.expanded ?? {})['clients-list'] === true,
    onToggle: () => actions.onToggleSection?.('clients-list'),
    summary: `${active.length}`,
    title: t('clientsTitle', { count: String(active.length) }),
    desc: t('clientsDesc'),
    children: active.length === 0
      ? React.createElement('p', { 'data-testid': 'clients-empty', className: 'rh-muted', style: { margin: 0 } },
        t('clientsEmpty'))
      : React.createElement('div', null,
        visibleClients.map(client => renderClientRow(client, state, actions)),
        active.length > CLIENTS_PREVIEW
          ? React.createElement('div', { className: 'rh-list-more' },
            React.createElement('span', { className: 'rh-muted' },
              showAllClients
                ? t('clientsCountAll', { count: String(active.length) })
                : t('clientsCountMore', { count: String(active.length - visibleClients.length) })),
            React.createElement(Button, {
              'data-testid': 'clients-show-all',
              variant: 'ghost',
              size: 'small',
              children: showAllClients ? t('collapse') : t('expandAll'),
              onClick: () => actions.onToggleSection?.(CLIENTS_SHOW_ALL_KEY),
            }))
          : null),
  })

  const peersSection = React.createElement(Section, {
    'data-testid': 'peer-accounts',
    collapsible: true,
    expanded: (state.expanded ?? {})['peer-accounts'] === true,
    onToggle: () => actions.onToggleSection?.('peer-accounts'),
    summary: `${(state.peers ?? []).length}`,
    title: t('peersTitle', { count: String(state.peers.length) }),
    desc: t('peersDesc'),
    children: state.peers.length === 0
      ? React.createElement('p', { 'data-testid': 'peers-empty', className: 'rh-muted', style: { margin: 0 } },
        t('peersEmpty'))
      : React.createElement('div', null,
        visiblePeers.map(peer => React.createElement('div', {
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
            ? t('peerNeverConnected')
            : `${t('peerLastConnected')} ${formatRelative(peer.lastConnectedAt, Date.now())}`),
        React.createElement('div', { className: 'rh-item-actions' },
          React.createElement(Button, {
            'data-testid': 'forget-peer',
            variant: 'danger',
            size: 'small',
            disabled: state.busy,
            title: t('peerForgetTitle', { label: peer.label ?? peer.origin }),
            children: t('peerForget'),
            onClick: () => actions.onForgetPeer(peer.id),
          })))),
        sortedPeers.length > CLIENTS_PREVIEW
          ? React.createElement('div', { className: 'rh-list-more' },
            React.createElement('span', { className: 'rh-muted' },
              showAllPeers
                ? t('peersCountAll', { count: String(sortedPeers.length) })
                : t('peersCountMore', { count: String(sortedPeers.length - visiblePeers.length) })),
            React.createElement(Button, {
              'data-testid': 'peers-show-all',
              variant: 'ghost',
              size: 'small',
              children: showAllPeers ? t('collapse') : t('expandAll'),
              onClick: () => actions.onToggleSection?.(PEERS_SHOW_ALL_KEY),
            }))
          : null),
  })

  // ── 区块 G：子账号（admin only，plan-optimization §3）─────────────────────
  // 非 admin 会话不渲染整块（不是 disabled）。
  const sub = state.subAccounts
  const isAdmin = status?.session?.role === 'admin'
  const subAccountsSection = sub === undefined || !isAdmin
    ? null
    : React.createElement(Section, {
      'data-testid': 'sub-accounts',
    collapsible: true,
    expanded: (state.expanded ?? {})['sub-accounts'] === true,
    onToggle: () => actions.onToggleSection?.('sub-accounts'),
    summary: `${(sub?.accounts ?? []).length}`,
      title: t('subTitle', { count: String(sub.accounts?.length ?? 0) }),
      desc: t('subDesc'),
      actions: React.createElement(Button, {
        'data-testid': 'sub-account-create-open',
        variant: 'primary',
        size: 'small',
        disabled: sub.creating || state.busy,
        children: t('subCreateOpen'),
        onClick: () => actions.onSubCreateOpen?.(true),
      }),
      children: React.createElement(React.Fragment, null,
        sub.error === null ? null : React.createElement(Notice, { 'data-testid': 'sub-account-error', tone: 'error' }, sub.error),
        sub.creating
          ? React.createElement('div', { className: 'rh-inline-panel' },
            React.createElement('div', { className: 'rh-cfg-title' }, t('subCreateTitle')),
            React.createElement('div', { className: 'rh-row' },
              React.createElement(Field, {
                label: t('subUsernameLabel'),
                children: React.createElement(Input, {
                  'data-testid': 'sub-account-username',
                  ariaLabel: t('subUsernameAriaLabel'),
                  autoComplete: 'off',
                  placeholder: t('subUsernamePlaceholder'),
                  value: sub.draft.username,
                  onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                    actions.onSubDraftChange?.('username', event.currentTarget.value),
                }),
              }),
              React.createElement(Field, {
                label: t('subPasswordLabel'),
                children: React.createElement(PasswordInput, {
                  'data-testid': 'sub-account-password-input',
                  ariaLabel: t('subPasswordAriaLabel'),
                  autoComplete: 'new-password',
                  placeholder: t('subPasswordPlaceholder'),
                  value: sub.draft.password,
                  onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                    actions.onSubDraftChange?.('password', event.currentTarget.value),
                }),
              })),
            React.createElement(Field, {
              label: t('subCeilingLabel'),
              children: React.createElement(Segmented, {
                'data-testid': 'sub-account-ceiling',
                ariaLabel: t('subCeilingAriaLabel'),
                value: sub.draft.roleCeiling,
                options: ROLE_OPTIONS.map(option => ({ value: option.value, label: option.label })),
                onChange: value => actions.onSubDraftChange?.('roleCeiling', value),
              }),
            }),
            React.createElement('div', { className: 'rh-row' },
              React.createElement(Button, {
                'data-testid': 'sub-account-create',
                variant: 'primary',
                loading: state.busy,
                disabled: sub.draft.username.trim() === '',
                children: state.busy ? t('subCreateSubmitting') : t('subCreateSubmit'),
                onClick: () => actions.onSubCreate?.(),
              }),
              React.createElement(Button, {
                variant: 'ghost',
                children: t('cancel'),
                onClick: () => actions.onSubCreateOpen?.(false),
              })))
          : null,
        sub.created === null
          ? null
          : React.createElement('div', { className: 'rh-inline-panel' },
            React.createElement(Notice, { tone: 'success' }, t('subCreatedSuccess', { username: sub.created.username })),
            sub.created.initialPassword === null
              ? null
              : React.createElement(React.Fragment, null,
                React.createElement('div', { className: 'rh-k' }, t('subCreatedOtpLabel')),
                React.createElement(CodeBox, { 'data-testid': 'sub-account-password' }, sub.created.initialPassword)),
            React.createElement('p', { className: 'rh-k' }, t('subCreatedOtpNote')),
            React.createElement(Button, {
              size: 'small',
              children: t('saved'),
              onClick: () => actions.onSubCreatedDismiss?.(),
            })),
        sub.accounts === null
          ? React.createElement('p', { className: 'rh-muted' }, t('subLoading'))
          : sub.accounts.length === 0
            ? React.createElement('p', { className: 'rh-muted', style: { margin: 0 } }, t('subEmpty'))
            : React.createElement('div', null, sub.accounts.map(account => renderSubAccountRow(account, state, actions, sub)))),
    })

  return pageRoot('ready', React.createElement(React.Fragment, null,
    // 两套账号必须分开显示：本机账号决定「谁能登录这台机器」，
    // 对端账号是本机作为控制端在别的机器上建立的信任。
    localAccount,
    trustSection,
    totpSection,
    policySection,
    clientsSection,
    peersSection,
    subAccountsSection,
    state.notice === null
      ? null
      : React.createElement(Notice, { 'data-testid': 'account-notice', tone: 'info', children: state.notice })))
}