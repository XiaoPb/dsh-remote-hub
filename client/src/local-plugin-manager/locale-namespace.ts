/**
 * 本地插件页的**文案**：字典命名空间 + 面板元数据。
 *
 * ## 为什么要一个独立命名空间
 *
 * 官方页把字典注册在 `pluginManager` 命名空间下（`ctx.locale.bind('pluginManager')`）。本插件改用
 * `remoteHubLocalPlugins`，这样：
 *
 * - 两页各自的字典互不覆盖（即使同一台机器上两页同时存在）；
 * - 宿主语言切换时，本插件只按自己的命名空间取词，不会读到官方页的注册结果。
 *
 * ## 文案来源
 *
 * `lexicon` 就是 vendored 的官方 `locales.ts` 词表（`zh` / `en` / ja / es / fr / de / ru / pt 九种语言），
 * **一条不改**；本文件只补三条与「本地」身份有关的词条（`panel` / `localSubtitle` / `localBadge`），
 * 让侧栏行与页头能说清「这是本机那份」。
 *
 * @module dsh-remote-hub/client/local-plugin-manager/locale-namespace
 */
import type { PluginManagerLocaleKey } from './locales.ts'
import * as lexicon from './locales.ts'

/** 本插件在宿主字典里占用的命名空间。 */
export const LOCAL_PLUGIN_NAMESPACE = 'remoteHubLocalPlugins'

/** 面板在侧栏的行 id（与 `main` key 相同）。 */
export const LOCAL_PANEL_KEY = 'local-plugins'

/** 侧栏行顺序：官方插件 `0`、云端设备 `60`、本地插件 `61`（紧挨云端设备，语义相邻）。 */
export const LOCAL_PANEL_ORDER = 61

/** 只有本地页才需要的补充词条。 */
const EXTRA_COPY = {
  zh: {
    panel: '本地插件',
    localSubtitle: '正在管理本机 DSH 的插件（当前已接管云端设备）',
    localBadge: '本机',
  },
  en: {
    panel: 'Local plugins',
    localSubtitle: 'Managing this machine’s DSH plugins while a cloud device is taken over',
    localBadge: 'Local',
  },
} as const

/** 一种语言的完整词表。 */
export type LocalPluginLexicon = Record<PluginManagerLocaleKey, string> & {
  readonly panel: string
  readonly localSubtitle: string
  readonly localBadge: string
}

/** 支持的语言。 */
const LANGUAGES = ['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt'] as const

/**
 * 把官方词表 + 本地补充词条合成一张完整字典。
 * @param language - 语言代码。
 * @returns 该语言的词表（回退到 en）。
 */
function lexiconFor(language: (typeof LANGUAGES)[number]): LocalPluginLexicon {
  const base = (lexicon as unknown as Record<string, Record<string, string>>)[language]
    ?? (lexicon.en as unknown as Record<string, string>)
  const extra = EXTRA_COPY[language as keyof typeof EXTRA_COPY] ?? EXTRA_COPY.en
  return { ...base, ...extra } as unknown as LocalPluginLexicon
}

/** 九种语言的字典（注册给宿主 `ctx.locale`）。 */
export const dictionaries: Record<string, LocalPluginLexicon> = Object.fromEntries(
  LANGUAGES.map(language => [language, lexiconFor(language)]),
)

/** 注册给宿主的字典对象（`ctx.locale.register(namespace, dictionaries)` 的形状）。 */
export const localeDictionaries = dictionaries as unknown as Record<string, Record<string, string>>

/** 语言命名空间名（与 {@link LOCAL_PLUGIN_NAMESPACE} 同值，供槽位注册的 `locale:` 字段使用）。 */
export const LOCALE_NAMESPACE = LOCAL_PLUGIN_NAMESPACE

/**
 * 取一条词条（宿主字典在注册前也可以直接用，面板标签这类**非渲染期**调用走这里）。
 * @param language - 语言代码（缺省中文）。
 * @param key - 词条。
 * @returns 该语言的文本。
 */
export function copyOf(language: string, key: 'panel' | 'localSubtitle' | 'localBadge'): string {
  const table = dictionaries[language] ?? dictionaries.zh ?? dictionaries.en
  return table === undefined ? key : table[key]
}
