/**
 * 详情文档的 Markdown 渲染 —— **优先复用宿主官方渲染器**。
 *
 * ## 为什么改
 *
 * 这里原本是自研的轻量实现（标题/段落/列表/代码块/粗斜体/链接/图片）。用户实测反馈
 * 「内容、表格这些 markdown 的渲染都不如官方的」：表格不渲染、没有代码高亮、没有数学公式，
 * 嵌套图片（README 徽章 `[![alt](img)](href)`）还会漏成纯文本。
 *
 * 官方页用的是 `@deepseek-ai/dsh-client-ui-primitives` 的 `MarkdownText`（完整 GFM）。
 * 该包**不单独发布**，但由宿主模块加载器提供 —— 官方 `dsh-client-ui-plugin-manager`
 * 的 bundle 第一行就是 `require("@deepseek-ai/dsh-client-ui-primitives")`；我们处在同样的
 * `factory(require)` 语境里，因此用完全相同的方式取用（见 `client/src/index.ts`）。
 *
 * ## 兜底
 *
 * 宿主若没提供 primitives，退回下面这套轻量渲染，页面不至于整块空白：
 *
 * - 支持：标题、段落、粗体/斜体、行内代码、代码块、有序/无序列表、引用、链接、图片、分割线、表格；
 * - **安全**：图片 URL 只允许 `http(s)` / `data:image` / 相对路径；链接只允许 `http(s)` / `mailto` / 相对路径；
 *   其余（`javascript:`、`vbscript:`、`data:text/html`）一律降级成可读文本；
 * - **本地图片改写**：相对图片路径经 `pathImages.toUrl?.()` 交给宿主路由
 *   （`/api/hub/local-plugin-manager/detail-file`），与官方 `MarkdownPathImages` 语义一致。
 *
 * @module dsh-remote-hub/client/local-plugin-manager/markdown
 */
import { Fragment, createElement, type ReactNode } from 'react'

/** 本地图片路径的解析面（与官方 `MarkdownPathImages` 同形）。 */
export interface MarkdownPathImages {
  readonly toUrl?: (destination: string) => string | undefined
}

/** 文档文案（与官方 MarkdownLabels 对齐的常用子集）。 */
/** 官方渲染器缺省界面文案（调用方不传 labels 时使用；只影响代码块工具栏等界面标签）。 */
const DEFAULT_MARKDOWN_LABELS: MarkdownLabels = Object.freeze({
  copy: 'Copy',
  copied: 'Copied',
  collapse: 'Collapse',
  expand: 'Expand',
  code: { copyLabel: 'Copy', copiedLabel: 'Copied', toolbarLabels: { codeLabel: 'Code', wrapLabel: 'Wrap', unwrapLabel: 'Unwrap' } },
  footnotes: 'Footnotes',
})

export interface MarkdownLabels {
  readonly copy?: string
  readonly copied?: string
  readonly collapse?: string
  readonly expand?: string
  readonly code?: {
    readonly copyLabel?: string
    readonly copiedLabel?: string
    readonly toolbarLabels?: {
      readonly codeLabel?: string
      readonly wrapLabel?: string
      readonly unwrapLabel?: string
    }
  }
  readonly footnotes?: string
  readonly [key: string]: unknown
}

/** 只允许安全协议的链接。 */
const SAFE_LINK = /^(?:https?:|mailto:|#|\/(?!\/)|\.{0,2}\/)/iu
/** 只允许安全协议的图片。 */
const SAFE_IMAGE = /^(?:https?:|data:image\/|#|\/(?!\/)|\.{0,2}\/)/iu

/**
 * 把文档里的图片地址解析成可渲染的 URL。
 * @param destination - 文档里写的地址。
 * @param pathImages - 宿主提供的解析面。
 * @returns URL，或 undefined（不安全 → 不渲染图片）。
 */
export function resolveImageSource(destination: string, pathImages?: MarkdownPathImages): string | undefined {
  const trimmed = destination.trim()
  if (trimmed === '') return undefined
  // 宿主解析器已经把相对路径换成了**绝对** URL（`/api/...` 或 `http(s)://…`）。
  // 解析器**返回**了就说明它认得这张图（官方 `BundleDetailController.image()` 对绝对地址返回
  // `undefined`，相对路径才拼成 detail-file URL），这里不再对返回值套白名单 —— 否则
  // 一个合法的相对路径会被再判一次而丢掉（2026-11-14：实验性插件的预览图显示成裂图 + alt 文字）。
  const resolved = pathImages?.toUrl?.(trimmed)
  if (resolved !== undefined) return resolved
  // 没有解析器（或解析器拒收）时，自己按绝对地址白名单兜底。
  return SAFE_IMAGE.test(trimmed) ? trimmed : undefined
}

/** 一个行内节点。 */
type Inline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'strong'; readonly children: Inline[] }
  | { readonly kind: 'em'; readonly children: Inline[] }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'link'; readonly href: string; readonly title?: string; readonly children: Inline[] }
  | { readonly kind: 'image'; readonly src: string; readonly alt: string }

