/**
 * 本地插件页的图标（**由 `scripts/generate-local-icons.mjs` 生成，请勿手改**）。
 *
 * ### 出处
 *
 * 每个图标都是官方 `@deepseek-ai/dsh-client-ui-primitives/src/icons/artwork.ts` 里对应字形在对应
 * 粗细下的 **SVG 源码原样内联**（viewBox / stroke-width / currentColor 全部来自官方），因此与官方页
 * 的图标像素一致。官方页用 `<symbol>` 精灵 + `<use>` 解引用，本插件直接内联，省掉 ui-theme 的运行时依赖。
 *
 * 上游改图时：`node scripts/generate-local-icons.mjs --from <ui-primitives>/src/icons/artwork.ts` 重跑本脚本；
 * `test/local-plugin-vendor.test.mjs` 会比对生成物与上游源码，漂移即失败。
 *
 * @module dsh-remote-hub/client/local-plugin-manager/icons
 */
import { createElement, type ReactElement } from 'react'

/** 图标 props（与官方 `IconProps` 同形）。 */
export interface IconProps {
  /** 方形边长（px）；缺省用字形自带尺寸。 */
  size?: number | undefined
  /** 额外 class（颜色走 currentColor）。 */
  className?: string | undefined
}

/** 官方 `<svg>` 根属性按字形解析（viewBox 等），这里在生成期直接内联。 */
interface GlyphSpec {
  readonly size: number
  readonly width: number
  readonly height: number
  readonly viewBox: string
  /** 官方 <svg> 根上的绘制属性（fill="none" 等），逐字继承。 */
  readonly paint: Readonly<Record<string, string>>
  readonly inner: string
}

/** 渲染一个内联字形。 */
function glyph(spec: GlyphSpec, props: IconProps): ReactElement {
  const size = props.size ?? spec.size
  return createElement('svg', {
    ...spec.paint,
    width: (size * spec.width) / spec.height, height: size, viewBox: spec.viewBox,
    className: props.className, 'aria-hidden': true, dangerouslySetInnerHTML: { __html: spec.inner },
  })
}

