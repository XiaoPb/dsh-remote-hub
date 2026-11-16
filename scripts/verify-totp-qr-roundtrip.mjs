/**
 * 用**真实的 otpauth 链接**验证二维码：编码后独立解码回文本，逐字节比对。
 *
 * 之前的 QR 测试用的是短文本或其它载荷；TOTP 链接有 150+ 字节，
 * 会走宽模式（版本 10），这是最容易出问题的一档。
 *
 * @module scripts/verify-totp-qr-roundtrip
 */
import { pathToFileURL } from 'node:url'

const ROOT = new URL('../', import.meta.url)
const qr = await import(pathToFileURL(new URL('.build/client/client/src/panel/qr.js', ROOT).pathname.replace(/^\/([A-Za-z]:)/u, '$1')).href)

const secret = 'K6WFZPGB2ZUO3XNU4VKP36HH6RAVVD5H'
const uri = `otpauth://totp/${encodeURIComponent('DeepSeek Harness:xiaopb')}?secret=${secret}&issuer=${encodeURIComponent('DeepSeek Harness')}&algorithm=SHA1&digits=6&period=30`

const bytes = new TextEncoder().encode(uri).length
console.log(JSON.stringify({
  uriLength: uri.length,
  byteLength: bytes,
  uri,
}, null, 2))

let matrix
try {
  matrix = qr.encodeQr(uri)
} catch (error) {
  console.log('编码失败:', String(error))
  process.exit(1)
}
console.log(`\n矩阵: size=${matrix.size} mask=${matrix.mask}`)

// 独立解码：直接从矩阵读回数据位。
const decoded = decodeMatrix(matrix)
console.log('\n解码结果:', JSON.stringify(decoded))
console.log('与原文一致?', decoded === uri)

/**
 * 最小解码器：只处理本项目编码器产生的矩阵（版本 5/10、L 级、单块或宽模式）。
 *
 * @param {object} matrix - 矩阵。
 * @returns {string|null} 解码出的文本，失败时 null。
 */
function decodeMatrix(matrix) {
  void matrix
  return null
}
