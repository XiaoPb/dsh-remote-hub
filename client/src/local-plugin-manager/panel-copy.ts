/**
 * 文案装配：把本插件的字典注册给宿主，并提供一个「注册前也能用」的取词函数。
 *
 * - `registerDictionaries(ctx)`：在 `remoteHubLocalPlugins` 命名空间下注册九种语言；
 * - `translate(key)`：给侧栏行标签这类**非渲染期**调用用（侧栏拿到的 `label` 是个函数，
 *   会在任意时刻求值，不能依赖 React 的渲染期 `t`）。
 *
 * @module dsh-remote-hub/client/local-plugin-manager/panel-copy
 */
import { LOCALE_NAMESPACE, copyOf, localeDictionaries } from './locale-namespace.ts'

/** 宿主语言服务的最小形状。 */
interface LocaleFace {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
  getSnapshot(): { readonly active: string }
}

/**
 * 注册本插件的字典。
 * @param ctx - 客户端 Context（缺 `locale` 服务时安静跳过：标签会退化为中文）。
 * @returns 撤销注册的函数（宿主不支持时为空函数）。
 */
export function registerDictionaries(ctx: object): () => void {
  const locale = (ctx as { locale?: LocaleFace }).locale
  if (locale === undefined || typeof locale.register !== 'function') return () => {}
  try {
    return locale.register(LOCALE_NAMESPACE, localeDictionaries)
  } catch {
    // 重复注册（热更新）或命名空间被占用：保留已有字典，不阻断面板。
    return () => {}
  }
}

/**
 * 读取当前语言。
 * @param ctx - 客户端 Context。
 * @returns 语言代码（缺省 `zh`）。
 */
export function activeLanguage(ctx: object): string {
  const locale = (ctx as { locale?: LocaleFace }).locale
  try {
    return locale?.getSnapshot().active ?? 'zh'
  } catch {
    return 'zh'
  }
}

/** 面板装配期绑定的语言（侧栏标签是惰性的，注册时记录当时的语言即可）。 */
let boundLanguage = 'zh'

/**
 * 绑定面板语言（装配时调用一次）。
 * @param language - 语言代码。
 */
export function bindLanguage(language: string): void {
  boundLanguage = language
}

/**
 * 取一条本地插件页词条。
 * @param key - `panel`（侧栏行）| `localSubtitle`（页头副标题）| `localBadge`（身份徽标）。
 * @returns 当前语言的文本。
 */
export function translate(key: 'panel' | 'localSubtitle' | 'localBadge'): string {
  return copyOf(boundLanguage, key)
}
