/**
 * 认证服务：账号 / TOTP / 浏览器会话 / 可信客户端 / 7 天租约 / 请求签名校验。
 *
 * 威胁模型与不变量：
 * - 口令失败按账号 + 时间窗限速；比较走常量时间。
 * - TOTP 挑战一次性、5 分钟、5 次错误即烧；错误码不区分「口令错」与「账号不存在」。
 * - 浏览器会话是**有状态**的（服务端可撤销），Cookie 只承载 `<sid>.<secret>`，
 *   服务端只存 `sha256(secret)`。
 * - 租约是 `<clientId>.<generation>.<secret>`，服务端只存 `sha256(secret)`；
 *   轮换后旧代次立即失效，且**重放旧代次会撤销该客户端**（令牌被偷的强信号）。
 * - Hub 请求必须同时满足：租约有效 + 客户端签名（方法/路径/目标/时间/nonce/正文摘要）。
 *
 * @module dsh-remote-hub/host/auth/service
 */
import { randomBytes } from 'node:crypto'

import type {
  AccountView,
  AuthClaims,
  AuthErrorCode,
  AuthSessionView,
  AuthStatusResponse,
  ClientPublicKeyJwk,
  ClientType,
  EnrollClientRequest,
  EnrollClientResponse,
  HubAuthPort,
  HubAuthVerdict,
  HubAuthVerifyInput,
  LeaseGrant,
  LoginRequest,
  LoginResponse,
  MfaRequest,
  TrustedClientView,
} from '@core/auth.js'
import {
  AUTH_ERROR_CODES,
  AUTH_HEADERS,
  DEFAULT_PASSWORD_POLICY,
  LEASE_RENEW_WINDOW_MS,
  LEASE_TTL_MS,
  MFA_TRUST_WINDOW_MS,
  PROOF_MAX_SKEW_MS,
  PROOF_NONCE_TTL_MS,
  SESSION_TTL_MS,
  SESSION_IDLE_MS,
  buildProofPayload,
  evaluatePassword,
  isPasswordPolicy,
  type PasswordPolicy,
} from '@core/auth.js'
import { ROLE_FULL, isRoleName, roleAtMost, type RoleName } from '@core/roles.js'

import {
  hashPassword,
  isClientPublicKeyJwk,
  publicKeyFingerprint,
  randomToken,
  sha256Hex,
  verifyEcdsa,
  verifyPassword,
} from './crypto.js'
import type { AccountRecord, AuthStore, AuthStoreData, ClientRecord, SessionRecord } from './store.js'
import { newAccountId, newClientId, newKeyId, newSessionId } from './store.js'
import {
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCode,
  otpauthUri,
  secondsRemaining,
  verifyTotp,
} from './totp.js'

/** 一次密码校验通过后的会话签发结果。 */
export interface IssuedSession {
  session: AuthSessionView
  /** `Set-Cookie` 的值（`dsh_hub_session=<sid>.<secret>`）。 */
  cookie: string
}

/** 引导结果：额外一次性返回 TOTP 密钥与备用码（**只此一次**）。 */
export interface BootstrapResult extends IssuedSession {
  totpSecret: string
  otpauth: string
  backupCodes: string[]
}

/** 认证服务的公开面（Host 进程内使用）。 */
export interface AuthService extends HubAuthPort {
  status(sessionToken?: string): Promise<AuthStatusResponse>
  /** 首个管理员引导；调用方必须已确认请求来自回环。 */
  bootstrap(input: { username: string; password: string }): Promise<BootstrapResult>
  login(input: LoginRequest): Promise<
    | { ok: true; response: LoginResponse; cookie?: string }
    | { ok: false; code: AuthErrorCode; reason: string }
  >
  verifyMfa(input: MfaRequest): Promise<IssuedSession | { error: AuthErrorCode; reason: string }>
  logout(sessionToken?: string): Promise<void>
  /** 读取会话（同时节流更新 lastSeenAt）。 */
  readSession(sessionToken?: string): Promise<{ record: SessionRecord; view: AuthSessionView } | null>
  /** 注册可信客户端（需要已认证会话 + 最近 2FA）。 */
  enroll(sessionToken: string | undefined, input: EnrollClientRequest): Promise<EnrollClientResponse>
  /**
   * 修改口令。
   *
   * 默认账号首次登录时 `status.passwordChangeRequired === true`，改密成功后清除
   * （**只强制一次**）；之后仍可凭当前口令再次修改。
   */
  changePassword(
    sessionToken: string | undefined,
    input: { currentPassword: string; newPassword: string },
  ): Promise<{ ok: true }>
  /** 是否仍需强制改密（无会话时为 false）。 */
  passwordChangeRequired(sessionToken?: string): Promise<boolean>
  /** 当前生效的口令策略。 */
  passwordPolicy(): PasswordPolicy
  /** 切换口令策略（仅管理员会话；立即生效，无需重启）。 */
  setPasswordPolicy(sessionToken: string | undefined, policy: PasswordPolicy): Promise<PasswordPolicy>
  /** 账号列表（admin）。 */
  listAccounts(sessionToken: string | undefined): Promise<AccountView[]>
  /**
   * 创建子账号（admin；要求新鲜 2FA）。
   *
   * 未提供口令时生成一次性初始口令，返回一次；该账号首次登录必须改密。
   */
  createAccount(
    sessionToken: string | undefined,
    input: { username: string; password?: string; roleCeiling?: RoleName },
  ): Promise<{ account: AccountView; initialPassword?: string }>
  /** 调整账号上限（admin；抬高要求新鲜 2FA）。 */
  setAccountCeiling(sessionToken: string | undefined, accountId: string, role: RoleName): Promise<AccountView>
  /** 禁用子账号：会话失效、名下客户端全部撤销。 */
  disableAccount(sessionToken: string | undefined, accountId: string): Promise<AccountView>
  /** 重新启用子账号。 */
  enableAccount(sessionToken: string | undefined, accountId: string): Promise<AccountView>
  /** 删除子账号（连同其客户端与会话）。 */
  deleteAccount(sessionToken: string | undefined, accountId: string): Promise<void>
  /** 首次启动：无账号时用默认口令创建一个「必须先改密」的账号。 */
  seedDefaultAccount(input: { username: string; password: string }): Promise<boolean>
  /** 账号是否仍在等待初始改密（无账号 / 已完成 → false）。 */
  initialPasswordPending(): boolean
  listClients(sessionToken: string | undefined): Promise<TrustedClientView[]>
  /** 守卫用：不需要会话即可列出全部客户端（账号模式下的「设备表」）。 */
  listTrustedClients(): readonly TrustedClientView[]
  /**
   * 用**邀请**登记一个可信客户端（不需要浏览器会话）。
   *
   * 授权来自本机管理员签发的短时一次性邀请（角色上限随邀请携带），
   * 因此这里不要求会话与 2FA，但仍然只接受 ECDSA P-256 公钥。
   */
  enrollFromInvite(input: {
    label: string
    clientType: ClientType
    publicKey: ClientPublicKeyJwk
    roleCeiling: RoleName
  }): Promise<EnrollClientResponse>
  /**
   * 单控：把 `keepClientId` 之外的客户端标记为被挤下线，返回**本次新挤掉**的 id。
   *
   * 只改标记，不断连接；断连由 Hub 的 `onSessionDisplaced` 负责。
   */
  displaceOthers(keepClientId: string): Promise<readonly string[]>
  revokeClient(sessionToken: string | undefined, clientId: string): Promise<void>
  setActiveRole(sessionToken: string | undefined, clientId: string, role: RoleName): Promise<TrustedClientView>
  setRoleCeiling(sessionToken: string | undefined, clientId: string, role: RoleName): Promise<TrustedClientView>
  /**
   * 在当前会话上重新做一次双因素验证（口令 + TOTP/备用码）。
   *
   * 只刷新 `lastMfaAt`（提权窗口）；**同时轮换会话密钥**并返回新 cookie。
   */
  reauth(
    sessionToken: string | undefined,
    input: { password: string; code: string },
  ): Promise<{ ok: true; session: AuthSessionView; cookie: string }>
  /** 用客户端私钥证明换取 / 轮换租约（无需浏览器会话）。 */
  renewLease(input: {
    /** 当前租约明文（`Authorization: Bearer` 里的值）。 */
    lease: string
    keyId: string
    generation: number
    proofHeaders: Readonly<Record<string, string | undefined>>
    audience: string
    method: string
    path: string
    bodyDigest: string
  }): Promise<LeaseGrant | { error: AuthErrorCode; reason: string }>
  /** 开启 TOTP 绑定（返回一次性密钥与备用码）。 */
  startTotpSetup(sessionToken: string | undefined, username?: string): Promise<{
    secret: string
    otpauth: string
    backupCodes: string[]
    secondsRemaining: number
  }>
  /** 确认绑定（需要一次正确的动态码）。 */
  confirmTotp(sessionToken: string | undefined, code: string): Promise<void>
  /** 关闭 TOTP（需要口令 + 一次正确动态码）。 */
  disableTotp(sessionToken: string | undefined, password: string, code: string): Promise<void>
  /** 剩余有效秒数（UI 倒计时用）。 */
  totpSecondsRemaining(): number
}

