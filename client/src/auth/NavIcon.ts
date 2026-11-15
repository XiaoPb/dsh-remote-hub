/**
 * 侧栏「登录与账号」图标（钥匙 + 盾的极简形态，28×28 视口）。
 * @module dsh-remote-hub/client/auth/NavIcon
 */
import React from 'react'

/**
 * 渲染图标。
 * @returns SVG 节点。
 */
export function AccountNavIcon(): React.ReactNode {
  return React.createElement('svg', {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  },
  React.createElement('path', { d: 'M12 3l7 3v6c0 4.2-2.9 7.4-7 9-4.1-1.6-7-4.8-7-9V6l7-3z' }),
  React.createElement('circle', { cx: 12, cy: 11, r: 2.2 }),
  React.createElement('path', { d: 'M12 13.2V16' }))
}
