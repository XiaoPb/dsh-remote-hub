/**
 * 通过真实 UI 走完登录（口令 + TOTP），进入 ready 态。
 *
 * 凭据来源：账号 `demo` 的口令被临时设为 `UI_TEST_PASSWORD`（仅本机测试沙箱，
 * 由 `dev/ui-acceptance/` 下的脚本写入 sqlite，不写进仓库）。TOTP 密钥从
 * 同一个 sqlite 读取后按 RFC 6238 现算，不落盘、不打印。
 *
 * @module scripts/ui-acceptance-login
 */
import { DatabaseSync } from 'node:sqlite'
import { createHmac } from 'node:crypto'

/** 测试口令（与 tmp-setpw.mjs 一致；可被环境变量覆盖）。 */
export const UI_TEST_PASSWORD = process.env.UI_TEST_PASSWORD ?? 'UiAcceptance!2026'
/** 测试账号名。 */
export const UI_TEST_USERNAME = process.env.UI_TEST_USERNAME ?? 'demo'

const DB = 'E:/dsh-box-data/dsh-box-files/data/sandboxes/testhub/home/remote-hub/auth.db'

/**
 * Base32 解码（RFC 4648，无填充）。
 * @param {string} input - Base32 文本。
 * @returns {Buffer} 字节。
 */
function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const clean = input.toUpperCase().replace(/=+$/u, '').replace(/\s+/gu, '')
  let bits = 0
  let value = 0
  const out = []
  for (const char of clean) {
    const index = alphabet.indexOf(char)
    if (index < 0) continue
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/**
 * 现算 TOTP（6 位，30s 步长，SHA-1）。
 * @param {string} secretBase32 - 密钥。
 * @param {number} [at] - 毫秒时间戳。
 * @returns {string} 6 位验证码。
 */
export function totp(secretBase32, at = Date.now()) {
  const counter = Math.floor(at / 30_000)
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', base32Decode(secretBase32)).update(buffer).digest()
  const offset = digest.at(-1) & 0xf
  const code = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  return String(code % 1_000_000).padStart(6, '0')
}

/**
 * 从沙箱 sqlite 读当前测试账号的 TOTP 密钥（不打印）。
 * @returns {{secret: string, username: string}|null} 密钥。
 */
export function readTotpSecret() {
  const db = new DatabaseSync(DB, { readOnly: true })
  try {
    const row = db.prepare('SELECT username, totp_secret FROM accounts WHERE username = ?').get(UI_TEST_USERNAME)
    if (row === undefined || typeof row.totp_secret !== 'string' || row.totp_secret === '') return null
    return { secret: row.totp_secret, username: String(row.username) }
  } finally {
    db.close()
  }
}

/**
 * 走 UI 登录到 ready。
 *
 * 关键点：口令与验证码都用**真实输入事件**填（`Input.insertText` 走框架的
 * onChange），按钮用真实点击，不用 `form.submit()` 之类的旁路。
 * @param {object} page - page 驱动（ui-acceptance-cdp）。
 * @param {{timeout?: number}} [options] - 选项。
 * @returns {Promise<{phase: string, steps: string[]}>} 结果。
 */
export async function loginToReady(page, { timeout = 60_000 } = {}) {
  const steps = []
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const phase = () => page.eval('document.querySelector(\'[data-testid="account-page"]\')?.getAttribute("data-phase") ?? null')
  const current = await phase()
  if (current === 'ready') return { phase: 'ready', steps: ['already ready'] }

  // 登录页：填口令并提交。
  if (current === 'login') {
    await page.typeInto('[data-testid=login-username]', UI_TEST_USERNAME)
    await page.typeInto('[data-testid=login-password]', UI_TEST_PASSWORD)
    steps.push('filled credentials')
    await page.click('[data-testid=login-submit]')
    for (let i = 0; i < 100; i += 1) {
      const now = await phase()
      if (now !== 'login') break
      await sleep(200)
    }
    steps.push(`after login: ${await phase()}`)
  }

  // MFA 页：算 6 位动态码。
  if (await phase() === 'mfa') {
    const info = readTotpSecret()
    if (info === null) throw new Error('account has no TOTP secret but MFA was requested')
    await page.typeInto('[data-testid=mfa-code]', totp(info.secret))
    steps.push('filled totp')
    await page.click('[data-testid=mfa-submit]')
    for (let i = 0; i < 100; i += 1) {
      const now = await phase()
      if (now !== 'mfa') break
      await sleep(200)
    }
    steps.push(`after mfa: ${await phase()}`)
  }

  // 等 ready（改密 / 绑定 2FA 这两种强制向导不该出现，出现即视为失败）。
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const now = await phase()
    if (now === 'ready') return { phase: 'ready', steps }
    if (now === 'change-password' || now === 'enroll-totp') {
      throw new Error(`unexpected forced wizard: ${now}`)
    }
    await sleep(300)
  }
  throw new Error(`login did not reach ready (phase=${await phase()})`)
}
