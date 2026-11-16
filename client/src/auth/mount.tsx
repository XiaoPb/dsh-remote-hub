/**
 * 「登录与账号」页的装配（hooks + 认证 API + 密钥环）。
 *
 * 安全相关的取舍：
 * - 私钥只在 WebCrypto 里（不可导出）；租约与 `clientId` 一起存在 IndexedDB，
 *   与私钥同域——单独拿到租约没有私钥也签不出请求。
 * - 退出登录只撤销**会话**，不自动撤销已信任的客户端；撤销客户端是独立动作。
 *
 * @module dsh-remote-hub/client/auth/mount
 */
import React from 'react'

import type { AuthStatusResponse } from '@core/auth.js'
import type { RoleName } from '@core/roles.js'

import {
  initialDraft,
  initialSubAccounts,
  renderAccountPage,
  type AccountPageActions,
  type AccountFormDraft,
  type AccountPageState,
  type PeerAccountRow,
} from './AccountPage.js'
import { createAuthApi, AuthApiError, type AuthApi } from './api.js'
import { createKeyring, type ClientBinding, type ClientIdentity } from './keyring.js'
import { t } from '../rhui/i18n.js'

/** 角色名守卫（下拉/分段控件回传的是字符串）。 */
function isRoleValue(value: string): value is RoleName {
  return value === 'read-only' || value === 'control' || value === 'full'
}

/** 装配依赖（测试可注入）。 */
export interface AccountPageDeps {
  api?: AuthApi
  keyring?: ReturnType<typeof createKeyring>
  /** 认证启用前的探测结果（Host 未提供认证面时页面保持不可用）。 */
  probeStatus?: () => Promise<AuthStatusResponse | null>
  /** 对端账号（出站信任记录）：由宿主档案读出。 */
  loadPeers?: () => Promise<readonly PeerAccountRow[]>
  /** 移除一条对端信任记录。 */
  forgetPeer?: (targetId: string) => Promise<unknown>
}

/** 错误文案（不回显凭据/挑战）。 */
function messageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const value = error as { message?: unknown; code?: unknown }
    if (value.code === 'auth-rate-limited') return t('errRateLimited')
    if (value.code === 'auth-invalid-credentials') return t('errInvalidCredentials')
    if (value.code === 'auth-mfa-invalid') return t('errMfaInvalid')
    if (value.code === 'auth-mfa-expired') return t('errMfaExpired')
    if (value.code === 'auth-forbidden') return t('errForbidden')
    if (value.code === 'auth-password-change-required') return t('errPasswordChangeRequired')
    if (value.code === 'auth-current-password-invalid') return t('errCurrentPasswordInvalid')
    if (value.code === 'auth-password-weak') return t('errPasswordWeak')
    if (value.code === 'auth-password-unchanged') return t('errPasswordUnchanged')
    if (typeof value.message === 'string') return value.message
  }
  return t('errDefault')
}

/**
 * 创建页面组件。
 * @param deps - 注入依赖。
 * @returns 无 props 的 React 组件。
 */
