/**
 * CSS Module 编译器测试（`scripts/local-plugin-css.mjs`）。
 *
 * 这是「样式照搬官方页」的地基：页面组件用 `css.foo` 读类名，类名映射或作用域错了，
 * 本地页的布局就会与官方页不一致。因此这里既测语法（属性选择器 / 多维选择器 / `:global` /
 * `@media` / `@container` / `@keyframes`），也用**官方 CSS 原文**做真实覆盖。
 *
 * @module test/local-plugin-css
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { compileCssModule, hashOf, localCssModules, moduleSource, splitRules } from '../scripts/local-plugin-css.mjs'
import { PATHS } from './_helpers.mjs'

const STYLESHEET = `${PATHS.clientSrc}/local-plugin-manager/PluginManagerPage.module.css`
const PAGE = `${PATHS.clientSrc}/local-plugin-manager/PluginManagerPage.tsx`

const officialCss = () => readFileSync(STYLESHEET, 'utf8')

test('哈希稳定且确定性', () => {
  assert.equal(hashOf('a'), hashOf('a'))
  assert.notEqual(hashOf('a'), hashOf('b'))
  assert.match(hashOf('a'), /^[0-9a-f]{8}$/u)
})

test('类名被作用域化，`.foo[data-x]` 的属性选择器保持原样', () => {
  const compiled = compileCssModule('.foo[aria-invalid="true"] { color: red }', 'x.module.css')
  assert.deepEqual(Object.keys(compiled.classes), ['foo'])
  assert.match(compiled.text, /\.lpl_[0-9a-f]+_foo\[aria-invalid="true"\]\{ color: red \}/u)
})

test('多行逗号选择器组逐个作用域化', () => {
  const compiled = compileCssModule('.a,\n  .b { margin: 0 }', 'x.module.css')
  assert.deepEqual(Object.keys(compiled.classes).sort(), ['a', 'b'])
  assert.match(compiled.text, /\.lpl_[0-9a-f]+_a,\n\.lpl_[0-9a-f]+_b\{ margin: 0 \}/u)
})

test(':global(...) 前缀原样透传，其后的局部类名仍被作用域化', () => {
  const compiled = compileCssModule(":global([data-platform='darwin']) .head { color: red }", 'x.module.css')
  assert.match(compiled.text, /^:global\(\[data-platform='darwin'\]\) \.lpl_[0-9a-f]+_head\{/u)
})

test(':not(.x) 内的类名同样被作用域化', () => {
  const compiled = compileCssModule('.a:not(.b) { color: red }', 'x.module.css')
  assert.match(compiled.text, /\.lpl_[0-9a-f]+_a:not\(\.lpl_[0-9a-f]+_b\)/u)
})

test('@media / @container 递归编译，@keyframes 整体保留', () => {
  const source = [
    '@media (max-width: 767px) { .page { padding: 0 } }',
    '@container card (width < 600px) { .bar .head { align-items: center } }',
    '@keyframes dsh-x { from { opacity: 0 } to { opacity: 1 } }',
  ].join('\n')
  const compiled = compileCssModule(source, 'x.module.css')
  assert.match(compiled.text, /@media \(max-width: 767px\)\{\.lpl_[0-9a-f]+_page\{/u)
  assert.match(compiled.text, /@container card \(width < 600px\)\{\.lpl_[0-9a-f]+_bar \.lpl_[0-9a-f]+_head\{/u)
  assert.match(compiled.text, /@keyframes dsh-x\{ from \{ opacity: 0 \} to \{ opacity: 1 \} \}/u)
})

test('注释里的 .foo 不被当成类名', () => {
  const compiled = compileCssModule('.a { /* .b is not a class here */ color: red }', 'x.module.css')
  assert.deepEqual(Object.keys(compiled.classes), ['a'])
})

test('不支持的语法直接报错（不静默降级）', () => {
  assert.throws(() => compileCssModule('.a { background: url(x.png) }', 'x.module.css'), /url\(\)/u)
  assert.throws(() => compileCssModule('.a { composes: b }', 'x.module.css'), /composes/u)
})

test('splitRules 处理字符串与嵌套花括号', () => {
  const rules = splitRules('.a { content: "}" } .b { color: red }')
  assert.equal(rules.length, 2)
  assert.equal(rules[0].selector, '.a')
  assert.equal(rules[1].selector, '.b')
})

