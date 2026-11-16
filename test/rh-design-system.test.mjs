/**
 * 设计系统门禁：`--rh-*` token 是唯一色源，页面与组件不得再写死色值/字号。
 *
 * 依据 `dev/ui-redesign/design-system.md §2 / §3 / §11` 与
 * `plan-optimization.md §10`：
 * - 唯一允许字面色值的位置是 `client/src/rhui/tokens.ts`（token 定义）；
 * - 组件与页面只写 `var(--rh-*)`，类名 `rh-` 前缀；
 * - 不再出现非 `--rh-*` 的 CSS 变量定义（`--dsw-*` 只作 token 内的 fallback 引用）。
 *
 * 这是**静态源码门禁**（与 `panel.test.mjs` 的渲染断言互补）：渲染断言只能覆盖
 * 当前会渲染的分支，门禁覆盖整个源码树。
 *
 * @module test/rh-design-system.test.mjs
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { PATHS } from './_helpers.mjs'

const TOKENS_FILE = join(PATHS.clientSrc, 'rhui', 'tokens.ts')

/** 递归列出 `client/src` 下的 .ts/.tsx 文件。 */
function sourceFiles(dir = PATHS.clientSrc, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out)
      continue
    }
    if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(full)
  }
  return out
}

const FILES = sourceFiles().filter(file => file !== TOKENS_FILE && !file.endsWith('QrScanner.ts'))

/**
 * 本次改造范围内（`design-system.md` 适用范围）：设置页「登录与账号」+
 * 云端设备主页 + 它们共用的公共组件。本地插件页（`local-plugin-manager/`）与
 * 云端路径 UI（`paths/`）按文档**不在**本次范围，门禁不覆盖它们。
 */
const IN_SCOPE = /[\\/](rhui|panel|auth)[\\/]/u
const SCOPED_FILES = FILES.filter(file => IN_SCOPE.test(file))

/** 去掉注释与字符串里的说明文字后按行扫描（保留真正的代码）。 */
function codeLines(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(entry => !entry.line.trim().startsWith('//'))
}

