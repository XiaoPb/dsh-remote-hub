/**
 * QR 编码器正确性测试（版本 5-L，固定配置）。
 *
 * 验证手段不是"看起来像二维码"，而是**规格级自检**：
 *  1. 从矩阵反解出码字（撤销掩码 → zigzag 读取），逐字节等于 `encodeCodewords`；
 *  2. 全码字多项式在 26 个根（α^0..α^25）处求值为 0 —— Reed-Solomon 余数正确；
 *  3. 数据段按 QR 规则解析回的文本与原文本一致；
 *  4. 定位/时序/固定深色模块、格式信息（EC=L、掩码一致）结构正确。
 *
 * @module test/qr.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { registerAlias } from './panel-alias-loader.mjs'

await registerAlias()

const QR = await import('../.build/client/client/src/panel/qr.js')

/** GF(256) 乘法（与实现独立的第二份实现，用于校验子）。 */
function gfMul(x, y) {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

/** 把矩阵按规格反解成码字序列（撤销掩码后 zigzag 读取）。 */
function extractCodewords(matrix, mask) {
  const { size, modules } = matrix
  // 重建 isFunction 表（与编码器同一套功能图形规则）。
  const isFn = Array.from({ length: size }, () => Array.from({ length: size }, () => false))
  const mark = (x, y) => { if (x >= 0 && y >= 0 && x < size && y < size) isFn[y][x] = true }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) mark(cx + dx, cy + dy)
  }
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4)
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(size - 7 + dx, size - 7 + dy)
  for (let i = 8; i < size - 8; i++) { mark(i, 6); mark(6, i) }
  for (let i = 0; i <= 5; i++) mark(8, i)
  mark(8, 7); mark(8, 8); mark(7, 8)
  for (let i = 9; i < 15; i++) mark(14 - i, 8)
  for (let i = 0; i < 8; i++) mark(size - 1 - i, 8)
  for (let i = 8; i < 15; i++) mark(8, size - 15 + i)
  mark(8, size - 8)

  const bits = []
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (isFn[y][x]) continue
        let value = modules[y][x]
        // 撤销掩码
        let invert
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break
          case 1: invert = y % 2 === 0; break
          case 2: invert = x % 3 === 0; break
          case 3: invert = (x + y) % 3 === 0; break
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break
          case 5: invert = (x * y) % 2 + (x * y) % 3 === 0; break
          case 6: invert = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break
          default: invert = ((x + y) % 2 + (x * y) % 3) % 2 === 0; break
        }
        if (invert) value = !value
        bits.push(value ? 1 : 0)
      }
    }
  }
  const bytes = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]
    bytes.push(byte)
  }
  return bytes
}

/** 校验子：全码字在 α^0..α^(ec-1) 处求值应为 0。 */
function syndromesZero(codewords, ecCount) {
  for (let i = 0; i < ecCount; i++) {
    let root = 1
    for (let k = 0; k < i; k++) root = gfMul(root, 2)
    let value = 0
    for (const byte of codewords) value = gfMul(value, root) ^ byte
    if (value !== 0) return false
  }
  return true
}

/** 从数据码字解析出 byte 模式的文本。 */
function decodeText(dataCodewords) {
  const bits = []
  for (const byte of dataCodewords) {
    for (let i = 7; i >= 0; i--) bits.push((byte >>> i) & 1)
  }
  const take = n => {
    let value = 0
    for (let i = 0; i < n; i++) value = (value << 1) | (bits.shift() ?? 0)
    return value
  }
  const mode = take(4)
  if (mode !== 0b0100) throw new Error(`unexpected mode ${mode}`)
  const length = take(8)
  const bytes = []
  for (let i = 0; i < length; i++) bytes.push(take(8))
  return new TextDecoder().decode(Uint8Array.from(bytes))
}

describe('QR 编码器：结构', () => {
  it('边长 37（版本 5），三个定位图形与固定深色模块正确', () => {
    const matrix = QR.encodeQr('hello')
    assert.equal(matrix.size, 37)
    const { modules, size } = matrix
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      // 外框 7×7 深色
      assert.equal(modules[cy - 3][cx - 3], true)
      assert.equal(modules[cy + 3][cx + 3], true)
      // 内部 3×3 深色
      assert.equal(modules[cy][cx], true)
      // 中间白环
      assert.equal(modules[cy - 2][cx], false)
    }
    // 时序图形
    assert.equal(modules[6][8], true)
    assert.equal(modules[6][9], false)
    assert.equal(modules[8][6], true)
    // 固定深色模块
    assert.equal(modules[size - 8][8], true)
  })

  it('格式信息解码回 EC=L 与所选掩码', () => {
    const matrix = QR.encodeQr('format-check')
    // 读取第一份副本（bit0..14）
    const bits = []
    for (let i = 0; i <= 5; i++) bits.push(matrix.modules[i][8] ? 1 : 0)
    bits.push(matrix.modules[7][8] ? 1 : 0)
    bits.push(matrix.modules[8][8] ? 1 : 0)
    bits.push(matrix.modules[8][7] ? 1 : 0)
    for (let i = 9; i < 15; i++) bits.push(matrix.modules[8][14 - i] ? 1 : 0)
    let value = 0
    for (let i = 0; i < 15; i++) value |= bits[i] << i
    value ^= 0x5412
    const ecLevel = value >>> 13
    const mask = (value >>> 10) & 0b111
    assert.equal(ecLevel, 1, '纠错等级 L')
    assert.equal(mask, matrix.mask, '格式信息中的掩码与矩阵一致')
  })
})

describe('QR 编码器：规格级还原', () => {
  it('反解码字 = encodeCodewords 输出，且校验子全零', () => {
    const text = 'dsh-remote-hub://pair?origin=http%3A%2F%2F127.0.0.1%3A8443&ticket=abc'
    const matrix = QR.encodeQr(text)
    const codewords = extractCodewords(matrix, matrix.mask)
    const expected = QR.encodeCodewords(text)
    assert.equal(codewords.length >= expected.length, true)
    for (let i = 0; i < expected.length; i++) {
      assert.equal(codewords[i], expected[i], `codeword ${i} mismatch`)
    }
    assert.equal(syndromesZero(expected.slice(0, 134), 26), true, 'Reed-Solomon 余数正确（26 个校验子为 0）')
  })

  it('数据段解析回原文（UTF-8 往返）', () => {
    for (const text of ['ABCD2345', 'dsh-remote-hub://pair?origin=http://127.0.0.1:8443&ticket=' + 'a'.repeat(43)]) {
      const matrix = QR.encodeQr(text)
      const codewords = extractCodewords(matrix, matrix.mask)
      const data = Uint8Array.from(codewords.slice(0, 108))
      assert.equal(decodeText(data), text)
    }
  })

  it('超长载荷抛错（不静默截断）', () => {
    assert.throws(() => QR.encodeQr('x'.repeat(QR.QR_MAX_BYTES + 1)), /payload too long/u)
    assert.doesNotThrow(() => QR.encodeQr('x'.repeat(QR.QR_MAX_BYTES)))
  })

  it('确定性：同输入同矩阵', () => {
    const a = QR.encodeQr('deterministic')
    const b = QR.encodeQr('deterministic')
    assert.deepEqual(a.modules, b.modules)
    assert.equal(a.mask, b.mask)
  })
})