/** 依赖。 */
export interface AuthServiceDeps {
  store: AuthStore
  /** 注入时钟（测试用）。 */
  now?: () => number
  /** 认证器里显示的 issuer。 */
  issuer?: string
  /** 是否强制 MFA；默认 true。 */
  requireMfa?: boolean
  /** 登录失败预算。 */
  maxLoginAttempts?: number
  /** 登录失败窗口。 */
  loginWindowMs?: number
  /**
   * 强制改密成功时调用一次。
   *
   * 插件用它删除初始口令文件（明文只活到这一刻）。
   */
  onForcedPasswordChanged?: () => void | Promise<void>
  /** 默认口令策略（存储里没有设置时使用；默认 strong）。 */
  defaultPasswordPolicy?: PasswordPolicy
}

const DEFAULT_MAX_LOGIN_ATTEMPTS = 5
const DEFAULT_LOGIN_WINDOW_MS = 15 * 60_000
const MAX_MFA_ATTEMPTS = 5
const MFA_TOKEN_TTL_MS = 5 * 60_000

/** 解析 `Authorization` 里的 Bearer 租约。 */
function leaseFromHeader(value: string | undefined): string {
  if (typeof value !== 'string') return ''
  if (!value.startsWith('Bearer ')) return ''
  return value.slice('Bearer '.length).trim()
}

/** 解析租约 `<clientId>.<generation>.<secret>`。 */
function parseLease(lease: string): { clientId: string; generation: number; secret: string } | null {
  const parts = lease.split('.')
  if (parts.length !== 3) return null
  const [clientId, generationText, secret] = parts
  if (clientId === undefined || generationText === undefined || secret === undefined) return null
  if (!/^cli_[0-9a-f]{24}$/u.test(clientId)) return null
  if (!/^\d{1,9}$/u.test(generationText)) return null
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(secret)) return null
  return { clientId, generation: Number(generationText), secret }
}

/** 解析会话 Cookie `<sid>.<secret>`。 */
function parseSessionToken(token: string | undefined): { sid: string; secret: string } | null {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [sid, secret] = parts
  if (sid === undefined || secret === undefined) return null
  if (!/^sid_[0-9a-f]{24}$/u.test(sid)) return null
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(secret)) return null
  return { sid, secret }
}

/** 全部账号（兼容只有 `account` 的 v1 存储）。 */
function accountsOf(store: AuthStore) {
  return store.data.accounts ?? (store.data.account === null ? [] : [store.data.account])
}

/** 管理员账号（单账号迁移期与全局配置用）。 */
function accountOf(store: AuthStore) {
  const list = accountsOf(store)
  return list.find(account => account.isAdmin !== false) ?? list[0] ?? null
}

/** 按 username 精确查找（区分大小写）。 */
function findAccountByName(store: AuthStore, username: string) {
  return accountsOf(store).find(account => account.username === username) ?? null
}

/** 按 accountId 查找。 */
function findAccountById(store: AuthStore, accountId: string | undefined) {
  if (accountId === undefined) return null
  return accountsOf(store).find(account => (account.accountId ?? 'acc_admin') === accountId) ?? null
}

/** 会话所属账号。 */
function accountForSession(store: AuthStore, record: SessionRecord) {
  return findAccountById(store, record.accountId) ?? accountOf(store)
}

/**
 * 创建认证服务。
 * @param deps - 存储、时钟与策略参数。
 * @returns `AuthService`（同时实现 `HubAuthPort`）。
 */
