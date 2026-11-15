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

  async function post(path: string, body: unknown): Promise<Response> {
    const response = await fetchImpl(`${base}${path}`, {
      method: 'POST',
      // 会话 Cookie 只发给同源认证面。
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    return response
  }

  async function readJson<T>(response: Response): Promise<T> {
    if (!response.ok) throw await failure(response)
    return await response.json() as T
  }

  return {
    async status() {
      const response = await fetchImpl(`${base}${AUTH_ROUTES.status}`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
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
      const response = await post(AUTH_ROUTES.logout, {})
      if (!response.ok) throw await failure(response)
    },
    async enroll(input) {
      return readJson<EnrollClientResponse>(await post(AUTH_ROUTES.enroll, input))
    },
    async clients(action) {
      return readJson(await post(AUTH_ROUTES.clients, action))
    },
  }
}
