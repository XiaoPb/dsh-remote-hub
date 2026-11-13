/**
 * `clsx` 的最小等价实现（替代第三方依赖）。
 *
 * vendored 的官方组件用 `clsx(...)` 拼接类名：支持字符串、对象（键为类名、值为是否包含）、
 * 数组嵌套与假值忽略。本文件给出**行为等价**实现，从而不必把 `clsx` 加进依赖。
 *
 * @module dsh-remote-hub/client/local-plugin-manager/class-names
 */

/** 可接受的类名片段。 */
export type ClassValue =
  | string
  | number
  | null
  | undefined
  | false
  | Record<string, unknown>
  | readonly ClassValue[]

/**
 * 拼接类名。
 * @param values - 片段列表（字符串 / 条件对象 / 嵌套数组；假值忽略）。
 * @returns 以空格分隔的类名串。
 */
export function classNames(...values: readonly ClassValue[]): string {
  const parts: string[] = []
  for (const value of values) {
    if (value === null || value === undefined || value === false || value === 0 || value === '') continue
    if (typeof value === 'string') {
      parts.push(value)
      continue
    }
    if (typeof value === 'number') {
      parts.push(String(value))
      continue
    }
    if (Array.isArray(value)) {
      const nested = classNames(...value)
      if (nested !== '') parts.push(nested)
      continue
    }
    if (typeof value === 'object') {
      for (const [key, enabled] of Object.entries(value)) {
        if (enabled !== false && enabled !== null && enabled !== undefined && enabled !== 0) parts.push(key)
      }
    }
  }
  return parts.join(' ')
}

export default classNames
