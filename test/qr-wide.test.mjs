/**
 * 宽模式（版本 10-L）编码器：TOTP 的 `otpauth://` 链接需要 >106 字节。
 *
 * 验证手段与窄模式一致：**规格级自检**，不是「看起来像二维码」：
 *  1. 结构：57×57、三只定位图形、三只校正图形（28 × 3 处）；
 *  2. 版本信息块（版本 ≥7 必需）：BCH(18,6) 逐位一致；
 *  3. Reed-Solomon：274+18 码字多项式在 18 个根处求值为 0；
 *  4. 格式信息：EC=L、掩码编号与 `matrix.mask` 一致；
 *  5. 载荷：从矩阵反解数据段，还原文本与原文本逐字节相同。
 *
 * @module test/qr-wide.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { registerAlias } from './panel-alias-loader.mjs'

await registerAlias()

const QR = await import('../.build/client/client/src/panel/qr.js')

/** GF(256) 乘法（与实现独立的第二份实现）。 */
function gfMul(x, y) {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

/** 重建功能图形表（与实现同一套规则，含版本信息块）。 */
function functionMap(size) {
  const isFn = Array.from({ length: size }, () => Array.from({ length: size }, () => false))
  const mark = (x, y) => { if (x >= 0 && y >= 0 && x < size && y < size) isFn[y][x] = true }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) mark(cx + dx, cy + dy)
  }
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4)
  for (const cy of [6, 28, 50]) {
    for (const cx of [6, 28, 50]) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(cx + dx, cy + dy)
    }
  }
  for (let i = 0; i < size; i++) { mark(i, 6); mark(6, i) }
  for (let i = 0; i < 18; i++) { mark(size - 11 + (i % 3), Math.floor(i / 3)); mark(Math.floor(i / 3), size - 11 + (i % 3)) }
  // 格式信息
  for (let i = 0; i <= 5; i++) mark(8, i)
  mark(8, 7); mark(8, 8); mark(7, 8)
  for (let i = 9; i < 15; i++) mark(14 - i, 8)
  for (let i = 0; i < 8; i++) mark(size - 1 - i, 8)
  for (let i = 8; i < 15; i++) mark(8, size - 15 + i)
  mark(8, size - 8)
  return isFn
}

/** 撤销掩码并 zigzag 读取码字。 */
function extractCodewords(matrix) {
  const { size, modules, mask } = matrix
  const isFn = functionMap(size)
  const invert = (x, y) => {
    switch (mask) {
      case 0: return (x + y) % 2 === 0
      case 1: return y % 2 === 0
      case 2: return x % 3 === 0
      case 3: return (x + y) % 3 === 0
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
      case 5: return (x * y) % 2 + (x * y) % 3 === 0
      case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0
      default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0
    }
  }
  const bits = []
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (isFn[y][x]) continue
        bits.push((modules[y][x] ? 1 : 0) ^ (invert(x, y) ? 1 : 0))
      }
    }
  }
  const words = new Uint8Array(Math.floor(bits.length / 8))
  for (let i = 0; i < words.length; i++) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i * 8 + j] ?? 0)
    words[i] = byte
  }
  return words
}

const TOTP_URI = 'otpauth://totp/DeepSeek%20Harness%3Aadmin?secret=FF4STT2IIORNX5JFTEDVQM5K7RBHVHOZ&issuer=DeepSeek+Harness&algorithm=SHA1&digits=6&period=30'

