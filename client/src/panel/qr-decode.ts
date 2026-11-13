/**
 * 极简 QR **解码器**（只服务本插件自己生成的码：byte 模式 · EC-L · 版本 5 · 37×37）。
 *
 * 为什么自己写：Electron/Chromium 在 Windows 上通常**没有** `BarcodeDetector`
 * （该 API 只在 Android/ChromeOS/macOS 上稳定可用），依赖它会让「扫码」按钮在
 * 目标平台上直接不可用。这里实现一个**受限但可自测**的解码器：
 *
 *  灰度 → Otsu 二值化 → 1:1:3:1:1 定位图形 → 三点定向 → 单应性采样 37×37
 *  → 格式信息（BCH 校验）→ 去掩码 → 读出码字 → byte 模式解析
 *
 * **不做 Reed-Solomon 纠错**：单块 26 个纠错码字本可纠 13 个错误，但实现
 * Berlekamp-Massey + Forney 的成本与风险高；相机帧的误差主要来自采样抖动，
 * 已用「多阈值重试 + 邻域自适应阈值」覆盖。解不出来时页面提示改用短码。
 *
 * 依据：ISO/IEC 18004；定位图形扫描与单应性采样对照 ZXing 的经典做法。
 *
 * @module dsh-remote-hub/client/panel/qr-decode
 */

/** 只支持本插件生成的版本 5（37×37）。 */
const DIM = 37
const DATA_CODEWORDS = 108
const EC_CODEWORDS = 26

/** 一个候选定位图形。 */
interface Finder {
  x: number
  y: number
  /** 单个模块的像素边长估计。 */
  moduleSize: number
}

/** 二值图（true = 深色）。 */
interface Binary {
  width: number
  height: number
  dark: Uint8Array
}

/** 灰度图。 */
export interface GrayImage {
  width: number
  height: number
  /** 长度 = width*height，0..255。 */
  data: Uint8Array | Uint8ClampedArray
}

/** Otsu 阈值。 */
function otsuThreshold(gray: GrayImage): number {
  const hist = new Uint32Array(256)
  const total = gray.width * gray.height
  for (let i = 0; i < total; i++) hist[gray.data[i] ?? 0] = (hist[gray.data[i] ?? 0] ?? 0) + 1
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * (hist[i] ?? 0)
  let sumB = 0
  let wB = 0
  let best = 0
  let bestVar = -1
  for (let t = 0; t < 256; t++) {
    wB += hist[t] ?? 0
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * (hist[t] ?? 0)
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > bestVar) {
      bestVar = between
      best = t
    }
  }
  return best
}

/** 按阈值二值化。 */
function binarize(gray: GrayImage, threshold: number): Binary {
  const dark = new Uint8Array(gray.width * gray.height)
  // 注意用 <=：Otsu 返回的是「前景最大灰度」，恰好等于阈值的那一类仍是深色。
  for (let i = 0; i < dark.length; i++) dark[i] = (gray.data[i] ?? 255) <= threshold ? 1 : 0
  return { width: gray.width, height: gray.height, dark }
}

/** 读取二值图的一个像素（越界视为浅色）。 */
function isDark(image: Binary, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return false
  return image.dark[y * image.width + x] === 1
}

/** 1:1:3:1:1 判据（容差随模块尺寸缩放）。 */
function matchesFinderRatios(runs: readonly number[]): boolean {
  const total = runs.reduce((a, b) => a + b, 0)
  if (total < 7) return false
  const module = total / 7
  const maxVar = module * 0.7
  if (Math.abs((runs[0] ?? 0) - module) > maxVar) return false
  if (Math.abs((runs[1] ?? 0) - module) > maxVar) return false
  if (Math.abs((runs[2] ?? 0) - 3 * module) > 3 * maxVar) return false
  if (Math.abs((runs[3] ?? 0) - module) > maxVar) return false
  if (Math.abs((runs[4] ?? 0) - module) > maxVar) return false
  return true
}

