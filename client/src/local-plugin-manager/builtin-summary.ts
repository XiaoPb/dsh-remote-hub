/**
 * 内置官方插件的**一行说明**（卡片副标题）。
 *
 * ## 为什么需要
 *
 * 官方插件页的四张「内置插件配置」卡片，标题下面各有一行说明：
 * 「设置子智能体的递归层级、数量和模型。」等。这些文案由各贡献者在
 * `plugins.item` 的 `view === 'summary'` 分支里返回 —— 而本地页拿不到渲染器
 * （声明权在官方页，见 ADR-004），所以卡片只剩标题。
 *
 * ## 做法
 *
 * 文案本身在**各插件自己的词典命名空间**里，`ctx.locale.bind(ns)(key)` 就能取到，
 * 不需要经过槽位渲染。这里把「内置项 id → (命名空间, 文案键)」写成表。
 *
 * @module dsh-remote-hub/client/local-plugin-manager/builtin-summary
 */

/** 每个内置项的说明文案来自哪里。 */
const BUILTIN_SUMMARY: Readonly<Record<string, { readonly ns: string; readonly key: string }>> = Object.freeze({
  'subagent': { ns: 'settings.subagent', key: 'subagentDescription' },
  'web-search': { ns: 'settings.webSearch', key: 'description' },
  'agent-loop': { ns: 'settings.agentLoop', key: 'description' },
  'shell': { ns: 'settings.shell', key: 'description' },
})

/** 语言服务的最小形状（只用到 `bind`）。 */
interface LocaleBinder {
  bind?: (namespace: string) => (key: string) => string
}

/**
 * 取某个内置项的一行说明。
 * @param locale - 宿主的语言服务（缺 `bind` 时返回 undefined）。
 * @param id - `plugins.item` 的注册 id。
 * @returns 文案；未知 id 或文案缺失时 undefined。
 */
export function builtinSummary(locale: unknown, id: string): string | undefined {
  const entry = BUILTIN_SUMMARY[id]
  if (entry === undefined) return undefined
  const bind = (locale as LocaleBinder | undefined)?.bind
  if (typeof bind !== 'function') return undefined
  try {
    const t = bind.call(locale, entry.ns)
    if (typeof t !== 'function') return undefined
    const text = t(entry.key)
    // 词典缺失时 `bind` 会原样返回键名 —— 那不算一条说明。
    return typeof text === 'string' && text !== '' && text !== entry.key ? text : undefined
  } catch {
    return undefined
  }
}
