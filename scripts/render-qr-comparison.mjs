/**
 * 生成「修改前 / 修改后」二维码对比图（SVG），用于确认扫码可读性。
 *
 * 左边：旧实现（版本 10-L，57 模块，120px → 2.1px/模块）
 * 右边：新实现（qrcode-generator M 级，49 模块，204px → 4.16px/模块）
 *
 * @module scripts/render-qr-comparison
 */
import { writeFileSync } from 'node:fs'

import qrcode from 'qrcode-generator'

const URI = 'otpauth://totp/DeepSeek%20Harness%3Axiaopb'
  + '?secret=K6WFZPGB2ZUO3XNU4VKP36HH6RAVVD5H'
  + '&issuer=DeepSeek+Harness&algorithm=SHA1&digits=6&period=30'

/**
 * 用手写实现的参数（固定版本 + 固定像素）生成一个矩阵。
 *
 * @param {number} version - QR 版本。
 * @param {string} level - 纠错等级。
 * @returns {{size: number, isDark: Function}} 矩阵。
 */
function encodeFixed(version, level) {
  const code = qrcode(version, level)
  code.addData(URI, 'Byte')
  code.make()
  return { size: code.getModuleCount(), isDark: (r, c) => code.isDark(r, c) }
}

/**
 * 把矩阵画成一个 `<svg>` 片段。
 *
 * @param {object} matrix - 矩阵。
 * @param {number} px - 显示边长（CSS px）。
 * @param {number} x - 画布内偏移。
 * @param {number} y - 画布内偏移。
 * @param {string} caption - 图注。
 * @param {boolean} highlight - 是否用红色描出单个模块。
 * @returns {string} SVG 片段。
 */
function panel(matrix, px, x, y, caption, highlight) {
  const quiet = 4
  const total = matrix.size + quiet * 2
  let cells = ''
  for (let row = 0; row < matrix.size; row++) {
    for (let column = 0; column < matrix.size; column++) {
      if (!matrix.isDark(row, column)) continue
      cells += `<rect x="${column + quiet}" y="${row + quiet}" width="1" height="1"/>`
    }
  }
  const boxSize = 56 // 放大的单个模块示意
  const sample = highlight
    ? `<g transform="translate(${x + px + 20}, ${y + 4})">`
      + `<rect x="0" y="0" width="${boxSize}" height="${boxSize}" fill="#000"/>`
      + `<text x="0" y="${boxSize + 18}" font-family="system-ui" font-size="12" fill="#b91c1c">`
      + `单个模块 = ${(px / matrix.size).toFixed(1)}px</text>`
      + '<text x="0" y="' + (boxSize + 34) + '" font-family="system-ui" font-size="12" fill="#666">'
      + (px / matrix.size >= 4 ? '达到 4px 门槛' : '低于 4px 门槛')
      + '</text></g>'
    : ''
  const captionEl = `<text x="${x}" y="${y + px + 26}" font-family="system-ui" font-size="14" fill="#111">${caption}</text>`
  return `<g transform="translate(${x}, ${y})">`
    + `<rect x="-8" y="-8" width="${px + 16}" height="${px + 16}" fill="#fff" stroke="#e5e7eb"/>`
    + `<svg width="${px}" height="${px}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">`
    + `<rect width="${total}" height="${total}" fill="#fff"/>`
    + `<g fill="#000">${cells}</g></svg>`
    + `</g>${captionEl}${sample}`
}

const before = encodeFixed(10, 'L')
// 140 字节在 M 级下是版本 8（49 模块）；版本 7-M 只能放 124 字节，装不下。
const after = encodeFixed(8, 'M')

const width = 760
const height = 340
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
  + `<rect width="${width}" height="${height}" fill="#f8fafc"/>`
  + `<text x="24" y="34" font-family="system-ui" font-size="16" font-weight="600" fill="#111">`
  + 'TOTP 绑定二维码：模块尺寸对比</text>'
  + `<text x="24" y="56" font-family="system-ui" font-size="12" fill="#666">`
  + '两者编码的是同一条 140 字节的 otpauth:// 链接</text>'
  + panel(before, 120, 24, 84, `修改前：${before.size} 模块 / 120px`, true)
  + panel(after, 204, 330, 84, `修改后：${after.size} 模块 / 204px`, true)
  + '</svg>'

const out = process.argv[2] ?? 'dev/screenshots/qr-comparison.svg'
writeFileSync(out, svg, 'utf8')
console.log(JSON.stringify({
  out,
  before: { modules: before.size, px: 120, pxPerModule: +(120 / before.size).toFixed(2) },
  after: { modules: after.size, px: 204, pxPerModule: +(204 / after.size).toFixed(2) },
}, null, 2))
