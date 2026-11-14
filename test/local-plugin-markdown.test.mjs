/**
 * 详情文档 Markdown 的行内解析：徽章、图片与链接。
 *
 * 2026-11-14 线上问题：本地插件页把 README 里的
 * `[![CI](badge.svg)](ci.yml)` 渲染成了 `![CI](https://…)` 原文，
 * 而官方页显示的是徽章图片。根因是链接标签被当成纯文本，未递归解析。
 *
 * 这里测的是**编译产物** `lib/client.js` 中的真实实现：切出 `parseInline`
 * 函数体求值，不复制任何逻辑。产物缺失时跳过。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const BUNDLE = new URL('../lib/client.js', import.meta.url)

/**
 * 从 bundle 里取出编译后的 `parseInline`。
 *
 * `parseInline` 依赖同模块的 `SAFE_LINK` / `SAFE_IMAGE` / `resolveImageSource`，
 * 所以这几段也一并切片 —— 求值的始终是产物里的真实实现。
 * @returns 行内解析函数；产物缺失或形状不符时返回 undefined。
 */
function loadParseInline() {
  if (!existsSync(BUNDLE)) return undefined
  const source = readFileSync(BUNDLE, 'utf8')

  /**
   * 从某个标记起，按花括号配平切出完整声明。
   * @param {string} marker - 起始标记（不含）。
   * @returns {string | undefined} 源码片段。
   */
  const sliceBalanced = marker => {
    const start = source.indexOf(marker)
    if (start < 0) return undefined
    let depth = 0
    for (let index = source.indexOf('{', start); index < source.length; index += 1) {
      if (source[index] === '{') depth += 1
      else if (source[index] === '}') {
        depth -= 1
        if (depth === 0) return source.slice(start, index + 1)
      }
    }
    return undefined
  }

  /**
   * 切出一个 `const NAME = <表达式>;` 声明（到行末分号）。
   * @param {string} name - 常量名。
   * @returns {string | undefined} 源码片段。
   */
  const sliceConst = name => {
    const start = source.indexOf(`const ${name} = `)
    if (start < 0) return undefined
    const end = source.indexOf(';', start)
    return end < 0 ? undefined : source.slice(start, end + 1)
  }

  const pieces = [
    sliceConst('SAFE_LINK'),
    sliceConst('SAFE_IMAGE'),
    sliceBalanced('function resolveImageSource('),
    sliceBalanced('function parseInline(text, pathImages)'),
  ]
  if (pieces.some(piece => piece === undefined)) return undefined
  try {
    return new Function(`${pieces.join('\n')}\nreturn parseInline`)()
  } catch {
    return undefined
  }
}

const parseInline = loadParseInline()

/**
 * 断言前提：拿不到真实实现就跳过（并要求已构建）。
 * @param {import('node:test').TestContext} t - 测试上下文。
 * @returns {boolean} 是否应当跳过。
 */
function skipIfMissing(t) {
  if (parseInline !== undefined) return false
  t.skip('lib/client.js 未构建或形状变化')
  return true
}

test('徽章语法 [![alt](img)](href) 解析为「链接包裹图片」', t => {
  if (skipIfMissing(t)) return
  const nodes = parseInline('[![CI](https://example.com/badge.svg)](https://example.com/ci)', undefined)
  assert.equal(nodes.length, 1, '整段是一个链接节点')
  const link = nodes[0]
  assert.equal(link.kind, 'link')
  assert.equal(link.href, 'https://example.com/ci')
  assert.equal(link.children.length, 1, '链接标签里应当有一张图片，而不是纯文本')
  const image = link.children[0]
  assert.equal(image.kind, 'image')
  assert.equal(image.alt, 'CI')
  assert.equal(image.src, 'https://example.com/badge.svg')
})

test('裸图片与普通链接仍然照常解析', t => {
  if (skipIfMissing(t)) return
  const image = parseInline('![logo](https://example.com/logo.png)', undefined)[0]
  assert.equal(image.kind, 'image')
  assert.equal(image.alt, 'logo')

  const link = parseInline('[文档](https://example.com/docs)', undefined)[0]
  assert.equal(link.kind, 'link')
  assert.equal(link.children[0].kind, 'text')
})

test('不安全协议的链接不会泄漏原文，标签内容仍可读', t => {
  if (skipIfMissing(t)) return
  const nodes = parseInline('[危险](javascript:alert(1))', undefined)
  assert.ok(!nodes.some(node => node.kind === 'link'), 'javascript: 不能成为链接')
  assert.ok(nodes.some(node => node.kind === 'text' && node.text.includes('危险')))
})
