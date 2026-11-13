/**
 * QR 解码器测试：合成图像（渲染 → 旋转 → 噪声）→ 解码回原文。
 *
 * 这是「扫码」功能的真实回归面：解码器的输入是相机帧的灰度图，所以测试用
 * 合成的灰度图（而非矩阵）驱动完整链路：二值化 → 定位 → 单应性采样 → 解码。
 *
 * @module test/qr-decode.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { PATHS, read } from './_helpers.mjs'
import { registerAlias } from './panel-alias-loader.mjs'

await registerAlias()

const QR = await import('../.build/client/client/src/panel/qr.js')
const DECODE = await import('../.build/client/client/src/panel/qr-decode.js')

/**
 * 把 QR 矩阵渲染成灰度图，可旋转/加噪（模拟相机帧）。
 * @returns {{width:number,height:number,data:Uint8Array}}
 */
function render(text, options = {}) {
  const { scale = 8, margin = 4, angleDeg = 0, noise = 0, seed = 1 } = options
  const { size, modules } = QR.encodeQr(text)
  const side = (size + margin * 2) * scale
  const clean = new Uint8Array(side * side).fill(235)
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (!modules[row][col]) continue
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const x = (col + margin) * scale + dx
          const y = (row + margin) * scale + dy
          clean[y * side + x] = 25
        }
      }
    }
  }
  if (angleDeg === 0 && noise === 0) return { width: side, height: side, data: clean }

  // 逆映射旋转（把目标像素映回源图），再叠加确定性伪随机噪声。
  const rad = (angleDeg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const cx = side / 2
  const cy = side / 2
  const data = new Uint8Array(side * side).fill(235)
  let state = seed
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0xffffffff
  }
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const dx = x - cx
      const dy = y - cy
      const sx = Math.round(cx + dx * cos + dy * sin)
      const sy = Math.round(cy - dx * sin + dy * cos)
      let value = 235
      if (sx >= 0 && sy >= 0 && sx < side && sy < side) value = clean[sy * side + sx]
      if (noise > 0) value += Math.round((rand() - 0.5) * 2 * noise)
      data[y * side + x] = Math.max(0, Math.min(255, value))
    }
  }
  return { width: side, height: side, data }
}

const LINK = 'http://192.168.1.10:8443#dshrh=' + 'A'.repeat(43)

describe('QR 解码：矩阵级', () => {
  it('编码后的矩阵可解回原文', () => {
    for (const text of ['ABCD2345', LINK]) {
      const { modules } = QR.encodeQr(text)
      assert.equal(DECODE.decodeQrMatrix(modules), text)
    }
  })
})

describe('QR 解码：灰度图（合成相机帧）', () => {
  it('干净帧', () => {
    assert.equal(DECODE.decodeQrGray(render(LINK)), LINK)
  })

  it('不同缩放（每模块 5px）', () => {
    assert.equal(DECODE.decodeQrGray(render(LINK, { scale: 5 })), LINK)
  })

  it('旋转 7°', () => {
    assert.equal(DECODE.decodeQrGray(render(LINK, { angleDeg: 7 })), LINK)
  })

  it('旋转 7° + 噪声 ±12', () => {
    assert.equal(DECODE.decodeQrGray(render(LINK, { angleDeg: 7, noise: 12 })), LINK)
  })

  it('噪声 ±20（低质量帧）', () => {
    assert.equal(DECODE.decodeQrGray(render('ABCD2345', { noise: 20, seed: 7 })), 'ABCD2345')
  })

  it('纯噪声 / 空白图返回 undefined（不误报）', () => {
    const blank = { width: 300, height: 300, data: new Uint8Array(300 * 300).fill(240) }
    assert.equal(DECODE.decodeQrGray(blank), undefined)
    let state = 42
    const noise = new Uint8Array(300 * 300)
    for (let i = 0; i < noise.length; i++) {
      state = (state * 1664525 + 1013904223) >>> 0
      noise[i] = state & 0xff
    }
    assert.equal(DECODE.decodeQrGray({ width: 300, height: 300, data: noise }), undefined)
  })

  it('过小的图直接返回 undefined（避免无谓扫描）', () => {
    assert.equal(DECODE.decodeQrGray({ width: 40, height: 40, data: new Uint8Array(1600) }), undefined)
  })
})

describe('扫码组件：实现契约（源码级）', () => {
  const SRC = read(`${PATHS.clientSrc}/panel/QrScanner.ts`)

  it('用 getUserMedia 而且要关掉 track（否则摄像头常亮）', () => {
    assert.ok(SRC.includes('getUserMedia'))
    assert.ok(SRC.includes('getTracks') && SRC.includes('track.stop'))
    assert.ok(SRC.includes('cancelled = true'), 'unmount cleanup')
  })

  it('不依赖 BarcodeDetector：存在时加速，缺失时用自研解码', () => {
    assert.ok(SRC.includes('BarcodeDetector'))
    assert.ok(SRC.includes('decode('), 'falls back to own decoder')
    assert.ok(SRC.includes('decodeQrGray'))
  })

  it('权限被拒有明确提示', () => {
    assert.ok(SRC.includes('NotAllowedError'))
    assert.ok(SRC.includes('摄像头权限被拒绝'))
  })
})

describe('页面：扫码按钮接入', () => {
  const PAGE_SRC = read(`${PATHS.clientSrc}/panel/RemoteHubPage.ts`)

  it('按钮存在且命中后自动连接', () => {
    assert.ok(PAGE_SRC.includes("'data-testid': 'scan'"))
    assert.ok(PAGE_SRC.includes('QrScanner'))
    assert.ok(PAGE_SRC.includes('applyScan') && PAGE_SRC.includes('connectWith'))
  })
})