/** 水平扫描定位图形候选。 */
function scanRowFinders(image: Binary, y: number): Finder[] {
  const found: Finder[] = []
  const runs: number[] = []
  const colors: number[] = []
  let x = 0
  while (x < image.width) {
    const dark = isDark(image, x, y) ? 1 : 0
    let length = 1
    while (x + length < image.width && (isDark(image, x + length, y) ? 1 : 0) === dark) length++
    runs.push(length)
    colors.push(dark)
    if (runs.length > 5) {
      runs.shift()
      colors.shift()
    }
    if (runs.length === 5 && colors[0] === 1 && colors[1] === 0 && colors[2] === 1 && colors[3] === 0 && colors[4] === 1
      && matchesFinderRatios(runs)) {
      const total = runs.reduce((a, b) => a + b, 0)
      // `x` 是第 5 段（当前段）的起点；整段图形起点 = x + 当前段长 - total。
      const centerX = x + (runs[4] ?? 0) - total / 2
      const moduleSize = total / 7
      const verified = verifyVertical(image, Math.round(centerX), y, moduleSize)
      if (verified !== undefined) found.push({ x: centerX, y: verified, moduleSize })
    }
    x += length
  }
  return found
}

/** 竖直方向复核（返回修正后的中心 y）。 */
function verifyVertical(image: Binary, cx: number, cy: number, moduleSize: number): number | undefined {
  const limit = Math.ceil(moduleSize * 7)
  let up = 0
  while (up < limit && isDark(image, cx, cy - up - 1)) up++
  let down = 0
  while (down < limit && isDark(image, cx, cy + down + 1)) down++
  // 中心竖线应是 3 个模块宽（深色），再上下各 1 个模块深色（外框）与中间白环。
  const core = up + down + 1
  if (core < moduleSize * 1.5 || core > moduleSize * 5) return undefined
  let upLight = 0
  while (upLight < limit && !isDark(image, cx, cy - up - upLight - 1)) upLight++
  let downLight = 0
  while (downLight < limit && !isDark(image, cx, cy + down + downLight + 1)) downLight++
  if (upLight === 0 || downLight === 0) return undefined
  return cy
}

/** 把所有候选聚成最多若干个定位图形。 */
function clusterFinders(candidates: readonly Finder[]): Finder[] {
  const clusters: { x: number; y: number; moduleSize: number; count: number }[] = []
  for (const candidate of candidates) {
    const hit = clusters.find(cluster =>
      Math.abs(cluster.x - candidate.x) <= candidate.moduleSize * 3
      && Math.abs(cluster.y - candidate.y) <= candidate.moduleSize * 3)
    if (hit === undefined) {
      clusters.push({ x: candidate.x, y: candidate.y, moduleSize: candidate.moduleSize, count: 1 })
      continue
    }
    hit.x = (hit.x * hit.count + candidate.x) / (hit.count + 1)
    hit.y = (hit.y * hit.count + candidate.y) / (hit.count + 1)
    hit.moduleSize = (hit.moduleSize * hit.count + candidate.moduleSize) / (hit.count + 1)
    hit.count += 1
  }
  return clusters
    .filter(cluster => cluster.count >= 2)
    .map(cluster => ({ x: cluster.x, y: cluster.y, moduleSize: cluster.moduleSize }))
}

/**
 * 结构复核：真定位图形是「深-白-深」三层同心方环。
 *
 * 只靠 1:1:3:1:1 的行扫描会把数据区的巧合图案也当成定位图形（实测合成图上
 * 能出十几个假候选），所以再用四个方向的灰度结构复核：
 * 中心 3×3 深、±2 模块白环、±3 模块外框深。
 */
function verifyFinderStructure(image: Binary, finder: Finder): boolean {
  const m = finder.moduleSize
  const cx = Math.round(finder.x)
  const cy = Math.round(finder.y)
  if (!isDark(image, cx, cy)) return false
  const darkAt = (dx: number, dy: number): boolean =>
    isDark(image, Math.round(cx + dx * m), Math.round(cy + dy * m))
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]] as const) {
    if (!darkAt(dx, dy)) return false
  }
  for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2]] as const) {
    if (darkAt(dx, dy)) return false
  }
  for (const [dx, dy] of [[3, 0], [-3, 0], [0, 3], [0, -3]] as const) {
    if (!darkAt(dx, dy)) return false
  }
  return true
}

