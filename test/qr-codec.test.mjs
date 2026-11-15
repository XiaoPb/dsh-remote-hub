/**
 * QR 编解码测试：**只保留编码器**（TOTP 绑定二维码渲染要用）。
 *
 * 相机扫码（`QrScanner.ts`）与自研解码器（`qr-decode.ts`）随邀请链路一起删除：
 * 邀请 / 短码 / 深链在 P4 阶段 B 已整体下线，页面不再提供任何扫码入口。
 *
 * @module test/qr-codec.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { PATHS, read } from './_helpers.mjs'

const QR_SRC = read(`${PATHS.clientSrc}/panel/qr.ts`)
const DECODE_SRC = read(`${PATHS.clientSrc}/panel/qr-decode.ts`)
const SCANNER_SRC = read(`${PATHS.clientSrc}/panel/QrScanner.ts`)
const PAGE_SRC = read(`${PATHS.clientSrc}/panel/RemoteHubPage.ts`)
const INDEX_SRC = read(`${PATHS.clientSrc}/index.ts`)

describe('二维码编码器（保留：TOTP 绑定用）', () => {
  it('自研编码器仍在，且不依赖任何网络/外部库', () => {
    assert.ok(QR_SRC.includes('export function encodeQr'), 'encodeQr 必须保留（TOTP 绑定二维码）')
    assert.ok(QR_SRC.includes('rsRemainder'), 'Reed-Solomon 实现必须在页面内')
    assert.ok(QR_SRC.includes('QR_MAX_BYTES = 106'), '二维码容量上限常量必须保留')
  })
})

describe('扫码链路已删除（阶段 B）', () => {
  it('QrScanner / 解码器源文件不再存在', () => {
    assert.equal(SCANNER_SRC, '', 'QrScanner.ts 必须删除')
    assert.equal(DECODE_SRC, '', 'qr-decode.ts 必须删除')
  })

  it('页面无任何扫码入口（按钮、组件、深链解析）', () => {
    assert.equal(PAGE_SRC.includes("'data-testid': 'scan'"), false, '不得再有扫码按钮')
    assert.equal(PAGE_SRC.includes('QrScanner'), false, '页面不得再引用相机扫码组件')
    assert.equal(PAGE_SRC.includes('#dshrh='), false, '不得再解析邀请深链')
    assert.equal(PAGE_SRC.includes('classifyPairSecret'), false, '不得再识别邀请短码/票据')
    assert.equal(PAGE_SRC.includes('pair-qr'), false, '不得再渲染邀请二维码')
  })

  it('包入口不再导出扫码组件与解码器', () => {
    assert.equal(INDEX_SRC.includes('QrScanner'), false)
    assert.equal(INDEX_SRC.includes('decodeQrGray'), false)
    assert.ok(INDEX_SRC.includes('encodeQr'), '编码器仍需导出（TOTP 绑定）')
  })
})
