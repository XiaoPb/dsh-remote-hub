/**
 * 认证 HTTP 面（`/remote-auth/*`）。
 *
 * 挂在 DSH 自己的 `webServer` 上（**不是**守卫），因为浏览器与远程 App 都通过
 * DSH 的 Web origin 访问认证面；守卫是另一个端口，只负责授权后的 Hub 流量。
 *
 * 安全措施：
 * - 状态变更请求要求 `Origin` 与 `Host` 同源（CSRF 围栏）；Cookie 用
 *   `SameSite=Strict` + `HttpOnly`。
 * - `bootstrap` 只在回环来源可用（防止远程抢先注册首个管理员）。
 * - 请求体上限 64 KiB，JSON 解析失败一律 400，不回显载荷。
 * - 响应里**永不**出现口令哈希、TOTP 密钥（除引导那一次）、租约密文（除签发那一次）。
 *
 * @module dsh-remote-hub/host/auth/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { ClientPublicKeyJwk, ClientType } from '@core/auth.js'
import {
  AUTH_ERROR_CODES,
  AUTH_ROUTES,
  SESSION_COOKIE,
} from '@core/auth.js'
import { isRoleName } from '@core/roles.js'

import type { AuthService } from './service.js'

/** 注册所需的依赖。 */
export interface AuthRouteDeps {
  service: AuthService
  /** 是否允许非 HTTPS 部署（`Secure` 属性取决于部署，默认按请求协议判断）。 */
  secureCookie?: boolean
}

const MAX_BODY_BYTES = 64 * 1024

/** 读取 JSON 请求体（超限返回 undefined）。 */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** 解析 Cookie 头里的一个值（同名取第一个）。 */
function cookieValue(header: string | undefined, name: string): string | undefined {
  if (typeof header !== 'string' || header === '') return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return undefined
}

/** 回环来源判定（bootstrap 专用）。 */
function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? ''
  return address === '::1'
    || address.startsWith('127.')
    || address.startsWith('::ffff:127.')
}

/**
 * CSRF 围栏：浏览器带 `Origin` 时必须与 `Host` 同源。
 * 没有 `Origin` 的请求（curl / 同源导航）放行——认证仍由 Cookie 与会话承担。
 */
function sameOriginOk(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === String(req.headers.host ?? '')
  } catch {
    return false
  }
}

/** 目标 authority（小写 host[:port]），签名 audience 用。 */
export function audienceOf(req: IncomingMessage): string {
  return String(req.headers.host ?? '').toLowerCase()
}

/** 写 JSON 响应。 */
function sendJson(res: ServerResponse, status: number, body: unknown, cookie?: string): void {
  const text = JSON.stringify(body)
  const headers: Record<string, string | number> = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  }
  if (cookie !== undefined) headers['set-cookie'] = cookie
  res.writeHead(status, headers)
  res.end(text)
}

/** 构造会话 Cookie（`Max-Age` 与签发时一致）。 */
function sessionCookie(value: string, secure: boolean, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

/** 清空会话 Cookie。 */
function clearCookie(secure: boolean): string {
  return [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0', ...(secure ? ['Secure'] : [])].join('; ')
}

/** 认证错误 → HTTP 状态。 */
function statusFor(code: string): number {
  switch (code) {
    case AUTH_ERROR_CODES.unauthorized:
    case AUTH_ERROR_CODES.invalidCredentials:
    case AUTH_ERROR_CODES.mfaRequired:
    case AUTH_ERROR_CODES.mfaInvalid:
    case AUTH_ERROR_CODES.mfaExpired:
    case AUTH_ERROR_CODES.currentPasswordInvalid:
      return 401
    case AUTH_ERROR_CODES.forbidden:
    case AUTH_ERROR_CODES.bootstrapClosed:
    case AUTH_ERROR_CODES.roleExceeded:
    case AUTH_ERROR_CODES.passwordChangeRequired:
      return 403
    case AUTH_ERROR_CODES.rateLimited:
      return 429
    case AUTH_ERROR_CODES.clientInvalid:
    case AUTH_ERROR_CODES.leaseExpired:
    case AUTH_ERROR_CODES.proofInvalid:
      return 401
    case AUTH_ERROR_CODES.badRequest:
    case AUTH_ERROR_CODES.bootstrapRequired:
    case AUTH_ERROR_CODES.passwordWeak:
    case AUTH_ERROR_CODES.passwordUnchanged:
      return 400
    case AUTH_ERROR_CODES.unavailable:
      return 503
    default:
      return 500
  }
}

/** 从异常里取出认证错误码。 */
function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code
  }
  return AUTH_ERROR_CODES.internal
}