describe('宽模式（版本 10-L）', () => {
  it('TOTP 链接超过窄模式容量时自动升级到 57×57', () => {
    assert.ok(new TextEncoder().encode(TOTP_URI).length > QR.QR_MAX_BYTES, '前提：TOTP 链接超过 106 字节')
    assert.ok(new TextEncoder().encode(TOTP_URI).length <= QR.QR_WIDE_MAX_BYTES)
    const matrix = QR.encodeQr(TOTP_URI)
    assert.equal(matrix.size, 57, '宽模式边长必须是 57')
    assert.equal(matrix.modules.length, 57)
  })

  it('结构：三只定位图形 + 三只校正图形', () => {
    const matrix = QR.encodeQr(TOTP_URI)
    const { modules, size } = matrix
    const finderAt = (ox, oy) => {
      for (const [dx, dy] of [[0, 0], [6, 0], [0, 6], [3, 3]]) {
        assert.equal(modules[oy + dy][ox + dx], true, `定位图形 (${ox},${oy}) 偏移 (${dx},${dy})`)
      }
      assert.equal(modules[oy + 1][ox + 1], false, '定位图形内部必须是白环')
    }
    finderAt(0, 0)
    finderAt(size - 7, 0)
    finderAt(0, size - 7)
    // 校正图形中心（28,28）与（50,50）
    for (const [cx, cy] of [[28, 28], [50, 50], [28, 50]]) {
      assert.equal(modules[cy][cx], true, `校正图形中心 (${cx},${cy})`)
      assert.equal(modules[cy - 1][cx], false, '校正图形内环')
    }
  })

  it('版本信息块（BCH(18,6)）逐位正确', () => {
    const matrix = QR.encodeQr(TOTP_URI)
    const { modules, size } = matrix
    let rem = 10
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (10 << 12) | rem
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      assert.equal(modules[b][a], dark, `版本信息块右上 bit ${i}`)
      assert.equal(modules[a][b], dark, `版本信息块左下 bit ${i}`)
    }
  })

  it('Reed-Solomon：274+18 码字在 18 个根处求值为 0', () => {
    const matrix = QR.encodeQr(TOTP_URI)
    const words = extractCodewords(matrix)
    assert.ok(words.length >= 292, `码字数量不足：${words.length}`)
    const data = words.slice(0, 274)
    const ec = words.slice(274, 292)
    let ok = true
    for (let i = 0; i < 18; i++) {
      // 在 α^i 处对 [data | ec] 求值
      let value = 0
      for (const byte of data) value = gfMul(value, exp(i)) ^ byte
      for (const byte of ec) value = gfMul(value, exp(i)) ^ byte
      if (value !== 0) ok = false
    }
    assert.ok(ok, 'Reed-Solomon 余数校验失败')

    function exp(power) {
      let value = 1
      for (let i = 0; i < power; i++) value = gfMul(value, 0x02)
      return value
    }
  })

  it('格式信息：EC=L 且掩码编号与 matrix.mask 一致', () => {
    const matrix = QR.encodeQr(TOTP_URI)
    const { modules, mask, size } = matrix
    const data = (1 << 3) | mask
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const bits = ((data << 10) | rem) ^ 0x5412
    const bitAt = index => ((bits >>> index) & 1) !== 0
    for (let i = 0; i <= 5; i++) assert.equal(modules[i][8], bitAt(i), `格式 bit ${i}`)
    assert.equal(modules[7][8], bitAt(6))
    assert.equal(modules[8][8], bitAt(7))
    assert.equal(modules[8][7], bitAt(8))
    for (let i = 9; i < 15; i++) assert.equal(modules[8][14 - i], bitAt(i), `格式 bit ${i}`)
    assert.equal(modules[size - 8][8], true, '固定深色模块')
  })

  it('数据段还原文本与原文本逐字节相同', () => {
    const matrix = QR.encodeQr(TOTP_URI)
    const words = extractCodewords(matrix)
    // byte 模式：4 bit 模式（0100）+ 8 bit 长度 + 内容
    const bits = []
    for (const byte of words) for (let i = 7; i >= 0; i--) bits.push((byte >>> i) & 1)
    const take = (from, count) => bits.slice(from, from + count).reduce((acc, b) => (acc << 1) | b, 0)
    assert.equal(take(0, 4), 0b0100, 'byte 模式')
    const length = take(4, 8)
    assert.equal(length, new TextEncoder().encode(TOTP_URI).length)
    const bytes = []
    for (let i = 0; i < length; i++) bytes.push(take(12 + i * 8, 8))
    assert.equal(new TextDecoder().decode(new Uint8Array(bytes)), TOTP_URI)
  })

  it('超过 271 字节时报错（不静默截断）', () => {
    assert.throws(() => QR.encodeQr('x'.repeat(QR.QR_WIDE_MAX_BYTES + 1)), /payload too long/u)
  })

  it('窄载荷仍走 37×37（不无谓升级）', () => {
    assert.equal(QR.encodeQr('hello').size, QR.QR_SIZE)
  })
})
