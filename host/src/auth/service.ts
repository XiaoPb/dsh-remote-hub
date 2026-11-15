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
import type {
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
  LEASE_TTL_MS,
  MFA_TRUST_WINDOW_MS,
  PROOF_MAX_SKEW_MS,
  PROOF_NONCE_TTL_MS,
  SESSION_TTL_MS,
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
import type { AuthStore, ClientRecord, SessionRecord } from './store.js'
import { newClientId, newKeyId, newSessionId } from './store.js'
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
  /** 首次启动：无账号时用默认口令创建一个「必须先改密」的账号。 */
  seedDefaultAccount(input: { username: string; password: string }): Promise<boolean>
  /** 账号是否仍在等待初始改密（无账号 / 已完成 → false）。 */
  initialPasswordPending(): boolean
  listClients(sessionToken: string | undefined): Promise<TrustedClientView[]>
  revokeClient(sessionToken: string | undefined, clientId: string): Promise<void>
  setActiveRole(sessionToken: string | undefined, clientId: string, role: RoleName): Promise<TrustedClientView>
  setRoleCeiling(sessionToken: string | undefined, clientId: string, role: RoleName): Promise<TrustedClientView>
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

/** 从存储取账号（唯一账号模型）。 */
function accountOf(store: AuthStore) {
  return store.data.account
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
    const account = accountOf(store)
    return {
      accountId: account?.username ?? '',
      username: account?.username ?? '',
      role: 'admin',
      createdAt: new Date(record.createdAt).toISOString(),
      expiresAt: record.expiresAt,
      lastMfaAt: record.lastMfaAt,
    }
  }

  function clientView(record: ClientRecord): TrustedClientView {
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
      revokedAt: record.revokedAt === null ? null : new Date(record.revokedAt).toISOString(),
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

  async function createSession(record: { lastMfaAt: number | null }): Promise<IssuedSession> {
    const at = now()
    const sid = newSessionSid()
    const secret = randomToken()
    const session: SessionRecord = {
      sid,
      secretHash: sha256Hex(secret),
      createdAt: at,
      expiresAt: at + SESSION_TTL_MS,
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

  function checkLoginRate(username: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const at = now()
    const entry = loginFailures.get(username)
    if (entry === undefined || entry.resetAt <= at) return { ok: true }
    if (entry.count >= maxLoginAttempts) return { ok: false, retryAfterMs: entry.resetAt - at }
    return { ok: true }
  }

  function recordLoginFailure(username: string): void {
    const at = now()
    const entry = loginFailures.get(username)
    if (entry === undefined || entry.resetAt <= at) {
      loginFailures.set(username, { count: 1, resetAt: at + loginWindowMs })
      return
    }
    entry.count += 1
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

  async function requireSession(token: string | undefined): Promise<{ record: SessionRecord; view: AuthSessionView }> {
    const session = await readSessionInternal(token)
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
    if (accountOf(store)?.mustChangePassword === true) {
      throw Object.assign(new Error('change the initial password first'), {
        code: AUTH_ERROR_CODES.passwordChangeRequired,
      })
    }
    return session
  }

  const service: AuthService = {
    serviceName: 'remoteHubAuth',

    async status(sessionToken) {
      pruneNonces()
      const account = accountOf(store)
      const session = await readSessionInternal(sessionToken)
      const base: AuthStatusResponse = {
        ready: true,
        bootstrapped: account !== null,
        mfaEnabled: requireMfa,
        session: session?.view ?? null,
        username: account?.username ?? null,
        // 策略是部署事实，不敏感：登录页/引导页据此显示规则清单。
        passwordPolicy: currentPolicy(),
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
      if (accountOf(store) !== null) {
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
      if (accountOf(store) !== null) return false
      const username = String(input.username ?? '').trim()
      const password = String(input.password ?? '')
      if (username === '' || password === '') return false
      const at = now()
      const passwordHash = await hashPassword(password)
      await store.mutate((data) => {
        data.account = {
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
      return accountOf(store)?.mustChangePassword === true
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
      const account = accountOf(store)
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
      const account = accountOf(store)
      const username = String(input.username ?? '')
      const rate = checkLoginRate(username)
      if (!rate.ok) {
        return {
          ok: false,
          code: AUTH_ERROR_CODES.rateLimited,
          reason: `too many attempts; retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`,
        }
      }
      // 账号不存在与口令错误返回同一个错误码（不泄露账号是否存在）。
      if (account === null || account.username !== username) {
        recordLoginFailure(username)
        return { ok: false, code: AUTH_ERROR_CODES.invalidCredentials, reason: 'invalid username or password' }
      }
      const valid = await verifyPassword(String(input.password ?? ''), account.passwordHash)
      if (!valid) {
        recordLoginFailure(username)
        return { ok: false, code: AUTH_ERROR_CODES.invalidCredentials, reason: 'invalid username or password' }
      }

      const at = now()
      await store.mutate((data) => {
        if (data.account !== null) data.account.lastLoginAt = at
      }, { deferred: true })

      const totpVerified = account.totp?.verified === true && requireMfa
      if (!totpVerified) {
        const issued = await createSession({ lastMfaAt: null })
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

      const account = accountOf(store)
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
        if (data.account !== null) data.account.lastLoginAt = at
      })
      const issued = await createSession({ lastMfaAt: at })
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
      const account = accountOf(store)
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
      const existing = store.data.clients.find(row => row.revokedAt === null && row.keyId === keyId)
      if (existing !== undefined) {
        // 同一把公钥重复注册：复用记录并轮换租约（页面刷新场景）。
        const lease = await rotateLease(existing)
        return { ok: true, client: clientView(existing), lease }
      }

      const clientId = newClientId()
      const secret = randomToken()
      const expiresAt = at + LEASE_TTL_MS
      const record: ClientRecord = {
        clientId,
        keyId,
        label,
        clientType: input.clientType as ClientType,
        publicKey: input.publicKey,
        fingerprint: publicKeyFingerprint(input.publicKey),
        roleCeiling: input.roleCeiling,
        activeRole: input.roleCeiling,
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
    },

    async listClients(sessionToken) {
      await requireReadySession(sessionToken)
      return store.data.clients.map(clientView)
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
      await requireReadySession(sessionToken)
      const client = store.data.clients.find(row => row.clientId === clientId)
      if (client === undefined) {
        throw Object.assign(new Error('unknown client'), { code: AUTH_ERROR_CODES.clientInvalid })
      }
      if (!isRoleName(role)) {
        throw Object.assign(new Error('invalid role'), { code: AUTH_ERROR_CODES.badRequest })
      }
      await store.mutate((data) => {
        const row = data.clients.find(item => item.clientId === clientId)
        if (row === undefined) return
        row.roleCeiling = role
        if (!roleAtMost(row.activeRole, role)) row.activeRole = role
      })
      const next = store.data.clients.find(row => row.clientId === clientId)!
      for (const listener of [...roleListeners]) listener(clientId, next.activeRole)
      return clientView(next)
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
        accountId: accountOf(store)?.username ?? '',
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
      const account = accountOf(store)
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
      const account = accountOf(store)
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
      const account = accountOf(store)
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