/** 三点定向：返回 [左上, 右上, 左下]。 */
function orientFinders(finders: readonly Finder[]): [Finder, Finder, Finder] | undefined {
  if (finders.length < 3) return undefined
  let best: { a: Finder; b: Finder; c: Finder; hyp: number } | undefined
  for (let i = 0; i < finders.length; i++) {
    for (let j = i + 1; j < finders.length; j++) {
      for (let k = j + 1; k < finders.length; k++) {
        const a = finders[i]!
        const b = finders[j]!
        const c = finders[k]!
        const pairs: [Finder, Finder, Finder, number][] = [
          [a, b, c, dist(a, b)],
          [a, c, b, dist(a, c)],
          [b, c, a, dist(b, c)],
        ]
        for (const [p, q, r, hyp] of pairs) {
          const legA = dist(p, r)
          const legB = dist(q, r)
          // 直角顶点 r 的两条边应**近似等长**（真实 QR 是等腰直角三角形）。
          // 这一条把数据区里偶然凑出的近直角三角形滤掉。
          if (Math.min(legA, legB) / Math.max(legA, legB) < 0.7) continue
          const legs = legA * legA + legB * legB
          if (Math.abs(legs - hyp * hyp) > hyp * hyp * 0.25) continue
          if (best === undefined || hyp > best.hyp) best = { a: p, b: q, c: r, hyp }
        }
      }
    }
  }
  if (best === undefined) return undefined
  const corner = best.c
  const v1 = { x: best.a.x - corner.x, y: best.a.y - corner.y }
  const v2 = { x: best.b.x - corner.x, y: best.b.y - corner.y }
  const cross = v1.x * v2.y - v1.y * v2.x
  // 图像坐标 y 向下：右上 × 左下 的叉积为正。
  return cross > 0 ? [corner, best.a, best.b] : [corner, best.b, best.a]
}

/** 两点距离。 */
function dist(a: Finder, b: Finder): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** 从四对点求单应性（源为 0..1 单位方形）→ 3×3 矩阵。 */
function homographyUnitSquare(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
): number[] | undefined {
  const dx1 = p1.x - p2.x
  const dx2 = p3.x - p2.x
  const dx3 = p0.x - p1.x + p2.x - p3.x
  const dy1 = p1.y - p2.y
  const dy2 = p3.y - p2.y
  const dy3 = p0.y - p1.y + p2.y - p3.y
  const den = dx1 * dy2 - dx2 * dy1
  if (Math.abs(den) < 1e-9) return undefined
  const g = (dx3 * dy2 - dx2 * dy3) / den
  const h = (dx1 * dy3 - dx3 * dy1) / den
  return [
    p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x,
    p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y,
    g, h, 1,
  ]
}

/** 用单应性把单位方形坐标映射到图像坐标。 */
function applyH(matrix: readonly number[], u: number, v: number): { x: number; y: number } {
  const w = (matrix[6] ?? 0) * u + (matrix[7] ?? 0) * v + (matrix[8] ?? 1)
  return {
    x: ((matrix[0] ?? 0) * u + (matrix[1] ?? 0) * v + (matrix[2] ?? 0)) / w,
    y: ((matrix[3] ?? 0) * u + (matrix[4] ?? 0) * v + (matrix[5] ?? 0)) / w,
  }
}

/** 双线性采样灰度。 */
function sampleGray(gray: GrayImage, x: number, y: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const at = (px: number, py: number): number => {
    const cx = Math.min(gray.width - 1, Math.max(0, px))
    const cy = Math.min(gray.height - 1, Math.max(0, py))
    return gray.data[cy * gray.width + cx] ?? 255
  }
  const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx
  const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx
  return top * (1 - fy) + bottom * fy
}

