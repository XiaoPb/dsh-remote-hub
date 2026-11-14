/**
 * 「本地插件」侧栏图标：**同一枚官方 pinwheel** + 一枚绿点角标。
 *
 * ## 需求对应
 *
 * - 「图标使用和插件页的一样」：字形来自 `primitives.ts` → `icons.tsx`，
 *   而后者由 `scripts/generate-local-icons.mjs` 从官方 `icons/artwork.ts` **生成**（几何数据逐字相同），
 *   官方页的 `PluginsPanelIcon` 也用同一枚 `IconPluginPinwheelOutlineRegular`。
 * - 「侧边栏图标通过增加绿点进行区分」：绿点与「云端设备」图标（`client/src/panel/NavIcon.ts`）
 *   完全同款 —— 同一组设计令牌、同样的描边与位置比例，于是两种状态在侧栏里一眼可辨：
 *   **云端设备**用绿点表示「已连接」；**本地插件**用绿点表示「当前处于接管中、这是本机那份」。
 * - 「实际页面的图标使用规则完全照搬」：本文件只作用于侧栏那一格；页面内部的卡片/行/详情图标
 *   （`PluginManagerPage.tsx` 的 `itemArtwork` / `PackageArtwork` / `PluginArtwork*`）**不加任何额外标记**。
 *
 * @module dsh-remote-hub/client/local-plugin-manager/LocalPluginsPanelIcon
 */
import type { ReactNode } from 'react'

import { IconPluginPinwheelOutlineRegular } from './primitives.ts'

/** 侧栏图标收到的 props（与官方 `sidebar.panellist` 的 owner props 同形）。 */
export interface LocalPluginsPanelIconProps {
  /** 侧栏请求的方形边长（px）。 */
  readonly size?: number
  /** 该面板是否被选中。 */
  readonly active?: boolean
}

/** 角标相对图标的边长比例（与 `RemoteHubNavIcon` 的 `r: 3.2` / `size: 20` 比例一致）。 */
const DOT_RATIO = 3.2 / 20
/** 角标描边宽度（随尺寸缩放，基准同样是 20px 下的 1.5）。 */
const DOT_STROKE_RATIO = 1.5 / 20

/**
 * 渲染「本地插件」侧栏图标。
 * @param props - `{ size, active }`。
 * @returns 图标 + 绿点角标。
 */
export function LocalPluginsPanelIcon(props: LocalPluginsPanelIconProps = {}): ReactNode {
  const size = typeof props.size === 'number' && props.size > 0 ? props.size : 20
  const radius = Math.max(2, Math.round(size * DOT_RATIO * 10) / 10)
  const stroke = Math.max(1, Math.round(size * DOT_STROKE_RATIO * 10) / 10)
  const cx = size - radius / 2 - stroke / 2
  const cy = radius / 2 + stroke / 2
  return (
    <span
      data-testid="local-plugins-nav-icon"
      data-active={props.active === true ? true : undefined}
      style={{ position: 'relative', display: 'inline-flex', width: size, height: size }}
    >
      <IconPluginPinwheelOutlineRegular size={size} />
      <svg
        data-testid="local-plugins-nav-dot"
        width={size}
        height={size}
        viewBox={`0 0 ${String(size)} ${String(size)}`}
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      >
        <circle
          cx={cx}
          cy={cy}
          r={radius}
          fill="var(--dsw-alias-state-success-primary, #22c55e)"
          stroke="var(--dsw-alias-bg-layer-1, #fff)"
          strokeWidth={stroke}
        />
      </svg>
    </span>
  )
}

/**
 * 纯图标（无绿点）的等价物 —— 需要「和官方页一模一样」时使用（例如未来放进页面内部的入口）。
 * @param props - `{ size }`。
 * @returns 官方同款 pinwheel。
 */
export function LocalPluginsPlainIcon(props: { readonly size?: number } = {}): ReactNode {
  return <IconPluginPinwheelOutlineRegular size={props.size ?? 20} />
}
