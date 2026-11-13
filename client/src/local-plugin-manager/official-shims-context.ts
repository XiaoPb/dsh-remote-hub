/**
 * 从客户端 Context 读取「松耦合」服务（槽位注册表、语言服务）的运行时工具。
 *
 * ## 为什么要单独一个文件
 *
 * 官方 `ui-plugin-manager` 直接写 `localSlots(ctx).entries(...)` / `localLocale(ctx).getSnapshot()` —— 那些成员
 * 由宿主其它包的 `declare module` 合并进 Context 类型面。本插件不依赖那些包，所以用**属性读取**
 * 拿到它们（运行时形状完全一样），类型上用一个最小接口约束。
 *
 * 与 `official-shims-types.ts`（纯 `declare module` 脚本）分开：那个文件必须是无 import/export 的
 * 全局脚本，不能承载运行时代码。
 *
 * @module dsh-remote-hub/client/local-plugin-manager/official-shims-context
 */

/** 槽位注册表的最小形状。 */
export interface LocalSlotsFace {
  entries(name: string): readonly {
    readonly options: { readonly id?: string; readonly key?: string; readonly label?: string | (() => string) }
  }[]
  getVersion(name: string): number
  subscribe(name: string, listener: () => void): () => void
}

/** 语言服务的最小形状。 */
export interface LocalLocaleFace {
  getSnapshot(): { readonly revision: number }
  subscribe(listener: () => void): () => void
}

/**
 * 读取某 Context 上的槽位注册表。
 * @param ctx - 客户端 Context。
 * @returns 槽位注册表。
 * @throws 宿主没有提供 `slots` 服务时。
 */
export function localSlots(ctx: object): LocalSlotsFace {
  const slots = (ctx as { slots?: LocalSlotsFace }).slots
  if (slots === undefined) throw new Error('local-plugin-manager: slot registry is unavailable')
  return slots
}

/**
 * 读取某 Context 上的语言服务。
 * @param ctx - 客户端 Context。
 * @returns 语言服务。
 * @throws 宿主没有提供 `locale` 服务时。
 */
export function localLocale(ctx: object): LocalLocaleFace {
  const locale = (ctx as { locale?: LocalLocaleFace }).locale
  if (locale === undefined) throw new Error('local-plugin-manager: locale service is unavailable')
  return locale
}

/** 配置表单服务的最小形状（官方 `ConfigForms`）。 */
export interface LocalConfigFormsFace {
  describe(): any
  get<T = unknown>(id: string): any
}

/**
 * 读取某 Context 上的配置表单服务。
 * @param ctx - 客户端 Context。
 * @returns 配置表单服务。
 * @throws 宿主没有提供 `configForms` 服务时。
 */
export function localConfigForms(ctx: object): LocalConfigFormsFace {
  const forms = (ctx as { configForms?: LocalConfigFormsFace }).configForms
  if (forms === undefined) throw new Error('local-plugin-manager: configForms service is unavailable')
  return forms
}

/**
 * 解析槽位标签（官方 `resolveSlotLabel` 的最小等价实现）。
 * @param label - 字符串或惰性函数。
 * @returns 标签文本。
 */
export function resolveLabel(label: string | (() => string) | undefined): string | undefined {
  if (label === undefined) return undefined
  return typeof label === 'function' ? label() : label
}
