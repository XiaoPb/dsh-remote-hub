/**
 * Markdown 渲染的**最小替身**：替代官方 `DetailDocument` 依赖的 `mdast` / `micromark` / `katex` 整棵渲染树。
 *
 * ## 为什么（依赖最小化，ADR-009）
 *
 * 官方 `DetailDocument` 用 `MarkdownText` 渲染 README：它依赖
 * `mdast` + `mdast-util-*` + `micromark-util-sanitize-uri` + `katex` + 文件链接图标 + 图片灯箱……
 * 这是一整套文档渲染子系统。把它搬进插件会立刻破坏「运行时新增依赖 = 0」。
 *
 * ## 这里给出什么
 *
 * 一个**行为对齐、能力收敛**的渲染器：
 *
 * - 支持：标题、段落、粗体/斜体/行内代码、代码块、有序/无序列表、引用、链接、图片、分割线、表格；
 * - **安全**：图片 URL 只允许 `http(s)` / `data:image` / 相对路径；链接只允许 `http(s)` / `mailto` / 相对路径；
 *   其余（`javascript:`、`vbscript:`、`data:text/html`）一律降级成纯文本。
 * - **本地图片改写**：文档里的相对图片路径经 `pathImages.toUrl?.()` 交给宿主路由
 *   （详情图片走 `/api/hub/local-plugin-manager/detail-file`），与官方 `MarkdownPathImages` 语义一致。
 *
 * ## 与官方的差异（登记在 04-verification §6）
 *
 * - 不做代码高亮、不渲染数学公式、不做表格之外的扩展语法（任务列表、脚注等按普通文本处理）；
 * - 不做图片灯箱/拖拽，只渲染 `<img>`。
 *
 * @module dsh-remote-hub/client/local-plugin-manager/markdown
 */
import { Fragment, createElement, type ReactNode } from 'react'

/** 本地图片路径的解析面（与官方 `MarkdownPathImages` 同形）。 */
export interface MarkdownPathImages {
  readonly toUrl?: (destination: string) => string | undefined
}

/** 文档文案（与官方 MarkdownLabels 对齐的常用子集）。 */
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
  const resolved = pathImages?.toUrl?.(trimmed) ?? trimmed
  return SAFE_IMAGE.test(resolved) ? resolved : undefined
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
    const link = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/u.exec(rest)
    if (link !== null) {
      if (SAFE_LINK.test(link[2] ?? '')) {
        nodes.push({ kind: 'link', href: link[2] ?? '', ...(link[3] === undefined ? {} : { title: link[3] }), children: [{ kind: 'text', text: link[1] ?? '' }] })
      } else {
        pushText(link[1] ?? '')
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
export function MarkdownText({ markdown, pathImages }: {
  readonly markdown: string
  readonly pathImages?: MarkdownPathImages
}): ReactNode {
  return createElement('div', { className: 'dsh-local-markdown' }, renderBlocks(parseMarkdown(markdown, pathImages)))
}