/** 一个块级节点。 */
type Block =
  | { readonly kind: 'heading'; readonly depth: number; readonly children: Inline[] }
  | { readonly kind: 'paragraph'; readonly children: Inline[] }
  | { readonly kind: 'code'; readonly lang: string; readonly text: string }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly Inline[][] }
  | { readonly kind: 'quote'; readonly children: readonly Block[] }
  | { readonly kind: 'rule' }
  | { readonly kind: 'table'; readonly head: readonly string[]; readonly rows: readonly (readonly string[])[] }

/**
 * 解析行内语法（粗体 / 斜体 / 行内代码 / 链接 / 图片）。
 * @param text - 原始文本。
 * @param pathImages - 图片地址解析面。
 * @returns 行内节点列表。
 */
export function parseInline(text: string, pathImages?: MarkdownPathImages): Inline[] {
  const nodes: Inline[] = []
  let rest = text
  const pushText = (value: string): void => {
    if (value !== '') nodes.push({ kind: 'text', text: value })
  }
  while (rest !== '') {
    const code = /^`([^`]+)`/u.exec(rest)
    if (code !== null) {
      nodes.push({ kind: 'code', text: code[1] ?? '' })
      rest = rest.slice(code[0].length)
      continue
    }
    const image = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/u.exec(rest)
    if (image !== null) {
      const src = resolveImageSource(image[2] ?? '', pathImages)
      if (src !== undefined) nodes.push({ kind: 'image', src, alt: image[1] ?? '' })
      else pushText(image[1] ?? '')
      rest = rest.slice(image[0].length)
      continue
    }
    // 链接的标签里可以再嵌图片：徽章就是 `[![CI](badge.svg)](ci.yml)`。
    // 标签必须在**这里递归解析**，否则整段会退化成纯文本（2026-11-14：本地页的
    // CI/Release/npm 三个徽章显示成了 `![CI](https://…)` 原文）。
    const link = /^\[((?:[^\[\]]|\[[^\]]*\])*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/u.exec(rest)
    if (link !== null) {
      const label = link[1] ?? ''
      if (SAFE_LINK.test(link[2] ?? '')) {
        nodes.push({ kind: 'link', href: link[2] ?? '', ...(link[3] === undefined ? {} : { title: link[3] }), children: parseInline(label, pathImages) })
      } else {
        // 不安全的链接：保留标签里的可读内容（图片按图片规则处理）。
        nodes.push(...parseInline(label, pathImages))
      }
      rest = rest.slice(link[0].length)
      continue
    }
    const strong = /^\*\*([^*]+)\*\*|^__([^_]+)__/u.exec(rest)
    if (strong !== null) {
      nodes.push({ kind: 'strong', children: parseInline(strong[1] ?? strong[2] ?? '', pathImages) })
      rest = rest.slice(strong[0].length)
      continue
    }
    const em = /^\*([^*]+)\*|^_([^_]+)_/u.exec(rest)
    if (em !== null) {
      nodes.push({ kind: 'em', children: parseInline(em[1] ?? em[2] ?? '', pathImages) })
      rest = rest.slice(em[0].length)
      continue
    }
    // 普通字符：吃到下一个特殊符号为止（成批推进，避免 O(n²)）。
    const next = rest.slice(1).search(/[`![*_]/u)
    const take = next < 0 ? rest.length : next + 1
    pushText(rest.slice(0, take))
    rest = rest.slice(take)
  }
  return nodes
}

/**
 * 解析整篇 Markdown 成块级树（仅支持上文列出的语法）。
 * @param source - Markdown 原文。
 * @param pathImages - 图片地址解析面。
 * @returns 块级节点列表。
 */
export function parseMarkdown(source: string, pathImages?: MarkdownPathImages): Block[] {
  const lines = source.replace(/\r\n?/gu, '\n').split('\n')
  const blocks: Block[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '') { index += 1; continue }
    const fence = /^\s*```(\S*)\s*$/u.exec(line)
    if (fence !== null) {
      const body: string[] = []
      index += 1
      while (index < lines.length && !/^\s*```\s*$/u.test(lines[index] ?? '')) { body.push(lines[index] ?? ''); index += 1 }
      index += 1
      blocks.push({ kind: 'code', lang: fence[1] ?? '', text: body.join('\n') })
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/u.exec(line)
    if (heading !== null) {
      blocks.push({ kind: 'heading', depth: (heading[1] ?? '').length, children: parseInline(heading[2] ?? '', pathImages) })
      index += 1
      continue
    }
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/u.test(line)) {
      blocks.push({ kind: 'rule' })
      index += 1
      continue
    }
    if (/^\s*>/u.test(line)) {
      const body: string[] = []
      while (index < lines.length && /^\s*>/u.test(lines[index] ?? '')) {
        body.push((lines[index] ?? '').replace(/^\s*>\s?/u, ''))
        index += 1
      }
      blocks.push({ kind: 'quote', children: parseMarkdown(body.join('\n'), pathImages) })
      continue
    }
    if (/^\s*\|/u.test(line)) {
      const rows: string[][] = []
      while (index < lines.length && /^\s*\|/u.test(lines[index] ?? '')) {
        const cells = (lines[index] ?? '').trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(cell => cell.trim())
        if (!cells.every(cell => /^:?-{2,}:?$/u.test(cell))) rows.push(cells)
        index += 1
      }
      if (rows.length > 0) {
        const [head, ...body] = rows
        blocks.push({ kind: 'table', head: head ?? [], rows: body })
      }
      continue
    }
    const listItem = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/u.exec(line)
    if (listItem !== null) {
      const ordered = listItem[2] !== undefined
      const items: Inline[][] = []
      while (index < lines.length) {
        const match = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/u.exec(lines[index] ?? '')
        if (match === null) break
        if ((match[2] !== undefined) !== ordered) break
        items.push(parseInline(match[3] ?? '', pathImages))
        index += 1
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }
    const paragraph: string[] = []
    while (
      index < lines.length
      && (lines[index] ?? '').trim() !== ''
      && !/^\s*(?:#{1,6}\s|```|>|\||(?:[-*+]|\d+[.)])\s|(?:---+|\*\*\*+)\s*$)/u.test(lines[index] ?? '')
    ) {
      paragraph.push(lines[index] ?? '')
      index += 1
    }
    blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join('\n'), pathImages) })
  }
  return blocks
}

