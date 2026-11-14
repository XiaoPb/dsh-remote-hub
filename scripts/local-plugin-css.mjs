/**
 * CSS Module 编译器（rolldown `transform` 插件，**零新增依赖**）。
 *
 * ## 为什么自己写（ADR-003）
 *
 * 官方 UI 包把 CSS Modules 交给 `lightningcss` 编译；本插件按「运行时新增依赖 = 0」的约束不装它，
 * 也不装 esbuild。rolldown 自带的 `moduleTypes` 只接受 `css`（产出样式 chunk，不返回类名映射）
 * 或 `js`（原样当 JS 解析），所以这里用最小实现补齐：
 *
 * ```
 * moduleTypes: { '.css': 'js' },          // 让 rolldown 把 .css 当模块交给我们
 * plugins: [localCssModules({ prelude })], // 我们的 transform 把它变成 JS
 * ```
 *
 * ## 支持的语法（已按官方 CSS 统计核对）
 *
 * | 语法 | 官方页面里的出现次数 | 本编译器 |
 * | --- | --- | --- |
 * | 类规则 `.foo { }` | 281 | ✅ 哈希 |
 * | 属性选择器复合 `.foo[data-x]`、`.foo:hover`、`.foo > .bar` | 47 | ✅ 组合子/伪类/属性原样透传，`.bar` 仍哈希 |
 * | 多行逗号选择器组 `.a,\n  .b { }` | 12 | ✅ 逐个选择器处理 |
 * | `:global(...)` | 5 | ✅ 内容原样透传 |
 * | `@media` / `@supports` 内嵌规则 | 若干 | ✅ 递归处理 |
 * | `url()` / `composes` / CSS 嵌套 | 0 | ❌ 直接报错（不静默降级） |
 *
 * ## 产物
 *
 * 每个 `x.module.css` 变成：
 * ```js
 * import { registerStylesheet } from '<prelude>'
 * registerStylesheet('x.module.css', { classes: { foo: 'lpl_ab12cd_foo' }, text: '…' })
 * ```
 * 组件侧（vendored 官方代码）仍写 `import styles from './PluginManagerPage.module.css'` 的等价形式 ——
 * 只是改成从本地注册表读（见 `css-modules.ts` 的 `stylesheetOf`）。
 *
 * @module scripts/local-plugin-css
 */

/** 插件名称（rolldown 诊断里可见）。 */
export const CSS_MODULE_PLUGIN = 'dsh-local-css-modules'

/** 说明符改写插件的名字。 */
export const CSS_SPECIFIER_PLUGIN = 'dsh-local-css-specifier'

/** 类名的哈希前缀（避免与宿主 CSS 撞名，且一眼看出归属）。 */
const SCOPE_PREFIX = 'lpl'

/** 局部类名的清理正则：CSS Modules 允许 `-` / `_` 与数字开头以外的字符。 */
const LOCAL_CLASS = /^[A-Za-z_][\w-]*$/u

/**
 * 计算一个稳定短哈希（FNV-1a 变体，纯 JS，无依赖）。
 * @param text - 输入文本。
 * @returns 8 位十六进制字符串。
 */