/** 生成期解析出的字形规格表。 */
const GLYPHS = {
  "check-circle-fill:regular": {
    size: 16, width: 36, height: 36,
    viewBox: "0 0 36 36",
    paint: {"fill":"none","strokeWidth":"1"},
    inner: "<path d=\"M28.1936 14.6936L19.8066 23.0806C19.2373 23.65 18.7159 24.1742 18.24 24.5571C17.7389 24.9602 17.1365 25.3359 16.3657 25.458C15.9581 25.5225 15.5428 25.5225 15.1353 25.458C14.3645 25.3359 13.7621 24.9602 13.261 24.5571C12.7851 24.1742 12.2637 23.65 11.6943 23.0806L7.80737 19.1936L10.1936 16.8074L14.0806 20.6943C14.7033 21.317 15.0763 21.6873 15.377 21.9292C15.6523 22.1507 15.7109 22.1325 15.6626 22.1248C15.7208 22.1339 15.7802 22.1339 15.8384 22.1248C15.7901 22.1325 15.8486 22.1507 16.124 21.9292C16.4247 21.6873 16.7977 21.317 17.4204 20.6943L25.8074 12.3074L28.1936 14.6936Z\" fill=\"currentColor\"></path><path d=\"M32.8496 18.0005C32.8496 9.79906 26.2019 3.15137 18.0005 3.15137C9.79906 3.15137 3.15137 9.79906 3.15137 18.0005C3.15137 26.2019 9.79906 32.8496 18.0005 32.8496C26.2019 32.8496 32.8496 26.2019 32.8496 18.0005ZM35.7764 18.0005C35.7764 27.8173 27.8173 35.7764 18.0005 35.7764C8.18363 35.7764 0.224609 27.8173 0.224609 18.0005C0.224609 8.18363 8.18363 0.224609 18.0005 0.224609C27.8173 0.224609 35.7764 8.18363 35.7764 18.0005Z\" fill=\"currentColor\"></path>",
  },
  "check-circle-outline:regular": {
    size: 16, width: 16, height: 16,
    viewBox: "0 0 16 16",
    paint: {"fill":"none","strokeWidth":"1"},
    inner: "<path d=\"M12.5303 6.53027L8.80273 10.2578C8.54967 10.5109 8.31796 10.7439 8.10645 10.9141C7.88375 11.0932 7.616 11.2602 7.27344 11.3145C7.09229 11.3431 6.90771 11.3431 6.72656 11.3145C6.384 11.2602 6.11625 11.0932 5.89355 10.9141C5.68204 10.7439 5.45033 10.5109 5.19727 10.2578L3.46973 8.53027L4.53027 7.46973L6.25781 9.19727C6.53457 9.47402 6.70036 9.63859 6.83398 9.74609C6.95637 9.84453 6.98241 9.83644 6.96094 9.83301C6.98679 9.83709 7.01321 9.83709 7.03906 9.83301C7.01759 9.83644 7.04363 9.84453 7.16602 9.74609C7.29964 9.63859 7.46543 9.47402 7.74219 9.19727L11.4697 5.46973L12.5303 6.53027Z\" fill=\"currentColor\"></path><path d=\"M14.5996 8C14.5996 4.35492 11.6451 1.40039 8 1.40039C4.35492 1.40039 1.40039 4.35492 1.40039 8C1.40039 11.6451 4.35492 14.5996 8 14.5996C11.6451 14.5996 14.5996 11.6451 14.5996 8ZM15.9004 8C15.9004 12.363 12.363 15.9004 8 15.9004C3.63695 15.9004 0.0996094 12.363 0.0996094 8C0.0996094 3.63695 3.63695 0.0996094 8 0.0996094C12.363 0.0996094 15.9004 3.63695 15.9004 8Z\" fill=\"currentColor\"></path>",
  },
  "check-outline:regular": {
    size: 16, width: 16, height: 16,
    viewBox: "0 0 16 16",
    paint: {"fill":"none","strokeWidth":"1"},
    inner: "<path d=\"M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4\" stroke=\"currentColor\"></path>",
  },
  "chevron-down-outline:regular": {
    size: 16, width: 16, height: 16,
    viewBox: "0 0 16 16",
    paint: {"fill":"none","strokeWidth":"1"},
    inner: "<path d=\"M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6\" stroke=\"currentColor\"></path>",
  },
  "chevron-left-outline:medium": {
    size: 16, width: 16, height: 16,
    viewBox: "0 0 16 16",
    paint: {"fill":"none","strokeWidth":"1.3"},
    inner: "<path d=\"M10 4L6.70711 7.29289C6.31658 7.68342 6.31658 8.31658 6.70711 8.70711L10 12\" stroke=\"currentColor\"></path>",
  },
  "chevron-right-outline:regular": {
    size: 16, width: 16, height: 16,
    viewBox: "0 0 16 16",
    paint: {"fill":"none","strokeWidth":"1"},
    inner: "<path d=\"M6 12L9.29289 8.70711C9.68342 8.31658 9.68342 7.68342 9.29289 7.29289L6 4\" stroke=\"currentColor\"></path>",
  },
  "close-outline:medium": {
    size: 16, width: 16, height: 16,
    viewBox: "0 0 16 16",
    paint: {"fill":"none","strokeWidth":"1.3"},
    inner: "<path d=\"M2.5 2.5L13.5 13.5\" stroke=\"currentColor\"></path><path d=\"M13.5 2.5L2.5 13.5\" stroke=\"currentColor\"></path>",
  },
  "close-outline:regular": {
    size: 16, width: 16, height: 16,
    viewBox: "0 0 16 16",
    paint: {"fill":"none","strokeWidth":"1"},
    inner: "<path d=\"M2.5 2.5L13.5 13.5\" stroke=\"currentColor\"></path><path d=\"M13.5 2.5L2.5 13.5\" stroke=\"currentColor\"></path>",
  },
  "download-outline:regular": {
    size: 16, width: 16, height: 16,
    viewBox: "0 0 16 16",
    paint: {"fill":"none","strokeWidth":"1"},
    inner: "<path d=\"M8 1.95317V10.0469\" stroke=\"currentColor\"></path><path d=\"M4.25 6.29688L8 10.0469L11.75 6.29688\" stroke=\"currentColor\"></path><path d=\"M1.5 10.0469V13.158C1.5 13.3937 1.60536 13.6198 1.79289 13.7865C1.98043 13.9532 2.23478 14.0469 2.5 14.0469H13.5C13.7652 14.0469 14.0196 13.9532 14.2071 13.7865C14.3946 13.6198 14.5 13.3937 14.5 13.158V10.0469\" stroke=\"currentColor\"></path>",
  },
  "info-outline:regular": {
    size: 16, width: 14, height: 14,
    viewBox: "0 0 14 14",
    paint: {"fill":"none","strokeWidth":"1"},
    inner: "<path d=\"M12.5757 7.00012C12.5757 3.92085 10.0794 1.42463 7.00012 1.42456C3.9208 1.42456 1.42456 3.9208 1.42456 7.00012C1.42463 10.0794 3.92085 12.5757 7.00012 12.5757C10.0793 12.5756 12.5756 10.0793 12.5757 7.00012ZM13.8002 7.00012C13.8001 10.7559 10.7559 13.8001 7.00012 13.8002C3.2443 13.8002 0.199291 10.7559 0.199219 7.00012C0.199219 3.24426 3.24426 0.199219 7.00012 0.199219C10.7559 0.199291 13.8002 3.2443 13.8002 7.00012Z\" fill=\"currentColor\"></path><path d=\"M7.6127 3.18921V4.55986H6.38735V3.18921H7.6127Z\" fill=\"currentColor\"></path><path d=\"M7.6127 5.68921V10.8109H6.38735V5.68921H7.6127Z\" fill=\"currentColor\"></path>",
  },
  "plus-outline:regular": {
    size: 16, width: 16, height: 16,
    viewBox: "0 0 16 16",
    paint: {"fill":"none","strokeWidth":"1"},
    inner: "<path d=\"M8 2V14\" stroke=\"currentColor\"></path><path d=\"M2 8H14\" stroke=\"currentColor\"></path>",
  },
  "refresh-outline:regular": {
    size: 16, width: 16, height: 16,
    viewBox: "0 0 16 16",
    paint: {"fill":"none","strokeWidth":"1"},
    inner: "<path d=\"M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5C9.9001 1.5 11.7001 2.3 13.0001 3.6L14.5001 5.1\" stroke=\"currentColor\"></path><path d=\"M14.4999 1.5V5.1H10.8999\" stroke=\"currentColor\"></path>",
  },
  "trash-outline:regular": {
    size: 16, width: 16, height: 16,
    viewBox: "0 0 16 16",
    paint: {"fill":"none","strokeWidth":"1"},
    inner: "<path d=\"M1.28149 3.88831H14.7187\" stroke=\"currentColor\"></path><path d=\"M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833\" stroke=\"currentColor\"></path><path d=\"M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831\" stroke=\"currentColor\"></path><path d=\"M6.44946 6.98926V11.1238\" stroke=\"currentColor\"></path><path d=\"M9.55054 6.98926V11.1238\" stroke=\"currentColor\"></path>",
  },
  "warning-outline:regular": {
    size: 16, width: 16, height: 16,
    viewBox: "0 0 16 16",
    paint: {"fill":"none","strokeWidth":"1"},
    inner: "<path d=\"M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z\" stroke=\"currentColor\"></path><path d=\"M8 4.29199V9.79199\" stroke=\"currentColor\"></path><path d=\"M8 10.708V11.708\" stroke=\"currentColor\"></path>",
  },
  "chevron-left-outline:regular": {
    size: 16, width: 16, height: 16,
    viewBox: "0 0 16 16",
    paint: {"fill":"none","strokeWidth":"1"},
    inner: "<path d=\"M10 4L6.70711 7.29289C6.31658 7.68342 6.31658 8.31658 6.70711 8.70711L10 12\" stroke=\"currentColor\"></path>",
  },
  "plugin-pinwheel-outline:regular": {
    size: 16, width: 16, height: 16,
    viewBox: "0 0 16 16",
    paint: {"fill":"none","strokeWidth":"1"},
    inner: "<path d=\"M7.84457 5.06199C11.6605 4.93876 14.7962 6.14848 14.8484 7.76397C14.8875 8.97461 13.1838 10.0696 10.7215 10.5942\" stroke=\"currentColor\"></path><path d=\"M5.12742 8.07731C5.00419 4.26138 6.21391 1.12568 7.8294 1.07351C9.04004 1.03441 10.135 2.73808 10.6596 5.20037\" stroke=\"currentColor\"></path><path d=\"M8.02457 10.6802C4.20865 10.8034 1.07294 9.5937 1.02077 7.97821C0.981678 6.76758 2.68535 5.67262 5.14763 5.14798\" stroke=\"currentColor\"></path><path d=\"M10.7476 7.89535C10.8708 11.7113 9.66109 14.847 8.0456 14.8991C6.83496 14.9382 5.74 13.2346 5.21536 10.7723\" stroke=\"currentColor\"></path>",
  },
} as const

