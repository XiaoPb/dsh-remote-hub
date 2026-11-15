/**
 * 认证原语：口令哈希、常量时间比较、公钥校验与签名验证。
 *
 * 不变量：
 * - 口令只以 scrypt 派生值落盘（`scrypt$N$r$p$salt$hash`），永不存明文，也永不接受
 *   明文比较（与 `dsh-remote` 的 legacy 分支刻意不同：那条路径会把旧明文当口令用）。
 * - 所有比较先归一到等长再 `timingSafeEqual`，不因长度差异短路。
 * - 客户端公钥只接受 ECDSA P-256；签名按 DER（WebCrypto 的原生输出）验证。
 *
 * @module dsh-remote-hub/host/auth/crypto
 */
import { createHash, createPublicKey, randomBytes, scrypt as scryptCb, timingSafeEqual, verify as verifySignature } from 'node:crypto'
import { promisify } from 'node:util'

import type { ClientPublicKeyJwk } from '@core/auth.js'

/** `scrypt` 的 Promise 包装（保留 options 参数）。 */
const scryptAsync = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>

/** scrypt 参数（与 `dsh-remote` 一致，便于迁移现有哈希）。 */
export const SCRYPT_N = 16_384
export const SCRYPT_R = 8
export const SCRYPT_P = 1
const SCRYPT_KEYLEN = 64

/** 派生值前缀。 */
const SCRYPT_PREFIX = 'scrypt'

/**
 * 生成口令哈希。
 * @param password - 明文口令（只在本次调用中存在）。
 * @returns `scrypt$N$r$p$saltB64$hashB64`。
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })
  return [
    SCRYPT_PREFIX,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$')
}

/**
 * 常量时间校验口令。
 *
 * 兼容两种历史格式：
 * - `scrypt$N$r$p$salt$hash`（本仓库首选）
 * - `scrypt$salt$hash`（`dsh-remote` 的旧格式，N/r/p 固定）
 *
 * 明文旧值一律**拒绝**（返回 false），必须由迁移显式处理。
 * @param password - 候选口令。
 * @param stored - 落盘的派生值。
 * @returns 匹配时为 true；任何非法输入返回 false（不抛）。
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (typeof password !== 'string' || typeof stored !== 'string') return false
  const parts = stored.split('$')
  if (parts.length < 3 || parts[0] !== SCRYPT_PREFIX) return false

  let n = SCRYPT_N
  let r = SCRYPT_R
  let p = SCRYPT_P
  let saltB64: string | undefined
  let hashB64: string | undefined

  if (parts.length === 6) {
    n = Number(parts[1])
    r = Number(parts[2])
    p = Number(parts[3])
    saltB64 = parts[4]
    hashB64 = parts[5]
  } else if (parts.length === 3) {
    saltB64 = parts[1]
    hashB64 = parts[2]
  }
  if (saltB64 === undefined || hashB64 === undefined) return false
  if (!Number.isSafeInteger(n) || n < 1024 || n > 1_048_576) return false
  if (!Number.isSafeInteger(r) || r < 1 || r > 32) return false
  if (!Number.isSafeInteger(p) || p < 1 || p > 16) return false

  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(saltB64, 'base64')
    expected = Buffer.from(hashB64, 'base64')
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false

  let derived: Buffer
  try {
    derived = await scryptAsync(password, salt, expected.length, { N: n, r, p })
  } catch {
    return false
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

/**
 * `sha256(data)` 的十六进制小写表示。
 * @param data - 字节或字符串（按 UTF-8）。
 * @returns 64 字符十六进制。
 */
export function sha256Hex(data: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(data as never).digest('hex')
}

/**
 * 生成 32 字节随机串（base64url，43 字符）。
 * @returns 随机串。
 */
export function randomToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * 等长常量时间比较两个十六进制摘要。
 * @param a - 十六进制串。
 * @param b - 十六进制串。
 * @returns 相等且形状合法时为 true。
 */
export function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (!/^[0-9a-f]{64}$/u.test(a) || !/^[0-9a-f]{64}$/u.test(b)) return false
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

/** 公钥 JWK 的形状校验（只接受 ECDSA P-256）。 */
export function isClientPublicKeyJwk(value: unknown): value is ClientPublicKeyJwk {
  if (typeof value !== 'object' || value === null) return false
  const key = value as Record<string, unknown>
  return key.kty === 'EC'
    && key.crv === 'P-256'
    && typeof key.x === 'string' && key.x !== ''
    && typeof key.y === 'string' && key.y !== ''
    && !('d' in key)
}

/**
 * 公钥指纹：`sha256(JSON.stringify({kty,crv,x,y}))` 的前 16 个十六进制字符。
 *
 * 仅用于 UI 上让人眼核对「是不是这台设备」，**不是**认证凭据。
 * @param jwk - 公钥。
 * @returns 16 字符十六进制。
 */
export function publicKeyFingerprint(jwk: ClientPublicKeyJwk): string {
  const canonical = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y })
  return sha256Hex(canonical).slice(0, 16)
}

/**
 * 验证 ECDSA P-256 / SHA-256 签名。
 *
 * WebCrypto 的 `subtle.sign({name:'ECDSA',hash:'SHA-256'})` 输出 IEEE P1363
 * （r||s，64 字节），而 Node 默认按 DER 解析。这里两种都接受，避免客户端实现
 * 差异导致「签名永远验不过」。
 * @param jwk - 客户端登记的公钥。
 * @param payload - 被签名的规范化字符串（UTF-8）。
 * @param signatureB64 - base64 签名。
 * @returns 验证通过时为 true；任何解析失败返回 false（不抛）。
 */
export function verifyEcdsa(jwk: ClientPublicKeyJwk, payload: string, signatureB64: string): boolean {
  if (!isClientPublicKeyJwk(jwk)) return false
  if (typeof signatureB64 !== 'string' || signatureB64 === '') return false
  let signature: Buffer
  try {
    signature = Buffer.from(signatureB64, 'base64')
  } catch {
    return false
  }
  if (signature.length === 0 || signature.length > 256) return false

  let key: ReturnType<typeof createPublicKey>
  try {
    key = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: 'jwk' })
  } catch {
    return false
  }

  const data = Buffer.from(payload, 'utf8')
  // WebCrypto P-1363：64 字节定长 r||s。
  if (signature.length === 64) {
    try {
      if (verifySignature('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature)) return true
    } catch {
      // 落到 DER 分支再试一次。
    }
  }
  try {
    return verifySignature('sha256', data, { key, dsaEncoding: 'der' }, signature)
  } catch {
    return false
  }
}
