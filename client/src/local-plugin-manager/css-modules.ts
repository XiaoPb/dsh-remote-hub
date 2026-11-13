/**
 * CSS Module 的 TypeScript 声明（vendored 副本保持与官方一致）。
 *
 * ### 为什么不能照官方那样"静态编译进 bundle"
 *
 * 官方 UI 包用 `@deepseek-ai/dsh-client-ui-primitives` 的 `tsdown.client.ts`，它内置了 **lightningcss**，
 * 把 `x.module.css` 编译成「类名映射 + 一个 `<style>` 注入器」。本插件按 ADR-003 的要求**不引入新依赖**
 * （lightningcss / esbuild 都不装），所以改由 `scripts/local-plugin-css.mjs` —— 一个 ~120 行的
 * rolldown `transform` 插件 —— 做同一件事：
 *
 * - 编译期把 `PluginManagerPage.module.css` 转成 `__cssModule` 对象 + `__cssText` 字符串；
 * - 运行期由 `installStylesheet()` 把 `__cssText` 插进一个 `<style data-plugin-css="…">` 标签（只插一次）。
 *
 * 也就是说：**组件代码完全照搬官方**，唯一的改动是样式对象来自本地注册表而不是模块默认导出。
 *
 * @module dsh-remote-hub/client/local-plugin-manager/css-modules
 */

/**
 * 一个已编译的 CSS Module：类名 → 哈希后的类名，外加编译后的样式文本。
 */
export interface CompiledStylesheet {
  /** 类名映射（组件里 `css.foo` 读它）。 */
  readonly classes: Readonly<Record<string, string>>
  /** 编译后的 CSS 文本（作用域已被哈希，`:global()` 原样透传）。 */
  readonly text: string
}

/** 已注册的样式表（键 = 注入器里的 `data-plugin-css` 值）。 */
const stylesheets = new Map<string, CompiledStylesheet>()

/**
 * 注册一张编译好的样式表。
 *
 * 由 CSS 插件在编译期改写出来的模块调用（见 `scripts/local-plugin-css.mjs` 的 `prelude`）。
 * @param id - 样式表标识（同一份 CSS 在多次 import 下保持稳定）。
 * @param sheet - 编译结果。
 */
export function registerStylesheet(id: string, sheet: CompiledStylesheet): void {
  stylesheets.set(id, sheet)
}

/**
 * 读取一张已注册的样式表。
 * @param id - 样式表标识。
 * @returns 编译结果。
 */
export function stylesheetOf(id: string): CompiledStylesheet {
  const sheet = stylesheets.get(id)
  if (sheet === undefined) throw new Error(`local-plugin-manager: stylesheet ${id} was not compiled into the bundle`)
  return sheet
}

/**
 * 把一张样式表插入文档（幂等：同一个 `data-plugin-css` 只插一次）。
 *
 * 与官方 `styleInjectionModule()` 的行为一致：`<style data-plugin-css=…>` 挂在 `<head>` 末尾。
 * @param id - 样式表标识（同时是 `data-plugin-css` 的值）。
 */
export function installStylesheet(id: string): void {
  const sheet = stylesheetOf(id)
  if (typeof document === 'undefined') return
  const existing = document.querySelector(`style[data-plugin-css="${id}"]`)
  if (existing !== null) return
  const tag = document.createElement('style')
  tag.dataset.pluginCss = id
  tag.textContent = sheet.text
  document.head.appendChild(tag)
}

/**
 * 移除一张样式表（面板卸载时调用，避免断开接管后留下无用样式）。
 * @param id - 样式表标识。
 */
export function removeStylesheet(id: string): void {
  if (typeof document === 'undefined') return
  for (const tag of document.querySelectorAll(`style[data-plugin-css="${id}"]`)) tag.remove()
}
