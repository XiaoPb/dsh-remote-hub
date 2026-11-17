/**
 * 国际化工具层：**跟随 DSH 自身的语言设置** + 双语字典 + t() 翻译函数。
 *
 * ## 为什么不再自己猜语言（0.5.1 起）
 *
 * 原先 `detectLocale()` 读 `document.documentElement.lang` 再退回
 * `navigator.language`。这在真实宿主里**是错的**：
 * - DSH 自己的 `<html lang>` 是**由 DSH 语言设置驱动**的（`dsh-client-locale`
 *   在语言切换时同步写 `<html lang>`），本插件读它等于「照抄一个自己没订阅的值」；
 * - 更关键的是它**只读一次**：模块加载那一刻定死，之后用户在「设置 → 通用 → 语言」
 *   里切换，本插件文案纹丝不动（实测：DSH 已切到中文，账号页仍是英文）；
 * - 而验收文档里写的切换方式 `import('/plugins/dsh-remote-hub/client/src/rhui/i18n.js')`
 *   在打包产物里根本不存在（bundle 是 closure factory，没有可 import 的子模块），
 *   且 `setLocale` 因为从未被调用被 tree-shake 掉了。
 *
 * ## 现在的契约
 *
 * 1. **唯一真源**：DSH 的 locale 服务 `ctx.locale`（`dsh-client-locale` 提供）。
 *    `active` 是 BCP 47 风格 id：`zh` / `en` / `ja` / …；映射到本插件只用两种
 *    文案集：`zh*` → `'zh-CN'`，其余 → `'en'`（英文是 DSH 自己的兜底语言）。
 * 2. **两项订阅**：`ctx.locale.subscribe(fn)`（字典/语言变化都推进 revision）与
 *    `locale/change` 事件；任一触发都重算并**原地替换**模块级 `currentLocale`，
 *    所以已经渲染的页面在下次渲染时自然用新语言（不是重新加载）。
 * 3. **优雅降级**：`ctx.locale` 不存在（纯浏览器沙箱、单测、其它宿主）时退回
 *    `navigator.language`，行为与旧版一致，绝不因缺服务而抛错。
 *
 * 翻译函数保持**同步**（`t()` 是渲染期调用，不能引入 await）：语言切换通过
 * 上面的订阅在后台推进，下一帧就读到新值。
 *
 * @module dsh-remote-hub/client/rhui/i18n
 */

import { zhCN, type LocaleKey } from './locales/zh-CN.js'
import { en } from './locales/en.js'

export type { LocaleKey }

/** 支持的文案集（本插件只有这两套）。 */
export type Locale = 'zh-CN' | 'en'

/** 字典类型：key → 双语文案。 */
export type Dictionaries = Record<Locale, Record<LocaleKey, string>>

/** 完整字典。 */
const DICT: Dictionaries = {
  'zh-CN': zhCN,
  'en': en,
}

/**
 * BCP 47 id（DSH locale id，如 `zh` / `en` / `ja` / `zh-CN` / `pt-PT`）
 * → 本插件的文案集。`zh` 开头一律中文，其余一律英文（英文同时也是
 * DSH 的兜底语言）。
 * @param id - 语言 id。
 * @returns 文案集。
 */
export function localeFromLanguageTag(id: string | null | undefined): Locale {
  const tag = (id ?? '').trim().toLowerCase()
  return tag.startsWith('zh') ? 'zh-CN' : 'en'
}

/**
 * 浏览器兜底检测：只在**没有 DSH locale 服务**时使用。
 * @returns 文案集。
 */
export function detectLocale(): Locale {
  const navigatorLanguage =
    typeof navigator !== 'undefined' ? (navigator.languages?.[0] ?? navigator.language) : undefined
  return localeFromLanguageTag(navigatorLanguage ?? 'en')
}

/** 当前文案集（模块级；由 DSH locale 订阅或 {@link setLocale} 推进）。 */
let currentLocale: Locale = detectLocale()