/**
 * 由三个定位图形重建 37×37 模块矩阵。
 *
 * 二值化策略（两种都试）：`global` 用采样值的全局中点（大面积同色区域不受
 * 局部均值影响），`local` 用 5×5 邻域均值（应对照明不均/暗角）。
 */
function sampleMatrix(
  gray: GrayImage,
  corners: [Finder, Finder, Finder],
  mode: 'global' | 'local',
): boolean[][] | undefined {
  const [topLeft, topRight, bottomLeft] = corners
  // 定位图形中心在模块坐标 (3.5, 3.5) 与 (dim-3.5, ...)；
  // 单应性用外扩 3.5 个模块的边界，使单位方形正好覆盖整个符号。
  const expand = (point: Finder, dirX: number, dirY: number): { x: number; y: number } => ({
    x: point.x + dirX * point.moduleSize * 3.5,
    y: point.y + dirY * point.moduleSize * 3.5,
  })
  const unit = {
    x: (topRight.x - topLeft.x) / (DIM - 7),
    y: (topRight.y - topLeft.y) / (DIM - 7),
  }
  const vunit = {
    x: (bottomLeft.x - topLeft.x) / (DIM - 7),
    y: (bottomLeft.y - topLeft.y) / (DIM - 7),
  }
  const moduleApprox = (Math.hypot(unit.x, unit.y) + Math.hypot(vunit.x, vunit.y)) / 2
  if (moduleApprox < 0.8) return undefined
  void expand

  // 四个角（符号外边界中心），用平行四边形近似第四角。
  const p0 = {
    x: topLeft.x - unit.x * 3.5 - vunit.x * 3.5,
    y: topLeft.y - unit.y * 3.5 - vunit.y * 3.5,
  }
  const p1 = {
    x: topRight.x + unit.x * 3.5 - vunit.x * 3.5,
    y: topRight.y + unit.y * 3.5 - vunit.y * 3.5,
  }
  const p2 = {
    x: bottomLeft.x - unit.x * 3.5 + vunit.x * 3.5,
    y: bottomLeft.y - unit.y * 3.5 + vunit.y * 3.5,
  }
  const p3 = { x: p1.x + p2.x - p0.x, y: p1.y + p2.y - p0.y }

  // 经典公式要求参数顺序为 (0,0),(1,0),(1,1),(0,1) —— 即 TL、TR、BR、BL。
  const H = homographyUnitSquare(p0, p1, p3, p2)
  if (H === undefined) return undefined

  // 采样：先取每个模块中心的灰度，再用 5×5 模块邻域均值做自适应阈值。
  const values: number[][] = Array.from({ length: DIM }, () => Array.from({ length: DIM }, () => 0))
  for (let row = 0; row < DIM; row++) {
    for (let col = 0; col < DIM; col++) {
      const point = applyH(H, (col + 0.5) / DIM, (row + 0.5) / DIM)
      values[row]![col] = sampleGray(gray, point.x, point.y)
    }
  }
  const matrix: boolean[][] = Array.from({ length: DIM }, () => Array.from({ length: DIM }, () => false))
  if (mode === 'global') {
    let min = 255
    let max = 0
    for (let row = 0; row < DIM; row++) {
      for (let col = 0; col < DIM; col++) {
        const value = values[row]![col]!
        if (value < min) min = value
        if (value > max) max = value
      }
    }
    if (max - min < 24) return undefined // 对比度不足，不可能是可读码
    const threshold = (min + max) / 2
    for (let row = 0; row < DIM; row++) {
      for (let col = 0; col < DIM; col++) matrix[row]![col] = (values[row]![col] ?? 255) < threshold
    }
    return matrix
  }
  for (let row = 0; row < DIM; row++) {
    for (let col = 0; col < DIM; col++) {
      let sum = 0
      let count = 0
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const r = row + dy
          const c = col + dx
          if (r < 0 || c < 0 || r >= DIM || c >= DIM) continue
          sum += values[r]![c]!
          count++
        }
      }
      const average = sum / count
      matrix[row]![col] = (values[row]![col] ?? 255) < average - 2
    }
  }
  return matrix
}

