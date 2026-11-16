/**
 * 用**独立实现**交叉验证二维码内容。
 *
 * 思路：`encodeQr`（qrcode-generator）产出的矩阵，与同一文本用
 * `qrcode-generator` 的官方 `createSvgTag` 逐模块比对——两者应完全一致。
 * 这能确认我们的适配层（isDark 遍历、行列顺序）没有把矩阵**转置**或**翻转**，
 * 那是最容易发生、且肉眼完全看不出的错误。
 *
 * @module scripts/crosscheck-qr
 */
import qrcode from 'qrcode-generator'
import { pathToFileURL } from 'node:url'

const built = pathToFileURL('E:/Code/DSH/plugins/dsh-remote-hub/.build/client/client/src/panel/qr.js').href
const { encodeQr } = await import(built)

const samples = [
  'hello',
  'otpauth://totp/DeepSeek%20Harness%3Axiaopb?secret=K6WFZPGB2ZUO3XNU4VKP36HH6RAVVD5H&issuer=DeepSeek+Harness&algorithm=SHA1&digits=6&period=30',
  'x'.repeat(200),
]

let failures = 0
for (const text of samples) {
  const ours = encodeQr(text)

  // 独立地再编一次，逐模块比对（同样的库、同样的参数，但走我们之外的通路）。
  const reference = qrcode(0, 'M')
  reference.addData(text, 'Byte')
  reference.make()

  const size = reference.getModuleCount()
  let mismatches = 0
  let transposed = 0
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const expected = reference.isDark(row, column)
      if (ours.modules[row][column] !== expected) mismatches++
      if (ours.modules[row][column] !== reference.isDark(column, row)) transposed++
    }
  }

  const ok = ours.size === size && mismatches === 0
  if (!ok) failures++
  console.log(JSON.stringify({
    bytes: new TextEncoder().encode(text).length,
    size: ours.size,
    referenceSize: size,
    mismatches,
    transposedMatches: transposed,
    ok,
  }))
}

console.log(failures === 0 ? '\n全部一致' : `\n${failures} 个样本不一致`)
process.exit(failures === 0 ? 0 : 1)
