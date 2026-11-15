/**
 * 客户端租约与**每请求签名**。
 *
 * 每个 Hub 请求都带：
 * - `Authorization: Bearer <lease>`（7 天租约，服务端只存哈希）
 * - `x-hub-client-id` / `x-hub-key-id`（身份）
 * - `x-hub-ts` / `x-hub-nonce` / `x-hub-body-sha256` / `x-hub-signature`
 *   （对方法、路径、目标 authority、时间、nonce、正文摘要的 ECDSA 签名）
 *
 * 因此「偷到租约」并不够：没有客户端私钥就产生不了有效签名。租约到期前
 * 后台静默轮换（7 天），用户不会被打断。
 *
 * @module dsh-remote-hub/client/auth/session
 */
import { AUTH_HEADERS, AUTH_ROUTES, LEASE_TTL_MS, buildProofPayload } from '@core/auth.js'

import type { ClientIdentity } from './keyring.js'
import { sha256Hex, signPayload } from './keyring.js'

/** 一次可用的租约。 */
export interface LeaseState {
  lease: string
  generation: number
  expiresAt: number
}

/** 签名器配置。 */
export interface AuthSignerOptions {
  /** 目标 Host origin（如 `http://127.0.0.1:8443`）。 */
  origin: string
  identity: ClientIdentity
  clientId: string
  keyId: string
  lease: LeaseState
  fetchImpl?: typeof fetch
  now?: () => number
  /** 提前多久开始轮换（默认 12 小时；7 天周期内足够从容）。 */
  renewWindowMs?: number
}

/** 一次请求需要的元数据。 */
export interface SignInput {
  method: string
  /** 路由路径（可带 query；签名只覆盖 pathname）。 */
  path: string
  /** 请求正文（无正文传空串）。 */
  body: string
}

/** 签名器。 */
export interface AuthSigner {
  /** 生成完整认证头。 */
  headers(input: SignInput): Promise<Record<string, string>>
  /** 当前租约快照（不含私钥）。 */
  snapshot(): Readonly<LeaseState>
  /** 主动轮换（并发调用会合并成一次）。 */
  renew(): Promise<LeaseState>
  /** 是否需要轮换（供后台定时器判断）。 */
  needsRenewal(): boolean
}

/** 拼接 origin 与路径。 */
function joinUrl(origin: string, path: string): string {
  return `${origin.replace(/\/+$/u, '')}${path.startsWith('/') ? path : `/${path}`}`
}

/** 只取 pathname：服务端签名判定用的是 `url.pathname`。 */
function pathnameOf(path: string): string {
  const index = path.indexOf('?')
  return index < 0 ? path : path.slice(0, index)
}

/** target authority（小写 `host[:port]`）。 */
function audienceOf(origin: string): string {
  return new URL(origin).host.toLowerCase()
}

/** 生成一次性 nonce。 */
function nonce(): string {
  const bytes = new Uint8Array(16)
  const cryptoObject = (globalThis as { crypto?: Crypto }).crypto
  if (cryptoObject?.getRandomValues !== undefined) {
    cryptoObject.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256)
  }
  return [...bytes].map(byte => byte.toString(36).padStart(2, '0')).join('').slice(0, 24)
}

/**
 * 创建签名器。
 * @param options - 身份、租约与时钟。
 * @returns `AuthSigner`。
 */