/** 功能图形掩码（与编码器同一套规则，版本 5）。 */
function functionMask(): boolean[][] {
  const isFn: boolean[][] = Array.from({ length: DIM }, () => Array.from({ length: DIM }, () => false))
  const mark = (x: number, y: number): void => {
    if (x >= 0 && y >= 0 && x < DIM && y < DIM) isFn[y]![x] = true
  }
  for (const [cx, cy] of [[3, 3], [DIM - 4, 3], [3, DIM - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) mark(cx + dx, cy + dy)
  }
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(DIM - 7 + dx, DIM - 7 + dy)
  for (let i = 8; i < DIM - 8; i++) { mark(i, 6); mark(6, i) }
  for (let i = 0; i <= 5; i++) mark(8, i)
  mark(8, 7); mark(8, 8); mark(7, 8)
  for (let i = 9; i < 15; i++) mark(14 - i, 8)
  for (let i = 0; i < 8; i++) mark(DIM - 1 - i, 8)
  for (let i = 8; i < 15; i++) mark(8, DIM - 15 + i)
  mark(8, DIM - 8)
  return isFn
}

/** 合法格式信息集合（EC-L × 8 掩码），用于 BCH 纠错选择。 */
function formatCode(mask: number): number {
  const data = (0b01 << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return (((data << 10) | rem) ^ 0x5412) & 0x7fff
}

/** 汉明距离。 */
function hamming(a: number, b: number): number {
  let value = a ^ b
  let count = 0
  while (value !== 0) { count += value & 1; value >>>= 1 }
  return count
}

/** 从矩阵读格式信息，返回掩码（EC 必须是 L）。 */
function readFormat(matrix: readonly boolean[][]): { mask: number } | undefined {
  const bits: number[] = []
  for (let i = 0; i <= 5; i++) bits.push(matrix[i]![8]! ? 1 : 0)
  bits.push(matrix[7]![8]! ? 1 : 0)
  bits.push(matrix[8]![8]! ? 1 : 0)
  bits.push(matrix[8]![7]! ? 1 : 0)
  for (let i = 9; i < 15; i++) bits.push(matrix[8]![14 - i]! ? 1 : 0)
  let value = 0
  for (let i = 0; i < 15; i++) value |= (bits[i] ?? 0) << i
  // 注意：formatCode() 返回的已是**线上值**（含 ^0x5412），这里不要再异或。

  let bestMask = -1
  let bestDistance = 4
  for (let mask = 0; mask < 8; mask++) {
    const distance = hamming(value, formatCode(mask))
    if (distance < bestDistance) {
      bestDistance = distance
      bestMask = mask
    }
  }
  if (bestMask < 0) return undefined

  // 第二份副本做交叉校验（弱化：允许任一有效即可）。
  const bits2: number[] = []
  for (let i = 0; i < 8; i++) bits2.push(matrix[8]![DIM - 1 - i]! ? 1 : 0)
  for (let i = 8; i < 15; i++) bits2.push(matrix[DIM - 15 + i]![8]! ? 1 : 0)
  let value2 = 0
  for (let i = 0; i < 15; i++) value2 |= (bits2[i] ?? 0) << i
  if (hamming(value2, formatCode(bestMask)) > 3) {
    // 第二份不可靠时，只要第一份距离 ≤3 仍接受。
    if (bestDistance > 3) return undefined
  }
  return { mask: bestMask }
}

/** 掩码条件（与编码器一致）。 */
function maskInverts(mask: number, x: number, y: number): boolean {
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

/** 去掩码并读出 134 个码字。 */
function readCodewords(matrix: readonly boolean[][], mask: number, isFn: readonly boolean[][]): Uint8Array | undefined {
  const bits: number[] = []
  for (let right = DIM - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < DIM; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? DIM - 1 - vert : vert
        if (isFn[y]![x]) continue
        let value = matrix[y]![x]!
        if (maskInverts(mask, x, y)) value = !value
        bits.push(value ? 1 : 0)
      }
    }
  }
  const total = DATA_CODEWORDS + EC_CODEWORDS
  if (bits.length < total * 8) return undefined
  const bytes = new Uint8Array(total)
  for (let i = 0; i < total; i++) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i * 8 + j] ?? 0)
    bytes[i] = byte
  }
  return bytes
}