/** `check-circle-fill` @ regular（官方同名组件：IconCheckCircleFillRegular）。 */
export function IconCheckCircleFillRegular(props: IconProps = {}): ReactElement {
  return glyph(GLYPHS['check-circle-fill:regular'], props)
}

/** `check-circle-outline` @ regular（官方同名组件：IconCheckCircleOutlineRegular）。 */
export function IconCheckCircleOutlineRegular(props: IconProps = {}): ReactElement {
  return glyph(GLYPHS['check-circle-outline:regular'], props)
}

/** `check-outline` @ regular（官方同名组件：IconCheckOutlineRegular）。 */
export function IconCheckOutlineRegular(props: IconProps = {}): ReactElement {
  return glyph(GLYPHS['check-outline:regular'], props)
}

/** `chevron-down-outline` @ regular（官方同名组件：IconChevronDownOutlineRegular）。 */
export function IconChevronDownOutlineRegular(props: IconProps = {}): ReactElement {
  return glyph(GLYPHS['chevron-down-outline:regular'], props)
}

/** `chevron-left-outline` @ medium（官方同名组件：IconChevronLeftOutlineMedium）。 */
export function IconChevronLeftOutlineMedium(props: IconProps = {}): ReactElement {
  return glyph(GLYPHS['chevron-left-outline:medium'], props)
}