export function createAccountPageComponent(deps: AccountPageDeps = {}): () => React.ReactNode {
  const api = deps.api ?? createAuthApi()
  const keyring = deps.keyring ?? createKeyring()

  return function AccountPage(): React.ReactNode {
    const [state, setState] = React.useState<AccountPageState>({
      phase: 'loading',
      status: null,
      binding: null,
      policy: 'strong',
      peers: [],
      escalation: null,
      totp: null,
      totpDraft: { code: '', password: '' },
      enrollment: null,
      notice: null,
      busy: false,
      mfaToken: null,
      subAccounts: initialSubAccounts(),
    })
    const [draft, setDraft] = React.useState<AccountFormDraft>(initialDraft)
    const identityRef = React.useRef<ClientIdentity | null>(null)

    const patch = React.useCallback((next: Partial<AccountPageState>) => {
      setState(current => ({ ...current, ...next }))
    }, [])

    const load = React.useCallback(async () => {
      try {
        const status = await api.status()
        const storedBinding = await keyring.loadBinding()
        // 本地残留的绑定必须由服务端确认仍然有效：服务端重置账号、撤销或删除该客户端
        // 之后，浏览器里的密钥还在，但「本浏览器已受信」已经不成立。此时按未受信
        // 处理并清掉本地绑定，否则信任区会永久消失（用户再也无法重新受信）。
        const binding = storedBinding === null ? null
          : (status.clients ?? []).some(client => client.clientId === storedBinding.clientId
            && client.revokedAt === null)
            ? storedBinding
            : null
        if (storedBinding !== null && binding === null) {
          await keyring.clearBinding().catch(() => undefined)
        }
        // 对端账号独立于本机认证：档案读失败不影响本机账号操作。
        const peers = deps.loadPeers === undefined
          ? []
          : await deps.loadPeers().catch(() => [] as readonly PeerAccountRow[])
        // 子账号只对 admin 会话拉取（非 admin 不请求，也不渲染区块 G）。
        const subAccounts = status.session?.role === 'admin'
          ? await api.accounts({ action: 'list' })
            .then(result => ({
              ...initialSubAccounts(),
              accounts: result.accounts ?? [],
            }))
            .catch(() => ({ ...initialSubAccounts(), accounts: [] }))
          : initialSubAccounts()
        const session = status.session
        let phase: AccountPageState['phase']
        if (session === null) phase = status.bootstrapped ? 'login' : 'bootstrap'
        // 首次登录是一条**必须走完**的向导：改初始口令 → （可选改名）→ 绑定两步验证。
        // 服务端同样在未绑定 TOTP 时拒绝设置面，所以这里不是可跳过的入口。
        else if (status.passwordChangeRequired === true) phase = 'change-password'
        else if (status.totpEnrollmentRequired === true) phase = 'enroll-totp'
        else phase = 'ready'
        setState(current => ({
          ...current,
          phase,
          status,
          binding,
          peers,
          policy: status.passwordPolicy === 'basic' ? 'basic' : 'strong',
          notice: null,
          busy: false,
          subAccounts: { ...(current.subAccounts ?? initialSubAccounts()), ...subAccounts },
        }))
      } catch (error) {
        setState(current => ({
          ...current,
          phase: 'error',
          notice: messageOf(error),
          busy: false,
        }))
      }
    }, [api, keyring])

    React.useEffect(() => { void load() }, [load])

    const ensureIdentity = React.useCallback(async (): Promise<ClientIdentity> => {
      if (identityRef.current !== null) return identityRef.current
      const { identity } = await keyring.loadOrCreate()
      identityRef.current = identity
      return identity
    }, [keyring])

    const actions: AccountPageActions = {
      onSubmitBootstrap(username, password) {
        patch({ busy: true, notice: null })
        void api.bootstrap({ username, password })
          .then((result) => {
            patch({
              busy: false,
              enrollment: { otpauth: result.otpauth, backupCodes: result.backupCodes },
              notice: '管理员已创建。请用认证器绑定后，再信任本浏览器。',
            })
            return load()
          })
          .catch(error => patch({ busy: false, notice: messageOf(error) }))
      },
      onSubmitLogin(username, password) {
        patch({ busy: true, notice: null })
        void api.login({ username, password })
          .then((result) => {
            if (result.mfaRequired) {
              patch({ busy: false, phase: 'mfa', mfaToken: result.mfaToken, notice: null })
              return
            }
            return load()
          })
          .catch(error => patch({ busy: false, notice: messageOf(error) }))
      },
      onSubmitMfa(code) {
        const token = state.mfaToken
        if (token === null) {
          patch({ phase: 'login', notice: '登录已过期，请重新输入口令。' })
          return
        }
        patch({ busy: true, notice: null })
        void api.mfa({ mfaToken: token, code })
          .then(() => load())
          .catch(error => patch({ busy: false, notice: messageOf(error) }))
      },
      onChangePassword(currentPassword, newPassword) {
        patch({ busy: true, notice: null })
        void (async () => {
          await api.changePassword({ currentPassword, newPassword })
          // 首次登录这一屏可能同时改了账号名：改密成功后立刻提交改名
          // （改名需要新鲜 2FA，而刚刚的登录/改密会话正好满足）。
          const wanted = state.renameDraft?.trim() ?? ''
          const session = state.status?.session
          if (state.status?.usernameRenameAllowed === true
            && session !== undefined && session !== null
            && wanted.length >= 3 && wanted !== session.username) {
            await api.accounts({ action: 'rename', accountId: session.accountId, username: wanted })
          }
        })()
          .then(() => {
            setDraft(current => ({ ...current, currentPassword: '', newPassword: '' }))
            patch({ busy: false, notice: '口令已更新。' })
            return load()
          })
          .catch(error => patch({ busy: false, notice: messageOf(error) }))
      },
      onSetPasswordPolicy(policy) {
        patch({ busy: true, notice: null })
        void api.setPolicy(policy)
          .then((applied) => {
            patch({
              busy: false,
              policy: applied,
              notice: applied === 'strong' ? '已切换为仅允许强密码。' : '已切换为允许基础口令。',
            })
            return load()
          })
          .catch(error => patch({ busy: false, notice: messageOf(error) }))
      },
      onForgetPeer(targetId) {
        if (deps.forgetPeer === undefined) return
        patch({ busy: true, notice: null })
        void deps.forgetPeer(targetId)
          .then(() => {
            patch({ busy: false, notice: '已移除该对端账号的信任记录。' })
            return load()
          })
          .catch(error => patch({ busy: false, notice: messageOf(error) }))
      },
      onTrustClient(label, ceiling) {
        patch({ busy: true, notice: null })
        void (async () => {
          const identity = await ensureIdentity()
          const enrolled = await api.enroll({
            label,
            clientType: 'browser',
            publicKey: identity.publicKey,
            roleCeiling: ceiling,
          })
          const binding: ClientBinding = {
            clientId: enrolled.client.clientId,
            keyId: enrolled.client.keyId,
            lease: enrolled.lease.lease,
            generation: enrolled.lease.generation,
            expiresAt: enrolled.lease.expiresAt,
          }
          await keyring.saveBinding(binding)
          patch({ binding, busy: false, notice: '本浏览器已受信。刷新页面后 Hub 访问会自动使用该客户端。' })
          return load()
        })().catch(error => patch({ busy: false, notice: messageOf(error) }))
      },
      onRevokeClient(clientId) {
        patch({ busy: true, notice: null })
        void api.clients({ action: 'revoke', clientId })
          .then(async () => {
            const binding = await keyring.loadBinding()
            if (binding?.clientId === clientId) await keyring.clearBinding()
            return load()
          })
          .catch(error => patch({ busy: false, notice: messageOf(error) }))
      },
      onSetRole(clientId, role: RoleName) {
        patch({ busy: true })
        void api.clients({ action: 'setRole', clientId, role })
          .then(() => load())
          .catch(error => patch({ busy: false, notice: messageOf(error) }))
      },
      onSetCeiling(clientId, role: RoleName) {
        patch({ busy: true, notice: null })
        void api.clients({ action: 'setCeiling', clientId, role })
          .then(() => load())
          .catch((error: unknown) => {
            // 抬升上限需要新鲜 2FA：不直接报错，转入「验证以提权」流程。
            if (error instanceof AuthApiError && error.code === 'auth-mfa-required') {
              patch({
                busy: false,
                escalation: { clientId, role, password: '', code: '', error: null },
              })
              return
            }
            patch({ busy: false, notice: messageOf(error) })
          })
      },
      onEscalationChange(field, value) {
        setState(current => (current.escalation === null
          ? current
          : { ...current, escalation: { ...current.escalation, [field]: value, error: null } }))
      },
      onEscalationCancel() {
        patch({ escalation: null })
      },
      onStartTotp() {
        patch({ busy: true, notice: null })
        void api.totp({ action: 'start' })
          .then(result => {
            const secret = result.secret ?? ''
            const otpauth = result.otpauth ?? ''
            patch({
              busy: false,
              totp: { secret, otpauth, backupCodes: result.backupCodes ?? [] },
              totpDraft: { code: '', password: '' },
            })
          })
          .catch(error => patch({ busy: false, notice: messageOf(error) }))
      },
      onTotpChange(field, value) {
        setState(current => ({ ...current, totpDraft: { ...current.totpDraft, [field]: value } }))
      },
      onConfirmTotp() {
        patch({ busy: true, notice: null })
        void api.totp({ action: 'confirm', code: state.totpDraft.code })
          .then(() => {
            patch({ busy: false, totp: null, totpDraft: { code: '', password: '' }, notice: '两步验证已启用。' })
            return load()
          })
          .catch(error => patch({ busy: false, notice: messageOf(error) }))
      },
      onDisableTotp() {
        patch({ busy: true, notice: null })
        void api.totp({
          action: 'disable',
          password: state.totpDraft.password,
          code: state.totpDraft.code,
        })
          .then(() => {
            patch({ busy: false, totpDraft: { code: '', password: '' }, notice: '两步验证已关闭。' })
            return load()
          })
          .catch(error => patch({ busy: false, notice: messageOf(error) }))
      },
      onCancelTotp() {
        patch({ totp: null, totpDraft: { code: '', password: '' } })
      },
      onEscalationSubmit() {
        const pending = state.escalation
        if (pending === null) return
        patch({ busy: true })
        void api.reauth({ password: pending.password, code: pending.code })
          .then(() => api.clients({ action: 'setCeiling', clientId: pending.clientId, role: pending.role }))
          .then(() => {
            patch({ escalation: null, busy: false, notice: '已完成 2FA 验证并提升客户端上限。' })
            return load()
          })
          .catch((error: unknown) => {
            const message = messageOf(error)
            setState(current => (current.escalation === null
              ? { ...current, busy: false, notice: message }
              : { ...current, busy: false, escalation: { ...current.escalation, error: message } }))
          })
      },
      onLogout() {
        patch({ busy: true })
        void api.logout()
          .then(() => load())
          .catch(error => patch({ busy: false, notice: messageOf(error) }))
      },
      onRefresh() {
        patch({ phase: 'loading', busy: false })
        void load()
      },
      onToggleSection(sectionId) {
        setState(current => ({
          ...current,
          expanded: { ...(current.expanded ?? {}), [sectionId]: !(current.expanded ?? {})[sectionId] },
        }))
      },
      // ── 改账号名 ─────────────────────────────────────────────────────────
      onRenameOpen(open) {
        setState(current => ({
          ...current,
          renameOpen: open,
          renameDraft: open ? (current.status?.username ?? current.status?.session?.username ?? '') : current.renameDraft,
          ...(open ? {} : { renamePending: null }),
        }))
      },
      onRenameDraftChange(value) {
        setState(current => ({ ...current, renameDraft: value }))
      },
      onRenameSubmit(username) {
        const session = state.status?.session
        if (session === undefined || session === null) return
        // 改名属于敏感写入：先要求新鲜 2FA，验证通过后再提交。
        setState(current => ({
          ...current,
          renamePending: { username, password: '', code: '', error: null },
        }))
      },
      onRenamePendingChange(field, value) {
        setState(current => current.renamePending === null || current.renamePending === undefined
          ? current
          : { ...current, renamePending: { ...current.renamePending, [field]: value, error: null } })
      },
      onRenameCancel() {
        setState(current => ({ ...current, renamePending: null }))
      },
      onRenameConfirm() {
        const pending = state.renamePending
        const session = state.status?.session
        if (pending === null || pending === undefined || session === undefined || session === null) return
        void (async () => {
          await api.reauth({ password: pending.password, code: pending.code })
          await api.accounts({ action: 'rename', accountId: session.accountId, username: pending.username })
        })()
          .then(() => {
            setState(current => ({ ...current, renamePending: null, renameOpen: false, notice: null }))
            void load()
          })
          .catch((error: unknown) => {
            setState(current => current.renamePending === null || current.renamePending === undefined
              ? current
              : { ...current, renamePending: { ...current.renamePending, error: messageOf(error) } })
          })
      },
      // ── 区块 G：子账号 ────────────────────────────────────────────────────
      onSubCreateOpen(open) {
        setState(current => ({
          ...current,
          subAccounts: {
            ...(current.subAccounts ?? initialSubAccounts()),
            creating: open,
            error: null,
            ...(open ? { created: null } : {}),
          },
        }))
      },
      onSubDraftChange(field, value) {
        setState(current => {
          const sub = current.subAccounts ?? initialSubAccounts()
          return {
            ...current,
            subAccounts: {
              ...sub,
              draft: {
                ...sub.draft,
                [field]: field === 'roleCeiling' ? (isRoleValue(value) ? value : sub.draft.roleCeiling) : value,
              },
            },
          }
        })
      },
      onSubCreate() {
        const sub = state.subAccounts ?? initialSubAccounts()
        const username = sub.draft.username.trim()
        if (username === '') return
        patch({ busy: true })
        void api.accounts({
          action: 'create',
          username,
          ...(sub.draft.password === '' ? {} : { password: sub.draft.password }),
          roleCeiling: sub.draft.roleCeiling,
        })
          .then(result => {
            const created = {
              username: result.account?.username ?? username,
              initialPassword: result.initialPassword ?? null,
            }
            setState(current => ({
              ...current,
              busy: false,
              subAccounts: {
                ...(current.subAccounts ?? initialSubAccounts()),
                accounts: result.account === undefined
                  ? (current.subAccounts?.accounts ?? [])
                  : [...(current.subAccounts?.accounts ?? []), result.account],
                creating: false,
                draft: { username: '', password: '', roleCeiling: 'read-only' },
                created,
                error: null,
              },
            }))
          })
          .catch((error: unknown) => {
            setState(current => ({
              ...current,
              busy: false,
              subAccounts: {
                ...(current.subAccounts ?? initialSubAccounts()),
                error: messageOf(error),
              },
            }))
          })
      },
      onSubCreatedDismiss() {
        setState(current => ({
          ...current,
          subAccounts: { ...(current.subAccounts ?? initialSubAccounts()), created: null },
        }))
      },
      onSubRequest(accountId, action, role) {
        setState(current => {
          const sub = current.subAccounts ?? initialSubAccounts()
          // 「启用」不需要新鲜 2FA：直接执行。
          if (action === 'enable') {
            void runSubAction(accountId, { action: 'enable' })
            return current
          }
          if (action === 'delete' && sub.confirmingDelete !== accountId) {
            // 第一次点删除 → 展开红色二次确认。
            return {
              ...current,
              subAccounts: { ...sub, confirmingDelete: accountId, pending: null, error: null },
            }
          }
          return {
            ...current,
            subAccounts: {
              ...sub,
              confirmingDelete: null,
              pending: {
                accountId,
                action,
                ...(role === undefined ? {} : { role }),
                password: '',
                code: '',
                error: null,
              },
            },
          }
        })
      },
      onSubPendingChange(field, value) {
        setState(current => {
          const sub = current.subAccounts ?? initialSubAccounts()
          if (sub.pending === null) return current
          return {
            ...current,
            subAccounts: { ...sub, pending: { ...sub.pending, [field]: value, error: null } },
          }
        })
      },
      onSubCancel() {
        setState(current => {
          const sub = current.subAccounts ?? initialSubAccounts()
          return { ...current, subAccounts: { ...sub, pending: null, confirmingDelete: null, error: null } }
        })
      },
      onSubConfirm() {
        const sub = state.subAccounts ?? initialSubAccounts()
        const pending = sub.pending
        if (pending === null) return
        patch({ busy: true })
        void (async () => {
          await api.reauth({ password: pending.password, code: pending.code })
          if (pending.action === 'disable') await runSubAction(pending.accountId, { action: 'disable' })
          else if (pending.action === 'delete') await runSubAction(pending.accountId, { action: 'delete' })
          else if (pending.action === 'ceiling') {
            await runSubAction(pending.accountId, {
              action: 'setCeiling',
              role: pending.role ?? 'read-only',
            })
          }
        })()
          .then(() => load())
          .catch((error: unknown) => {
            const message = messageOf(error)
            setState(current => {
              const now = current.subAccounts ?? initialSubAccounts()
              return {
                ...current,
                busy: false,
                subAccounts: now.pending === null
                  ? { ...now, error: message }
                  : { ...now, pending: { ...now.pending, error: message } },
              }
            })
          })
      },
    }

    /**
     * 执行一条子账号动作（不需要 / 已完成新鲜 2FA 时直接调用）。
     * @param accountId - 目标账号。
     * @param action - 动作。
     */
    async function runSubAction(
      accountId: string,
      action:
        | { action: 'enable' }
        | { action: 'disable' }
        | { action: 'delete' }
        | { action: 'setCeiling'; role: RoleName },
    ): Promise<void> {
      try {
        if (action.action === 'delete') await api.accounts({ action: 'delete', accountId })
        else if (action.action === 'setCeiling') await api.accounts({ action: 'setCeiling', accountId, role: action.role })
        else await api.accounts({ action: action.action, accountId })
        const refreshed = await api.accounts({ action: 'list' })
        setState(current => ({
          ...current,
          busy: false,
          subAccounts: {
            ...(current.subAccounts ?? initialSubAccounts()),
            accounts: refreshed.accounts ?? [],
            pending: null,
            confirmingDelete: null,
            error: null,
          },
        }))
      } catch (error) {
        const message = messageOf(error)
        setState(current => {
          const sub = current.subAccounts ?? initialSubAccounts()
          return {
            ...current,
            busy: false,
            subAccounts: sub.pending === null
              ? { ...sub, error: message }
              : { ...sub, pending: { ...sub.pending, error: message } },
          }
        })
      }
    }

    return renderAccountPage(state, actions, draft, setDraft)
  }
}