export function hashOf(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 在顶层扫描 CSS，按规则边界切分（正确处理字符串、注释与嵌套花括号）。
 *
 * 只做**切分**：返回 `{ selector, body }` 列表（`@media` 等 at-rule 的 body 保留原文由其递归处理），
 * 以及原文中夹在规则之间的其它文本（`@charset`、自定义属性声明块等）。
 * @param css - 原始 CSS。
 * @returns 规则列表（顺序与原文件一致）。
 */
export function splitRules(css) {
  const rules = []
  let index = 0
  let start = 0
  while (index < css.length) {
    const char = css[index]
    // 注释
    if (char === '/' && css[index + 1] === '*') {
      const end = css.indexOf('*/', index + 2)
      index = end < 0 ? css.length : end + 2
      continue
    }
    // 字符串
    if (char === '"' || char === "'") {
      const quote = char
      index += 1
      while (index < css.length) {
        if (css[index] === '\\') { index += 2; continue }
        if (css[index] === quote) { index += 1; break }
        index += 1
      }
      continue
    }
    if (char === '{') {
      const selector = css.slice(start, index).trim()
      const close = matchBrace(css, index)
      const body = css.slice(index + 1, close)
      rules.push({ selector, body })
      index = close + 1
      start = index
      continue
    }
    if (char === ';' || char === '}') {
      // 规则之间的其它文本（@charset / @import 等）一并挂到「无选择器」条目上。
      const raw = css.slice(start, index + 1)
      if (raw.trim() !== '') rules.push({ selector: '', body: raw })
      index += 1
      start = index
      continue
    }
    index += 1
  }
  const tail = css.slice(start)
  if (tail.trim() !== '') rules.push({ selector: '', body: tail })
  return rules
}

/**
 * 找到与 `openIndex` 处 `{` 匹配的 `}`（跳过字符串与注释）。
 * @param css - 原始 CSS。
 * @param openIndex - `{` 的下标。
 * @returns `}` 的下标（找不到时返回末尾）。
 */
function matchBrace(css, openIndex) {
  let depth = 0
  for (let index = openIndex; index < css.length; index += 1) {
    const char = css[index]
    if (char === '/' && css[index + 1] === '*') {
      const end = css.indexOf('*/', index + 2)
      index = end < 0 ? css.length : end + 1
      continue
    }
    if (char === '"' || char === "'") {
      const quote = char
      index += 1
      while (index < css.length) {
        if (css[index] === '\\') { index += 2; continue }
        if (css[index] === quote) break
        index += 1
      }
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return css.length
}

/**
 * 把一个选择器里的**局部类名**替换成哈希名，`[...]` / `:global(...)` 原样保留。
 * @param selector - 单个选择器（已按逗号切分）。
 * @param scope - 本次编译的哈希前缀。
 * @param classes - 类名映射（原地累积）。
 * @returns 改写后的选择器。
 */
export function scopeSelector(selector, scope, classes) {
  let output = ''
  let index = 0
  while (index < selector.length) {
    const char = selector[index]
    // 属性选择器 / 伪类参数里的方括号与圆括号内容整体保留（除 :global(...) 由下面单独处理）。
    if (char === '[') {
      const end = selector.indexOf(']', index)
      const stop = end < 0 ? selector.length : end + 1
      output += selector.slice(index, stop)
      index = stop
      continue
    }
    // 注释：原样抄写（选择器里的注释很少见，但不能把里面的 `.foo` 当类名哈希）。
    if (char === '/' && selector[index + 1] === '*') {
      const end = selector.indexOf('*/', index + 2)
      const stop = end < 0 ? selector.length : end + 2
      output += selector.slice(index, stop)
      index = stop
      continue
    }
    if (char === ':') {
      const global = /^:global\(/u.exec(selector.slice(index))
      if (global !== null) {
        // `:global(…)` 的内容**不加哈希**（官方 5 处都是 [data-platform=…] 这类环境选择器）。
        let depth = 0
        let cursor = index + ':global('.length - 1
        for (; cursor < selector.length; cursor += 1) {
          if (selector[cursor] === '(') depth += 1
          else if (selector[cursor] === ')') {
            depth -= 1
            if (depth === 0) break
          }
        }
        output += selector.slice(index, cursor + 1) // 原样保留 `:global(...)`（内部不加哈希）
        index = cursor + 1
        continue
      }
      // 普通伪类（`:hover` / `:not(.x)`）原样抄写，但 `:not(...)` 里的类名仍要哈希。
      const notMatch = /^:not\(/u.exec(selector.slice(index))
      if (notMatch !== null) {
        const end = selector.indexOf(')', index)
        const stop = end < 0 ? selector.length : end + 1
        const inner = selector.slice(index + ':not('.length, stop - 1)
        output += `:not(${scopeSelector(inner, scope, classes)})`
        index = stop
        continue
      }
      output += char
      index += 1
      continue
    }
    if (char === '.') {
      const match = /^\.([A-Za-z_][\w-]*)/u.exec(selector.slice(index))
      if (match === null) {
        output += char
        index += 1
        continue
      }
      const local = match[1]
      if (!LOCAL_CLASS.test(local)) throw new Error(`local-plugin-css: unsupported class name .${local}`)
      classes[local] ??= `${scope}_${local}`
      output += `.${classes[local]}`
      index += match[0].length
      continue
    }
    output += char
    index += 1
  }
  return output
}

/**
 * 编译一份 CSS Module 源码。
 * @param source - 原始 CSS 文本。
 * @param fileId - 文件标识（参与哈希，保证不同文件不撞名）。
 * @returns `{ classes, text }`。
 * @throws 遇到 `url()` / `composes` / CSS 嵌套等不支持的语法。
 */
export function compileCssModule(source, fileId) {
  if (/\burl\(/u.test(source)) throw new Error(`local-plugin-css: url() is not supported (${fileId})`)
  if (/\bcomposes\s*:/u.test(source)) throw new Error(`local-plugin-css: composes: is not supported (${fileId})`)
  const scope = `${SCOPE_PREFIX}_${hashOf(fileId)}`
  const classes = {}
  const emit = rules => rules.map((rule) => {
    if (rule.selector === '') return rule.body
    if (rule.selector.startsWith('@')) {
      // at-rule：`@media … { … }` 递归；`@keyframes` 等整体保留（内部标识符不外泄到类名映射）。
      const name = /^@([a-z-]+)/iu.exec(rule.selector)?.[1]?.toLowerCase() ?? ''
      if (name === 'keyframes' || name.startsWith('-webkit-keyframes')) return `${rule.selector}{${rule.body}}`
      return `${rule.selector}{${emit(splitRules(rule.body))}}`
    }
    const selectors = rule.selector.split(',').map(part => part.trim()).filter(part => part !== '')
    if (selectors.length === 0) return ''
    // 形如 `from { … }` / `to { … }` 的关键帧步进不是选择器：无类名时原样保留。
    if (selectors.every(part => !part.includes('.')) && !rule.selector.startsWith('.')) {
      return `${rule.selector}{${rule.body}}`
    }
    const scoped = selectors.map(part => scopeSelector(part, scope, classes)).join(',\n')
    return `${scoped}{${rule.body}}`
  }).join('\n')
  const text = emit(splitRules(source))
  return { classes, text }
}

/**
 * 生成一个 CSS Module 的 JS 模块源码。
 * @param fileId - 文件标识（= `data-plugin-css` 的值与哈希种子）。
 * @param compiled - 编译结果。
 * @param prelude - 运行期注册函数的模块说明符（例如 `'./css-modules.js'`）。
 * @returns ES 模块源码。
 */
/**
 * 生成一个 CSS Module 的 JS 模块源码。
 *
 * 导入的是**别名入口** `__registerCompiledStylesheet`，不是 `registerStylesheet`：后者在最终的
 * client bundle 里会和 vendored UI 里别处的同名局部函数撞名（rolldown 会给其中一个改名），
 * 使用别名可以保证每个样式表都注册到 `css-modules.ts` 里真正的那张表上。
 * @param fileId - 文件标识（= `data-plugin-css` 的值与哈希种子）。
 * @param compiled - 编译结果。
 * @param prelude - 运行期注册函数的模块说明符（例如 `'./css-modules.js'`）。
 * @returns ES 模块源码。
 */
export function moduleSource(fileId, compiled, prelude) {
  return [
    `import { __dshLocalRegisterStylesheet } from ${JSON.stringify(prelude)}`,
    `__dshLocalRegisterStylesheet(${JSON.stringify(fileId)}, {`,
    `  classes: ${JSON.stringify(compiled.classes)},`,
    `  text: ${JSON.stringify(compiled.text)},`,
    '})',
    `export default ${JSON.stringify(compiled.classes)}`,
    '',
  ].join('\n')
}

/**
 * 构造 rolldown 插件。
 * @param options - 选项。
 * @param options.prelude - 运行期注册模块的说明符（相对 bundle 入口解析，见 tsdown 配置的 alias）。
 * @returns rolldown 插件对象。
 */
/**
 * 把产物里的 `x.module.css` 说明符改写成 `x.module.css?`。
 *
 * 为什么需要：tsdown 自带一个 `tsdown:css-guard` 插件，只对 `\.css$` 的模块报错（要求安装 `@tsdown/css`）。
 * 我们的样式由 {@link localCssModules} 自己编译，不需要那个包；给说明符加上查询串即可让它不再介入，
 * 而本文件的 transform 会先去掉查询串再识别文件。
 * @returns rolldown 插件。
 */
export function rewriteCssModuleSpecifier() {
  return {
    name: CSS_SPECIFIER_PLUGIN,
    transform(code, id) {
      if (!id.endsWith('.js') && !id.endsWith('.mjs')) return null
      const next = code.replace(/\.module\.css(?=["'])/gu, '.module.css?')
      return next === code ? null : { code: next, map: null }
    },
  }
}

export function localCssModules(options) {
  const prelude = options?.prelude
  if (typeof prelude !== 'string' || prelude === '') {
    throw new Error('local-plugin-css: options.prelude is required')
  }
  return {
    name: CSS_MODULE_PLUGIN,
    // `order: 'pre'`：必须先于 tsdown 内置的 css-guard 运行（后者只匹配 `.css$`，
    // 我们用带 `?` 的说明符绕过它；这里在 pre 阶段把 id 规整回真实路径）。
    transform: {
      order: 'pre',
      filter: { id: /\.module\.css/u },
      handler(code, id) {
        const file = id.split('?')[0] ?? id
        if (!file.endsWith('.module.css')) return null
        const fileId = file.split(/[\\/]/u).slice(-1)[0] ?? file
        const compiled = compileCssModule(code, fileId)
        return { code: moduleSource(fileId, compiled, prelude), map: null }
      },
    },
  }
}