/**
 * 处理一条认证路由。
 * @param deps - 服务与部署选项。
 * @returns 一个可以交给 `webServer.register({ kind: 'exact', handler })` 的处理器。
 */
export function createAuthHandler(deps: AuthRouteDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { service } = deps

  return async function handle(req, res): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://hub.invalid').pathname
    const secure = deps.secureCookie ?? (req.headers['x-forwarded-proto'] === 'https')
    const token = cookieValue(req.headers.cookie, SESSION_COOKIE)

    try {
      // ── 状态（无鉴权）──────────────────────────────────────────────────────
      if (path === AUTH_ROUTES.status) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, code: AUTH_ERROR_CODES.badRequest, message: 'method not allowed' })
          return
        }
        sendJson(res, 200, await service.status(token))
        return
      }

      // ── 引导（仅回环）──────────────────────────────────────────────────────
      if (path === AUTH_ROUTES.bootstrap) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, code: AUTH_ERROR_CODES.badRequest, message: 'method not allowed' })
          return
        }
        if (!isLoopbackRequest(req)) {
          sendJson(res, 403, {
            ok: false,
            code: AUTH_ERROR_CODES.forbidden,
            message: 'the first administrator may only be created from loopback',
          })
          return
        }
        if (!sameOriginOk(req)) {
          sendJson(res, 403, { ok: false, code: AUTH_ERROR_CODES.forbidden, message: 'cross-origin request refused' })
          return
        }
        const body = await readJson(req)
        if (body === undefined) {
          sendJson(res, 400, { ok: false, code: AUTH_ERROR_CODES.badRequest, message: 'invalid body' })
          return
        }
        const issued = await service.bootstrap({
          username: String(body.username ?? ''),
          password: String(body.password ?? ''),
        })
        sendJson(res, 200, {
          ok: true,
          session: issued.session,
          totpSecret: issued.totpSecret,
          otpauth: issued.otpauth,
          backupCodes: issued.backupCodes,
        }, sessionCookie(issued.cookie, secure, 7 * 24 * 60 * 60))
        return
      }

      // ── 登录（两步）────────────────────────────────────────────────────────
      if (path === AUTH_ROUTES.login) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, code: AUTH_ERROR_CODES.badRequest, message: 'method not allowed' })
          return
        }
        if (!sameOriginOk(req)) {
          sendJson(res, 403, { ok: false, code: AUTH_ERROR_CODES.forbidden, message: 'cross-origin request refused' })
          return
        }
        const body = await readJson(req)
        if (body === undefined) {
          sendJson(res, 400, { ok: false, code: AUTH_ERROR_CODES.badRequest, message: 'invalid body' })
          return
        }
        const result = await service.login({
          username: String(body.username ?? ''),
          password: String(body.password ?? ''),
        })
        if (!result.ok) {
          sendJson(res, statusFor(result.code), { ok: false, code: result.code, message: result.reason })
          return
        }
        if (result.response.mfaRequired) {
          sendJson(res, 200, {
            ok: true,
            mfaRequired: true,
            mfaToken: result.response.mfaToken,
            expiresAt: result.response.expiresAt,
          })
          return
        }
        // 无 MFA（或 TOTP 尚未确认）：直接签发会话。
        sendJson(res, 200, {
          ok: true,
          mfaRequired: false,
          session: result.response.session,
        }, result.cookie === undefined ? undefined : sessionCookie(result.cookie, secure, 7 * 24 * 60 * 60))
        return
      }

      // ── 第二步 ─────────────────────────────────────────────────────────────
      if (path === AUTH_ROUTES.mfa) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, code: AUTH_ERROR_CODES.badRequest, message: 'method not allowed' })
          return
        }
        if (!sameOriginOk(req)) {
          sendJson(res, 403, { ok: false, code: AUTH_ERROR_CODES.forbidden, message: 'cross-origin request refused' })
          return
        }
        const body = await readJson(req)
        if (body === undefined) {
          sendJson(res, 400, { ok: false, code: AUTH_ERROR_CODES.badRequest, message: 'invalid body' })
          return
        }
        const issued = await service.verifyMfa({
          mfaToken: String(body.mfaToken ?? ''),
          code: String(body.code ?? ''),
        })
        if ('error' in (issued as { error?: string })) {
          const failure = issued as { error: string; reason: string }
          sendJson(res, statusFor(failure.error), { ok: false, code: failure.error, message: failure.reason })
          return
        }
        const ok = issued as { session: unknown; cookie: string }
        sendJson(res, 200, { ok: true, session: ok.session }, sessionCookie(ok.cookie, secure, 7 * 24 * 60 * 60))
        return
      }

      // ── 登出 ───────────────────────────────────────────────────────────────
      if (path === AUTH_ROUTES.logout) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, code: AUTH_ERROR_CODES.badRequest, message: 'method not allowed' })
          return
        }
        await service.logout(token)
        sendJson(res, 200, { ok: true }, clearCookie(secure))
        return
      }

      // ── 改密（首次登录强制；之后仍可主动修改）──────────────────────────────
      if (path === AUTH_ROUTES.password) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, code: AUTH_ERROR_CODES.badRequest, message: 'method not allowed' })
          return
        }
        if (!sameOriginOk(req)) {
          sendJson(res, 403, { ok: false, code: AUTH_ERROR_CODES.forbidden, message: 'cross-origin request refused' })
          return
        }
        const body = await readJson(req)
        if (body === undefined) {
          sendJson(res, 400, { ok: false, code: AUTH_ERROR_CODES.badRequest, message: 'invalid body' })
          return
        }
        await service.changePassword(token, {
          currentPassword: String(body.currentPassword ?? ''),
          newPassword: String(body.newPassword ?? ''),
        })
        sendJson(res, 200, { ok: true })
        return
      }

      // ── 口令策略（设置页开关；管理员会话）──────────────────────────────────
      if (path === AUTH_ROUTES.policy) {
        if (req.method !== 'GET' && req.method !== 'POST') {
          sendJson(res, 405, { ok: false, code: AUTH_ERROR_CODES.badRequest, message: 'method not allowed' })
          return
        }
        if (!sameOriginOk(req)) {
          sendJson(res, 403, { ok: false, code: AUTH_ERROR_CODES.forbidden, message: 'cross-origin request refused' })
          return
        }
        if (req.method === 'GET') {
          // 读取也需要会话：策略是部署配置，不向匿名访客暴露。
          if (await service.readSession(token) === null) {
            sendJson(res, 401, { ok: false, code: AUTH_ERROR_CODES.unauthorized, message: 'session required' })
            return
          }
          sendJson(res, 200, { ok: true, policy: service.passwordPolicy() })
          return
        }
        const body = await readJson(req)
        if (body === undefined) {
          sendJson(res, 400, { ok: false, code: AUTH_ERROR_CODES.badRequest, message: 'invalid body' })
          return
        }
        const policy = await service.setPasswordPolicy(token, body.policy as never)
        sendJson(res, 200, { ok: true, policy })
        return
      }

      // ── 客户端注册 / 管理（需要会话）──────────────────────────────────────
      if (path === AUTH_ROUTES.enroll) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, code: AUTH_ERROR_CODES.badRequest, message: 'method not allowed' })
          return
        }
        if (!sameOriginOk(req)) {
          sendJson(res, 403, { ok: false, code: AUTH_ERROR_CODES.forbidden, message: 'cross-origin request refused' })
          return
        }
        const body = await readJson(req)
        if (body === undefined) {
          sendJson(res, 400, { ok: false, code: AUTH_ERROR_CODES.badRequest, message: 'invalid body' })
          return
        }
        const clientType = body.clientType
        if (clientType !== 'browser' && clientType !== 'app' && clientType !== 'dsh') {
          sendJson(res, 400, { ok: false, code: AUTH_ERROR_CODES.badRequest, message: 'invalid clientType' })
          return
        }
        const result = await service.enroll(token, {
          label: String(body.label ?? ''),
          clientType: clientType as ClientType,
          publicKey: body.publicKey as ClientPublicKeyJwk,
          roleCeiling: body.roleCeiling as never,
        })
        sendJson(res, 200, result)
        return
      }

      if (path === AUTH_ROUTES.clients) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, code: AUTH_ERROR_CODES.badRequest, message: 'method not allowed' })
          return
        }
        if (!sameOriginOk(req)) {
          sendJson(res, 403, { ok: false, code: AUTH_ERROR_CODES.forbidden, message: 'cross-origin request refused' })
          return
        }
        const body = await readJson(req)
        if (body === undefined) {
          sendJson(res, 400, { ok: false, code: AUTH_ERROR_CODES.badRequest, message: 'invalid body' })
          return
        }
        const action = body.action
        if (action === 'list') {
          sendJson(res, 200, { ok: true, clients: await service.listClients(token) })
          return
        }
        if (action === 'revoke') {
          await service.revokeClient(token, String(body.clientId ?? ''))
          sendJson(res, 200, { ok: true })
          return
        }
        if (action === 'setRole') {
          const role = body.role
          if (!isRoleName(role)) {
            sendJson(res, 400, { ok: false, code: AUTH_ERROR_CODES.badRequest, message: 'invalid role' })
            return
          }
          sendJson(res, 200, {
            ok: true,
            client: await service.setActiveRole(token, String(body.clientId ?? ''), role),
          })
          return
        }
        if (action === 'setCeiling') {
          const role = body.role
          if (!isRoleName(role)) {
            sendJson(res, 400, { ok: false, code: AUTH_ERROR_CODES.badRequest, message: 'invalid role' })
            return
          }
          sendJson(res, 200, {
            ok: true,
            client: await service.setRoleCeiling(token, String(body.clientId ?? ''), role),
          })
          return
        }
        sendJson(res, 400, { ok: false, code: AUTH_ERROR_CODES.badRequest, message: 'unknown action' })
        return
      }

      // ── 租约轮换（客户端私钥签名；无需会话 Cookie）────────────────────────
      if (path === AUTH_ROUTES.lease) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, code: AUTH_ERROR_CODES.badRequest, message: 'method not allowed' })
          return
        }
        const authorization = req.headers.authorization
        const lease = typeof authorization === 'string' && authorization.startsWith('Bearer ')
          ? authorization.slice('Bearer '.length).trim()
          : ''
        const header = (name: string): string | undefined => {
          const value = req.headers[name]
          return typeof value === 'string' ? value : undefined
        }
        // 正文只用于摘要核对，本端点不解析业务字段。
        const bodyBuffer = await readBodyBuffer(req)
        if (bodyBuffer === undefined) {
          sendJson(res, 400, { ok: false, code: AUTH_ERROR_CODES.badRequest, message: 'body too large' })
          return
        }
        const { createHash } = await import('node:crypto')
        const bodyDigest = createHash('sha256').update(bodyBuffer).digest('hex')
        const grant = await service.renewLease({
          lease,
          keyId: header('x-hub-key-id') ?? '',
          generation: Number(header('x-hub-generation') ?? '0'),
          proofHeaders: {
            'x-hub-client-id': header('x-hub-client-id'),
            'x-hub-key-id': header('x-hub-key-id'),
            'x-hub-ts': header('x-hub-ts'),
            'x-hub-nonce': header('x-hub-nonce'),
            'x-hub-body-sha256': header('x-hub-body-sha256'),
            'x-hub-signature': header('x-hub-signature'),
          },
          audience: audienceOf(req),
          method: req.method ?? 'POST',
          path,
          bodyDigest,
        })
        if ('error' in grant) {
          const failure = grant as { error: string; reason: string }
          sendJson(res, statusFor(failure.error), { ok: false, code: failure.error, message: failure.reason })
          return
        }
        sendJson(res, 200, { ok: true, lease: grant.lease, generation: grant.generation, expiresAt: grant.expiresAt })
        return
      }

      sendJson(res, 404, { ok: false, code: AUTH_ERROR_CODES.badRequest, message: 'not found' })
    } catch (error) {
      const code = codeOf(error)
      const message = error instanceof Error ? error.message : 'authentication failed'
      const failures = (error as { failures?: unknown })?.failures
      sendJson(res, statusFor(code), {
        ok: false,
        code,
        message,
        // 口令策略失败时把未满足的规则逐条返回，供输入框下的提示打勾。
        ...(Array.isArray(failures) ? { failures } : {}),
      })
    }
  }
}

/** 读取原始正文（上限 64 KiB）。 */
async function readBodyBuffer(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}