/** 十六进制色值（`#fff` / `#FFFFFF` / `#11223344`）。 */
const HEX = /#[0-9a-fA-F]{3,8}\b/u
/** 函数式色值（`rgb(...)` / `rgba(...)` / `hsl(...)`）。 */
const RGB = /\b(rgba?|hsla?)\(/u

describe('设计系统 token（--rh-*）', () => {
  it('token 定义齐全（design-system §2.1 / §3 / §4）', () => {
    const source = readFileSync(TOKENS_FILE, 'utf8')
    const required = [
      '--rh-bg', '--rh-surface', '--rh-border', '--rh-border-strong',
      '--rh-text', '--rh-text-2', '--rh-text-3', '--rh-accent', '--rh-accent-fg',
      '--rh-blue', '--rh-blue-bg', '--rh-green', '--rh-green-bg',
      '--rh-red', '--rh-red-bg', '--rh-orange', '--rh-orange-bg', '--rh-purple', '--rh-shadow',
      '--rh-fs-h1', '--rh-fs-h2', '--rh-fs-h3', '--rh-fs-label', '--rh-fs-body',
      '--rh-fs-mono', '--rh-fs-stat', '--rh-font', '--rh-mono',
      '--rh-radius', '--rh-radius-sm', '--rh-radius-pill',
      '--rh-gap', '--rh-pad', '--rh-pad-mobile',
    ]
    for (const token of required) {
      assert.ok(source.includes(`${token}:`), `tokens.ts 缺 ${token}`)
    }
  })

  it('亮暗双套 + 系统偏好 + 宿主强制 + 三档断点', () => {
    const source = readFileSync(TOKENS_FILE, 'utf8')
    assert.match(source, /@media \(prefers-color-scheme: dark\)/u, '缺系统暗色')
    assert.match(source, /\[data-theme="dark"\]/u, '缺宿主强制暗色')
    assert.match(source, /@media \(max-width: 899px\)/u, '缺平板断点')
    assert.match(source, /@media \(max-width: 479px\)/u, '缺手机断点')
    assert.match(source, /prefers-reduced-motion/u, '缺动效降级')
  })

  it('组件与页面不写字面色值（唯一例外：tokens.ts 与二维码白底）', () => {
    const offenders = []
    for (const file of SCOPED_FILES) {
      const text = readFileSync(file, 'utf8')
      if (text.includes('getUserMedia')) continue
      for (const { line, number } of codeLines(text)) {
        // 二维码必须白底黑模块才能在暗色下被扫到（design-system 允许的唯一例外）。
        const cleaned = line
          .replace(/#FFFFFF\b/giu, '')
          .replace(/#FFFFFF/gu, '')
          .replace(/#000000\b/giu, '')
          .replace(/#fff\b/giu, '')
          .replace(/#000\b/giu, '')
        if (HEX.test(cleaned) || RGB.test(cleaned)) {
          offenders.push(`${file.slice(PATHS.clientSrc.length)}:${number}: ${line.trim()}`)
        }
      }
    }
    assert.deepEqual(offenders, [], `发现写死色值，请改用 var(--rh-*)：\n${offenders.join('\n')}`)
  })

  it('不再定义非 --rh-* 的 CSS 变量（--dsw-* 只能作为 token 内的 fallback 引用）', () => {
    const offenders = []
    for (const file of SCOPED_FILES) {
      const text = readFileSync(file, 'utf8')
      for (const { line, number } of codeLines(text)) {
        // 变量定义（`--x:`），排除 CSS 自定义属性的读取 `var(--x)`。
        const declarations = [...line.matchAll(/(^|[;{\s])--([a-zA-Z0-9-]+)\s*:/gu)]
        for (const match of declarations) {
          if (match[2].startsWith('rh-')) continue
          offenders.push(`${file.slice(PATHS.clientSrc.length)}:${number}: ${line.trim()}`)
        }
      }
    }
    assert.deepEqual(offenders, [], `只能定义 --rh-* 变量：\n${offenders.join('\n')}`)
  })

  it('不写非标准字号（font-size 只能是 token 或允许的固定值）', () => {
    const allowed = new Set([
      'var(--rh-fs-h1)', 'var(--rh-fs-h2)', 'var(--rh-fs-h3)', 'var(--rh-fs-label)',
      'var(--rh-fs-body)', 'var(--rh-fs-mono)', 'var(--rh-fs-stat)',
      // design-system §2.3 / §6.2 里明确写死的三处：验证码大号、图标尺寸、继承。
      '20px', 'inherit', '32px',
    ])
    const offenders = []
    for (const file of SCOPED_FILES) {
      const text = readFileSync(file, 'utf8')
      for (const { line, number } of codeLines(text)) {
        for (const match of line.matchAll(/fontSize:\s*'([^']+)'/gu)) {
          const value = match[1].trim()
          if (!allowed.has(value)) offenders.push(`${file.slice(PATHS.clientSrc.length)}:${number}: fontSize: ${value}`)
        }
      }
    }
    assert.deepEqual(offenders, [], `非标准字号：\n${offenders.join('\n')}`)
  })

  it('样式类名统一 rh- 前缀（允许组件后缀 is-online / is-primary 这类状态修饰）', () => {
    const offenders = []
    for (const file of SCOPED_FILES) {
      const text = readFileSync(file, 'utf8')
      for (const { line, number } of codeLines(text)) {
        for (const match of line.matchAll(/className:\s*'([^']+)'/gu)) {
          for (const name of match[1].split(/\s+/u).filter(Boolean)) {
            if (name.startsWith('rh-') || name.startsWith('is-')) continue
            offenders.push(`${file.slice(PATHS.clientSrc.length)}:${number}: ${name}`)
          }
        }
      }
    }
    assert.deepEqual(offenders, [], `类名必须 rh- 前缀：\n${offenders.join('\n')}`)
  })
})
