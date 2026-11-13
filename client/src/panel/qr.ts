/**
 * 极简 QR 编码器（byte 模式 · 纠错等级 L · 版本 5）。
 *
 * 为什么固定版本 5-L：配对链接（origin + 43 字符票据 + 前缀）约 100 字节，
 * 版本 5 的字节容量是 **106 字节**；它仍是**单块** Reed-Solomon（108 数据码字
 * + 26 纠错码字 = 134），且版本 ≤ 6 无需版本信息位，实现面小、可审计。
 * 超出容量时**抛错**而不是静默截断。
 *
 * 依据：ISO/IEC 18004。实现对照 Nayuki 的 qrcodegen（同算法，纯 TypeScript
 * 重写，无依赖）。掩码按罚分（规则 1/2/4）择优。
 *
 * **不是通用 QR 库**：不支持多版本、多纠错等级、多块交织、Kanji/数字模式。
 *
 * @module dsh-remote-hub/client/panel/qr
 */

/** 版本 5 的模块边长。 */
export const QR_SIZE = 37

/** 版本 5-L：数据码字 / 纠错码字。 */
const DATA_CODEWORDS = 108
const EC_CODEWORDS = 26

/** 版本 5-L byte 模式最大载荷（字节）。 */
export const QR_MAX_BYTES = 106

/** 纠错等级 L 的格式信息位（2 bit）。 */
const EC_FORMAT_L = 1

/** GF(256) 乘法（本原多项式 0x11D）。 */
function gfMul(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

/** Reed-Solomon 生成多项式（degree 个系数，升幂）。 */
function rsDivisor(degree: number): Uint8Array {
  const result = new Uint8Array(degree)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j]!, root)
      if (j + 1 < result.length) result[j] = result[j]! ^ result[j + 1]!
    }
    root = gfMul(root, 0x02)
  }
  return result
}

/** 计算余数（= 纠错码字）。 */
function rsRemainder(data: Uint8Array, divisor: Uint8Array): Uint8Array {
  const result = new Uint8Array(divisor.length)
  for (const byte of data) {
    const factor = byte ^ result[0]!
    result.copyWithin(0, 1)
    result[result.length - 1] = 0
    for (let i = 0; i < result.length; i++) result[i] = result[i]! ^ gfMul(divisor[i]!, factor)
  }
  return result
}

/** 格式信息位（BCH(15,5) + 掩码 0x5412）。 */
function formatBits(mask: number): number {
  const data = (EC_FORMAT_L << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return ((data << 10) | rem) ^ 0x5412
}

/** 取 bit。 */
function bit(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0
}

/** 把 UTF-8 载荷编码成 70 个码字（55 数据 + 15 纠错）。 */
export function encodeCodewords(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length > QR_MAX_BYTES) {
    throw new Error(`qr: payload too long (${bytes.length} bytes > ${QR_MAX_BYTES})`)
  }
  const capacityBits = DATA_CODEWORDS * 8
  const bits: number[] = []
  const push = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  push(0b0100, 4) // byte 模式
  push(bytes.length, 8) // 版本 1-9 的字符计数用 8 bit
  for (const byte of bytes) push(byte, 8)
  // 终止符（最多 4 个 0）
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0)
  // 补齐到字节边界
  while (bits.length % 8 !== 0) bits.push(0)
  // 填充码字 0xEC / 0x11
  const data = new Uint8Array(DATA_CODEWORDS)
  for (let i = 0; i < DATA_CODEWORDS; i++) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i * 8 + j] ?? 0)
    data[i] = byte
  }
  for (let i = Math.ceil(bits.length / 8), pad = 0; i < DATA_CODEWORDS; i++, pad++) {
    data[i] = pad % 2 === 0 ? 0xec : 0x11
  }
  const ec = rsRemainder(data, rsDivisor(EC_CODEWORDS))
  const out = new Uint8Array(DATA_CODEWORDS + EC_CODEWORDS)
  out.set(data, 0)
  out.set(ec, DATA_CODEWORDS)
  return out
}

/** 一个已编码的 QR 矩阵。 */
export interface QrMatrix {
  /** 边长（模块数）。 */
  size: number
  /** `modules[row][col]`，true = 深色。 */
  modules: boolean[][]
  /** 选用的掩码编号。 */
  mask: number
}

