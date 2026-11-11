/**
 * 配对：一台设备变成受信任设备的**唯一**途径。
 *
 * 两条路径（D-14），共享同一个签发出口与同一个角色绑定：
 * - **QR 主路径**：`issueTicket(role)` → 32 字节随机 / base64url 43 字符 /
 *   TTL 120s / 单次使用。载荷里**不含** `deviceId` 或 `role`（角色由签发记录决定，
 *   请求体无法自称）。
 * - **短码兜底**：`issueCode(role)` → 8 位 Crockford Base32（40 bit，去掉 I/L/O/U）/
 *   TTL 600s / 5 次错误预算。**成功或预算耗尽都必须 burn**。
 *
 * 安全性质（红线 R4）：
 * - 短码/票据**绝不写日志、绝不回显进错误体**。错误体只给 `pair-invalid` /
 *   `pair-expired` / `rate-limited` 这类码。
 * - 签发端（`GUARD_ROUTES.pairTicket` / `pairCode`）由守卫施加**双条件回环门控**
 *   以及进程内 `pairIssueToken`；兑换端（`GUARD_ROUTES.pair`）**故意不门控**
 *   —— 远程设备在隧道外，门控兑换端等于永远配不上。
 * - 所有比较走常量时间：先对两边哈希使长度恒等，再 `timingSafeEqual`。
 * - 新签发作废同一路径上的旧签发（同一时刻每个路径最多一个有效签发）。
 *
 * @module dsh-remote-hub/host/pairing
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'

import { CROCKFORD_ALPHABET, ERROR_CODES, PAIRING } from '@core/index.js'
import type { PairingAuditRow, PairingPath, RoleName, IssuedDeviceToken } from '@core/index.js'
import { isRoleName } from '@core/roles.js'

import { hashToken } from './token.js'

/** 兑换结果。失败只给码，**不含**票据/短码或具体失败原因。 */
export type RedeemResult =
  | { ok: true; issued: IssuedDeviceToken }
  | { ok: false; code: typeof ERROR_CODES.pairInvalid | typeof ERROR_CODES.pairExpired | typeof ERROR_CODES.rateLimited }

/** 一次签发的公开视图（给本机屏幕显示，绝不写到日志里）。 */
export interface IssuedPairing {
  /** QR 路径的 43 字符票据，或短码路径的 8 位码。 */
  secret: string
  role: RoleName
  expiresAt: number
}

interface Issuance {
  /** 只存哈希：比较时把候选也哈希，长度恒等。 */
  hash: string
  role: RoleName
  expiresAt: number
  failedAttempts: number
  burned: boolean
}

export interface PairingServiceDeps {
  config: {
    pairQrTtlMs: number
    pairCodeTtlMs: number
    maxPairAttempts: number
    defaultRole?: RoleName
  }
  /** 兑换成功时签发设备令牌。 */
  tokens: {
    issue(options: { label: string; role: RoleName }): Promise<{ device: unknown; token: string }>
  }
  /** 注入时钟（测试 TTL 用）。 */
  now?: () => number
  /** 每条成功兑换写一行结构化审计。 */
  onAudit?: (row: PairingAuditRow) => void
}

export interface PairingService {
  /** 签发 QR 票据。作废之前的 QR 票据。 */
  issueTicket(role?: RoleName): IssuedPairing
  /** 签发 8 位短码。作废之前的短码。 */
  issueCode(role?: RoleName): IssuedPairing
  /** 兑换 QR 票据（redeem 即 burn）。 */
  redeemTicket(ticket: string, clientLabel: string): Promise<RedeemResult>
  /** 兑换短码（成功或预算耗尽都 burn）。 */
  redeemCode(code: string, clientLabel: string): Promise<RedeemResult>
  /**
   * 当前是否还有未过期、未 burn 的签发。
   *
   * **不回显 secret**：票据/短码只在 `issueTicket()` / `issueCode()` 的返回值里
   * 交给本机屏幕一次，服务内部只留哈希。这样它不可能从 `current()` 漏进日志。
   */
  current(): { path: PairingPath; role: RoleName; expiresAt: number } | null
}

/** 8 位 Crockford Base32：40 bit，字符集不含 `I L O U`。 */
export function generatePairCode(): string {
  const bytes = randomBytes(PAIRING.codeLength)
  let out = ''
  for (const byte of bytes) out += CROCKFORD_ALPHABET[byte & 31]
  return out
}

/** 32 字节随机 → base64url（43 字符）。 */
export function generatePairTicket(): string {
  return randomBytes(PAIRING.ticketBytes).toString('base64url')
}

/** 候选短码的形状（常量时间比较前的资源保护，不是安全判定）。 */
export function isPairCodeShaped(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== PAIRING.codeLength) return false
  return [...value].every(char => CROCKFORD_ALPHABET.includes(char))
}