/** 渲染行内节点。 */
function renderInline(nodes: readonly Inline[], key = 'i'): ReactNode {
  return createElement(Fragment, null, nodes.map((node, position) => {
    const nodeKey = `${key}-${String(position)}`
    switch (node.kind) {
      case 'text':
        return createElement(Fragment, { key: nodeKey }, node.text)
      case 'strong':
        return createElement('strong', { key: nodeKey }, renderInline(node.children, nodeKey))
      case 'em':
        return createElement('em', { key: nodeKey }, renderInline(node.children, nodeKey))
      case 'code':
        return createElement('code', { key: nodeKey }, node.text)
      case 'link':
        return createElement('a', {
          key: nodeKey,
          href: node.href,
          ...(node.title === undefined ? {} : { title: node.title }),
          target: '_blank',
          rel: 'noreferrer noopener',
        }, renderInline(node.children, nodeKey))
      case 'image':
        return createElement('img', { key: nodeKey, src: node.src, alt: node.alt, loading: 'lazy' })
    }
  }))
}

/** 渲染块级节点。 */
function renderBlocks(blocks: readonly Block[], key = 'b'): ReactNode {
  return createElement(Fragment, null, blocks.map((block, position) => {
    const blockKey = `${key}-${String(position)}`
    switch (block.kind) {
      case 'heading':
        return createElement(`h${String(Math.min(block.depth + 1, 6))}`, { key: blockKey }, renderInline(block.children, blockKey))
      case 'paragraph':
        return createElement('p', { key: blockKey }, renderInline(block.children, blockKey))
      case 'code':
        return createElement('pre', { key: blockKey, 'data-lang': block.lang === '' ? undefined : block.lang }, createElement('code', null, block.text))
      case 'list':
        return createElement(block.ordered ? 'ol' : 'ul', { key: blockKey },
          block.items.map((item, itemIndex) => createElement('li', { key: `${blockKey}-${String(itemIndex)}` }, renderInline(item, `${blockKey}-${String(itemIndex)}`))))
      case 'quote':
        return createElement('blockquote', { key: blockKey }, renderBlocks(block.children, blockKey))
      case 'rule':
        return createElement('hr', { key: blockKey })
      case 'table':
        return createElement('table', { key: blockKey },
          createElement('thead', null, createElement('tr', null,
            block.head.map((cell, cellIndex) => createElement('th', { key: `${blockKey}-h${String(cellIndex)}` }, cell)))),
          createElement('tbody', null, block.rows.map((row, rowIndex) => createElement('tr', { key: `${blockKey}-r${String(rowIndex)}` },
            row.map((cell, cellIndex) => createElement('td', { key: `${blockKey}-r${String(rowIndex)}c${String(cellIndex)}` }, cell))))))
    }
  }))
}

