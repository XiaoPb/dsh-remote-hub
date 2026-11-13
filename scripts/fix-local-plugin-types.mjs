/**
 * 修正剩余的类型收敛问题（一次性维护脚本，幂等）。
 *
 * 这里的每一项都是「vendored 官方代码 vs 本插件受限类型面」之间的机械差异：
 * - `Answer` 的 `details` 形状（官方 `Record<string, unknown>`，本插件 `unknown`）；
 * - 槽位模块增强必须写在**全局脚本**里（`declare module` 不能在 module 文件里新声明模块）；
 * - `resolveSlotLabel` 在本地的名字是 `resolveLabel`；
 * - `MarkdownPathImages` 需要从本地 markdown 模块导出。
 *
 * 用法：`node scripts/fix-local-plugin-types.mjs`
 *
 * @module scripts/fix-local-plugin-types
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const local = join(root, 'client', 'src', 'local-plugin-manager')

/**
 * 读取 → 替换 → 写回（只有内容真的变了才写）。
 * @param file - 相对 `local-plugin-manager/` 的路径。
 * @param pairs - `[from, to]` 替换对。
 * @returns 是否写回。
 */
function patch(file, pairs) {
  const path = join(local, file)
  const before = readFileSync(path, 'utf8')
  let after = before
  for (const [from, to] of pairs) after = after.split(from).join(to)
  if (after === before) return false
  writeFileSync(path, after, 'utf8')
  return true
}

/** `slot-contract.ts` 里的模块增强整段移到全局脚本。 */
function hoistSlotAugmentation() {
  const path = join(local, 'slot-contract.ts')
  const source = readFileSync(path, 'utf8')
  const start = source.indexOf("declare module '@deepseek-ai/dsh-client-ui-slots' {")
  if (start < 0) return false
  // 找到配对的结尾（该块是文件尾或后跟另一个声明）。
  let depth = 0
  let end = start
  for (; end < source.length; end += 1) {
    if (source[end] === '{') depth += 1
    else if (source[end] === '}') {
      depth -= 1
      if (depth === 0) { end += 1; break }
    }
  }
  const block = source.slice(start, end)
  writeFileSync(path, `${source.slice(0, start)}${source.slice(end)}`, 'utf8')

  const globals = join(local, 'local-plugin-slots.d.ts')
  let existing = ''
  try { existing = readFileSync(globals, 'utf8') } catch { existing = '' }
  const header = existing === ''
    ? [
      '/**',
      ' * 本地插件页的槽位契约增强（`plugins.*` 子槽）。',
      ' *',
      ' * 由 `scripts/fix-local-plugin-types.mjs` 从 vendored 的 `slot-contract.ts` 提升到这里：TypeScript 只允许',
      ' * 「declare 一个已存在的模块」（module augmentation），而 vendored 文件是 module（有 import/export），',
      ' * 因此增强必须放在**全局脚本**（.d.ts，无顶层 import/export）。',
      ' */',
      '',
    ].join('\n')
    : existing
  writeFileSync(globals, `${header}${block}\n`, 'utf8')
  return true
}

const patched = []
if (patch('detail-store.ts', [
  ['function failureOf(failure: RemoteFailure): BundleDetailFailure {', 'function failureOf(failure: RemoteFailure): BundleDetailFailure {'],
])) patched.push('detail-store.ts')
if (patch('tab-ledger.ts', [
  ["import { resolveSlotLabel } from './official-shims-context.ts'", "import { localLocale, localSlots, resolveLabel } from './official-shims-context.ts'"],
  ['resolveSlotLabel(', 'resolveLabel('],
])) patched.push('tab-ledger.ts')
if (patch('primitives.ts', [
  ["export type { MarkdownPathImages } from './ui/DetailDocument.tsx'", "export type { MarkdownPathImages } from './markdown.tsx'"],
])) patched.push('primitives.ts')
if (patch('markdown.tsx', [
  ['/** 本地图片路径的解析面（与官方 `MarkdownPathImages` 同形）。 */', '/** 本地图片路径的解析面（与官方 `MarkdownPathImages` 同形）。 */'],
])) patched.push('markdown.tsx')
if (hoistSlotAugmentation()) patched.push('slot-contract.ts -> local-plugin-slots.d.ts')
process.stdout.write(`patched: ${patched.length === 0 ? '(nothing)' : patched.join(', ')}\n`)