/** 候选票据的形状。 */
export function isPairTicketShaped(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value)
}

/** 常量时间比较：两边各自 sha256 后比较 32 字节缓冲区。 */
function constantTimeSecretEqual(candidate: string, expectedHash: string): boolean {
  const left = Buffer.from(hashToken(candidate), 'hex')
  const right = Buffer.from(expectedHash, 'hex')
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * 创建配对服务。
 * @param deps - 配置、令牌服务、可选时钟与审计回调。
 * @returns `PairingService`。
 */
export function createPairingService(deps: PairingServiceDeps): PairingService {
  const now = deps.now ?? (() => Date.now())
  let ticket: Issuance | null = null
  let code: Issuance | null = null

  const resolveRole = (role?: RoleName): RoleName => {
    const chosen = role ?? deps.config.defaultRole ?? 'control'
    if (!isRoleName(chosen)) throw new Error(`pairing: invalid role ${JSON.stringify(chosen)}`)
    return chosen
  }

  const issue = (path: PairingPath, secret: string, role: RoleName, ttlMs: number): IssuedPairing => {
    const issuance: Issuance = {
      hash: hashToken(secret),
      role,
      expiresAt: now() + ttlMs,
      failedAttempts: 0,
      burned: false,
    }
    if (path === 'qr') ticket = issuance
    else code = issuance
    return { secret, role, expiresAt: issuance.expiresAt }
  }

  const redeem = async (
    path: PairingPath,
    candidate: string,
    clientLabel: string,
    shapeOk: (value: unknown) => boolean,
  ): Promise<RedeemResult> => {
    const issuance = path === 'qr' ? ticket : code
    if (issuance === null) return { ok: false, code: ERROR_CODES.pairInvalid }
    // **预算检查先于 burned 检查**（ROADMAP T1.6 / A1-4 / G-5）：
    // 前 5 次错码都是 attempt（返回 pair-invalid，不 burn）；failedAttempts 达到
    // maxPairAttempts 之后，第 6 次调用（无论送来什么）才返回 rate-limited 并 burn。
    // 顺序反了的话第 5 次就会 burn，第 6 次落到 burned 前置检查变成 pair-invalid。
    if (issuance.failedAttempts >= deps.config.maxPairAttempts) {
      issuance.burned = true
      return { ok: false, code: ERROR_CODES.rateLimited }
    }
    // 已 burn 的签发（成功兑换过、过期过、或后续预算耗尽过）一律拒。
    if (issuance.burned) return { ok: false, code: ERROR_CODES.pairInvalid }
    if (now() > issuance.expiresAt) {
      // 过期即 burn：不让一个过期的签发继续占据「当前签发」的位置。
      issuance.burned = true
      return { ok: false, code: ERROR_CODES.pairExpired }
    }

    const matches = shapeOk(candidate) && constantTimeSecretEqual(candidate, issuance.hash)
    if (!matches) {
      // 错码只累加计数；**不在这里 burn**。第 5 次错码仍是 pair-invalid。
      issuance.failedAttempts += 1
      return { ok: false, code: ERROR_CODES.pairInvalid }
    }

    // 成功立即 burn（单次使用）：两次 redeem 第二次必得 pair-invalid。
    issuance.burned = true
    const { device, token } = await deps.tokens.issue({
      label: typeof clientLabel === 'string' && clientLabel.trim() !== '' ? clientLabel.trim() : 'remote device',
      role: issuance.role,
    })
    const record = device as { deviceId?: unknown; role?: unknown } | null
    const issued: IssuedDeviceToken = {
      deviceId: typeof record?.deviceId === 'string' ? record.deviceId : '',
      token,
      role: issuance.role,
    }
    deps.onAudit?.({
      deviceId: issued.deviceId,
      label: clientLabel,
      role: issuance.role,
      path,
      at: new Date(now()).toISOString(),
      sourceAuthority: null,
    })
    return { ok: true, issued }
  }

  return {
    issueTicket(role) {
      return issue('qr', generatePairTicket(), resolveRole(role), deps.config.pairQrTtlMs)
    },
    issueCode(role) {
      return issue('code', generatePairCode(), resolveRole(role), deps.config.pairCodeTtlMs)
    },
    redeemTicket(ticketValue, clientLabel) {
      return redeem('qr', ticketValue, clientLabel, isPairTicketShaped)
    },
    redeemCode(codeValue, clientLabel) {
      return redeem('code', codeValue, clientLabel, isPairCodeShaped)
    },
    current() {
      const at = now()
      for (const [path, issuance] of [['qr', ticket], ['code', code]] as const) {
        if (issuance !== null && !issuance.burned && at <= issuance.expiresAt) {
          return { path, role: issuance.role, expiresAt: issuance.expiresAt }
        }
      }
      return null
    },
  }
}
