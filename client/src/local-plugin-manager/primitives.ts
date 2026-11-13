/**
 * 本地插件管理页的**最小统一导出面**：把 vendored 官方 UI 需要的组件/工具聚合成一个模块。
 *
 * ## 为什么需要
 *
 * 官方 `ui-plugin-manager` 的页面从 `@deepseek-ai/dsh-client-ui-primitives`（一个 100+ 文件的内置包）
 * 导入 30 来个组件。本插件按「运行时新增依赖 = 0」的约束**不引用那个包**，而是：
 *
 * - **组件**：原样 vendored 到 `./ui/`（Button / Input / Switch / Tag / StateDot / SegmentedTabs /
 *   Tooltip / Toast / Checkbox / Menu / Modal / TerminalBlock / DetailDocument + 它们的 CSS Module），
 *   只把 `clsx` 换成本地 `classNames`、`anser` 换成本地 ANSI 解析、图标换成本地 `./icons.tsx`；
 * - **图标**：由 `scripts/generate-local-icons.mjs` 从官方 `icons/artwork.ts` **生成**（几何数据逐字相同）；
 * - **品牌插画**：从官方 `plugin-artwork.tsx` 复制到 `./plugin-artwork.tsx`（固定调色板 SVG）。
 *
 * 页面组件（vendored 的 `PluginManagerPage.tsx` 等）因此只需把 `from '@deepseek-ai/dsh-client-ui-primitives'`
 * 改成 `from './primitives.ts'` —— **其余一行不动**。
 *
 * @module dsh-remote-hub/client/local-plugin-manager/primitives
 */

// ── 本地工具替身 ───────────────────────────────────────────────────────────────

export { classNames } from './class-names.ts'

// ── 图标（生成物）──────────────────────────────────────────────────────────────

export {
  IconCheckCircleFillRegular,
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronLeftOutlineMedium,
  IconChevronRightOutlineRegular,
  IconCloseOutlineRegular,
  IconCloseOutlineMedium,
  IconDownloadOutlineRegular,
  IconInfoOutlineRegular,
  IconPluginPinwheelOutlineRegular,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
  IconTrashOutlineRegular,
  IconWarningOutlineRegular,
} from './icons.tsx'
export type { IconProps } from './icons.tsx'

// ── 品牌插画（官方固定调色板 SVG）───────────────────────────────────────────────

export {
  PluginArtworkDefault,
  PluginArtworkLoop,
  PluginArtworkSearch,
  PluginArtworkSubagent,
  PluginArtworkTerminal,
} from './plugin-artwork.tsx'

// ── 原子组件（vendored）───────────────────────────────────────────────────────

export { Button } from './ui/Button.tsx'
export { Checkbox } from './ui/Checkbox.tsx'
export { Input } from './ui/Input.tsx'
export { Menu, MenuItemButton } from './ui/Menu.tsx'
export { Modal } from './ui/Modal.tsx'
export { SegmentedTabs } from './ui/SegmentedTabs.tsx'
export { StateDot } from './ui/StateDot.tsx'
export { Switch } from './ui/Switch.tsx'
export { Tag } from './ui/Tag.tsx'
export { TerminalBlock } from './ui/TerminalBlock.tsx'
export { Toast } from './ui/Toast.tsx'
export { Tooltip } from './ui/Tooltip.tsx'

// ── 组合组件（vendored，需要官方 markdown 渲染面）────────────────────────────────

export { DetailDocument, detailDocumentState, useDetailDocumentLabels } from './ui/DetailDocument.tsx'
export type { MarkdownPathImages } from './markdown.tsx'

// ── 输入模态工具 ───────────────────────────────────────────────────────────────

export { pointerModality } from './ui/input-modality.ts'
export { useDismissOnOutsidePointer } from './ui/useDismissOnOutsidePointer.ts'

// ── 组件 props 类型 ────────────────────────────────────────────────────────────

export type { IconProps as PrimitiveIconProps } from './icons.tsx'
export type { StateDotState } from './ui/StateDot.tsx'
export type { TerminalBlockLabels } from './ui/TerminalBlock.tsx'
