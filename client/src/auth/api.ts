/**
 * 认证面的浏览器客户端（`/remote-auth/*`，走 DSH 自己的 Web origin）。
 *
 * 与 Hub 的 `/remote/*`（守卫端口）**分开**：这里用会话 Cookie 管理账号与信任，
 * 那里用租约 + 客户端签名访问 Hub。
 *
 * @module dsh-remote-hub/client/auth/api
 */
import type {
  AuthStatusResponse,
  ClientPublicKeyJwk,
  ClientType,
  EnrollClientResponse,
  LoginResponse,
  PasswordPolicy,
  TrustedClientView,
} from '@core/auth.js'
import { AUTH_ROUTES } from '@core/auth.js'

/** 一次调用的失败。 */
export class AuthApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'AuthApiError'
    this.code = code
    this.status = status
  }
}

/** 调用配置。 */
export interface AuthApiOptions {
  /** 认证面所在的 origin；缺省用页面自身 origin。 */
  origin?: string
  fetchImpl?: typeof fetch
  /**
   * 跨源模式：会话用 `Authorization: Bearer <sessionToken>` 传递。
   *
   * 控制端页面与目标守卫不同源，`SameSite=Strict` 的 Cookie 不会过去；
   * 守卫上的认证面因此额外在响应体里返回 `sessionToken`，这里负责保存与回填。
   */
  headerSession?: boolean
}

/** 认证 API。 */
export interface AuthApi {
  status(): Promise<AuthStatusResponse>
  bootstrap(input: { username: string; password: string }): Promise<{
    session: unknown
    totpSecret: string
    otpauth: string
    backupCodes: string[]
  }>
  login(input: { username: string; password: string }): Promise<LoginResponse>
  mfa(input: { mfaToken: string; code: string }): Promise<{ session: unknown }>
  logout(): Promise<void>
  /** 修改口令（首次登录强制；也需要当前口令）。 */
  changePassword(input: { currentPassword: string; newPassword: string }): Promise<void>
  /** 读取当前口令策略。 */
  policy(): Promise<PasswordPolicy>
  /** 两步验证绑定（start 返回一次性密钥与备用码）。 */
  totp(action:
    | { action: 'start' }
    | { action: 'confirm'; code: string }
    | { action: 'disable'; password: string; code: string }): Promise<{
      ok: true
      secret?: string
      otpauth?: string
      backupCodes?: string[]
      secondsRemaining?: number
    }>
  /** 提权前重新验证（口令 + TOTP），刷新 2FA 窗口而不换会话。 */
  reauth(input: { password: string; code: string }): Promise<void>
  /** 切换口令策略（立即生效）。 */
  setPolicy(policy: PasswordPolicy): Promise<PasswordPolicy>
  enroll(input: {
    label: string
    clientType: ClientType
    publicKey: ClientPublicKeyJwk
    roleCeiling: 'read-only' | 'control' | 'full'
  }): Promise<EnrollClientResponse>
  clients(action:
    | { action: 'list' }
    | { action: 'revoke'; clientId: string }
    | { action: 'setRole'; clientId: string; role: 'read-only' | 'control' | 'full' }
    | { action: 'setCeiling'; clientId: string; role: 'read-only' | 'control' | 'full' },
  ): Promise<{ clients?: TrustedClientView[]; client?: TrustedClientView }>
}

/** 解析错误响应。 */
async function failure(response: Response): Promise<AuthApiError> {
  let code = 'auth-internal'
  let message = `authentication request failed (${response.status})`
  try {
    const body = await response.json() as { code?: unknown; message?: unknown }
    if (typeof body.code === 'string') code = body.code
    if (typeof body.message === 'string') message = body.message
  } catch {
    // 非 JSON 响应：保留默认文案，不回显正文（可能含服务端细节）。
  }
  return new AuthApiError(code, message, response.status)
}

/**
 * 创建认证 API 客户端。
 * @param options - origin 与 fetch 覆盖。
 * @returns `AuthApi`。
 */
export function createAuthApi(options: AuthApiOptions = {}): AuthApi {
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args))
  const base = (options.origin
    ?? (globalThis.location as { origin?: string } | undefined)?.origin
    ?? '').replace(/\/+$/u, '')
  const headerSession = options.headerSession === true
  let sessionToken: string | undefined

  /** 头会话请求头（Cookie 模式为空）。 */
  function sessionHeaders(): Record<string, string> {
    return sessionToken === undefined ? {} : { authorization: `Bearer ${sessionToken}` }
  }

  /** 从响应体里接住守卫返回的会话令牌（仅头模式）。 */
  function capture<T>(body: T): T {
    const token = (body as { sessionToken?: unknown } | null)?.sessionToken
    if (headerSession && typeof token === 'string' && token !== '') sessionToken = token
    return body
  }

  async function post(path: string, body: unknown): Promise<Response> {
    const response = await fetchImpl(`${base}${path}`, {
      method: 'POST',
      // 会话 Cookie 只发给同源认证面；跨源用显式头。
      credentials: headerSession ? 'omit' : 'same-origin',
      headers: { 'content-type': 'application/json', ...sessionHeaders() },
      body: JSON.stringify(body ?? {}),
    })
    return response
  }

  async function readJson<T>(response: Response): Promise<T> {
    if (!response.ok) throw await failure(response)
    return capture(await response.json() as T)
  }

  return {
    async status() {
      const response = await fetchImpl(`${base}${AUTH_ROUTES.status}`, {
        method: 'GET',
        credentials: headerSession ? 'omit' : 'same-origin',
        headers: { accept: 'application/json', ...sessionHeaders() },
      })
      return readJson<AuthStatusResponse>(response)
    },
    async bootstrap(input) {
      return readJson(await post(AUTH_ROUTES.bootstrap, input))
    },
    async login(input) {
      return readJson<LoginResponse>(await post(AUTH_ROUTES.login, input))
    },
    async mfa(input) {
      return readJson(await post(AUTH_ROUTES.mfa, input))
    },
    async logout() {
      try {
        const response = await post(AUTH_ROUTES.logout, {})
        if (!response.ok) throw await failure(response)
      } finally {
        sessionToken = undefined
      }
    },
    async changePassword(input) {
      const response = await post(AUTH_ROUTES.password, input)
      if (!response.ok) throw await failure(response)
    },
    async policy() {
      const response = await fetchImpl(`${base}${AUTH_ROUTES.policy}`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      const body = await readJson<{ policy?: PasswordPolicy }>(response)
      return body.policy === 'basic' ? 'basic' : 'strong'
    },
    async setPolicy(policy) {
      const body = await readJson<{ policy?: PasswordPolicy }>(await post(AUTH_ROUTES.policy, { policy }))
      return body.policy === 'basic' ? 'basic' : 'strong'
    },
    async reauth(input) {
      // readJson 顺带接住轮换后的会话令牌（头模式）。
      await readJson(await post(AUTH_ROUTES.reauth, input))
    },
    async totp(action) {
      return readJson(await post(AUTH_ROUTES.totp, action))
    },
    async enroll(input) {
      return readJson<EnrollClientResponse>(await post(AUTH_ROUTES.enroll, input))
    },
    async clients(action) {
      return readJson(await post(AUTH_ROUTES.clients, action))
    },
  }
}
