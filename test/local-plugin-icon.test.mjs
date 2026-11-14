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
  // 切片只到**下一个字形键**为止。键一定是带引号的（生成物 `"name:weight":`、官方 `'name':`），
  // 而 `paint: {…}` / `size: 16` 这类字段不带引号 —— 用引号把键框住才不会把切片截断在路径之前。
  const next = source.slice(start + key.length).search(/[\r\n]+\s*(?:"[a-z0-9-]+(?::[a-z]+)?"|'[a-z0-9-]+')\s*:\s*\{/u)
  const slice = source.slice(start, next < 0 ? start + 20000 : start + key.length + next)
  // 生成物把 SVG 存成 JSON 字符串（`inner: "<path d=\"…\">"`），官方源码则是裸模板字符串；
  // 因此这里必须容忍 `\"` 这种转义引号。
  return [...slice.matchAll(/d=\\*"((?:[^"\\]|\\.)+?)\\*"/gu)].map(match => match[1])
}

/**
 * 从本插件的图标源码里取 pinwheel 的四条 path。
 * @returns 路径列表。
 */
function localPaths() {
  const source = readFileSync(new URL('../client/src/local-plugin-manager/icons.tsx', import.meta.url), 'utf8')
  return pathsOf(source, '"plugin-pinwheel-outline:regular"') ?? []
}

test('pinwheel 字形与内核 artwork 逐字一致', t => {
  const artwork = findArtwork()
  if (artwork === undefined) {
    t.skip('kernel artwork.ts 不在本地（单插件签出）')
    return
  }
  const officialSource = readFileSync(artwork, 'utf8')
  const official = pathsOf(officialSource, "'plugin-pinwheel-outline'")
  assert.ok(official !== undefined, '内核 artwork 必须包含 plugin-pinwheel-outline')
  assert.ok(official !== undefined && official.length >= 4, 'pinwheel 至少有 4 条 path')
  const pinwheel = official.filter((_, index) => index < 4)
  const mine = localPaths()
  assert.equal(mine.length, 4, '本插件的 pinwheel 也必须有 4 条 path')
  assert.deepEqual(mine, pinwheel, '字形必须逐字相同；上游换图时请重新生成 icons.tsx')
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

test('描边字形必须继承官方根上的 fill="none"（否则会被黑色填充涂满）', () => {
  // 2026-11-14 实机：生成器只保留 viewBox，丢掉根上的 fill="none"，
  // 结果刷新/加号/垃圾桶/返回箭头等 13 个图标被 SVG 默认的 fill:black 涂黑。
  const icons = readFileSync(new URL('../client/src/local-plugin-manager/icons.tsx', import.meta.url), 'utf8')
  const specs = [...icons.matchAll(/"([a-z0-9-]+:(?:regular|medium))": \{[\s\S]*?paint: (\{[^}]*\}),/gu)]
  assert.ok(specs.length > 0, 'generated glyph table must exist')
  for (const [, name, paint] of specs) {
    const parsed = JSON.parse(paint)
    // 每个字形都必须显式声明 fill（描边类为 "none"，实心类由 path 自带 currentColor）。
    assert.ok(
      parsed.fill === 'none' || parsed.fill === 'currentColor',
      `${name}: root fill must be declared, got ${JSON.stringify(parsed)}`,
    )
  }
  // 渲染器必须把 paint 展开到 <svg> 上。
  assert.ok(/\.\.\.spec\.paint/u.test(icons), 'glyph() must spread spec.paint onto the svg element')
})
