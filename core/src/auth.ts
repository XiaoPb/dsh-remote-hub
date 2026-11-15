/**
 * 账号认证与可信客户端的**共享契约**（host 认证插件、Hub 守卫、浏览器侧共用）。
 *
 * 设计要点：
 * - 账号口令 + TOTP 只在**建立信任**时使用；之后每个请求靠客户端私钥证明。
 * - 浏览器会话 Cookie 只用于认证管理面（`/remote-auth/*`），**不**直接授权 Hub。
 * - Hub 访问使用**租约**（7 天） + 每请求签名；租约可撤销、可后台轮换。
 * - 客户端公钥为 ECDSA P-256（WebCrypto 全平台可用），服务端只存公钥 JWK。
 *
 * RULE: 路由、头名、错误码、规范化字符串格式只在这里定义，两侧禁止各自复制。
 *
 * @module @core/auth
 */
import type { RoleName } from './roles.js'

/** 认证面路由（独立于守卫的 `/remote/*`）。 */
export const AUTH_ROUTES = {
  /** 无鉴权状态下的事实：是否已建账号、是否启用 MFA、当前会话。 */
  status: '/remote-auth/status',
  /** 首个管理员引导（仅回环）。 */
  bootstrap: '/remote-auth/bootstrap',
  /** 口令步骤；需要 MFA 时返回一次性挑战。 */
  login: '/remote-auth/login',
  /** 第二步：TOTP 或备用码。 */
  mfa: '/remote-auth/mfa',
  /** 登出（撤销当前浏览器会话）。 */
  logout: '/remote-auth/logout',
  /** 注册一个可信客户端公钥（需要已认证会话 + 最近一次 2FA）。 */
  enroll: '/remote-auth/clients/enroll',
  /** 列出 / 撤销 / 切换角色。 */
  clients: '/remote-auth/clients',
  /** 用客户端私钥证明换取 / 轮换 7 天租约。 */
  lease: '/remote-auth/lease',
} as const

export type AuthRoutePath = (typeof AUTH_ROUTES)[keyof typeof AUTH_ROUTES]

/** 请求头：客户端身份与签名。 */
export const AUTH_HEADERS = {
  clientId: 'x-hub-client-id',
  keyId: 'x-hub-key-id',
  /** 毫秒时间戳（十进制）。 */
  timestamp: 'x-hub-ts',
  /** 一次性随机串（base64url，16..64 字符）。 */
  nonce: 'x-hub-nonce',
  /** 请求体 sha256（十六进制小写）。 */
  bodyDigest: 'x-hub-body-sha256',
  /** base64 的 ECDSA P-256 DER 签名。 */
  signature: 'x-hub-signature',
} as const

/** 浏览器会话 Cookie 名（HttpOnly；与 DSH 核心的 `dsh-auth` 无关）。 */
export const SESSION_COOKIE = 'dsh_hub_session'

/** 认证面错误码（与守卫的 `ERROR_CODES` 分 namespace）。 */
export const AUTH_ERROR_CODES = {
  unauthorized: 'auth-unauthorized',
  forbidden: 'auth-forbidden',
  badRequest: 'auth-bad-request',
  /** 尚未创建账号：前端进入引导模式。 */
  bootstrapRequired: 'auth-bootstrap-required',
  /** 已经存在账号：引导端点拒绝。 */
  bootstrapClosed: 'auth-bootstrap-closed',
  /** 口令 + 用户名不匹配（对外不区分二者，避免枚举）。 */
  invalidCredentials: 'auth-invalid-credentials',
  /** 需要第二步（响应里带一次性 `mfaToken`，**不是**会话）。 */
  mfaRequired: 'auth-mfa-required',
  /** 动态码 / 备用码错误。 */
  mfaInvalid: 'auth-mfa-invalid',
  /** 挑战过期或已被使用。 */
  mfaExpired: 'auth-mfa-expired',
  /** 失败次数超限（窗口内）。 */
  rateLimited: 'auth-rate-limited',
  /** 客户端未知 / 已撤销 / 公钥不匹配。 */
  clientInvalid: 'auth-client-invalid',
  /** 租约过期或已轮换。 */
  leaseExpired: 'auth-lease-expired',
  /** 请求签名不合法（含时间戳漂移、nonce 重放、正文摘要不符）。 */
  proofInvalid: 'auth-proof-invalid',
  /** 请求角色超出该客户端的上限。 */
  roleExceeded: 'auth-role-exceeded',
  /** 认证服务不可用（Hub 侧 fail-closed）。 */
  unavailable: 'auth-unavailable',
  internal: 'auth-internal',
} as const

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES]

