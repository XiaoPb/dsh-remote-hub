/**
 * 设备令牌原语。
 *
 * 不变量（由 `test/token.test.mjs` 与 `scripts/sec-check.mjs` 强制）：
 * - 32 字节 `randomBytes(32).toString('base64url')` → 43 字符。
 * - 落盘只存 `hex(sha256(token))`（64 个十六进制字符）。被拿走的 `devices.json`
 *   提供零个可用凭据。
 * - 校验走常量时间：**两边先各自哈希使长度恒等**，再 `timingSafeEqual`；
 *   不短路、不按长度提前返回。
 * - 吊销即时且彻底：守卫在**路由之前**检查 `revokedAt`。
 *
 * 与官方先例的刻意差异：LiveShare 把凭据**明文**写入 0600 文件，因为它绑定的是一条
 * 单一中继的**短期** token。我们的设备令牌是**长期**凭据，所以必须存哈希。
 * 后人若「照抄先例」改成明文，就是把它变回长期明文凭据。
 *
 * @module dsh-remote-hub/host/token
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import type { DeviceRecord } from '@core/device.js'

/** 令牌字符数（32 字节 base64url）。 */
export const TOKEN_LENGTH = 43

/** 哈希的十六进制长度（sha256）。 */
export const TOKEN_HASH_LENGTH = 64

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u
const HASH_PATTERN = /^[0-9a-f]{64}$/u

/**
 * 生成一个新的设备令牌（明文只在这一刻存在）。
 * @returns 43 字符 base64url。
 */
export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * `hex(sha256(token))`。
 * @param token - 明文令牌。
 * @returns 64 字符十六进制哈希。
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * 常量时间比较。
 *
 * 关键点：**先对两边都哈希**，使长度恒等，再 `timingSafeEqual`。这样长度差异
 * （过短/过长的伪造令牌）走的是同一条代码路径，不会因为提前返回而泄露长度。
 * @param token - 待校验的明文令牌。
 * @param expectedHash - 设备记录里的 `tokenHash`。
 * @returns 匹配时为 true；任何非法输入都返回 false（**不抛**）。
 */
export function verifyTokenHash(token: string, expectedHash: string): boolean {
  if (typeof token !== 'string' || typeof expectedHash !== 'string') return false
  if (!HASH_PATTERN.test(expectedHash)) return false
  const actual = Buffer.from(hashToken(token), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  // 两个缓冲区长度恒为 32（sha256），所以这里不会因长度不同而抛。
  return timingSafeEqual(actual, expected)
}

/**
 * 形状快速拒绝：不是 43 字符 base64url 的输入连哈希都不必算。
 * 这是**资源保护**（挡住令牌洪泛），不是安全判定 —— 真正的判定是
 * {@link verifyTokenHash}。
 * @param value - 候选令牌。
 * @returns 形状合法时为 true。
 */
export function isTokenShaped(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value)
}

/** 令牌服务：签发、校验、吊销，以及吊销通知。 */
export interface TokenService {
  /** 生成并持久化一个新设备（只存哈希）；明文令牌只返回一次。 */
  issue(options: { label: string; role: DeviceRecord['role'] }): Promise<{ device: DeviceRecord; token: string }>
  /** 把一个 bearer 令牌解析成守卫侧身份；未知/已吊销返回 null。 */
  verify(token: string): Promise<{ deviceId: string; role: DeviceRecord['role'] } | null>
  /** 标记吊销；此后 `verify()` 永远返回 null。 */
  revoke(deviceId: string): Promise<void>
  /** 变更角色（重建 Peer 由调用方负责）。 */
  updateRole(deviceId: string, role: DeviceRecord['role']): Promise<void>
  /** 订阅吊销事件，用于丢弃该设备的 Peer 与在途流。 */
  onRevoked(listener: (deviceId: string) => void): () => void
  /** 订阅角色变更事件。 */
  onRoleChanged(listener: (deviceId: string, role: DeviceRecord['role']) => void): () => void
}

/** `createTokenService` 的依赖。 */
export interface TokenServiceDeps {
  devices: import('./devices.js').DeviceStore
  /** 注入时钟以便测试 TTL / 审计时间。 */
  now?: () => Date
}

/**
 * 创建令牌服务。
 *
 * 校验路径刻意**不缓存明文**：`verify()` 每次对候选令牌做 sha256，再与表里的
 * 每条 `tokenHash` 做常量时间比较。缓存已验证哈希会减少 CPU，但绝不允许缓存
 * 明文令牌本身（红线 R3）。
 * @param deps - 设备表与可选时钟。
 * @returns `TokenService`。
 */
export function createTokenService(deps: TokenServiceDeps): TokenService {
  const { devices } = deps
  const now = deps.now ?? (() => new Date())
  const revokedListeners = new Set<(deviceId: string) => void>()
  const roleListeners = new Set<(deviceId: string, role: DeviceRecord['role']) => void>()
  /** 心跳节流：每设备 60s 最多写一次 `lastSeenAt`（页面据此分级在线/空闲/离线）。 */
  const lastTouch = new Map<string, number>()
  const TOUCH_THROTTLE_MS = 60_000

  async function touchSeen(deviceId: string): Promise<void> {
    const at = now().getTime()
    const previous = lastTouch.get(deviceId) ?? 0
    if (at - previous < TOUCH_THROTTLE_MS) return
    lastTouch.set(deviceId, at)
    try {
      await devices.update(deviceId, { lastSeenAt: new Date(at).toISOString() })
    } catch {
      // 心跳写失败不影响认证结果。
    }
  }

  return {
    async issue(options) {
      const token = generateToken()
      const createdAt = now().toISOString()
      const device: DeviceRecord = {
        deviceId: `dev_${randomBytes(12).toString('hex')}`,
        label: options.label,
        role: options.role,
        tokenHash: hashToken(token),
        createdAt,
        lastSeenAt: null,
        revokedAt: null,
      }
      await devices.insert(device)
      return { device, token }
    },
    async verify(token) {
      if (!isTokenShaped(token)) return null
      for (const device of devices.list()) {
        if (device.revokedAt !== null) continue
        if (verifyTokenHash(token, device.tokenHash)) {
          void touchSeen(device.deviceId)
          return { deviceId: device.deviceId, role: device.role }
        }
      }
      return null
    },
    async revoke(deviceId) {
      const device = devices.get(deviceId)
      if (device === undefined || device.revokedAt !== null) return
      await devices.update(deviceId, { revokedAt: now().toISOString() })
      for (const listener of [...revokedListeners]) listener(deviceId)
    },
    async updateRole(deviceId, role) {
      const device = devices.get(deviceId)
      if (device === undefined) return
      if (device.role === role) return
      await devices.update(deviceId, { role })
      for (const listener of [...roleListeners]) listener(deviceId, role)
    },
    onRevoked(listener) {
      revokedListeners.add(listener)
      return () => { revokedListeners.delete(listener) }
    },
    onRoleChanged(listener) {
      roleListeners.add(listener)
      return () => { roleListeners.delete(listener) }
    },
  }
}