test('moduleSource 产出可执行的注册代码', () => {
  const compiled = compileCssModule('.a { color: red }', 'x.module.css')
  const source = moduleSource('x.module.css', compiled, './css-modules.js')
  assert.match(source, /^import \{ __dshLocalRegisterStylesheet \} from "\.\/css-modules\.js"/u)
  assert.match(source, /__dshLocalRegisterStylesheet\("x\.module\.css"/u)
  assert.match(source, /export default/u)
  assert.doesNotThrow(() => { new Function(source.replace(/^import .*$/mu, '').replace(/export default/u, 'return')) })
})

test('插件只处理 *.module.css，并要求 prelude', () => {
  assert.throws(() => localCssModules({}), /prelude is required/u)
  const plugin = localCssModules({ prelude: './css-modules.js' })
  // transform 以 `{ order: 'pre', filter, handler }` 形式注册（rolldown 的新插件 API）。
  assert.equal(typeof plugin.transform.handler, 'function')
  assert.equal(plugin.transform.order, 'pre')
  assert.equal(plugin.transform.handler('.a{color:red}', 'plain.css'), null)
  const out = plugin.transform.handler('.a{color:red}', '/abs/x.module.css?probe')
  assert.match(out.code, /__dshLocalRegisterStylesheet\("x\.module\.css"/u)
})

// ── 真实覆盖：官方样式表 ────────────────────────────────────────────────────────

test('官方样式表：每个声明的类都进了映射，页面用到的 css.* 全部命中', () => {
  const compiled = compileCssModule(officialCss(), 'PluginManagerPage.module.css')
  assert.ok(Object.keys(compiled.classes).length > 150, 'official stylesheet must yield many classes')
  const page = readFileSync(PAGE, 'utf8')
  const used = new Set([...page.matchAll(/css\.([A-Za-z_][\w-]*)/gu)].map(match => match[1]))
  assert.ok(used.size > 100, 'the page must reference many module classes')
  const missing = [...used].filter(name => !(name in compiled.classes))
  assert.deepEqual(missing, [], `classes referenced by the page but missing from the map: ${missing.join(', ')}`)
})

test('官方样式表：输出里没有未作用域的局部类选择器', () => {
  const compiled = compileCssModule(officialCss(), 'PluginManagerPage.module.css')
  const unscoped = compiled.text.split('\n').filter(line => /^\.[A-Za-z_]/u.test(line) && !/^\.lpl_/u.test(line))
  assert.deepEqual(unscoped, [], `unscoped selector lines: ${unscoped.slice(0, 3).join(' | ')}`)
})

test('官方样式表：5 处 :global 环境选择器全部保留', () => {
  const compiled = compileCssModule(officialCss(), 'PluginManagerPage.module.css')
  const kept = compiled.text.match(/\[data-platform='darwin'\]/gu) ?? []
  assert.equal(kept.length, 5)
  const collapsed = compiled.text.match(/\[data-sidebar-collapsed\]/gu) ?? []
  assert.equal(collapsed.length, 1)
})

test('官方样式表：哈希与文件标识绑定（不同文件不撞名）', () => {
  const a = compileCssModule('.page{color:red}', 'a.module.css')
  const b = compileCssModule('.page{color:red}', 'b.module.css')
  assert.notEqual(a.classes.page, b.classes.page)
})

test('样式表标识必须是 x.module.css（构建产物名带 .mjs，但注册名不能带）', () => {
  // 2026-11-14 沙箱实测：若注册名带 `.mjs`，面板的 installStylesheet('X.module.css') 永远取不到表，
  // 一条样式都不注入，按钮退化成原生控件。
  const compiled = compileCssModule('.a{color:red}', 'Button.module.css')
  const source = moduleSource('Button.module.css.mjs', compiled, './css-modules.js')
  assert.match(source, /__dshLocalRegisterStylesheet\("Button\.module\.css",/u)
  assert.ok(!source.includes('.css.mjs"'), 'the registered id must not carry the artifact suffix')
})

test('真实 client bundle 里的每一张样式表都以 x.module.css 注册', () => {
  const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const ids = [...new Set([...bundle.matchAll(/__dshLocalRegisterStylesheet\("([^"]+)"/gu)].map(match => match[1]))]
  assert.ok(ids.length > 0, 'the bundle must carry compiled stylesheets')
  for (const id of ids) {
    assert.match(id, /\.module\.css$/u, `stylesheet id must be x.module.css, got ${id}`)
  }
})

test('面板声明的样式表清单与 bundle 实际注册的完全一致', () => {
  // 少一张 → 对应控件退回浏览器原生外观；多一张 → 运行期 warn（说明清单漂移了）。
  const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const registered = [...new Set([...bundle.matchAll(/__dshLocalRegisterStylesheet\("([^"]+)"/gu)].map(m => m[1]))].sort()
  const panel = readFileSync(new URL('../client/src/local-plugin-manager/panel.ts', import.meta.url), 'utf8')
  const declared = [...panel.matchAll(/^ {2}'([A-Za-z]+\.module\.css)',$/gmu)].map(m => m[1]).sort()
  assert.deepEqual(declared, registered)
})

test('面板挂载时注入全部 vendored 样式表，卸载时全部移除', () => {
  // 2026-11-14 实机：只注入主页面那张 → 所有原子组件退回浏览器原生外观（按钮就是原生 <button>）。
  const panel = readFileSync(new URL('../client/src/local-plugin-manager/panel.ts', import.meta.url), 'utf8')
  assert.match(panel, /for \(const id of STYLESHEET_IDS\)/u, 'mount must loop over every sheet')
  assert.match(panel, /installStylesheet\(id\)/u, 'each sheet must be installed')
  assert.match(panel, /for \(const id of installed\) removeStylesheet\(id\)/u, 'dispose must remove what it installed')
  assert.ok(!/^\s*installStylesheet\(STYLESHEET_ID\)/mu.test(panel), 'the single-sheet path must be gone')
})