export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { store } = deps
  const now = deps.now ?? (() => Date.now())
  const issuer = deps.issuer ?? 'DeepSeek Harness'
  const requireMfa = deps.requireMfa ?? true
  const maxLoginAttempts = deps.maxLoginAttempts ?? DEFAULT_MAX_LOGIN_ATTEMPTS
  const loginWindowMs = deps.loginWindowMs ?? DEFAULT_LOGIN_WINDOW_MS
  const onForcedPasswordChanged = deps.onForcedPasswordChanged
  const fallbackPolicy: PasswordPolicy = deps.defaultPasswordPolicy ?? DEFAULT_PASSWORD_POLICY

  /** 当前生效的口令策略：存储里的设置优先，否则用配置默认值。 */
  function currentPolicy(): PasswordPolicy {
    const stored = store.data.settings?.passwordPolicy
    return isPasswordPolicy(stored) ? stored : fallbackPolicy
  }

  /** 校验口令并抛出带失败清单的错误（UI 直接展示）。 */
  function assertPasswordAcceptable(password: string, username: string): void {
    const verdict = evaluatePassword(password, currentPolicy(), username)
    if (verdict.ok) return
    throw Object.assign(new Error(`password does not meet the ${currentPolicy()} policy`), {
      code: AUTH_ERROR_CODES.passwordWeak,
      failures: verdict.failures,
    })
  }

  const revokedListeners = new Set<(clientId: string) => void>()
  const roleListeners = new Set<(clientId: string, role: RoleName) => void>()
  /** 登录失败限速：username → { count, resetAt }。 */
  const loginFailures = new Map<string, { count: number; resetAt: number }>()
  /** lastSeen 节流。 */
  const lastSeenTouch = new Map<string, number>()
  const TOUCH_THROTTLE_MS = 60_000

  function sessionView(record: SessionRecord): AuthSessionView {
    const account = accountForSession(store, record)
    return {
      accountId: account?.accountId ?? 'acc_admin',
      username: account?.username ?? '',
      // 会话角色：管理员恒为 admin；子账号按其账号上限显示（实际权限仍逐请求判）。
      role: account?.isAdmin === false ? 'control' : 'admin',
      createdAt: new Date(record.createdAt).toISOString(),
      expiresAt: record.expiresAt,
      lastMfaAt: record.lastMfaAt,
    }
  }

  function clientView(record: ClientRecord): TrustedClientView {
    // 归属账号：客户端按 `accountId` 归属某个账号；v1 单账号迁移期没有该字段，
    // 回退到默认管理员（`acc_admin`），保证 UI 永远能显示「账号 xxx」。
    const ownerId = record.accountId ?? 'acc_admin'
    const owner = findAccountById(store, ownerId) ?? accountOf(store)
    return {
      clientId: record.clientId,
      keyId: record.keyId,
      label: record.label,
      clientType: record.clientType,
      fingerprint: record.fingerprint,
      roleCeiling: record.roleCeiling,
      activeRole: record.activeRole,
      createdAt: new Date(record.createdAt).toISOString(),
      lastSeenAt: record.lastSeenAt === null ? null : new Date(record.lastSeenAt).toISOString(),
      leaseExpiresAt: record.leaseExpiresAt,
      leaseGeneration: record.leaseGeneration,
      displacedAt: record.displacedAt === undefined || record.displacedAt === null
        ? null
        : new Date(record.displacedAt).toISOString(),
      revokedAt: record.revokedAt === null ? null : new Date(record.revokedAt).toISOString(),
      accountId: owner?.accountId ?? ownerId,
      username: owner?.username ?? null,
    }
  }

  function pruneNonces(): void {
    const at = now()
    for (const [nonce, expiresAt] of Object.entries(store.data.nonces)) {
      if (expiresAt <= at) delete store.data.nonces[nonce]
    }
    // 会话/挑战也顺手清理，避免文件无限增长。
    store.data.sessions = store.data.sessions.filter(session => session.expiresAt > at)
    store.data.challenges = store.data.challenges.filter(challenge => challenge.expiresAt > at)
  }

  function findSession(record: { sid: string }): SessionRecord | undefined {
    return store.data.sessions.find(session => session.sid === record.sid)
  }

  function issueCookie(sid: string, secret: string): string {
    return `${sid}.${secret}`
  }

  async function createSession(
    record: { lastMfaAt: number | null },
    ttlMs: number = SESSION_TTL_MS,
    accountId: string = 'acc_admin',
  ): Promise<IssuedSession> {
    const at = now()
    const sid = newSessionSid()
    const secret = randomToken()
    const session: SessionRecord = {
      sid,
      accountId,
      secretHash: sha256Hex(secret),
      createdAt: at,
      expiresAt: at + ttlMs,
      lastSeenAt: at,
      lastMfaAt: record.lastMfaAt,
      revokedAt: null,
    }
    await store.mutate(data => { data.sessions.push(session) })
    // 只保留最近 20 个会话，避免文件膨胀（旧会话本来也会过期）。
    if (store.data.sessions.length > 20) {
      const alive = store.data.sessions.filter(row => row.expiresAt > at).slice(-20)
      await store.mutate(data => { data.sessions = alive })
    }
    return { session: sessionView(session), cookie: issueCookie(sid, secret) }
  }

  function newSessionSid(): string {
    return newSessionId()
  }

  async function readSessionInternal(token: string | undefined): Promise<{ record: SessionRecord; view: AuthSessionView } | null> {
    const parsed = parseSessionToken(token)
    if (parsed === null) return null
    const record = findSession(parsed)
    if (record === undefined) return null
    const at = now()
    if (record.revokedAt !== null) return null
    if (record.expiresAt <= at) return null
    if (record.secretHash !== sha256Hex(parsed.secret)) return null
    // 闲置超时：长时间没用过的会话直接作废（绝对有效期之外的第二道闸）。
    if (record.lastSeenAt !== null && at - record.lastSeenAt > SESSION_IDLE_MS) {
      void store.mutate((data) => {
        const row = data.sessions.find(session => session.sid === record.sid)
        if (row !== undefined && row.revokedAt === null) row.revokedAt = at
      }, { deferred: true }).catch(() => { /* 忽略 */ })
      return null
    }
    // 节流更新 lastSeenAt。
    const previous = lastSeenTouch.get(record.sid) ?? 0
    if (at - previous >= TOUCH_THROTTLE_MS) {
      lastSeenTouch.set(record.sid, at)
      void store.mutate((data) => {
        const row = data.sessions.find(session => session.sid === record.sid)
        if (row !== undefined) row.lastSeenAt = at
      }, { deferred: true }).catch(() => { /* 心跳失败不影响认证 */ })
    }
    return { record, view: sessionView(record) }
  }

  /**
   * 限流桶：`src:<来源>` 与 `user:<用户名>` 分别计数。
   *
   * 只按用户名计数时，知道账号名的攻击者每窗口失败几次就能把管理员锁死；
   * 因此**来源**是主控制（默认 5 次/窗口），用户名维度更宽（4×），
   * 两者都超过才拒绝，且窗口结束自动恢复。
   */
  function checkBucket(key: string, limit: number): { ok: true } | { ok: false; retryAfterMs: number } {
    const at = now()
    const entry = loginFailures.get(key)
    if (entry === undefined || entry.resetAt <= at) return { ok: true }
    if (entry.count < limit) return { ok: true }
    return { ok: false, retryAfterMs: entry.resetAt - at }
  }

  function bumpBucket(key: string): void {
    const at = now()
    const entry = loginFailures.get(key)
    if (entry === undefined || entry.resetAt <= at) {
      loginFailures.set(key, { count: 1, resetAt: at + loginWindowMs })
      return
    }
    entry.count += 1
  }

  function checkLoginRate(username: string, source: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const bySource = checkBucket(`src:${source}`, maxLoginAttempts)
    if (!bySource.ok) return bySource
    return checkBucket(`user:${username}`, maxLoginAttempts * 4)
  }

  function recordLoginFailure(username: string, source: string): void {
    bumpBucket(`src:${source}`)
    bumpBucket(`user:${username}`)
  }

  /** 成功登录清空该来源与该用户名的失败计数（不惩罚正常用户）。 */
  function clearLoginFailures(username: string, source: string): void {
    loginFailures.delete(`src:${source}`)
    loginFailures.delete(`user:${username}`)
  }

  function currentLease(client: ClientRecord, generation: number, secret: string): boolean {
    if (client.leaseHash === null || client.leaseExpiresAt === null) return false
    if (generation !== client.leaseGeneration) return false
    return client.leaseHash === sha256Hex(secret) && client.leaseExpiresAt > now()
  }

  async function rotateLease(client: ClientRecord): Promise<LeaseGrant> {
    const generation = client.leaseGeneration + 1
    const secret = randomToken()
    const expiresAt = now() + LEASE_TTL_MS
    await store.mutate((data) => {
      const row = data.clients.find(item => item.clientId === client.clientId)
      if (row === undefined) return
      row.leaseHash = sha256Hex(secret)
      row.leaseGeneration = generation
      row.leaseExpiresAt = expiresAt
      row.lastSeenAt = now()
    })
    return {
      lease: `${client.clientId}.${generation}.${secret}`,
      generation,
      expiresAt,
    }
  }

  /** 统一校验「租约 + 签名」。 */
  async function verifySigned(input: {
    lease: string
    method: string
    path: string
    audience: string
    bodyDigest: string
    headers: Readonly<Record<string, string | undefined>>
    /** 已知代次时（轮换）用来判断是否旧代次重放。 */
    expectGeneration?: number
  }): Promise<{ ok: true; client: ClientRecord; generation: number } | { ok: false; code: AuthErrorCode; reason: string }> {
    const parsed = parseLease(input.lease)
    if (parsed === null) return { ok: false, code: AUTH_ERROR_CODES.unauthorized, reason: 'malformed lease' }
    const client = store.data.clients.find(item => item.clientId === parsed.clientId)
    if (client === undefined || client.revokedAt !== null) {
      return { ok: false, code: AUTH_ERROR_CODES.clientInvalid, reason: 'unknown or revoked client' }
    }

    // 旧代次重放：租约被复制到别处的强信号 → 撤销该客户端。
    if (parsed.generation < client.leaseGeneration) {
      await revokeByClientId(client.clientId)
      return { ok: false, code: AUTH_ERROR_CODES.leaseExpired, reason: 'stale lease generation (replay detected)' }
    }
    if (!currentLease(client, parsed.generation, parsed.secret)) {
      return { ok: false, code: AUTH_ERROR_CODES.leaseExpired, reason: 'lease expired or rotated' }
    }

    const headerClientId = input.headers[AUTH_HEADERS.clientId]
    const headerKeyId = input.headers[AUTH_HEADERS.keyId]
    const timestamp = input.headers[AUTH_HEADERS.timestamp]
    const nonce = input.headers[AUTH_HEADERS.nonce]
    const signature = input.headers[AUTH_HEADERS.signature]
    const bodyDigest = input.headers[AUTH_HEADERS.bodyDigest]

    if (headerClientId !== client.clientId || headerKeyId !== client.keyId) {
      return { ok: false, code: AUTH_ERROR_CODES.proofInvalid, reason: 'client/key header mismatch' }
    }
    if (typeof timestamp !== 'string' || !/^\d{1,16}$/u.test(timestamp)) {
      return { ok: false, code: AUTH_ERROR_CODES.proofInvalid, reason: 'missing timestamp' }
    }
    const at = now()
    const skew = Math.abs(at - Number(timestamp))
    if (skew > PROOF_MAX_SKEW_MS) {
      return { ok: false, code: AUTH_ERROR_CODES.proofInvalid, reason: 'timestamp outside allowed skew' }
    }
    if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/u.test(nonce)) {
      return { ok: false, code: AUTH_ERROR_CODES.proofInvalid, reason: 'missing nonce' }
    }
    if (typeof signature !== 'string' || signature === '') {
      return { ok: false, code: AUTH_ERROR_CODES.proofInvalid, reason: 'missing signature' }
    }
    if ((bodyDigest ?? '') !== input.bodyDigest) {
      return { ok: false, code: AUTH_ERROR_CODES.proofInvalid, reason: 'body digest mismatch' }
    }

    // 一次性 nonce：进程内立即生效；落盘走节流。
    pruneNonces()
    const nonceKey = `${client.clientId}:${nonce}`
    if (store.data.nonces[nonceKey] !== undefined) {
      return { ok: false, code: AUTH_ERROR_CODES.proofInvalid, reason: 'nonce already used' }
    }

    const payload = buildProofPayload({
      method: input.method,
      path: input.path,
      audience: input.audience,
      timestamp,
      nonce,
      clientId: client.clientId,
      keyId: client.keyId,
      generation: parsed.generation,
      bodyDigest: input.bodyDigest,
    })
    if (!verifyEcdsa(client.publicKey, payload, signature)) {
      return { ok: false, code: AUTH_ERROR_CODES.proofInvalid, reason: 'signature invalid' }
    }

    store.data.nonces[nonceKey] = at + PROOF_NONCE_TTL_MS
    void store.mutate(() => { /* data 已就地修改，这里只触发落盘 */ }, { deferred: true }).catch(() => {})

    if (input.expectGeneration !== undefined && parsed.generation !== input.expectGeneration) {
      return { ok: false, code: AUTH_ERROR_CODES.leaseExpired, reason: 'generation mismatch' }
    }
    return { ok: true, client, generation: parsed.generation }
  }

  async function revokeByClientId(clientId: string): Promise<void> {
    const client = store.data.clients.find(item => item.clientId === clientId)
    if (client === undefined || client.revokedAt !== null) return
    await store.mutate((data) => {
      const row = data.clients.find(item => item.clientId === clientId)
      if (row === undefined) return
      row.revokedAt = now()
      row.leaseHash = null
      row.leaseExpiresAt = null
    })
    for (const listener of [...revokedListeners]) listener(clientId)
  }

  /**
   * 校验并登记一个可信客户端（会话登记与邀请兑换共用）。
   *
   * 同一把公钥重复登记时**复用记录并轮换租约**（页面刷新 / 重连场景），
   * 不会堆出多个只差密钥的记录。
   */
  async function registerClient(input: {
    label: string
    clientType: ClientType
    publicKey: ClientPublicKeyJwk
    roleCeiling: RoleName
  }, accountId: string = 'acc_admin'): Promise<EnrollClientResponse> {
    // 角色不得超过账号上限：子账号不能借注册客户端绕过自己的天花板。
    const accountCap = findAccountById(store, accountId)?.roleCeiling ?? 'full'
    const requestedRole = roleAtMost(input.roleCeiling, accountCap) ? input.roleCeiling : accountCap
    if (!isClientPublicKeyJwk(input.publicKey)) {
      throw Object.assign(new Error('publicKey must be an ECDSA P-256 JWK'), { code: AUTH_ERROR_CODES.badRequest })
    }
    if (input.clientType !== 'browser' && input.clientType !== 'app' && input.clientType !== 'dsh') {
      throw Object.assign(new Error('invalid clientType'), { code: AUTH_ERROR_CODES.badRequest })
    }
    if (!isRoleName(input.roleCeiling)) {
      throw Object.assign(new Error('invalid roleCeiling'), { code: AUTH_ERROR_CODES.badRequest })
    }
    const label = String(input.label ?? '').trim().slice(0, 80)
    if (label === '') {
      throw Object.assign(new Error('label required'), { code: AUTH_ERROR_CODES.badRequest })
    }

    const at = now()
    const keyId = newKeyId(input.publicKey)
    const existing = store.data.clients.find(row => row.revokedAt === null && row.keyId === keyId
      && (row.accountId ?? 'acc_admin') === accountId)
    if (existing !== undefined) {
      const lease = await rotateLease(existing)
      return { ok: true, client: clientView(existing), lease }
    }

    const clientId = newClientId()
    const secret = randomToken()
    const expiresAt = at + LEASE_TTL_MS
    const record: ClientRecord = {
      accountId,
      clientId,
      keyId,
      label,
      clientType: input.clientType,
      publicKey: input.publicKey,
      fingerprint: publicKeyFingerprint(input.publicKey),
      roleCeiling: requestedRole,
      activeRole: requestedRole,
      leaseHash: sha256Hex(secret),
      leaseGeneration: 1,
      leaseExpiresAt: expiresAt,
      createdAt: at,
      lastSeenAt: at,
      revokedAt: null,
    }
    await store.mutate((data) => { data.clients.push(record) })
    return {
      ok: true,
      client: clientView(record),
      lease: { lease: `${clientId}.1.${secret}`, generation: 1, expiresAt },
    }
  }

  async function requireSession(token: string | undefined): Promise<{ record: SessionRecord; view: AuthSessionView }> {    const session = await readSessionInternal(token)
    if (session === null) {
      throw Object.assign(new Error('session required'), { code: AUTH_ERROR_CODES.unauthorized })
    }
    return session
  }

  /**
   * 会话 + 「已完成强制改密」双重前置。
   *
   * 默认账号在改密之前**不能**绑定 2FA、信任客户端或轮换租约——因此也拿不到
   * 访问 Hub 的凭据。改密成功后标记永久清除（只强制一次）。
   */
  async function requireReadySession(token: string | undefined): Promise<{ record: SessionRecord; view: AuthSessionView }> {
    const session = await requireSession(token)
    if (accountForSession(store, session.record)?.mustChangePassword === true) {
      throw Object.assign(new Error('change the initial password first'), {
        code: AUTH_ERROR_CODES.passwordChangeRequired,
      })
    }
    return session
  }

  /**
   * 提权前的「新鲜双因素」检查。
   *
   * 只对**抬高**权限的动作生效（例如把客户端上限提到 `full`）：一个 7 天前
   * 验证过的会话不足以提权，必须重新过口令 + TOTP。
   */
  function requireFreshMfa(session: { record: SessionRecord }): void {
    const at = session.record.lastMfaAt
    if (at === null || now() - at > MFA_TRUST_WINDOW_MS) {
      throw Object.assign(new Error('recent two-factor verification required to raise privileges'), {
        code: AUTH_ERROR_CODES.mfaRequired,
      })
    }
  }

  /** 管理员会话（账号管理的唯一入口）。 */
  async function requireAdmin(token: string | undefined): Promise<{ record: SessionRecord; view: AuthSessionView }> {
    const session = await requireReadySession(token)
    const account = accountForSession(store, session.record)
    if (account === null || account.isAdmin === false) {
      throw Object.assign(new Error('administrator only'), { code: AUTH_ERROR_CODES.forbidden })
    }
    return session
  }

  /** 一次性初始口令（满足 strong 策略：大小写 + 数字 + 符号，≥12 位）。 */
  function generateInitialPassword(): string {
    return `Dsh-${randomBytes(10).toString('hex')}-A9!`
  }

  /** 账号视图。 */
  function accountViewOf(account: AccountRecord): AccountView {
    return {
      accountId: account.accountId ?? 'acc_admin',
      username: account.username,
      isAdmin: account.isAdmin !== false,
      roleCeiling: account.roleCeiling ?? 'full',
      disabledAt: account.disabledAt ?? null,
      lastLoginAt: account.lastLoginAt ?? null,
      createdAt: account.createdAt,
    }
  }

  /** 审计事件（失败不影响认证主流程）。 */
  function audit(
    kind: string,
    detail: Record<string, unknown>,
    ids: { accountId?: string | null; clientId?: string | null } = {},
  ): void {
    try {
      store.appendAudit?.({
        at: now(),
        kind,
        accountId: ids.accountId ?? null,
        clientId: ids.clientId ?? null,
        detail: JSON.stringify(detail),
      })
    } catch {
      // 审计只是旁路：写失败不能拒绝登录/管理操作。
    }
  }

  /** 账号表内的查找（在 mutate 回调里用，避免读到旧快照）。 */
  function findIn(data: AuthStoreData, accountId: string) {
    const list = data.accounts ?? (data.account === null ? [] : [data.account])
    return list.find(item => (item.accountId ?? 'acc_admin') === accountId)
  }

  const service: AuthService = {
    serviceName: 'remoteHubAuth',

    async status(sessionToken) {
      pruneNonces()
      const session = await readSessionInternal(sessionToken)
      const account = session === null ? accountOf(store) : accountForSession(store, session.record)
      const base: AuthStatusResponse = {
        ready: true,
        bootstrapped: account !== null,
        mfaEnabled: requireMfa,
        totpEnabled: account?.totp?.verified === true,
        session: session?.view ?? null,
        // 匿名请求只给「能不能登录」所需的事实：账号名与口令策略属于
        // 已认证信息，不该向未登录访客暴露（P5）。
        ...(session === null
          ? {}
          : {
            username: account?.username ?? null,
            passwordPolicy: currentPolicy(),
          }),
      }
      if (session !== null) {
        base.clients = store.data.clients.map(clientView)
      }
      // 强制改密标记只对**已登录**会话有意义（匿名请求不需要知道）。
      if (session !== null) {
        base.passwordChangeRequired = account?.mustChangePassword === true
      }
      return base
    },

    async bootstrap(input) {
      if (accountsOf(store).length > 0) {
        throw Object.assign(new Error('bootstrap already completed'), { code: AUTH_ERROR_CODES.bootstrapClosed })
      }
      const username = String(input.username ?? '').trim()
      if (username === '' || username.length > 64) {
        throw Object.assign(new Error('invalid username'), { code: AUTH_ERROR_CODES.badRequest })
      }
      const password = String(input.password ?? '')
      // 与设置页同一套规则（默认强密码）。
      assertPasswordAcceptable(password, username)
      const at = now()
      const passwordHash = await hashPassword(password)
      const secret = generateTotpSecret()
      const backupCodes = generateBackupCodes(10)
      await store.mutate((data) => {
        data.account = {
          accountId: 'acc_admin',
          isAdmin: true,
          roleCeiling: 'full',
          username,
          passwordHash,
          totp: { secret, verified: false, createdAt: at },
          backupCodes: backupCodes.map(code => ({ hash: hashBackupCode(code) })),
          createdAt: at,
          updatedAt: at,
          lastLoginAt: at,
        }
      })
      const issued = await createSession({ lastMfaAt: null })
      // 一次性返回密钥与备用码；此后任何接口都不再返回它们。
      return {
        ...issued,
        totpSecret: secret,
        otpauth: otpauthUri({ issuer, account: username, secret }),
        backupCodes,
      }
    },

    async seedDefaultAccount(input) {
      if (accountsOf(store).length > 0) return false
      const username = String(input.username ?? '').trim()
      const password = String(input.password ?? '')
      if (username === '' || password === '') return false
      const at = now()
      const passwordHash = await hashPassword(password)
      await store.mutate((data) => {
        data.account = {
          accountId: 'acc_admin',
          isAdmin: true,
          roleCeiling: 'full',
          username,
          passwordHash,
          createdAt: at,
          updatedAt: at,
          lastLoginAt: null,
          // 首次登录必须先改密（只强制一次）；改完之前也拿不到 2FA/客户端/租约。
          mustChangePassword: true,
        }
      })
      return true
    },

    async passwordChangeRequired(sessionToken) {
      const session = await readSessionInternal(sessionToken)
      if (session === null) return false
      return accountForSession(store, session.record)?.mustChangePassword === true
    },

    initialPasswordPending() {
      return accountOf(store)?.mustChangePassword === true
    },

    passwordPolicy() {
      return currentPolicy()
    },

    async setPasswordPolicy(sessionToken, policy) {
      // 策略属于安全配置：要求已通过强制改密的管理员会话。
      await requireReadySession(sessionToken)
      if (!isPasswordPolicy(policy)) {
        throw Object.assign(new Error('unknown password policy'), { code: AUTH_ERROR_CODES.badRequest })
      }
      await store.mutate((data) => {
        data.settings = { ...(data.settings ?? {}), passwordPolicy: policy }
      })
      return policy
    },

    async changePassword(sessionToken, input) {
      const session = await requireSession(sessionToken)
      const account = accountForSession(store, session.record)
      if (account === null) {
        throw Object.assign(new Error('no account'), { code: AUTH_ERROR_CODES.bootstrapRequired })
      }
      const current = String(input.currentPassword ?? '')
      if (!await verifyPassword(current, account.passwordHash)) {
        throw Object.assign(new Error('current password is incorrect'), {
          code: AUTH_ERROR_CODES.currentPasswordInvalid,
        })
      }
      const next = String(input.newPassword ?? '')
      if (next === current) {
        throw Object.assign(new Error('new password must differ from the current one'), {
          code: AUTH_ERROR_CODES.passwordUnchanged,
        })
      }
      // 阻止把初始口令原样改回同一串；策略校验在下面（含用户名检查）。
      assertPasswordAcceptable(next, account.username)
      const at = now()
      const passwordHash = await hashPassword(next)
      const wasForced = account.mustChangePassword === true
      await store.mutate((data) => {
        if (data.account === null) return
        data.account.passwordHash = passwordHash
        data.account.updatedAt = at
        // 强制改密**只触发一次**：清除后不再要求（后续仍可主动改）。
        delete data.account.mustChangePassword
        const row = data.sessions.find(item => item.sid === session.record.sid)
        if (row !== undefined) row.lastMfaAt = row.lastMfaAt ?? null
      })
      if (wasForced) {
        // 初始口令已完成使命：让插件删掉明文文件。
        try {
          await onForcedPasswordChanged?.()
        } catch {
          // 删除失败不能把改密回滚（账号已更新）；插件下次启动会清理残留。
        }
      }
      return { ok: true }
    },

    async login(input) {
      const username = String(input.username ?? '')
      // 账号不存在与口令错误返回同一个错误码（不泄露账号是否存在）。
      const account = findAccountByName(store, username)
      const source = String(input.source ?? 'local')
      const rate = checkLoginRate(username, source)
      if (!rate.ok) {
        return {
          ok: false,
          code: AUTH_ERROR_CODES.rateLimited,
          reason: `too many attempts; retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`,
        }
      }
      // 账号不存在与口令错误返回同一个错误码（不泄露账号是否存在）。
      if (account === null) {
        recordLoginFailure(username, source)
        return { ok: false, code: AUTH_ERROR_CODES.invalidCredentials, reason: 'invalid username or password' }
      }
      if ((account.disabledAt ?? null) !== null) {
        recordLoginFailure(username, source)
        return { ok: false, code: AUTH_ERROR_CODES.forbidden, reason: 'account disabled' }
      }
      const valid = await verifyPassword(String(input.password ?? ''), account.passwordHash)
      if (!valid) {
        recordLoginFailure(username, source)
        return { ok: false, code: AUTH_ERROR_CODES.invalidCredentials, reason: 'invalid username or password' }
      }

      const at = now()
      clearLoginFailures(username, source)
      await store.mutate((data) => {
        const list = data.accounts ?? (data.account === null ? [] : [data.account])
        const row = list.find(item => (item.accountId ?? 'acc_admin') === (account.accountId ?? 'acc_admin'))
        if (row !== undefined) row.lastLoginAt = at
      }, { deferred: true })

      const totpVerified = account.totp?.verified === true && requireMfa
      if (!totpVerified) {
        const issued = await createSession({ lastMfaAt: null }, input.sessionTtlMs, account.accountId ?? 'acc_admin')
        return {
          ok: true,
          response: { ok: true, mfaRequired: false, session: issued.session },
          cookie: issued.cookie,
        }
      }

      // 生成一次性挑战（明文只出现在响应里）。
      const mfaToken = randomToken()
      const expiresAt = at + MFA_TOKEN_TTL_MS
      await store.mutate((data) => {
        data.challenges.push({
          tokenHash: sha256Hex(mfaToken),
          accountId: account.accountId ?? 'acc_admin',
          createdAt: at,
          expiresAt,
          consumedAt: null,
          attempts: 0,
        })
      })
      return { ok: true, response: { ok: true, mfaRequired: true, mfaToken, expiresAt } }
    },

    async verifyMfa(input) {
      const at = now()
      const tokenHash = sha256Hex(String(input.mfaToken ?? ''))
      const challenge = store.data.challenges.find(row => row.tokenHash === tokenHash)
      if (challenge === undefined) {
        return { error: AUTH_ERROR_CODES.mfaExpired, reason: 'challenge not found' }
      }
      if (challenge.consumedAt !== null || challenge.expiresAt <= at) {
        return { error: AUTH_ERROR_CODES.mfaExpired, reason: 'challenge expired or already used' }
      }
      if ((challenge.attempts ?? 0) >= MAX_MFA_ATTEMPTS) {
        return { error: AUTH_ERROR_CODES.rateLimited, reason: 'too many code attempts; sign in again' }
      }

      const account = findAccountById(store, challenge.accountId) ?? accountOf(store)
      if (account?.totp?.verified !== true) {
        return { error: AUTH_ERROR_CODES.mfaInvalid, reason: 'MFA is not enabled' }
      }

      const code = String(input.code ?? '').trim()
      let accepted = false
      if (/^\d{6}$/u.test(code) && verifyTotp(account.totp.secret, code, { now })) {
        accepted = true
      } else {
        // 备用码：一次性消费。
        const normalized = code.toUpperCase()
        const hash = hashBackupCode(normalized)
        const entry = account.backupCodes?.find(row => row.hash === hash && row.usedAt === undefined)
        if (entry !== undefined) {
          entry.usedAt = at
          accepted = true
          await store.mutate(() => { /* 就地修改，触发落盘 */ })
        }
      }

      if (!accepted) {
        challenge.attempts = (challenge.attempts ?? 0) + 1
        await store.mutate(() => { /* 就地修改，触发落盘 */ })
        return { error: AUTH_ERROR_CODES.mfaInvalid, reason: 'invalid code' }
      }

      challenge.consumedAt = at
      await store.mutate((data) => {
        const list = data.accounts ?? (data.account === null ? [] : [data.account])
        const row = list.find(item => (item.accountId ?? 'acc_admin') === (account.accountId ?? 'acc_admin'))
        if (row !== undefined) row.lastLoginAt = at
      })
      const issued = await createSession({ lastMfaAt: at }, input.sessionTtlMs, account.accountId ?? 'acc_admin')
      return issued
    },

    async logout(sessionToken) {
      const parsed = parseSessionToken(sessionToken)
      if (parsed === null) return
      await store.mutate((data) => {
        const row = data.sessions.find(session => session.sid === parsed.sid)
        if (row !== undefined) row.revokedAt = now()
      })
    },

    readSession: readSessionInternal,

    async enroll(sessionToken, input) {
      const session = await requireReadySession(sessionToken)
      const account = accountForSession(store, session.record)
      if (account?.totp?.verified !== true) {
        throw Object.assign(new Error('MFA must be enabled before trusting a client'), {
          code: AUTH_ERROR_CODES.forbidden,
        })
      }
      const lastMfaAt = session.record.lastMfaAt
      if (lastMfaAt === null || now() - lastMfaAt > MFA_TRUST_WINDOW_MS) {
        throw Object.assign(new Error('recent two-factor verification required'), {
          code: AUTH_ERROR_CODES.forbidden,
        })
      }
      return registerClient(input, account.accountId ?? 'acc_admin')
    },

    async listClients(sessionToken) {
      await requireReadySession(sessionToken)
      return store.data.clients.map(clientView)
    },

    listTrustedClients() {
      return store.data.clients.map(clientView)
    },

    async listAccounts(sessionToken) {
      await requireAdmin(sessionToken)
      return accountsOf(store).map(accountViewOf)
    },

    async createAccount(sessionToken, input) {
      const session = await requireAdmin(sessionToken)
      requireFreshMfa(session)
      const username = String(input.username ?? '').trim()
      if (username.length < 3 || username.length > 32) {
        throw Object.assign(new Error('username must be 3-32 characters'), { code: AUTH_ERROR_CODES.badRequest })
      }
      if (findAccountByName(store, username) !== null) {
        throw Object.assign(new Error('username already taken'), { code: AUTH_ERROR_CODES.accountExists })
      }
      const roleCeiling = input.roleCeiling ?? 'control'
      if (!isRoleName(roleCeiling)) {
        throw Object.assign(new Error('invalid roleCeiling'), { code: AUTH_ERROR_CODES.badRequest })
      }
      const generated = input.password === undefined || String(input.password) === ''
      const password = generated ? generateInitialPassword() : String(input.password)
      assertPasswordAcceptable(password, username)
      const at = now()
      const account: AccountRecord = {
        accountId: newAccountId(),
        username,
        passwordHash: await hashPassword(password),
        roleCeiling,
        isAdmin: false,
        disabledAt: null,
        mustChangePassword: true,
        createdAt: at,
        updatedAt: at,
        lastLoginAt: null,
      }
      await store.mutate((data) => {
        if (data.accounts === undefined) data.accounts = data.account === null ? [] : [data.account]
        data.accounts.push(account)
      })
      audit('account-create', { username, roleCeiling }, { accountId: account.accountId })
      return { account: accountViewOf(account), ...(generated ? { initialPassword: password } : {}) }
    },

    async setAccountCeiling(sessionToken, accountId, role) {
      const session = await requireAdmin(sessionToken)
      const target = findAccountById(store, accountId)
      if (target === null) {
        throw Object.assign(new Error('account not found'), { code: AUTH_ERROR_CODES.accountNotFound })
      }
      if (!isRoleName(role)) {
        throw Object.assign(new Error('invalid role'), { code: AUTH_ERROR_CODES.badRequest })
      }
      if (target.isAdmin !== false && role !== ROLE_FULL) {
        throw Object.assign(new Error('the administrator ceiling cannot be lowered'), { code: AUTH_ERROR_CODES.badRequest })
      }
      const raising = !roleAtMost(role, target.roleCeiling ?? 'control')
      if (raising) requireFreshMfa(session)
      await store.mutate((data) => {
        const row = findIn(data, accountId)
        if (row === undefined) return
        row.roleCeiling = role
        row.updatedAt = now()
        // 账号上限降低时，名下客户端的上限/当前角色一并收敛。
        for (const client of data.clients) {
          if ((client.accountId ?? 'acc_admin') !== accountId) continue
          if (!roleAtMost(client.roleCeiling, role)) client.roleCeiling = role
          if (!roleAtMost(client.activeRole, role)) client.activeRole = role
        }
      })
      audit('ceiling-change', { accountId, role }, { accountId })
      return accountViewOf(findAccountById(store, accountId)!)
    },

    async disableAccount(sessionToken, accountId) {
      const session = await requireAdmin(sessionToken)
      const target = findAccountById(store, accountId)
      if (target === null) {
        throw Object.assign(new Error('account not found'), { code: AUTH_ERROR_CODES.accountNotFound })
      }
      if (target.isAdmin !== false) {
        throw Object.assign(new Error('the administrator cannot be disabled'), { code: AUTH_ERROR_CODES.lastAdmin })
      }
      requireFreshMfa(session)
      const at = now()
      await store.mutate((data) => {
        const row = findIn(data, accountId)
        if (row !== undefined) {
          row.disabledAt = at
          row.updatedAt = at
        }
        // 级联：会话失效 + 客户端撤销（租约立即作废）。
        for (const row2 of data.sessions) {
          if ((row2.accountId ?? 'acc_admin') === accountId) row2.revokedAt = at
        }
        for (const client of data.clients) {
          if ((client.accountId ?? 'acc_admin') !== accountId) continue
          client.revokedAt = at
          client.leaseHash = null
        }
      })
      audit('account-disable', { accountId }, { accountId })
      return accountViewOf(findAccountById(store, accountId)!)
    },

    async enableAccount(sessionToken, accountId) {
      const session = await requireAdmin(sessionToken)
      if (findAccountById(store, accountId) === null) {
        throw Object.assign(new Error('account not found'), { code: AUTH_ERROR_CODES.accountNotFound })
      }
      requireFreshMfa(session)
      await store.mutate((data) => {
        const row = findIn(data, accountId)
        if (row !== undefined) {
          row.disabledAt = null
          row.updatedAt = now()
        }
      })
      audit('account-enable', { accountId }, { accountId })
      return accountViewOf(findAccountById(store, accountId)!)
    },

    async deleteAccount(sessionToken, accountId) {
      const session = await requireAdmin(sessionToken)
      const target = findAccountById(store, accountId)
      if (target === null) {
        throw Object.assign(new Error('account not found'), { code: AUTH_ERROR_CODES.accountNotFound })
      }
      if (target.isAdmin !== false) {
        throw Object.assign(new Error('the administrator cannot be deleted'), { code: AUTH_ERROR_CODES.lastAdmin })
      }
      requireFreshMfa(session)
      await store.mutate((data) => {
        data.accounts = (data.accounts ?? []).filter(item => (item.accountId ?? 'acc_admin') !== accountId)
        data.clients = data.clients.filter(client => (client.accountId ?? 'acc_admin') !== accountId)
        data.sessions = data.sessions.filter(row => (row.accountId ?? 'acc_admin') !== accountId)
        data.challenges = data.challenges.filter(row => (row.accountId ?? 'acc_admin') !== accountId)
      })
      audit('account-delete', { accountId }, { accountId })
    },

    async enrollFromInvite(input) {
      // 邀请本身已由配对服务校验并 burn；这里只做公钥登记。
      return registerClient(input)
    },

    async displaceOthers(keepClientId) {
      const at = now()
      const displaced: string[] = []
      await store.mutate((data) => {
        for (const row of data.clients) {
          if (row.clientId === keepClientId) {
            // 重新上台：清掉旧的「被挤下线」标记。
            if (row.displacedAt !== undefined && row.displacedAt !== null) row.displacedAt = null
            continue
          }
          if (row.revokedAt !== null) continue
          if (row.displacedAt !== undefined && row.displacedAt !== null) continue
          row.displacedAt = at
          displaced.push(row.clientId)
        }
      })
      return displaced
    },

    async revokeClient(sessionToken, clientId) {
      await requireReadySession(sessionToken)
      await revokeByClientId(clientId)
    },

    async setActiveRole(sessionToken, clientId, role) {
      await requireReadySession(sessionToken)
      const client = store.data.clients.find(row => row.clientId === clientId)
      if (client === undefined) {
        throw Object.assign(new Error('unknown client'), { code: AUTH_ERROR_CODES.clientInvalid })
      }
      if (!isRoleName(role) || !roleAtMost(role, client.roleCeiling)) {
        throw Object.assign(new Error('role exceeds the client ceiling'), { code: AUTH_ERROR_CODES.roleExceeded })
      }
      await store.mutate((data) => {
        const row = data.clients.find(item => item.clientId === clientId)
        if (row !== undefined) row.activeRole = role
      })
      for (const listener of [...roleListeners]) listener(clientId, role)
      return clientView(store.data.clients.find(row => row.clientId === clientId)!)
    },

    async setRoleCeiling(sessionToken, clientId, role) {
      const session = await requireReadySession(sessionToken)
      const client = store.data.clients.find(row => row.clientId === clientId)
      if (client === undefined) {
        throw Object.assign(new Error('unknown client'), { code: AUTH_ERROR_CODES.clientInvalid })
      }
      if (!isRoleName(role)) {
        throw Object.assign(new Error('invalid role'), { code: AUTH_ERROR_CODES.badRequest })
      }
      // 提权（把上限抬高）必须来自**新鲜**的双因素验证；降级/不变不要求。
      // 否则一个被盗的 7 天会话就能把客户端推到 full，与「2FA 之后才提权」相悖。
      const raising = role !== client.roleCeiling && !roleAtMost(role, client.roleCeiling)
      if (raising) requireFreshMfa(session)
      await store.mutate((data) => {
        const row = data.clients.find(item => item.clientId === clientId)
        if (row === undefined) return
        // 上限变化即生效：抬高时把当前角色一并抬到新上限（否则「改了上限却没权限」），
        // 降低时收敛到新上限。
        if (row.roleCeiling !== role) row.activeRole = role
        row.roleCeiling = role
      })
      const next = store.data.clients.find(row => row.clientId === clientId)!
      for (const listener of [...roleListeners]) listener(clientId, next.activeRole)
      return clientView(next)
    },

    /**
     * 在当前会话上重新做一次双因素验证（口令 + TOTP/备用码）。
     *
     * 只刷新 `lastMfaAt`，**不**签发新会话：避免提权时把旧会话悄悄换成一个
     * 全新的 7 天凭据。
     */
    async reauth(sessionToken, input) {
      const session = await requireReadySession(sessionToken)
      const account = accountForSession(store, session.record)
      if (account === null) {
        throw Object.assign(new Error('account missing'), { code: AUTH_ERROR_CODES.forbidden })
      }
      const password = String(input.password ?? '')
      if (password === '' || !await verifyPassword(password, account.passwordHash)) {
        throw Object.assign(new Error('invalid password'), { code: AUTH_ERROR_CODES.invalidCredentials })
      }
      if (account.totp?.verified !== true) {
        throw Object.assign(new Error('MFA is not enabled'), { code: AUTH_ERROR_CODES.mfaRequired })
      }
      const code = String(input.code ?? '').trim()
      let ok = /^\d{6}$/u.test(code) && verifyTotp(account.totp.secret, code, { now })
      if (!ok) {
        const hash = hashBackupCode(code.toUpperCase())
        const entry = account.backupCodes?.find(row => row.hash === hash && row.usedAt === undefined)
        if (entry !== undefined) {
          entry.usedAt = now()
          ok = true
        }
      }
      if (!ok) {
        throw Object.assign(new Error('invalid code'), { code: AUTH_ERROR_CODES.mfaInvalid })
      }
      const at = now()
      // 重新验证同时**轮换会话密钥**：同一个 sid，新 secret，旧令牌立即失效。
      // 这样一次被截获的令牌不会因为用户「重新验证以提权」而继续有效。
      const secret = randomToken()
      await store.mutate((data) => {
        const row = data.sessions.find(item => item.sid === session.record.sid)
        if (row !== undefined) {
          row.lastMfaAt = at
          row.secretHash = sha256Hex(secret)
        }
        if (data.account !== null) data.account.lastLoginAt = at
      })
      const view = sessionView(store.data.sessions.find(item => item.sid === session.record.sid)!)
      return { ok: true as const, session: view, cookie: issueCookie(session.record.sid, secret) }
    },

    async renewLease(input) {
      const verdict = await verifySigned({
        lease: input.lease,
        method: input.method,
        path: input.path,
        audience: input.audience,
        bodyDigest: input.bodyDigest,
        headers: input.proofHeaders,
        expectGeneration: input.generation,
      })
      if (!verdict.ok) return { error: verdict.code, reason: verdict.reason }
      if (verdict.client.keyId !== input.keyId) {
        return { error: AUTH_ERROR_CODES.proofInvalid, reason: 'key mismatch' }
      }
      // 只在到期前 24h 内允许续租：过早续租等于无限滑动会话，客户端应等到窗口再换。
      const expiresAt = verdict.client.leaseExpiresAt
      if (expiresAt !== null && now() < expiresAt - LEASE_RENEW_WINDOW_MS) {
        return { error: AUTH_ERROR_CODES.leaseNotExpired, reason: 'lease still outside the renewal window' }
      }
      return rotateLease(verdict.client)
    },

    async verifyHubRequest(input: HubAuthVerifyInput): Promise<HubAuthVerdict> {
      const lease = leaseFromHeader(input.lease)
      if (lease === '') {
        return { ok: false, code: AUTH_ERROR_CODES.unauthorized, reason: 'missing lease' }
      }
      const verdict = await verifySigned({
        lease,
        method: input.method,
        path: input.path,
        audience: input.audience,
        bodyDigest: input.bodyDigest,
        headers: input.headers,
      })
      if (!verdict.ok) return { ok: false, code: verdict.code, reason: verdict.reason }
      const client = verdict.client
      if (!roleAtMost(client.activeRole, client.roleCeiling)) {
        return { ok: false, code: AUTH_ERROR_CODES.roleExceeded, reason: 'active role exceeds ceiling' }
      }
      // 节流更新 lastSeenAt。
      const previous = lastSeenTouch.get(`client:${client.clientId}`) ?? 0
      if (now() - previous >= TOUCH_THROTTLE_MS) {
        lastSeenTouch.set(`client:${client.clientId}`, now())
        void store.mutate((data) => {
          const row = data.clients.find(item => item.clientId === client.clientId)
          if (row !== undefined) row.lastSeenAt = now()
        }, { deferred: true }).catch(() => {})
      }
      const claims: AuthClaims = {
        accountId: findAccountById(store, client.accountId)?.username ?? accountOf(store)?.username ?? '',
        clientId: client.clientId,
        keyId: client.keyId,
        clientType: client.clientType,
        roleCeiling: client.roleCeiling,
        activeRole: client.activeRole,
        leaseGeneration: verdict.generation,
        expiresAt: client.leaseExpiresAt ?? 0,
      }
      return { ok: true, claims }
    },

    onClientRevoked(listener) {
      revokedListeners.add(listener)
      return () => { revokedListeners.delete(listener) }
    },

    onClientRoleChanged(listener) {
      roleListeners.add(listener)
      return () => { roleListeners.delete(listener) }
    },

    async startTotpSetup(sessionToken) {
      const session = await requireReadySession(sessionToken)
      const account = accountForSession(store, session.record)
      if (account === null) {
        throw Object.assign(new Error('no account'), { code: AUTH_ERROR_CODES.bootstrapRequired })
      }
      const secret = generateTotpSecret()
      const backupCodes = generateBackupCodes(10)
      await store.mutate((data) => {
        if (data.account === null) return
        data.account.totp = { secret, verified: false, createdAt: now() }
        data.account.backupCodes = backupCodes.map(code => ({ hash: hashBackupCode(code) }))
        data.account.updatedAt = now()
        const row = data.sessions.find(item => item.sid === session.record.sid)
        if (row !== undefined) row.lastMfaAt = null
      })
      return {
        secret,
        otpauth: otpauthUri({ issuer, account: account.username, secret }),
        backupCodes,
        secondsRemaining: secondsRemaining(now()),
      }
    },

    async confirmTotp(sessionToken, code) {
      const session = await requireReadySession(sessionToken)
      const account = accountForSession(store, session.record)
      if (account?.totp === undefined) {
        throw Object.assign(new Error('no pending TOTP setup'), { code: AUTH_ERROR_CODES.badRequest })
      }
      if (!verifyTotp(account.totp.secret, code, { now })) {
        throw Object.assign(new Error('invalid code'), { code: AUTH_ERROR_CODES.mfaInvalid })
      }
      const at = now()
      await store.mutate((data) => {
        if (data.account?.totp !== undefined) {
          data.account.totp.verified = true
          data.account.updatedAt = at
        }
        const row = data.sessions.find(item => item.sid === session.record.sid)
        if (row !== undefined) row.lastMfaAt = at
      })
    },

    async disableTotp(sessionToken, password, code) {
      const session = await requireReadySession(sessionToken)
      const account = accountForSession(store, session.record)
      if (account === null) {
        throw Object.assign(new Error('no account'), { code: AUTH_ERROR_CODES.bootstrapRequired })
      }
      if (!await verifyPassword(String(password ?? ''), account.passwordHash)) {
        throw Object.assign(new Error('invalid password'), { code: AUTH_ERROR_CODES.invalidCredentials })
      }
      const totpOk = account.totp !== undefined && verifyTotp(account.totp.secret, code, { now })
      const backupOk = account.backupCodes?.some(row => row.hash === hashBackupCode(String(code ?? '')) && row.usedAt === undefined) === true
      if (!totpOk && !backupOk) {
        throw Object.assign(new Error('invalid code'), { code: AUTH_ERROR_CODES.mfaInvalid })
      }
      await store.mutate((data) => {
        if (data.account === null) return
        delete data.account.totp
        delete data.account.backupCodes
        data.account.updatedAt = now()
        const row = data.sessions.find(item => item.sid === session.record.sid)
        if (row !== undefined) row.lastMfaAt = null
      })
    },

    totpSecondsRemaining() {
      return secondsRemaining(now())
    },

    async dispose() {
      revokedListeners.clear()
      roleListeners.clear()
      loginFailures.clear()
      await store.dispose()
    },
  }

  return service
}

/** 允许的最高角色（供 UI / 配置校验复用）。 */
export const MAX_ROLE: RoleName = ROLE_FULL