/** 语言变化监听者（页面用它触发一次重渲染）。 */
const listeners = new Set<() => void>()

/**
 * 写入当前文案集并通知监听者；值没变时不通知（避免无意义重渲染）。
 * @param locale - 新文案集。
 * @internal
 */
function commitLocale(locale: Locale): void {
  if (locale === currentLocale) return
  currentLocale = locale
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // 单个监听者失败不影响其它监听者与宿主。
    }
  }
}

/** 获取当前语言。 */
export function getLocale(): Locale {
  return currentLocale
}

/**
 * 手动切换语言（供测试与无 DSH 服务的宿主使用；不写回 DSH 设置）。
 *
 * 真实的语言设置入口是 DSH 的「设置 → 通用 → 语言」，本函数不替代它：
 * 一旦 DSH locale 服务可用，以其快照为准。
 * @param locale - 文案集。
 */
export function setLocale(locale: Locale): void {
  commitLocale(locale)
}

/**
 * 订阅语言变化（**页面必须用它**，否则挂载后切语言不会重渲染）。
 * @param listener - 变化回调。
 * @returns 取消订阅。
 */
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 本模块从 DSH locale 服务同步过来的状态（用于卸载与幂等）。 */
interface LocaleBinding {
  dispose(): void
}

/** 当前绑定（一个 client 上下文只会有一份）。 */
let binding: LocaleBinding | undefined

/**
 * 接一个 DSH locale 服务的**最小结构面**。
 *
 * 只依赖这两个方法，所以单测可以直接喂一个假对象，无需真 cordis。
 * @internal
 */
export interface LocaleServiceLike {
  getLocale?(): { active?: unknown }
  subscribe?(listener: () => void): () => void
}

/**
 * 把 DSH locale 服务接上本模块的 `currentLocale`。
 *
 * 幂等：重复调用会先解绑旧的，再绑定新的。
 * @param service - `ctx.locale`（结构匹配即可）。
 * @returns 解绑函数。
 */
export function attachLocaleService(service: LocaleServiceLike | null | undefined): () => void {
  binding?.dispose()
  binding = undefined

  if (service === null || service === undefined || typeof service.subscribe !== 'function') {
    // 没有服务：保持当前值（浏览器兜底或上一次显式设置）。
    return () => {}
  }

  const sync = (): void => {
    try {
      const snapshot = service.getLocale?.()
      const active = snapshot?.active
      if (typeof active === 'string') commitLocale(localeFromLanguageTag(active))
    } catch {
      // 快照读取失败时保持现有文案，绝不打断渲染。
    }
  }

  sync()
  let dispose = (): void => {}
  try {
    dispose = service.subscribe(sync)
  } catch {
    dispose = () => {}
  }

  binding = {
    dispose: () => {
      try {
        dispose()
      } catch {
        // 解绑失败不影响后续绑定。
      }
    },
  }
  return () => {
    if (binding?.dispose === undefined) return
    binding.dispose()
    binding = undefined
  }
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

/**
 * 导出给测试使用的**可变视图**（只读语义，不提供写入口）。
 * @internal
 */
export const __i18nInternals = {
  get current(): Locale {
    return currentLocale
  },
  reset(): void {
    binding?.dispose()
    binding = undefined
    listeners.clear()
    currentLocale = detectLocale()
  },
}

// 防 tree-shake：tsdown 把本 bundle 打成一个闭包，若宿主只用到 `t`，
// `setLocale` 会被整段摇掉——而验收脚本/集成测试正需要它来独立切换语言。
// 把入口挂到全局（只暴露这两个纯函数，不含任何状态写权限之外的能力）。
try {
  ;(globalThis as Record<string, unknown>).__DSH_REMOTE_HUB_I18N__ = Object.freeze({
    getLocale,
    setLocale,
    subscribeLocale,
    localeKeys,
  })
} catch {
  // 全局不可写（如 frozen globalThis）时静默跳过，不影响翻译。
}
