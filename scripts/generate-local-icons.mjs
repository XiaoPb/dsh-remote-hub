/**
 * 从官方图标表**生成**本插件用的内联图标组件（`client/src/local-plugin-manager/icons.tsx`）。
 *
 * ## 为什么生成而不是 import（依赖最小化，ADR-008）
 *
 * 官方 `@deepseek-ai/dsh-client-ui-primitives` 的图标有一套 `<symbol>` 精灵机制：`ui-theme` 在文档里发布
 * `dsw-icon-<glyph>-<weight>` 符号，组件只渲染 `<use href="#…">`。把整套包引进来会把 ui-theme 的运行时
 * 依赖一起拖进插件；而本地插件页只用到 **11 个字形**。
 *
 * 本脚本直接读官方 `icons/artwork.ts` 的 `ICON_ARTWORK` 表，把那 11 个字形的 **SVG 源码原样内联**成本地组件
 * （viewBox / stroke-width / currentColor 全部来自官方），因此**图标与官方页像素一致**，且零运行时依赖。
 *
 * ## 用法
 *
 * ```powershell
 * node scripts/generate-local-icons.mjs --from <ui-primitives>/src/icons/artwork.ts
 * ```
 *
 * `test/local-plugin-vendor.test.mjs` 会重新计算并与生成物逐字比对（上游改图 → 测试红 → 重跑本脚本）。
 *
 * @module scripts/generate-local-icons
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本地插件页用到的字形（= vendored UI 里引用的图标名，见 `REQUIRED_ICONS`）。 */
export const REQUIRED_ICONS = Object.freeze({
  IconCheckCircleFillRegular: ['check-circle-fill', 'regular'],
  IconCheckCircleOutlineRegular: ['check-circle-outline', 'regular'],
  IconCheckOutlineRegular: ['check-outline', 'regular'],
  IconChevronDownOutlineRegular: ['chevron-down-outline', 'regular'],
  IconChevronLeftOutlineMedium: ['chevron-left-outline', 'medium'],
  IconChevronRightOutlineRegular: ['chevron-right-outline', 'regular'],
  IconCloseOutlineMedium: ['close-outline', 'medium'],
  IconCloseOutlineRegular: ['close-outline', 'regular'],
  IconDownloadOutlineRegular: ['download-outline', 'regular'],
  IconInfoOutlineRegular: ['info-outline', 'regular'],
  IconPlusOutlineRegular: ['plus-outline', 'regular'],
  IconRefreshOutlineRegular: ['refresh-outline', 'regular'],
  IconTrashOutlineRegular: ['trash-outline', 'regular'],
  IconWarningOutlineRegular: ['warning-outline', 'regular'],
  IconChevronLeftOutlineRegular: ['chevron-left-outline', 'regular'],
  IconPluginPinwheelOutlineRegular: ['plugin-pinwheel-outline', 'regular'],
})

/** 官方字符宽度常量的取值（`ICON_REGULAR_STROKE` / `ICON_MEDIUM_STROKE`）。 */
const STROKES = { regular: 1, medium: 1.3 }

/**
 * 从官方 `artwork.ts` 里取出一个字形在某个粗细下的 SVG 源码。
 *
 * 用**求值**而不是正则：官方表里同一个字形可能按 `strokeWidth === ICON_MEDIUM_STROKE` 三元分支，
 * 只有真正执行 `svg(stroke)` 才能拿到正确的那一份。
 * @param source - `artwork.ts` 源码。
 * @param glyph - 字形名（`ICON_ARTWORK` 的键）。
 * @param weight - `regular` | `medium`。
 * @returns SVG 源码字符串。
 */
export function glyphSvg(source, glyph, weight) {
  const table = extractTable(source)
  const entry = table[glyph]
  if (entry === undefined) throw new Error(`generate-local-icons: unknown glyph ${glyph}`)
  const svg = entry.svg(STROKES[weight])
  if (typeof svg !== 'string' || !svg.startsWith('<svg')) {
    throw new Error(`generate-local-icons: glyph ${glyph}/${weight} did not produce SVG markup`)
  }
  return svg
}

/**
 * 在一个隔离的函数作用域里求值官方图标表的对象字面量。
 *
 * 只执行数据部分（`{ 'glyph': { size, svg: fn } }`），不 import 官方包。
 * @param source - `artwork.ts` 源码。
 * @returns 字形表。
 */
export function extractTable(source) {
  const start = source.indexOf('export const ICON_ARTWORK')
  if (start < 0) throw new Error('generate-local-icons: ICON_ARTWORK not found')
  const open = source.indexOf('{', start)
  const end = source.indexOf('\n} satisfies Record<string, IconArtwork>', open)
  if (open < 0 || end < 0) throw new Error('generate-local-icons: ICON_ARTWORK literal bounds not found')
  const literal = source.slice(open, end + 2)
  const strokes = { ICON_REGULAR_STROKE: STROKES.regular, ICON_MEDIUM_STROKE: STROKES.medium }
  // eslint-disable-next-line no-new-func -- evaluating a trusted data literal from the kernel checkout
  const build = new Function('ICON_REGULAR_STROKE', 'ICON_MEDIUM_STROKE', `return (${literal})`)
  return build(strokes.ICON_REGULAR_STROKE, strokes.ICON_MEDIUM_STROKE)
}

/**
 * 把官方 SVG 源码转换成 React 组件体（把属性名改写成 JSX 形式，保留全部几何数据）。
 * @param svg - 官方 SVG 字符串。
 * @returns 可用于 `dangerouslySetInnerHTML` 的内部标记。
 */
