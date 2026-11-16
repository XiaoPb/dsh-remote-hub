import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

/**
 * 云端路径 UI 自 0.3.0 起**内置**（原来是独立伴生包 @xiaopb/dsh-remote-paths）。
 *
 * 这些断言锁住三件事：
 * 1. 源码确实在 client/src/paths 下，且随主 client bundle 编译；
 * 2. 它仍然只在「载体激活」时注册槽位，本机原生流程与 dsh-hardssh 不受影响；
 * 3. 插槽/命令的 id 与优先级保持稳定（避免与其他插件的 directoryFlow 抢位）。
 */
const src = readFileSync(new URL('../client/src/paths/index.tsx', import.meta.url), 'utf8')
const mount = readFileSync(new URL('../client/src/paths/mount.ts', import.meta.url), 'utf8')
const context = readFileSync(new URL('../client/src/paths/context.ts', import.meta.url), 'utf8')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('cloud path UI lives inside the main package', () => {
  // 本机模式不注册任何槽位；远程模式下由 mountAll() 统一注册（见 apply 的注释）。
  assert.match(src, /if \(!cloudPathContext\(\)\)/, '本机模式下不注册任何槽位')
  assert.match(src, /function mountAll\(ctx: PathsContext\)/, '注册集中在 mountAll')
  assert.match(src, /ctx\.commandUi\.register/)
  assert.match(src, /name: 'cloud-file'/)
  assert.match(src, /priority: -2/)
  // 目录选择交给官方 browse 表面：`directory-picker-auto` 在 trustedHosts
  // 含非回环 authority 时自动挂 browse 后端 + browse 客户端，浏览器里就是
  // 「浏览远程目录」。本插件不再抢那两个插槽（抢了反而覆盖官方选择）。
  assert.match(src, /directoryPicker\/list/)
  assert.match(src, /delegated-to-official/)
  assert.equal(pkg.name, '@xiaopb/dsh-remote-hub')
  assert.equal(typeof pkg.workspaces, 'undefined', '不能再依赖伴生 workspace 包')
  assert.equal(pkg.exports['./paths'], undefined, '不应再导出独立 paths 入口')
})

test('cloud path mounting waits for host services', () => {
  assert.match(mount, /'slots', 'commandUi', 'sessions', 'conversation'/)
  assert.match(mount, /host\.inject\(PATHS_DEPS/)
  assert.match(mount, /scopedHost\.commandUi === undefined/)
})

test('cloud path transport is allow-listed and only active when the carrier is', () => {
  assert.match(context, /directoryPicker\/list', 'directoryPicker\/createDirectory', 'workspaceFiles\/list'/)
  // 载体分支要求 active === true 且传输完整；否则不会走控制端那条路。
  assert.match(context, /carrier\?\.active === true/)
  assert.match(context, /typeof transport\?\.fetch === 'function'/)
  assert.match(context, /remote-access\/denied/)
})
