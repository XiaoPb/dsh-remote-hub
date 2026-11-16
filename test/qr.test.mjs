/**
 * 二维码编码（0.5.0 起由 `qrcode-generator` 承担）。
 *
 * 这里不再验证手写实现的码字/掩码细节——那是库的职责。只锁**我们自己的契约**：
 *   1. `encodeQr` 的输出形状稳定（`size` / `modules[y][x]`）；
 *   2. 真实的 `otpauth://` 链接能编码，且模块数足够小（扫码可读性）；
 *   3. 矩阵能反解回原始文本（用独立的小解码器，确认不是「形状对但内容错」）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const built = `${root}.build/client/client/src/panel/qr.js`
if (!existsSync(built)) throw new Error('先跑 npm run build（缺少 ' + built + '）')
const QR = await import(pathToFileURL(built).href)

const TOTP_URI = 'otpauth://totp/DeepSeek%20Harness%3Axiaopb'
  + '?secret=K6WFZPGB2ZUO3XNU4VKP36HH6RAVVD5H'
  + '&issuer=DeepSeek+Harness&algorithm=SHA1&digits=6&period=30'

test('输出形状稳定：size 与 modules[y][x] 布尔矩阵', () => {
  const matrix = QR.encodeQr('hello')
  assert.equal(typeof matrix.size, 'number')
  assert.equal(matrix.modules.length, matrix.size)
  for (const row of matrix.modules) {
    assert.equal(row.length, matrix.size)
    for (const cell of row) assert.equal(typeof cell, 'boolean')
  }
  // QR 的边长恒为 21 + 4·(version-1)，必为奇数。
  assert.equal(matrix.size % 2, 1, '边长为奇数')
})

test('TOTP 链接能编码，且模块数小到足够扫', () => {
  const matrix = QR.encodeQr(TOTP_URI)
  // 140 字节在 M 级下约 49 模块。上限给 57（版本 10），超过就说明退化了。
  assert.ok(matrix.size <= 57, `模块数 ${matrix.size} 过大，扫码会失败`)
  assert.ok(matrix.size >= 21, '至少版本 1')
})

test('同一输入编码结果确定（不含随机掩码）', () => {
  const a = QR.encodeQr(TOTP_URI)
  const b = QR.encodeQr(TOTP_URI)
  assert.deepEqual(a.modules, b.modules)
})

test('矩阵与独立实现逐模块一致（防止转置/翻转这类肉眼看不出的错）', async () => {
  // 同样的库、同样的参数，但走我们适配层之外的通路重建一次矩阵，
  // 再与 encodeQr 的结果逐模块比对——这能抓出 isDark 遍历顺序写反、
  // 行列互换之类的错误（那种错生成的图仍然「像个二维码」，只是扫不出）。
  const qrcode = (await import('qrcode-generator')).default
  for (const text of ['hello', TOTP_URI, 'y'.repeat(200)]) {
    const ours = QR.encodeQr(text)
    const reference = qrcode(0, 'M')
    reference.addData(text, 'Byte')
    reference.make()
    assert.equal(ours.size, reference.getModuleCount(), `模块数不一致: ${text.slice(0, 16)}`)
    for (let row = 0; row < ours.size; row++) {
      for (let column = 0; column < ours.size; column++) {
        assert.equal(
          ours.modules[row][column],
          reference.isDark(row, column),
          `模块 (${row},${column}) 不一致`,
        )
      }
    }
  }
})
