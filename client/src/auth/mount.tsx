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
  renderAccountPage,
  type AccountPageActions,
  type AccountFormDraft,
  type AccountPageState,
  type PeerAccountRow,
} from './AccountPage.js'
import { createAuthApi, AuthApiError, type AuthApi } from './api.js'
import { createKeyring, type ClientBinding, type ClientIdentity } from './keyring.js'

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
    if (value.code === 'auth-rate-limited') return '尝试次数过多，请稍后再试。'
    if (value.code === 'auth-invalid-credentials') return '用户名或口令不正确。'
    if (value.code === 'auth-mfa-invalid') return '验证码不正确，请重试。'
    if (value.code === 'auth-mfa-expired') return '验证已过期，请重新登录。'
    if (value.code === 'auth-forbidden') return '该操作需要先完成双因素验证，或当前账号无权执行。'
    if (value.code === 'auth-password-change-required') return '请先修改初始口令。'
    if (value.code === 'auth-current-password-invalid') return '当前口令不正确。'
    if (value.code === 'auth-password-weak') return '口令不满足当前策略，请按下方清单逐项补齐。'
    if (value.code === 'auth-password-unchanged') return '新口令不能与当前口令相同。'
    if (typeof value.message === 'string') return value.message
  }
  return '请求失败，请重试。'
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
    })
    const [draft, setDraft] = React.useState<AccountFormDraft>(initialDraft)
    const identityRef = React.useRef<ClientIdentity | null>(null)

    const patch = React.useCallback((next: Partial<AccountPageState>) => {
      setState(current => ({ ...current, ...next }))
    }, [])

    const load = React.useCallback(async () => {
      try {
        const status = await api.status()
        const binding = await keyring.loadBinding()
        // 对端账号独立于本机认证：档案读失败不影响本机账号操作。
        const peers = deps.loadPeers === undefined
          ? []
          : await deps.loadPeers().catch(() => [] as readonly PeerAccountRow[])
        const session = status.session
        let phase: AccountPageState['phase']
        if (session === null) phase = status.bootstrapped ? 'login' : 'bootstrap'
        // 默认账号首次登录：先改密，改完之前不展示 2FA / 信任 / 客户端管理。
        else if (status.passwordChangeRequired === true) phase = 'change-password'
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
        void api.changePassword({ currentPassword, newPassword })
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
    }

    return renderAccountPage(state, actions, draft, setDraft)
  }
}