/** 从码字解析 byte 模式文本。 */
function parseBytes(codewords: Uint8Array): string | undefined {
  const bits: number[] = []
  for (let i = 0; i < DATA_CODEWORDS; i++) {
    const byte = codewords[i] ?? 0
    for (let b = 7; b >= 0; b--) bits.push((byte >>> b) & 1)
  }
  const take = (n: number): number => {
    let value = 0
    for (let i = 0; i < n; i++) value = (value << 1) | (bits.shift() ?? 0)
    return value
  }
  if (take(4) !== 0b0100) return undefined
  const length = take(8)
  if (length <= 0 || length > 106) return undefined
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) bytes[i] = take(8)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

/** 从矩阵解出文本（内部实现，便于测试单点）。 */
export function decodeQrMatrix(matrix: readonly boolean[][]): string | undefined {
  if (matrix.length !== DIM) return undefined
  const format = readFormat(matrix)
  if (format === undefined) return undefined
  const codewords = readCodewords(matrix, format.mask, functionMask())
  if (codewords === undefined) return undefined
  return parseBytes(codewords)
}

/**
 * 诊断入口（测试与排障用）：返回定位/采样中间结果。
 * @param gray - 灰度图。
 * @returns 候选定位图形、定向结果与采样矩阵。
 */
export function debugQrScan(gray: GrayImage): {
  threshold: number
  finders: Finder[]
  oriented: [Finder, Finder, Finder] | undefined
  matrix: boolean[][] | undefined
  text: string | undefined
} {
  const threshold = Math.min(250, Math.max(12, otsuThreshold(gray)))
  const binary = binarize(gray, threshold)
  const candidates: Finder[] = []
  for (let y = 0; y < binary.height; y += 2) candidates.push(...scanRowFinders(binary, y))
  const finders = clusterFinders(candidates).filter(finder => verifyFinderStructure(binary, finder))
  const oriented = orientFinders(finders)
  const matrix = oriented === undefined ? undefined : sampleMatrix(gray, oriented, 'global')
  const text = matrix === undefined ? undefined : decodeQrMatrix(matrix)
  return { threshold, finders, oriented, matrix, text }
}

/**
 * 从灰度图解码 QR。
 * @param gray - 灰度图（相机帧/resized 画布）。
 * @returns 解码出的文本，失败为 undefined。
 */
export function decodeQrGray(gray: GrayImage): string | undefined {
  if (gray.width < DIM * 2 || gray.height < DIM * 2) return undefined
  const base = otsuThreshold(gray)
  // 多阈值重试：轻微偏亮/偏暗的帧也能取到可用二值图。
  for (const threshold of [base, base - 18, base + 18]) {
    const limited = Math.min(250, Math.max(12, threshold))
    const binary = binarize(gray, limited)
    const candidates: Finder[] = []
    for (let y = 0; y < binary.height; y += 2) {
      candidates.push(...scanRowFinders(binary, y))
    }
    const finders = clusterFinders(candidates).filter(finder => verifyFinderStructure(binary, finder))
    if (finders.length < 3) continue
    const corners = orientFinders(finders)
    if (corners === undefined) continue
    // 两种二值化都试：全局中点（大面积同色更稳）与邻域均值（照明不均更稳）。
    for (const mode of ['global', 'local'] as const) {
      const matrix = sampleMatrix(gray, corners, mode)
      if (matrix === undefined) continue
      const text = decodeQrMatrix(matrix)
      if (text !== undefined) return text
    }
  }
  return undefined
}