/**
 * 渲染一篇 Markdown 文档。
 * @param props.markdown - Markdown 原文。
 * @param props.pathImages - 图片地址解析面（本地详情图片路由）。
 * @returns React 节点。
 */
export function fallbackMarkdownText(markdown: string, pathImages?: MarkdownPathImages): ReactNode {
  return createElement('div', { className: 'dsh-local-markdown' }, renderBlocks(parseMarkdown(markdown, pathImages)))
}

/** 官方 primitives 里我们用到的那一小块。 */
interface OfficialPrimitives {
  readonly MarkdownText?: (props: {
    readonly text: string
    readonly labels: MarkdownLabels
    readonly pathImages?: MarkdownPathImages | undefined
    readonly omitHtml?: boolean
  }) => ReactNode
}

/**
 * 宿主注入的官方 primitives。
 *
 * 由 `client/src/index.ts` 在 factory 里 `require` 后登记 —— 那是唯一能拿到
 * `require` 的地方（模块系统 boot 之后 `create()` 已不可用）。
 */
let officialPrimitives: OfficialPrimitives | undefined

/**
 * 登记宿主提供的官方 primitives。
 * @param primitives - `@deepseek-ai/dsh-client-ui-primitives` 的导出；falsy 表示宿主没提供。
 */
export function installOfficialPrimitives(primitives: unknown): void {
  officialPrimitives = (primitives ?? undefined) as OfficialPrimitives | undefined
}

/**
 * 宿主是否提供了官方 Markdown 渲染器。
 * @returns 提供了官方 `MarkdownText` 时为 true。
 */
export function hasOfficialMarkdown(): boolean {
  return isRenderable(officialPrimitives?.MarkdownText)
}

/**
 * 该导出能不能当作组件渲染。
 *
 * 官方 `MarkdownText` 是 `React.memo` 包装：`typeof` 是 `'object'`，
 * 靠 `$typeof` 标记识别（2026-11-14 实测，只判 function 会白白退回兜底渲染）。
 * @param candidate - 导出的候选值。
 * @returns 可作为组件渲染时为 true。
 */
function isRenderable(candidate: unknown): boolean {
  if (typeof candidate === 'function') return true
  if (typeof candidate !== 'object' || candidate === null) return false
  // 官方 `MarkdownText` 是 `React.memo` 包装：typeof 是 object，靠 $$typeof 标记识别。
  // 不能直接比较 Symbol 身份（跨模块实例不相等），只检查形状。
  const elementType = candidate as { $$typeof?: unknown; type?: unknown }
  return elementType.$$typeof !== undefined
    && (typeof elementType.type === 'function' || typeof elementType.type === 'object')
}

/**
 * 渲染一篇 Markdown 文档：优先官方 `MarkdownText`，缺失时用本地兜底。
 * @param props.markdown - Markdown 原文。
 * @param props.labels - 官方渲染器需要的界面文案。
 * @param props.pathImages - 图片地址解析面。
 * @returns React 节点。
 */
export function MarkdownText({ markdown, labels, pathImages }: {
  readonly markdown: string
  readonly labels?: MarkdownLabels | undefined
  readonly pathImages?: MarkdownPathImages | undefined
}): ReactNode {
  const Official = officialPrimitives?.MarkdownText
  if (isRenderable(Official)) {
    // 官方导出是 memo 包装（object），createElement 接受它；这里按组件类型收窄。
    const Component = Official as NonNullable<OfficialPrimitives['MarkdownText']>
    return createElement(Component, {
      text: markdown,
      // 官方组件（如 DetailDocument）不一定传 labels：这些只是代码块的界面标签，
      // 缺省用中性英文即可，不影响文档内容本身。
      labels: labels ?? DEFAULT_MARKDOWN_LABELS,
      pathImages,
      omitHtml: true,
    })
  }
  return fallbackMarkdownText(markdown, pathImages)
}
