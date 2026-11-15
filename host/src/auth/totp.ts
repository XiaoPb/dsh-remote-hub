/**
 * TOTP（RFC 6238）+ 一次性备用码。
 *
 * 只依赖 `node:crypto`，不引第三方包：TOTP 是小而稳定的算法，
 * 多一个依赖就多一份供应链面。
 *
 * 关键约束：
 * - 动态码比较走**常量时间**，并且窗口内每个步长都完整比较，不提前返回。
 * - 备用码只存 `sha256`，消费是**一次性**的（记录 `usedAt`）。
 *
 * @module dsh-remote-hub/host/auth/totp
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** RFC 4648 base32（无填充）。 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * 编码为 base32（无 `=` 填充）。
 * @param buffer - 原始字节。
 * @returns 大写 base32 字符串。
 */
export function base32Encode(buffer: Buffer): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return output
}

/**
 * 解码 base32（忽略空格、`=`，大小写不敏感）。
 * @param input - base32 文本。
 * @returns 字节；非法字符时抛错。
 */
export function base32Decode(input: string): Buffer {
  const cleaned = input.replace(/[\s=]/gu, '').toUpperCase()
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char)
    if (index < 0) throw new Error(`invalid base32 character ${JSON.stringify(char)}`)
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

/** 生成一个新的 TOTP 密钥（20 字节 → 32 字符 base32）。 */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

/** 默认 30 秒步长。 */
export const TOTP_STEP_SECONDS = 30

/** 默认 6 位。 */
export const TOTP_DIGITS = 6

/**
 * 计算某个时间点的动态码。
 * @param secretBase32 - 密钥。
 * @param atMs - 时间戳（毫秒）。
 * @returns 6 位十进制字符串。
 */
export function totpCodeAt(secretBase32: string, atMs: number): string {
  const counter = Math.floor(atMs / 1000 / TOTP_STEP_SECONDS)
  const buffer = Buffer.alloc(8)
  buffer.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0)
  buffer.writeUInt32BE(counter % 0x1_0000_0000, 4)
  const digest = createHmac('sha1', base32Decode(secretBase32)).update(buffer).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  const binary = ((digest[offset]! & 0x7f) << 24)
    | ((digest[offset + 1]! & 0xff) << 16)
    | ((digest[offset + 2]! & 0xff) << 8)
    | (digest[offset + 3]! & 0xff)
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

/**
 * 验证动态码。
 *
 * `window` 是**前后允许的步数**（默认 1 = 允许 ±30s，用于容忍时钟漂移）。
 * 所有候选步长都会被计算、比较，不因先命中就提前返回。
 *
 * @param secretBase32 - 密钥。
 * @param code - 用户输入的 6 位码（会先去掉空白）。
 * @param options - `window` 与注入时钟。
 * @returns 命中时为 true。
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  options: { window?: number; now?: () => number } = {},
): boolean {
  const normalized = String(code ?? '').replace(/\s/gu, '')
  if (!/^\d{6}$/u.test(normalized)) return false
  const window = options.window ?? 1
  const now = options.now?.() ?? Date.now()
  let matched = false
  for (let offset = -window; offset <= window; offset++) {
    let candidate: string
    try {
      candidate = totpCodeAt(secretBase32, now + offset * TOTP_STEP_SECONDS * 1000)
    } catch {
      return false
    }
    const a = Buffer.from(candidate)
    const b = Buffer.from(normalized)
    if (a.length === b.length && timingSafeEqual(a, b)) matched = true
  }
  return matched
}

/**
 * 剩余有效秒数（UI 倒计时）。
 * @param atMs - 当前时间。
 * @returns 1..30。
 */
export function secondsRemaining(atMs: number): number {
  const stepMs = TOTP_STEP_SECONDS * 1000
  return Math.ceil((stepMs - (atMs % stepMs)) / 1000)
}

/**
 * 生成 `otpauth://` 绑定链接。
 * @param input - issuer / 账号 / 密钥。
 * @returns 认证器可直接扫描的链接。
 */
export function otpauthUri(input: { issuer: string; account: string; secret: string }): string {
  const label = `${input.issuer}:${input.account}`
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  })
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`
}

/**
 * 生成备用码（易读形式的 5×2 组，共 10 个）。
 * @param count - 个数。
 * @returns 明文备用码数组（**只返回这一次**）。
 */
export function generateBackupCodes(count = 10): string[] {
  const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'
  const codes: string[] = []
  for (let index = 0; index < count; index++) {
    let code = ''
    for (let part = 0; part < 2; part++) {
      for (let char = 0; char < 5; char++) {
        code += alphabet[randomBytes(1)[0]! % alphabet.length]
      }
      if (part === 0) code += '-'
    }
    codes.push(code)
  }
  return codes
}

/**
 * 备用码摘要（存盘用）。
 * @param code - 明文备用码。
 * @returns 十六进制 sha256。
 */
export function hashBackupCode(code: string): string {
  return createHash('sha256').update(String(code).trim().toUpperCase(), 'utf8').digest('hex')
}
