/**
 * 把 vendored 的 CSS Module 文件**镜像**进 tsc 的产物目录，并编译成 JS 模块。
 *
 * ## 为什么需要
 *
 * `*.module.css` 不是 TS 文件，`tsc` 不会把它 emit 到 `.build/client/`。而 `tsdown`（rolldown）在打包
 * `.build/client/client/src/**` 时按**产物目录**解析相对 import，于是 `./Button.module.css` 在那里找不到。
 *
 * ## 为什么编译成 `.mjs` 而不是直接交给 rolldown 的 transform
 *
 * rolldown 1.2 已移除「CSS 打包」的运行时支持：即使我们用 transform 把 `.css` 的**内容**换成 JS，
 * rolldown 仍按文件扩展名把它当 CSS 资源处理并直接报错
 * （`UNSUPPORTED_FEATURE: Bundling CSS is no longer supported`）。而 tsdown 又强制启用了自带的
 * `tsdown:css-guard`（只对 `.css$` 报「请安装 @tsdown/css」），两者叠加使得「在 .css 上做 transform」这条路走不通。
 *
 * 因此这里改成**在产物目录里做等价替换**：
 *
 * 1. 对每个 `x.module.css`，用 `scripts/local-plugin-css.mjs` 编译出 `x.module.css.mjs`
 *    （内容 = `registerStylesheet(id, { classes, text })` + `export default classes`）；
 * 2. 把所有 `.js` 产物里的 `'./x.module.css'` 说明符改写成 `'./x.module.css.mjs'`。
 *
 * 语义与官方（lightningcss + `<style>` 注入）一致：类名映射 + 一次性的样式注入。
 *
 * ## 顺序
 *
 * `scripts/build.mjs`：clean → tsc host → tsc client → **本脚本** → tsc types → tsdown
 *
 * @module scripts/copy-client-css
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { compileCssModule, moduleSource } from './local-plugin-css.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const from = join(root, 'client', 'src')
const to = join(root, '.build', 'client', 'client', 'src')

/** 运行期注册函数的模块说明符（相对被改写的产物文件）。 */
const PRELUDE = '../css-modules.js'

/**
 * 递归列出文件。
 * @param directory - 目录。
 * @returns 绝对路径列表。
 */
function walk(directory) {
  if (!existsSync(directory)) return []
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walk(path))
    else files.push(path)
  }
  return files
}

const buildDir = join(root, '.build', 'client')
if (!existsSync(buildDir)) {
  process.stderr.write('copy-client-css: .build/client is missing; run tsc first\n')
  process.exit(1)
}

// ① 编译每个 *.module.css 成对应的 *.module.css.mjs（放在产物目录，与 .css 同名 + .mjs）。
let compiled = 0
for (const file of walk(from)) {
  if (!file.endsWith('.module.css')) continue
  const target = join(to, relative(from, file))
  mkdirSync(dirname(target), { recursive: true })
  const fileId = file.split(/[\\/]/u).slice(-1)[0]
  const sheet = compileCssModule(readFileSync(file, 'utf8'), fileId)
  const depth = relative(to, dirname(target)).split(/[\\/]/u).filter(part => part !== '').length
  // 编译产物放在被编译样式表**同一目录**（`x.module.css.mjs`）。回来的路径只有两种：
  // `local-plugin-manager/` 顶层的文件用 `./css-modules.js`，`ui/` 之类的下一层用 `../css-modules.js`。
  // rolldown 不接受「先向上越级再向下」的多段相对路径，所以只生成这两种形态。
  const prelude = `${'../'.repeat(Math.max(depth - 1, 0))}${depth > 1 ? '' : './'}css-modules.js`
  writeFileSync(`${target}.mjs`, moduleSource(fileId, sheet, prelude), 'utf8')
  compiled += 1
}

// ② 把产物 JS 里的 `'./x.module.css'` 改写成 `'./x.module.css.mjs'`。
let rewritten = 0
for (const file of walk(to)) {
  if (!file.endsWith('.js') && !file.endsWith('.mjs')) continue
  const source = readFileSync(file, 'utf8')
  const next = source.replace(/(\.module\.css)(?=['"])/gu, '$1.mjs')
  if (next === source) continue
  writeFileSync(file, next, 'utf8')
  rewritten += 1
}

// ③ 把**非 TS 的运行时资源**（ANSI 解析器的 vendored 源码）镜像进产物目录。
//    它们由 vendored UI 直接 `import`，但 tsc 只管 TS 文件，不会 emit。
let assets = 0
for (const asset of ['anser.js']) {
  for (const file of walk(from)) {
    if (!file.endsWith(`/${asset}`) && !file.endsWith(`\\${asset}`)) continue
    const target = join(to, relative(from, file))
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(file, target)
    assets += 1
  }
}

process.stdout.write(`copy-client-css: ${String(compiled)} stylesheets compiled, ${String(rewritten)} modules rewritten, ${String(assets)} assets copied\n`)
if (compiled === 0) {
  process.stderr.write('copy-client-css: no *.module.css found under client/src\n')
  process.exit(1)
}

// 让 `pathToFileURL` 的导入保留给未来扩展（避免未使用告警在部分 lint 配置下报错）。
void pathToFileURL
void statSync
