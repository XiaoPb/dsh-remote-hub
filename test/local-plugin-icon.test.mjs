/**
 * 侧栏图标与官方 artwork 的**路径一致性**测试（T4.1 验收）。
 *
 * 需求原文：「图标使用和插件页的一样」。本插件的字形由 `scripts/generate-local-icons.mjs`
 * 从内核 `packages/client/ui-primitives/src/icons/artwork.ts` **生成**，因此这里直接读内核那一份，
 * 逐字比较 `d` 属性：官方换图时本测试会变红，提醒同步重新生成。
 *
 * 内核目录可能不存在（例如只签出本插件、或在 CI 上无 monorepo），此时跳过而不是失败。
 *
 * @module test/local-plugin-icon
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * 找到内核的 artwork 源码。
 *
 * 查找顺序：`DSH_KERNEL` 环境变量 → monorepo 同级布局 → 本机开发布局 → 依赖目录。
 * 本插件是独立仓库，工作区目录深度随分支/worktree 变化，因此优先信环境变量。
 * @returns 绝对路径或 `undefined`。
 */
function findArtwork() {
  const relative = 'packages/client/ui-primitives/src/icons/artwork.ts'
  const fromEnv = process.env.DSH_KERNEL
  const roots = [
    ...(fromEnv === undefined ? [] : [join(fromEnv, relative)]),
    // 仓库根的上一级、再上一级（monorepo 内与本机开发布局都覆盖）
    join(process.cwd(), '../..', 'deepseek-harness', relative),
    join(process.cwd(), '..', '..', '..', 'deepseek-harness', relative),
    join(process.cwd(), 'node_modules/@deepseek-ai/dsh-client-ui-primitives/src/icons/artwork.ts'),
  ]
  for (const path of roots) {
    if (existsSync(path)) return path
  }
  return undefined
}

/**
 * 从一段源文本里取某个键下的 `d` 属性列表。
 * @param source - 源文本。
 * @param key - 键名前缀（如 `'plugin-pinwheel-outline'` 或 `"plugin-pinwheel-outline:regular"`）。
 * @returns 路径列表（按出现顺序），找不到键时返回 `undefined`。
 */
function pathsOf(source, key) {
  const start = source.indexOf(key)
  if (start < 0) return undefined
  // 键后面可能还有 `{`、换行或数千字符的 geojson：取到下一个图标条目为止（最多 8k 字符）。
  const next = source.slice(start + key.length).search(/\n\s*(?:"|')?[a-z0-9-]+(?::[a-z]+)?(?:"|')?\s*:\s*\{/u)
  const end = next < 0 ? Math.min(source.length, start + 8000) : start + key.length + next
  const slice = source.slice(start, end)
  return [...slice.matchAll(/d=\\?"([^"\\]+)\\?"/gu)].map(match => match[1])
}

/**
 * 从本插件的图标源码里取 pinwheel 的四条 path。
 * @returns 路径列表。
 */
function localPaths() {
  const source = readFileSync(new URL('../client/src/local-plugin-manager/icons.tsx', import.meta.url), 'utf8')
  return pathsOf(source, 'plugin-pinwheel-outline:regular') ?? []
}

test('pinwheel 字形与内核 artwork 逐字一致', t => {
  const artwork = findArtwork()
  if (artwork === undefined) {
    t.skip('kernel artwork.ts 不在本地（单插件签出）')
    return
  }
  const official = pathsOf(readFileSync(artwork, 'utf8'), 'plugin-pinwheel-outline')
  assert.ok(official !== undefined, '内核 artwork 必须包含 plugin-pinwheel-outline')
  assert.equal(official.length, 4, 'pinwheel 由 4 条 path 组成')
  const mine = localPaths()
  assert.equal(mine.length, 4, '本插件的 pinwheel 也必须有 4 条 path')
  assert.deepEqual(mine, official, '字形必须逐字相同；上游换图时请重新生成 icons.tsx')
})

test('侧栏图标：同一枚字形 + 一枚绿点角标', () => {
  const source = readFileSync(new URL('../client/src/local-plugin-manager/LocalPluginsPanelIcon.tsx', import.meta.url), 'utf8')
  assert.ok(source.includes('IconPluginPinwheelOutlineRegular'), '侧栏图标必须复用官方字形')
  assert.ok(source.includes('local-plugins-nav-icon'), '图标根节点需要稳定的 testid')
  assert.ok(source.includes('local-plugins-nav-dot'), '绿点需要稳定的 testid')
  // 绿点用状态成功色，描边用层背景色（与云端设备图标同一组令牌）。
  assert.ok(source.includes('--dsw-alias-state-success-primary'))
  assert.ok(source.includes('--dsw-alias-bg-layer-1'))
  // 只改侧栏那一格：不引入页面内部的卡片图形组件，也不在这里定义任何页面图形。
  const code = source.split('\n').filter(line => !line.trimStart().startsWith('*')).join('\n')
  assert.ok(!code.includes('PackageArtwork'), '页面内图标不得在此改写')
  assert.ok(!code.includes('PluginArtworkBox'), '页面内图标不得在此改写')
})