export function svgInner(svg) {
  const inner = svg.replace(/^<svg[^>]*>/u, '').replace(/<\/svg>\s*$/u, '')
  // JSX 不认 `stroke-width` 这类连字符属性；这里直接输出 HTML 字符串，由图标组件统一用
  // `dangerouslySetInnerHTML` 注入 —— 与 `createElement('svg', …)` 渲染结果完全一致。
  return inner
}

/**
 * 生成 `icons.tsx` 源码。
 * @param artworkSource - 官方 `artwork.ts` 源码。
 * @returns 生成的源码。
 */
export function generateIcons(artworkSource) {
  const entries = Object.entries(REQUIRED_ICONS).map(([component, [glyph, weight]]) => ({
    component,
    glyph,
    weight,
    svg: glyphSvg(artworkSource, glyph, weight),
  }))
  const header = [
    '/**',
    ' * 本地插件页的图标（**由 `scripts/generate-local-icons.mjs` 生成，请勿手改**）。',
    ' *',
    ' * ### 出处',
    ' *',
    ' * 每个图标都是官方 `@deepseek-ai/dsh-client-ui-primitives/src/icons/artwork.ts` 里对应字形在对应',
    ' * 粗细下的 **SVG 源码原样内联**（viewBox / stroke-width / currentColor 全部来自官方），因此与官方页',
    ' * 的图标像素一致。官方页用 `<symbol>` 精灵 + `<use>` 解引用，本插件直接内联，省掉 ui-theme 的运行时依赖。',
    ' *',
    ' * 上游改图时：`node scripts/generate-local-icons.mjs --from <ui-primitives>/src/icons/artwork.ts` 重跑本脚本；',
    ' * `test/local-plugin-vendor.test.mjs` 会比对生成物与上游源码，漂移即失败。',
    ' *',
    ' * @module dsh-remote-hub/client/local-plugin-manager/icons',
    ' */',
    "import { createElement, type ReactElement } from 'react'",
    '',
    '/** 图标 props（与官方 `IconProps` 同形）。 */',
    'export interface IconProps {',
    '  /** 方形边长（px）；缺省用字形自带尺寸。 */',
    '  size?: number | undefined',
    '  /** 额外 class（颜色走 currentColor）。 */',
    '  className?: string | undefined',
    '}',
    '',
    "/** 官方 `<svg>` 根属性按字形解析（viewBox 等），这里在生成期直接内联。 */",
    'interface GlyphSpec {',
    '  readonly size: number',
    '  readonly width: number',
    '  readonly height: number',
    '  readonly viewBox: string',
    '  readonly inner: string',
    '}',
    '',
    '/** 渲染一个内联字形。 */',
    'function glyph(spec: GlyphSpec, props: IconProps): ReactElement {',
    '  const size = props.size ?? spec.size',
    '  return createElement(\'svg\', {',
    '    width: (size * spec.width) / spec.height, height: size, viewBox: spec.viewBox,',
    '    className: props.className, \'aria-hidden\': true, dangerouslySetInnerHTML: { __html: spec.inner },',
    '  })',
    '}',
    '',
    '/** 生成期解析出的字形规格表。 */',
    'const GLYPHS = {',
    ...entries.map((entry) => {
      const spec = parseSvg(entry.svg)
      return [
        `  ${JSON.stringify(entry.glyph + ':' + entry.weight)}: {`,
        `    size: ${String(spec.size)}, width: ${String(spec.width)}, height: ${String(spec.height)},`,
        `    viewBox: ${JSON.stringify(spec.viewBox)},`,
        `    inner: ${JSON.stringify(spec.inner)},`,
        '  },',
      ].join('\n')
    }),
    '} as const',
    '',
  ].join('\n')
  const components = entries.map(entry => [
    `/** \`${entry.glyph}\` @ ${entry.weight}（官方同名组件：${entry.component}）。 */`,
    `export function ${entry.component}(props: IconProps = {}): ReactElement {`,
    `  return glyph(GLYPHS['${entry.glyph}:${entry.weight}'], props)`,
    '}',
    '',
  ].join('\n'))
  return `${header}\n${components.join('\n')}`
}

/**
 * 解析官方 SVG 字符串的根属性与内部标记。
 * @param svg - 官方 SVG 字符串。
 * @returns 规格。
 */
export function parseSvg(svg) {
  const head = /^<svg([^>]*)>/u.exec(svg)
  if (head === null) throw new Error('generate-local-icons: svg root not found')
  const attrs = head[1]
  const viewBox = /viewBox="([^"]+)"/u.exec(attrs)?.[1] ?? '0 0 16 16'
  const [, , boxWidth, boxHeight] = viewBox.split(/\s+/u).map(Number)
  return {
    size: 16,
    width: boxWidth,
    height: boxHeight,
    viewBox,
    inner: svgInner(svg),
  }
}

const invokedDirectly = process.argv[1] !== undefined && basename(process.argv[1]) === 'generate-local-icons.mjs'
if (invokedDirectly) {
  const fromIndex = process.argv.indexOf('--from')
  if (fromIndex < 0 || process.argv[fromIndex + 1] === undefined) {
    process.stderr.write('usage: node scripts/generate-local-icons.mjs --from <ui-primitives>/src/icons/artwork.ts\n')
    process.exit(2)
  }
  const outIndex = process.argv.indexOf('--out')
  const out = outIndex < 0 || process.argv[outIndex + 1] === undefined
    ? join(fileURLToPath(new URL('..', import.meta.url)), 'client', 'src', 'local-plugin-manager', 'icons.tsx')
    : resolve(process.argv[outIndex + 1])
  const source = readFileSync(resolve(process.argv[fromIndex + 1]), 'utf8')
  writeFileSync(out, generateIcons(source), 'utf8')
  process.stdout.write(`generated ${String(Object.keys(REQUIRED_ICONS).length)} icons -> ${join(dirname(out), basename(out))}\n`)
}
