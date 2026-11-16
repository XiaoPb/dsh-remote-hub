/**
 * 国际化工具层：语言检测 + 双语字典 + t() 翻译函数。
 *
 * 设计原则：
 * - **零依赖**：不引入 i18n 库，仅用一个轻量 t(key) 函数；
 * - **语言检测**：优先 `<html lang>` → `navigator.language` → 默认 `zh-CN`；
 * - **字典单一来源**：zh-CN 为权威源，en 为对照翻译；
 * - **回退**：key 不存在时回退到 key 本身（不报错）。
 *
 * @module dsh-remote-hub/client/rhui/i18n
 */

import { zhCN, type LocaleKey } from './locales/zh-CN.js'
import { en } from './locales/en.js'

export type { LocaleKey }

/** 支持的语言。 */
export type Locale = 'zh-CN' | 'en'

/** 字典类型：key → 双语文案。 */
export type Dictionaries = Record<Locale, Record<LocaleKey, string>>

/** 完整字典。 */
const DICT: Dictionaries = {
  'zh-CN': zhCN,
  'en': en,
}

/** 检测当前语言。 */
export function detectLocale(): Locale {
  const lang =
    (typeof document !== 'undefined' && document.documentElement?.lang) ||
    (typeof navigator !== 'undefined' && navigator.language) ||
    'zh-CN'
  if (lang.toLowerCase().startsWith('zh')) return 'zh-CN'
  return 'en'
}

/** 当前语言（模块级缓存，通过 setLocale 切换）。 */
let currentLocale: Locale = detectLocale()

/** 获取当前语言。 */
export function getLocale(): Locale {
  return currentLocale
}

/** 切换语言（页面级，不会持久化）。 */
export function setLocale(locale: Locale): void {
  currentLocale = locale
}

/**
 * 翻译函数：key → 当前语言文案。
 *
 * 支持插值：`t('loginSubtitle', { name: 'admin' })` 替换 `{name}`。
 * @param key - 字典 key。
 * @param vars - 插值变量（可选）。
 * @returns 翻译后的字符串。
 */
export function t(key: LocaleKey, vars?: Record<string, string | number>): string {
  const dict = DICT[currentLocale] ?? DICT['zh-CN']
  let text = dict[key] ?? key
  if (vars !== undefined) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value))
    }
  }
  return text
}

/** 类型安全的 key 检查（开发时辅助）。 */
export function localeKeys(): readonly LocaleKey[] {
  return Object.keys(zhCN) as readonly LocaleKey[]
}
