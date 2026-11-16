/**
 * 复现：把截图里的 otpauth 链接编码成二维码，再解码回来，看是否一致。
 *
 * 扫码失败通常是三类原因：
 *   1. 二维码里编码的内容与显示出来的链接**不一致**（编码了别的串）；
 *   2. 编码内容本身不合法（分隔符是 `&` 而不是 `&amp;`、URL 被转义）；
 *   3. 掩码/纠错等级让常见扫码器读不出来。
 *
 * @module scripts/diagnose-otpauth-qr
 */
import { readFileSync } from 'node:fs'

const secret = 'K6WFZPGB2ZUO3XNU4VKP36HH6RAVVD5H'
const label = 'DeepSeek%20Harness%3Axiaopb'
const expected =
  `otpauth://totp/DeepSeek%20Harness%3Axiaopb?secret=${secret}&issuer=DeepSeek+Harness&algorithm=SHA1&digits=6&period=30`

// 读本插件的二维码实现，确认它编码的是哪个串。
const source = readFileSync(new URL('../core/src/auth.ts', import.meta.url), 'utf8')
const match = /export function totpOtpauthUrl[\s\S]*?\n\}/u.exec(source)
console.log('=== 生成 otpauth 的函数 ===')
console.log(match === null ? '(未找到)' : match[0].slice(0, 900))

// 直接跑一次，看实际输出与截图是否一致。
const mod = await import('../lib/auth.js')
if (typeof mod.totpOtpauthUrl === 'function') {
  const actual = mod.totpOtpauthUrl({ secret, issuer: 'DeepSeek Harness', account: 'xiaopb' })
  console.log('\n=== 实际生成 ===')
  console.log(actual)
  console.log('\n与截图一致?', actual === expected)
}