export function createAuthSigner(options: AuthSignerOptions): AuthSigner {
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args))
  const now = options.now ?? (() => Date.now())
  const renewWindowMs = options.renewWindowMs ?? 12 * 60 * 60 * 1000
  const origin = options.origin
  const audience = audienceOf(origin)
  let lease: LeaseState = { ...options.lease }
  let pending: Promise<LeaseState> | null = null

  async function signedHeaders(input: SignInput): Promise<Record<string, string>> {
    const timestamp = String(now())
    const nonceValue = nonce()
    const bodyDigest = await sha256Hex(input.body)
    const payload = buildProofPayload({
      method: input.method,
      path: pathnameOf(input.path),
      audience,
      timestamp,
      nonce: nonceValue,
      clientId: options.clientId,
      keyId: options.keyId,
      generation: lease.generation,
      bodyDigest,
    })
    const signature = await signPayload(options.identity.privateKey, payload)
    return {
      authorization: `Bearer ${lease.lease}`,
      [AUTH_HEADERS.clientId]: options.clientId,
      [AUTH_HEADERS.keyId]: options.keyId,
      [AUTH_HEADERS.timestamp]: timestamp,
      [AUTH_HEADERS.nonce]: nonceValue,
      [AUTH_HEADERS.bodyDigest]: bodyDigest,
      [AUTH_HEADERS.signature]: signature,
    }
  }

  async function renewNow(): Promise<LeaseState> {
    // 轮换本身也要签名：复用同一套头，只是路径不同。
    const headers = await signedHeaders({ method: 'POST', path: AUTH_ROUTES.lease, body: '' })
    const response = await fetchImpl(joinUrl(origin, AUTH_ROUTES.lease), {
      method: 'POST',
      credentials: 'omit',
      headers: { ...headers, 'content-type': 'text/plain' },
      body: '',
    })
    if (response.status !== 200) {
      const text = await response.text().catch(() => '')
      throw Object.assign(new Error(`lease renewal refused (${response.status}) ${text.slice(0, 200)}`), {
        code: 'lease-renewal-failed',
        status: response.status,
      })
    }
    const body = await response.json() as { lease?: unknown; generation?: unknown; expiresAt?: unknown }
    if (typeof body.lease !== 'string' || typeof body.generation !== 'number' || typeof body.expiresAt !== 'number') {
      throw Object.assign(new Error('malformed lease renewal response'), { code: 'lease-renewal-failed' })
    }
    lease = { lease: body.lease, generation: body.generation, expiresAt: body.expiresAt }
    return lease
  }

  return {
    headers: signedHeaders,
    snapshot: () => ({ ...lease }),
    needsRenewal: () => now() >= lease.expiresAt - renewWindowMs,
    renew() {
      // 并发轮换会互相作废（旧代次被重放 → 服务端撤销客户端），必须合并。
      if (pending !== null) return pending
      pending = renewNow().finally(() => { pending = null })
      return pending
    },
  }
}

/** 由登记响应构造初始租约状态。 */
export function leaseFromGrant(input: { lease: string; generation: number; expiresAt: number }): LeaseState {
  return { lease: input.lease, generation: input.generation, expiresAt: input.expiresAt }
}

/** 判断租约是否已过期。 */
export function leaseExpired(state: LeaseState, at = Date.now()): boolean {
  return at >= state.expiresAt
}

/** 默认租约周期（与 host 侧常量一致，供 UI 展示）。 */
export const DEFAULT_LEASE_TTL_MS = LEASE_TTL_MS

/** 守卫的一次性 WS 票据路由（与 core 约定一致）。 */
const WS_TICKET_PATH = '/remote/ws-ticket'

/**
 * 换取一次性 WebSocket 升级票据。
 *
 * 长期租约**绝不进入 URL**：先在本 HTTP 请求上做完整签名，服务端只回一个
 * 30 秒、消费一次就失效的票据。
 * @param signer - 已就绪的签名器。
 * @param origin - 守卫 origin。
 * @param fetchImpl - 可注入 fetch。
 * @returns 票据明文。
 */
export async function fetchWsTicket(
  signer: AuthSigner,
  origin: string,
  fetchImpl?: typeof fetch,
): Promise<string> {
  const doFetch = fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args))
  const headers = await signer.headers({ method: 'POST', path: WS_TICKET_PATH, body: '' })
  const response = await doFetch(joinUrl(origin, WS_TICKET_PATH), {
    method: 'POST',
    credentials: 'omit',
    headers: { ...headers, 'x-hub-protocol': '1', 'content-type': 'text/plain' },
    body: '',
  })
  if (response.status !== 200) {
    throw Object.assign(new Error(`ws ticket refused (${response.status})`), {
      code: 'ws-ticket-failed',
      status: response.status,
    })
  }
  const body = await response.json() as { ticket?: unknown }
  if (typeof body.ticket !== 'string' || body.ticket === '') {
    throw Object.assign(new Error('malformed ws ticket response'), { code: 'ws-ticket-failed' })
  }
  return body.ticket
}