/** 客户端类型（仅用于展示与策略提示，**不**作为身份判据）。 */
export type ClientType = 'browser' | 'app' | 'dsh'

export const CLIENT_TYPES: readonly ClientType[] = ['browser', 'app', 'dsh']

/** 运行期校验。 */
export function isClientType(value: unknown): value is ClientType {
  return typeof value === 'string' && (CLIENT_TYPES as readonly string[]).includes(value)
}

/** 校验并限制客户端公钥只接受 ECDSA P-256 的 JWK。 */
export interface ClientPublicKeyJwk {
  kty: 'EC'
  crv: 'P-256'
  x: string
  y: string
}

/** 一个可信客户端（对外视图，**不含**租约密文 / 私钥 / 任何可重放凭据）。 */
export interface TrustedClientView {
  clientId: string
  keyId: string
  label: string
  clientType: ClientType
  /** 公钥指纹（sha256 前 16 hex）：仅用于人眼核对，**不是**认证秘密。 */
  fingerprint: string
  roleCeiling: RoleName
  activeRole: RoleName
  createdAt: string
  lastSeenAt: string | null
  /** 租约到期时间（epoch ms）；无租约时为 null。 */
  leaseExpiresAt: number | null
  /** 当前租约代次（轮换检测用；单调递增，从 1 开始）。 */
  leaseGeneration: number
  revokedAt: string | null
}

/** 认证通过后交给 Hub 的声明（**唯一**跨插件边界的数据）。 */
export interface AuthClaims {
  accountId: string
  clientId: string
  keyId: string
  clientType: ClientType
  /** 该客户端允许的最高角色（服务端决定，请求不可提升）。 */
  roleCeiling: RoleName
  /** 当前生效角色；`<= roleCeiling`。 */
  activeRole: RoleName
  leaseGeneration: number
  /** epoch ms。 */
  expiresAt: number
}

/** 浏览器会话视图（认证管理面）。 */
export interface AuthSessionView {
  accountId: string
  username: string
  role: 'admin'
  createdAt: string
  expiresAt: number
  /** 最近一次完成 2FA 的时间（用于「信任新客户端」的时效判定）。 */
  lastMfaAt: number | null
}

/** `/remote-auth/status` 的响应体。 */
export interface AuthStatusResponse {
  /** 服务是否就绪。 */
  ready: boolean
  /** 是否已经创建账号（false = 引导模式）。 */
  bootstrapped: boolean
  /** 是否启用 MFA（默认启用）。 */
  mfaEnabled: boolean
  /** 当前浏览器会话；未登录为 null。 */
  session: AuthSessionView | null
  /** 当前账号名（未引导时为 null）。 */
  username: string | null
  /** 该账号已信任的客户端（仅已登录时返回）。 */
  clients?: readonly TrustedClientView[]
}

/** 登录请求体。 */
export interface LoginRequest {
  username: string
  password: string
}

/** 登录成功（或需要第二步）的响应。 */
export type LoginResponse =
  | { ok: true; mfaRequired: false; session: AuthSessionView }
  | { ok: true; mfaRequired: true; mfaToken: string; expiresAt: number }

/** 第二步请求体。 */
export interface MfaRequest {
  mfaToken: string
  /** 6 位动态码，或一次性备用码。 */
  code: string
}

/** 注册可信客户端请求体。 */
export interface EnrollClientRequest {
  label: string
  clientType: ClientType
  publicKey: ClientPublicKeyJwk
  /** 该客户端允许的最高角色。 */
  roleCeiling: RoleName
}

/** 注册成功：返回一次性的客户端标识 + 初始租约。 */
export interface EnrollClientResponse {
  ok: true
  client: TrustedClientView
  lease: LeaseGrant
}