/**
 * 编码任意文本为 QR 矩阵。
 * @param text - 待编码文本（UTF-8，≤53 字节）。
 * @returns 矩阵（含掩码编号）。
 * @throws 载荷超长时。
 */
export function encodeQr(text: string): QrMatrix {
  const codewords = encodeCodewords(text)
  const size = QR_SIZE
  const modules: boolean[][] = Array.from({ length: size }, () => Array.from({ length: size }, () => false))
  const isFn: boolean[][] = Array.from({ length: size }, () => Array.from({ length: size }, () => false))

  const setFn = (x: number, y: number, dark: boolean): void => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    modules[y]![x] = dark
    isFn[y]![x] = true
  }

  /** 7×7 定位图形 + 分隔符（dist=4 为白）。 */
  const drawFinder = (cx: number, cy: number): void => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        setFn(cx + dx, cy + dy, dist !== 2 && dist !== 4)
      }
    }
  }

  /** 5×5 校正图形。 */
  const drawAlignment = (cx: number, cy: number): void => {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
      }
    }
  }

  /** 格式信息（两张副本 + 固定深色模块）。 */
  const drawFormat = (mask: number): void => {
    const bits = formatBits(mask)
    for (let i = 0; i <= 5; i++) setFn(8, i, bit(bits, i))
    setFn(8, 7, bit(bits, 6))
    setFn(8, 8, bit(bits, 7))
    setFn(7, 8, bit(bits, 8))
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(bits, i))
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(bits, i))
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(bits, i))
    setFn(8, size - 8, true)
  }

  // ── 功能图形 ──────────────────────────────────────────────────────────────
  drawFinder(3, 3)
  drawFinder(size - 4, 3)
  drawFinder(3, size - 4)
  drawAlignment(size - 7, size - 7) // 版本 5 的校正图形中心 (30,30)
  for (let i = 8; i < size - 8; i++) {
    setFn(i, 6, i % 2 === 0)
    setFn(6, i, i % 2 === 0)
  }
  drawFormat(0) // 先占位（数据放置要跳过这些模块）

  // ── 数据码字（zigzag 两列一组，自右向左）────────────────────────────────
  {
    let index = 0
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5 // 跳过竖向 timing 列
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j
          const upward = ((right + 1) & 2) === 0
          const y = upward ? size - 1 - vert : vert
          if (!isFn[y]![x]! && index < codewords.length * 8) {
            modules[y]![x] = bit(codewords[index >>> 3]!, 7 - (index & 7))
            index++
          }
        }
      }
    }
  }

  // ── 掩码选择（罚分规则 1/2/4）───────────────────────────────────────────
  const applyMask = (mask: number): void => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (isFn[y]![x]!) continue
        let invert: boolean
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
        if (invert) modules[y]![x] = !modules[y]![x]
      }
    }
  }

  let bestMask = 0
  let bestPenalty = Number.POSITIVE_INFINITY
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask)
    drawFormat(mask)
    const penalty = penaltyScore(modules)
    if (penalty < bestPenalty) {
      bestPenalty = penalty
      bestMask = mask
    }
    applyMask(mask) // 撤销（异或自反）
  }
  applyMask(bestMask)
  drawFormat(bestMask)

  return { size, modules, mask: bestMask }
}

/** 罚分（规则 1：连续同色 ≥5；规则 2：2×2 同色；规则 4：深浅失衡）。 */
function penaltyScore(modules: boolean[][]): number {
  const size = modules.length
  let penalty = 0

  const runPenalty = (line: boolean[]): number => {
    let score = 0
    let run = 1
    for (let i = 1; i <= line.length; i++) {
      if (i < line.length && line[i]! === line[i - 1]!) { run++; continue }
      if (run >= 5) score += 3 + (run - 5)
      run = 1
    }
    return score
  }

  for (let y = 0; y < size; y++) penalty += runPenalty(modules[y]!)
  for (let x = 0; x < size; x++) penalty += runPenalty(modules.map(row => row[x]!))

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const color = modules[y]![x]!
      if (modules[y]![x + 1] === color && modules[y + 1]![x] === color && modules[y + 1]![x + 1] === color) {
        penalty += 3
      }
    }
  }

  let dark = 0
  for (const row of modules) for (const cell of row) if (cell) dark++
  const total = size * size
  const percent = (dark * 100) / total
  penalty += Math.floor(Math.abs(percent - 50) / 5) * 10
  return penalty
}
