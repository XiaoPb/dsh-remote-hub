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
  /** 修改口令（首次登录强制；也需要当前口令）。 */
  password: '/remote-auth/password',
  /** 口令策略读取 / 切换（仅管理员）。 */
  policy: '/remote-auth/policy',
  /** 在当前会话上重新验证口令 + TOTP（提权前的新鲜 2FA 窗口）。 */
  reauth: '/remote-auth/reauth',
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
  /** 必须先修改初始口令（默认账号首次登录）。 */
  passwordChangeRequired: 'auth-password-change-required',
  /** 修改口令时提供的当前口令不正确。 */
  currentPasswordInvalid: 'auth-current-password-invalid',
  /** 新口令不满足强度要求。 */
  passwordWeak: 'auth-password-weak',
  /** 新口令与当前口令相同。 */
  passwordUnchanged: 'auth-password-unchanged',
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
  /** 被单控挤下线的时间（仍保留信任，只是当前没在控制）。 */
  displacedAt?: string | null
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
  /**
   * 是否必须先修改口令才能继续。
   *
   * 由「默认账号自动创建」触发；改密成功后永久清除（**只强制一次**）。
   * 为 true 时除 `status` / `login` / `logout` / `password` 外的认证端点都返回
   * `auth-password-change-required`，因此拿不到租约、也进不了 Hub。
   */
  passwordChangeRequired?: boolean
  /** 当前生效的口令策略（仅已登录时返回；切换在设置页）。 */
  passwordPolicy?: PasswordPolicy
}

/** 登录请求体。 */
export interface LoginRequest {
  username: string
  password: string
  /**
   * 请求来源（IP 或隧道对端标识），用于按来源限流。
   *
   * 服务端自己填；客户端传了也会被覆盖。缺省 `local`（测试/本机调用）。
   */
  source?: string
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

/**
 * 会话闲置超时：超过这个时间没有任何请求，会话作废。
 *
 * 绝对有效期是 7 天，但「一直不用」的会话不该继续有效——被盗的 Cookie
 * 往往在很久之后才被使用。
 */
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000

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
  /**
   * 列出全部可信客户端（不需要会话）。
   *
   * 只给**守卫**用：账号认证模式下，`/remote/devices` 必须展示真正的身份表
   * （auth clients），而不是旧版设备表，否则运行页与设置页会各说各话。
   */
  listTrustedClients(): readonly TrustedClientView[]
  /**
   * 邀请兑换：登记客户端公钥（authorization 来自本机签发的短时邀请）。
   *
   * 账号认证模式下守卫的 `/remote/pair` 用它替代「签发长期设备令牌」。
   */
  enrollFromInvite(input: {
    label: string
    clientType: ClientType
    publicKey: ClientPublicKeyJwk
    roleCeiling: RoleName
  }): Promise<EnrollClientResponse>
  /**
   * 单控：把 `keepClientId` 之外的客户端标记为「被挤下线」并返回它们的 id。
   *
   * 只动标记，不断连接——断连由调用方走 `onSessionDisplaced`/`dropDevice`，
   * 这样认证层不依赖 Hub 的连接管理。
   */
  displaceOthers(keepClientId: string): Promise<readonly string[]>
  /** 客户端被撤销（Hub 丢弃该客户端的 Peer 与流）。 */
  onClientRevoked(listener: (clientId: string) => void): () => void
  /** 客户端角色变化（Hub 断开旧连接，避免降权只对新请求生效）。 */
  onClientRoleChanged(listener: (clientId: string, role: RoleName) => void): () => void
  /** 有序关闭（Hub 卸载时调用）。 */
  dispose(): Promise<void>
}

/** 默认账号：首次启动自动创建，仅用于让本地页面完成首次登录。 */
export const DEFAULT_ACCOUNT = {
  username: 'admin',
  /**
   * 初始口令。
   *
   * 空串 = **安装时随机生成**并写入 `INITIAL_PASSWORD_FILE`（明文、0600），
   * 改密成功后该文件被删除（一次性）。只有显式配置非空值时才使用固定口令。
   */
  password: '',
} as const

/**
 * 初始口令文件（相对 `~/.dsh/remote-hub/`）。
 *
 * 内容就是那一行口令，方便 `cat` / 复制；目录 0700、文件 0600。
 * **只在账号库为空时创建**；强制改密成功后删除，避免明文长期驻留。
 */
export const INITIAL_PASSWORD_FILE = 'initial-password'

/**
 * 认证面的 HTTP 处理器句柄（认证插件 `provide('remoteHubAuthHttp')`）。
 *
 * 守卫据此把 `/remote-auth/*` 也开在自己的监听上，让控制端能跨源完成
 * 「账号 + TOTP → 登记客户端公钥」；同源 Web 面仍走 webServer 的 Cookie 版本。
 */
