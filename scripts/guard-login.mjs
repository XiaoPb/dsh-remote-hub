/**
 * 端到端登录：用账号 + 口令 + TOTP 走完守卫的登录流程，拿到会话 Cookie。
 *
 * 用途：在真实浏览器里建立已登录会话，以便截取登录后的界面。
 *
 * @module scripts/guard-login
 */
import { createHmac } from 'node:crypto'

/**
 * 按 RFC 6238 算 6 位动态码。
 *
 * @param {string} secret - Base32 密钥。
 * @param {number} [atMs] - 时间戳（毫秒）。
 * @returns {string} 6 位数字。
 */
export function totp(secret, atMs = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const clean = secret.replace(/=+$/u, '').toUpperCase()
  let bits = ''
  for (const char of clean) {
    const index = alphabet.indexOf(char)
    if (index < 0) continue
    bits += index.toString(2).padStart(5, '0')
  }
  const bytes = []
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2))
  }
  const counter = Math.floor(atMs / 1000 / 30)
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', Buffer.from(bytes)).update(message).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const code = ((digest[offset] & 0x7f) << 24)
    | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8)
    | digest[offset + 3]
  return String(code % 1_000_000).padStart(6, '0')
}

/**
 * 走完登录，返回 Cookie 头。
 *
 * @param {object} options - 参数。
 * @param {string} options.origin - 守卫 origin。
 * @param {string} options.username - 用户名。
 * @param {string} options.password - 口令。
 * @param {string} options.secret - TOTP 密钥。
 * @returns {Promise<{ok: boolean, cookie?: string, stage?: string, body?: unknown}>} 结果。
 */
export async function login({ origin, username, password, secret }) {
  const first = await fetch(`${origin}/remote-web/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const firstBody = await first.json().catch(() => null)
  if (firstBody === null || firstBody.ok !== true) {
    return { ok: false, stage: 'login', body: firstBody }
  }
  if (firstBody.mfaRequired !== true) {
    const cookie = first.headers.get('set-cookie')
    return cookie === null ? { ok: false, stage: 'no-cookie' } : { ok: true, cookie }
  }
  const second = await fetch(`${origin}/remote-web/mfa`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mfaToken: firstBody.mfaToken, code: totp(secret) }),
  })
  const secondBody = await second.json().catch(() => null)
  if (secondBody === null || secondBody.ok !== true) {
    return { ok: false, stage: 'mfa', body: secondBody }
  }
  const cookie = second.headers.get('set-cookie')
  return cookie === null ? { ok: false, stage: 'no-cookie' } : { ok: true, cookie }
}
