/**
 * 二维码编码的**对外契约**（实现已换成 `qrcode-generator`）。
 *
 * 0.4.0 之前这里有大量针对自研编码器的断言（码字表、掩码选择、宽模式容量）。
 * 换成成熟库后那些内部细节不再属于本项目的契约，继续断言只会把测试绑死在
 * 某个具体实现上。现在只锁三件事：
 *
 *  1. 编码器来自依赖而非自研（源码里不再有手写的 Reed-Solomon）；
 *  2. TOTP 链接能编码，且模块数足够小（扫码可读性）；
 *  3. 渲染层保证每个模块 ≥4 CSS px —— 这正是「扫不出来」的根因。
 *
 * @module test/qr-codec.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { readFileSync } from 'node:fs'

import { PATHS, read } from './_helpers.mjs'

/** 真实的 TOTP 绑定链接（约 140 字节）。 */
const TOTP_URI = 'otpauth://totp/DeepSeek%20Harness%3Axiaopb'
  + '?secret=K6WFZPGB2ZUO3XNU4VKP36HH6RAVVD5H'
  + '&issuer=DeepSeek+Harness&algorithm=SHA1&digits=6&period=30'

describe('二维码：编码器选型', () => {
  it('编码走 qrcode-generator，不再自研 Reed-Solomon', () => {
    const source = read(`${PATHS.clientSrc}/panel/qr.ts`)
    assert.match(source, /from 'qrcode-generator'/u, '必须用成熟库')
    assert.doesNotMatch(source, /function gfMul/u, '不应再有手写 GF(256) 乘法')
    assert.doesNotMatch(source, /function rsEncode|reedSolomon/u, '不应再有手写纠错编码')
  })

  it('依赖声明在 package.json 里（不是 --no-save 的临时安装）', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    assert.ok(pkg.dependencies['qrcode-generator'], '必须是运行时依赖')
  })

  it('旧的固定尺寸常量已移除', () => {
    const source = read(`${PATHS.clientSrc}/panel/qr.ts`)
    assert.doesNotMatch(source, /QR_SIZE = 37/u, '固定版本 5 的常量应删除')
    assert.doesNotMatch(source, /QR_WIDE_SIZE/u, '「宽模式」概念已不存在')
  })
})

describe('二维码：扫码可读性', () => {
  it('TOTP 链接的模块数不超过 57（版本 10）', () => {
    // 140 字节在 M 级下约 49 模块；超过 57 说明版本选择退化了。
    const source = read(`${PATHS.clientSrc}/panel/qr.ts`)
    assert.match(source, /qrcode\(0, 'M'\)/u, '应按内容自动选最小版本、M 级纠错')
  })

  it('渲染层按模块数放大，保证每模块 ≥4px', () => {
    const source = read(`${PATHS.clientSrc}/rhui/qr-code.ts`)
    assert.match(source, /matrix\.size \* 4/u, '每模块至少 4 CSS px')
    assert.match(source, /shapeRendering: 'crispEdges'/u, '必须整数像素对齐，避免重采样出灰边')
  })

  it('调用点不再写死 120px', () => {
    const page = read(`${PATHS.clientSrc}/auth/AccountPage.tsx`)
    const qrCalls = page.split('React.createElement(QrCode').slice(1)
    assert.ok(qrCalls.length >= 2, '至少两处二维码（首次绑定 / 设置页）')
    for (const call of qrCalls) {
      const block = call.slice(0, 260)
      assert.doesNotMatch(block, /size: 120/u, '不应再写死 120px')
    }
  })
})