/** `chevron-right-outline` @ regular（官方同名组件：IconChevronRightOutlineRegular）。 */
export function IconChevronRightOutlineRegular(props: IconProps = {}): ReactElement {
  return glyph(GLYPHS['chevron-right-outline:regular'], props)
}

/** `close-outline` @ medium（官方同名组件：IconCloseOutlineMedium）。 */
export function IconCloseOutlineMedium(props: IconProps = {}): ReactElement {
  return glyph(GLYPHS['close-outline:medium'], props)
}

/** `close-outline` @ regular（官方同名组件：IconCloseOutlineRegular）。 */
export function IconCloseOutlineRegular(props: IconProps = {}): ReactElement {
  return glyph(GLYPHS['close-outline:regular'], props)
}

/** `download-outline` @ regular（官方同名组件：IconDownloadOutlineRegular）。 */
export function IconDownloadOutlineRegular(props: IconProps = {}): ReactElement {
  return glyph(GLYPHS['download-outline:regular'], props)
}

/** `info-outline` @ regular（官方同名组件：IconInfoOutlineRegular）。 */
export function IconInfoOutlineRegular(props: IconProps = {}): ReactElement {
  return glyph(GLYPHS['info-outline:regular'], props)
}

/** `plus-outline` @ regular（官方同名组件：IconPlusOutlineRegular）。 */
export function IconPlusOutlineRegular(props: IconProps = {}): ReactElement {
  return glyph(GLYPHS['plus-outline:regular'], props)
}

/** `refresh-outline` @ regular（官方同名组件：IconRefreshOutlineRegular）。 */
export function IconRefreshOutlineRegular(props: IconProps = {}): ReactElement {
  return glyph(GLYPHS['refresh-outline:regular'], props)
}

/** `trash-outline` @ regular（官方同名组件：IconTrashOutlineRegular）。 */
export function IconTrashOutlineRegular(props: IconProps = {}): ReactElement {
  return glyph(GLYPHS['trash-outline:regular'], props)
}

/** `warning-outline` @ regular（官方同名组件：IconWarningOutlineRegular）。 */
export function IconWarningOutlineRegular(props: IconProps = {}): ReactElement {
  return glyph(GLYPHS['warning-outline:regular'], props)
}

/** `chevron-left-outline` @ regular（官方同名组件：IconChevronLeftOutlineRegular）。 */
export function IconChevronLeftOutlineRegular(props: IconProps = {}): ReactElement {
  return glyph(GLYPHS['chevron-left-outline:regular'], props)
}

/** `plugin-pinwheel-outline` @ regular（官方同名组件：IconPluginPinwheelOutlineRegular）。 */
export function IconPluginPinwheelOutlineRegular(props: IconProps = {}): ReactElement {
  return glyph(GLYPHS['plugin-pinwheel-outline:regular'], props)
}
