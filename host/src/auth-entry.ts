/**
 * `@xiaopb/dsh-remote-hub/auth` 的公共入口（第二个 Cordis 插件行）。
 *
 * 与包主入口（`.` = Hub）在同一个进程内共存：
 * - 本入口 `provide('remoteHubAuth')`；
 * - Hub 入口按配置 `inject` 它并只消费认证结论。
 *
 * 这里同时导出认证原语与存储，供测试与运维脚本直接消费。
 *
 * @module dsh-remote-hub/auth
 */
export { apply, Config, name, inject, DEFAULT_AUTH_CONFIG } from './auth/plugin.js'
export type { AuthConfig } from './auth/plugin.js'

export {
  createAuthService,
  MAX_ROLE,
} from './auth/service.js'
export type {
  AuthService,
  AuthServiceDeps,
  BootstrapResult,
  IssuedSession,
} from './auth/service.js'

export {
  createAuthStore,
  defaultAuthStorePath,
  emptyAuthStore,
  newClientId,
  newKeyId,
  newSessionId,
} from './auth/store.js'
export type {
  AccountRecord,
  AuthStore,
  AuthStoreData,
  ClientRecord,
  MfaChallengeRecord,
  SessionRecord,
} from './auth/store.js'

export {
  hashPassword,
  verifyPassword,
  sha256Hex,
  randomToken,
  safeEqualHex,
  isClientPublicKeyJwk,
  publicKeyFingerprint,
  verifyEcdsa,
  SCRYPT_N,
  SCRYPT_R,
  SCRYPT_P,
} from './auth/crypto.js'

export {
  base32Encode,
  base32Decode,
  generateTotpSecret,
  totpCodeAt,
  verifyTotp,
  secondsRemaining,
  otpauthUri,
  generateBackupCodes,
  hashBackupCode,
  TOTP_STEP_SECONDS,
  TOTP_DIGITS,
} from './auth/totp.js'

export { createAuthHandler, audienceOf } from './auth/routes.js'
export type { AuthRouteDeps } from './auth/routes.js'

// 共享契约里两侧都要用的运行期常量与纯函数（浏览器侧与测试直接消费）。
export {
  AUTH_ROUTES,
  AUTH_HEADERS,
  AUTH_ERROR_CODES,
  SESSION_COOKIE,
  PROOF_VERSION,
  PROOF_MAX_SKEW_MS,
  PROOF_NONCE_TTL_MS,
  LEASE_TTL_MS,
  SESSION_TTL_MS,
  MFA_TRUST_WINDOW_MS,
  AUTH_STORE_VERSION,
  buildProofPayload,
  isClientType,
} from '@core/auth.js'
export type {
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
