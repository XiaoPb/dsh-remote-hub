/**
 * 内置官方插件的**只读配置视图**（ADR-004「接受只读」的落地）。
 *
 * ## 为什么需要
 *
 * 本地插件页不声明 `plugins.*` 子槽（声明权在官方页，冲突即抛 `already declared`），因此
 * 「内置插件配置」这四张卡点进去是空的 —— 用户看到的就是一个没有内容的详情页。
 * 但**配置值本身是拿得到的**：`ctx.configForms.get(ns).getSnapshot().value` 就带着 Host 已接受的值。
 * 所以这里把值**只读地**显示出来：能看见，不能改（改动仍在官方页完成）。
 *
 * ## 为什么长这样（对齐官方卡片）
 *
 * 官方四张卡都是 `SettingsForm` + 「分节标题 + 字段」的结构：每个字段一行「标签 …… 值」，
 * 节与节之间有分隔线。本模块照同一套视觉节奏排版（节标题 / 字段行 / 分隔线），
 * 只是把「输入控件 + 保存按钮」换成「当前值的只读文本」，因此在页面上看起来与官方卡片同构。
 *
 * ## 设计约束
 *
 * - **纯展示**：不调 `mutate`，不引入表单控件，避免与官方页的写入路径打架；
 * - **只针对内置四项**：id → 命名空间映射写死在下表（来自各官方包的 `NS` 常量），
 *   未知 id 一律返回 `undefined`，页面据此回退到「没有贡献者」；
 * - **零新依赖**：只用页内已有的 `Tag` 原子与 CSS Module。
 *
 * @module dsh-remote-hub/client/local-plugin-manager/readonly-config
 */
import type { ReactNode } from 'react'

import { Tag } from './primitives.ts'
import css from './PluginManagerPage.module.css'

/**
 * 内置插件的 `plugins.item` id → 它读取的 settings 命名空间。
 *
 * 多命名空间的项（子智能体 / 终端）按优先级排列，取**第一个**在 Host 上 served 的。
 */
export const BUILTIN_NAMESPACES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'subagent': ['subagent'],
  'web-search': ['web'],
  'agent-loop': ['agent-loop'],
  'shell': ['pwsh-sandbox', 'bash-sandbox'],
})

/**
 * 各命名空间里字段的**显示名**（取自官方卡片的分节/字段标题）。
 *
 * 找不到的键按原名显示 —— 官方加字段时这里不必同步也不会崩。
 */
const FIELD_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  'subagent': { maxDepth: '递归层级', maxActiveSubagents: '并行子智能体上限' },
  'web': { searchProvider: '搜索服务', fetchProvider: '网页读取服务' },
  'agent-loop': { maxParallelToolCalls: '并行工具调用上限' },
  'pwsh-sandbox': {
    timeoutMs: '默认超时（毫秒）',
    maxTimeoutMs: '最长超时（毫秒）',
    maxOutputBytes: '单次输出上限（字节）',
    maxSpillBytes: '溢出文件上限（字节）',
    graceMs: '宽限时间（毫秒）',
  },
  'bash-sandbox': {
    timeoutMs: '默认超时（毫秒）',
    maxTimeoutMs: '最长超时（毫秒）',
    maxOutputBytes: '单次输出上限（字节）',
    maxSpillBytes: '溢出文件上限（字节）',
    graceMs: '宽限时间（毫秒）',
  },
})

/** 该内置项要显示的命名空间（未 served 时为 undefined）。 */
export function namespaceFor(id: string, served: Iterable<string>): string | undefined {
  const candidates = BUILTIN_NAMESPACES[id]
  if (candidates === undefined) return undefined
  const available = new Set(served)
  return candidates.find(namespace => available.has(namespace))
}

/**
 * 把一个配置值渲染成「字段行」列表，键名替换为可读标签。
 * @param value - Host 已接受的配置值。
 * @param namespace - 该值所属命名空间（决定字段显示名）。
 * @returns 字段行（键/标签/文本）；空对象返回空数组。
 */
export function describeValue(
  value: unknown,
  namespace: string,
): readonly { readonly key: string; readonly label: string; readonly text: string }[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [{ key: '@value', label: '值', text: formatScalar(value) }]
  }
  const labels = FIELD_LABELS[namespace] ?? {}
  return Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => ({ key, label: labels[key] ?? key, text: formatScalar(entry) }))
}

/**
 * 标量/数组/嵌套对象的紧凑文本。
 * @param value - 任意值。
 * @returns 单行文本。
 */
function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.length === 0 ? '[]' : value.map(formatScalar).join(', ')
  return JSON.stringify(value)
}

/** 只读配置区块的 props。 */
export interface ReadonlyConfigSectionProps {
  /** 该项当前生效的配置值（Host 已接受值）。 */
  readonly value: unknown
  /** 该值所属命名空间（决定字段显示名）。 */
  readonly namespace: string
  /** 只读提示文案（已本地化）。 */
  readonly notice: string
  /** 「默认值」徽标文案（已本地化）。 */
  readonly defaultBadge: string
}

/**
 * 渲染内置插件当前生效的配置（只读），排版与官方 `SettingsForm` 同构：
 * 「只读提示 → 字段行（标签 …… 值）」。
 * @param props - 配置值、命名空间与两段文案。
 * @returns 只读配置区块。
 */
export function ReadonlyConfigSection(props: ReadonlyConfigSectionProps): ReactNode {
  const rows = describeValue(props.value, props.namespace)
  return (
    <section className={css.readonlyForm} data-plugin-readonly-config='true'>
      <p className={css.readonlyNotice}>
        <span>{props.notice}</span>
        <Tag tone='outline'>{props.defaultBadge}</Tag>
      </p>
      <div className={css.readonlyFields}>
        {rows.map(row => (
          <div className={css.readonlyField} key={row.key} data-readonly-field={row.key}>
            <span className={css.readonlyFieldLabel}>{row.label}</span>
            <span className={css.readonlyFieldValue}>{row.text}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