export interface AuthHttpSurface {
  /** 该处理器负责的路径集合。 */
  readonly paths: readonly string[]
  /**
   * 处理一次请求（请求/响应是 `node:http` 对象，跨包只按 unknown 传递）。
   * @returns 处理完成即 resolve。
   */
  handle(request: unknown, response: unknown): Promise<void>
}

/**
 * 口令策略。
 *
 * - `strong`（默认）：至少 12 位，且包含小写、大写、数字、符号；不得包含用户名。
 * - `basic`：至少 8 位（仅此要求）。
 *
 * 两侧共用 `evaluatePassword`，因此设置页展示的规则与 Host 的拒绝理由永远一致。
 */
export type PasswordPolicy = 'strong' | 'basic'

/** 可选策略列表（UI 顺序）。 */
export const PASSWORD_POLICIES: readonly PasswordPolicy[] = ['strong', 'basic']

/** 运行期校验。 */
export function isPasswordPolicy(value: unknown): value is PasswordPolicy {
  return value === 'strong' || value === 'basic'
}

/** 两条策略的最小长度（UI 提示与 Host 判定共用）。 */
export const PASSWORD_MIN_LENGTH: Readonly<Record<PasswordPolicy, number>> = {
  strong: 12,
  basic: 8,
}

/** 单条规则的失败原因。 */
export type PasswordFailure =
  | 'too-short'
  | 'no-lower'
  | 'no-upper'
  | 'no-digit'
  | 'no-symbol'
  | 'contains-username'
  | 'only-whitespace'

/** 一条可展示的规则。 */export interface PasswordRule {
  id: PasswordFailure
  /** 中文提示（设置页/登录页直接显示）。 */
  zh: string
  en: string
}

/** 强密码规则（顺序即 UI 顺序）。 */
export const STRONG_PASSWORD_RULES: readonly PasswordRule[] = [
  { id: 'too-short', zh: `至少 ${PASSWORD_MIN_LENGTH.strong} 位`, en: `At least ${PASSWORD_MIN_LENGTH.strong} characters` },
  { id: 'no-lower', zh: '包含小写字母', en: 'Contains a lowercase letter' },
  { id: 'no-upper', zh: '包含大写字母', en: 'Contains an uppercase letter' },
  { id: 'no-digit', zh: '包含数字', en: 'Contains a digit' },
  { id: 'no-symbol', zh: '包含符号（如 !@#$%^&*）', en: 'Contains a symbol (e.g. !@#$%^&*)' },
  { id: 'contains-username', zh: '不包含用户名', en: 'Does not contain the username' },
]

/** 基础策略规则。 */
export const BASIC_PASSWORD_RULES: readonly PasswordRule[] = [
  { id: 'too-short', zh: `至少 ${PASSWORD_MIN_LENGTH.basic} 位`, en: `At least ${PASSWORD_MIN_LENGTH.basic} characters` },
]

/** 取某策略下的规则表。 */
export function passwordRules(policy: PasswordPolicy): readonly PasswordRule[] {
  return policy === 'strong' ? STRONG_PASSWORD_RULES : BASIC_PASSWORD_RULES
}

/**
 * 评估口令。
 *
 * 返回**全部**未满足项（不是只返回第一条），设置页据此逐条打勾。
 * 纯函数、无副作用，Host 与浏览器共用同一份判定。
 *
 * @param password - 候选口令（不 trim：前导/尾随空格也算字符，但全空白直接拒绝）。
 * @param policy - 策略。
 * @param username - 账号名（`strong` 下禁止包含）。
 * @returns `{ ok, failures }`。
 */
export function evaluatePassword(
  password: string,
  policy: PasswordPolicy,
  username = '',
): { ok: boolean; failures: PasswordFailure[] } {
  const value = typeof password === 'string' ? password : ''
  const failures: PasswordFailure[] = []
  const minimum = PASSWORD_MIN_LENGTH[policy] ?? PASSWORD_MIN_LENGTH.strong

  if (value.trim() === '') failures.push('only-whitespace')
  if ([...value].length < minimum) failures.push('too-short')

  if (policy === 'strong') {
    if (!/[a-z]/u.test(value)) failures.push('no-lower')
    if (!/[A-Z]/u.test(value)) failures.push('no-upper')
    if (!/[0-9]/u.test(value)) failures.push('no-digit')
    if (!/[^\p{L}\p{N}]/u.test(value)) failures.push('no-symbol')
    const normalized = username.trim().toLowerCase()
    if (normalized !== '' && value.toLowerCase().includes(normalized)) failures.push('contains-username')
  }

  return { ok: failures.length === 0, failures }
}

/** 默认口令策略。 */
export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = 'strong'

/**
 * 默认账号的强制改密标记。
 *
 * 在改用**更强口令**之前，认证面只允许 `status` / `login` / `logout` / `password`，
 * 其余（绑定 2FA、信任客户端、轮换租约）一律 403 `auth-password-change-required`：
 * 没有改密就拿不到租约，也就进不了 Hub。
 */
export const FORCED_PASSWORD_CHANGE = true
