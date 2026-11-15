/**
 * 二维码矩阵渲染组件（设计系统基元）。
 *
 * 编码器仍是 `client/src/panel/qr.ts` 的 `encodeQr`（版本 5-L，自研、无依赖）；
 * 这里只负责把矩阵画成 SVG。用它的两处：设置页 **TOTP 绑定二维码**（otpauth URI）。
 * 邀请二维码已随 P4 阶段 B 删除。
 *
 * 视觉：白底 + 黑模块是**唯一允许的字面色值**（design-system 例外条款）——
 * 暗色主题下若跟随主题反色，手机相机将无法识别。
 *
 * @module dsh-remote-hub/client/rhui/qr-code
 */
import React from 'react'

import { encodeQr } from '../panel/qr.js'

/** 二维码属性。 */
export interface QrCodeProps {
  /** 编码内容（TOTP 用 otpauth URI）。 */
  text: string
  /** 边长（px）；默认 120（design-system §7）。 */
  size?: number
  /** 无障碍名称（默认「二维码」）。 */
  label?: string
  /** 内容超出编码器容量时的回退文案。 */
  tooLong?: string
  'data-testid'?: string
}

/**
 * 渲染二维码 SVG。
 * @param props - 内容与尺寸。
 * @returns SVG 节点（内容过长时返回一句提示，不抛错）。
 */
export function QrCode({ text, size = 120, label = '二维码', tooLong = '内容过长，无法生成二维码', ...rest }: QrCodeProps): React.ReactElement {
  let matrix: ReturnType<typeof encodeQr>
  try {
    matrix = encodeQr(text)
  } catch {
    return React.createElement('p', { className: 'rh-k' }, tooLong)
  }
  const cells: React.ReactNode[] = []
  for (let y = 0; y < matrix.size; y++) {
    for (let x = 0; x < matrix.size; x++) {
      if (!matrix.modules[y]?.[x]) continue
      cells.push(React.createElement('rect', { key: `${x}-${y}`, x, y, width: 1, height: 1 }))
    }
  }
  return React.createElement(
    'svg',
    {
      ...rest,
      className: 'rh-qr',
      style: { width: size, height: size },
      viewBox: `-2 -2 ${matrix.size + 4} ${matrix.size + 4}`,
      role: 'img',
      'aria-label': label,
      focusable: 'false',
    },
    React.createElement('rect', { x: -2, y: -2, width: matrix.size + 4, height: matrix.size + 4, fill: '#FFFFFF' }),
    React.createElement('g', { fill: '#000000' }, ...cells),
  )
}