/** 一次租约签发（明文只在这一刻出现在响应里）。 */
export interface LeaseGrant {
  /** 明文租约；Hub 侧作为 `Authorization: Bearer <lease>`。 */
  lease: string
  generation: number
  expiresAt: number
}

/** 轮换租约请求体。 */
export interface LeaseRenewRequest {
  clientId: string
  keyId: string
  generation: number
}

/** 客户端管理操作请求体。 */
export type ClientActionRequest =
  | { action: 'list' }
  | { action: 'revoke'; clientId: string }
  | { action: 'setRole'; clientId: string; role: RoleName }
  | { action: 'setCeiling'; clientId: string; roleCeiling: RoleName }

/** 签名域版本：任何字段变化都必须同时升级它与两侧实现。 */
export const PROOF_VERSION = 'v1'

/**
 * 构造被签名的规范化字符串。
 *
 * 字段顺序固定、分隔符固定；任何一处不同都必须导致签名失配。
 * 覆盖客户端身份（防止跨客户端拼装）、代次（防止旧租约复用）、
 * 正文摘要（防止换体）与时间/nonce（防止重放）。
 *
 * @param input - 请求事实。
 * @returns 供 ECDSA 签名的 UTF-8 文本。
 */
export function buildProofPayload(input: {
  method: string
  path: string
  audience: string
  timestamp: string
  nonce: string
  clientId: string
  keyId: string
  generation: number
  bodyDigest: string
}): string {
  return [
    PROOF_VERSION,
    input.method.toUpperCase(),
    input.path,
    input.audience.toLowerCase(),
    input.timestamp,
    input.nonce,
    input.clientId,
    input.keyId,
    String(input.generation),
    input.bodyDigest.toLowerCase(),
  ].join('\n')
}

/** 允许的时间戳漂移（毫秒）。 */
export const PROOF_MAX_SKEW_MS = 120_000

/** nonce 的记忆窗口（必须 > 漂移的两倍，保证漂移窗口内的重放都会被记账）。 */
export const PROOF_NONCE_TTL_MS = 10 * 60_000

/** 7 天租约（固定语义；后台在此周期轮换）。 */
export const LEASE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** 浏览器会话默认有效期（7 天；与租约同周期但不是同一凭据）。 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** 完成 2FA 之后允许「信任新客户端」的时效窗口。 */
export const MFA_TRUST_WINDOW_MS = 10 * 60_000

/** 账号存储格式版本。 */
export const AUTH_STORE_VERSION = 1

/** `verifyHubRequest` 的入参：Hub 守卫把请求事实交给认证服务。 */
export interface HubAuthVerifyInput {
  /** `Authorization: Bearer <lease>` 里的租约明文；缺失时为空串。 */
  lease: string
  method: string
  path: string
  /** 目标 authority（小写 `host[:port]`），防跨目标重放。 */
  audience: string
  /** 请求体 sha256（无正文时为空串）。 */
  bodyDigest: string
  /** 只读取 `AUTH_HEADERS` 里的名字。 */
  headers: Readonly<Record<string, string | undefined>>
}

/** `verifyHubRequest` 的结果。 */
export type HubAuthVerdict =
  | { ok: true; claims: AuthClaims }
  | { ok: false; code: AuthErrorCode; reason: string }

/**
 * 认证插件向 Hub 暴露的**唯一**服务面（`ctx.provide('remoteHubAuth', …)`）。
 *
 * Hub 只消费认证结论与撤销事件；它读不到账号文件、公钥或任何密文。
 */
export interface HubAuthPort {
  /** 服务名（Cordis service key）。 */
  readonly serviceName: 'remoteHubAuth'
  /** 校验一次 Hub 请求（租约 + 客户端签名）。 */
  verifyHubRequest(input: HubAuthVerifyInput): Promise<HubAuthVerdict>
  /** 客户端被撤销（Hub 丢弃该客户端的 Peer 与流）。 */
  onClientRevoked(listener: (clientId: string) => void): () => void
  /** 客户端角色变化（Hub 断开旧连接，避免降权只对新请求生效）。 */
  onClientRoleChanged(listener: (clientId: string, role: RoleName) => void): () => void
  /** 有序关闭（Hub 卸载时调用）。 */
  dispose(): Promise<void>
}
