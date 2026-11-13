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
  assert.match(src, /if \(!cloudPathContext\(\)\) return/, '本机模式下必须直接返回，不注册任何槽位')
  assert.match(src, /ctx\.commandUi\.register/)
  assert.match(src, /name: 'cloud-file'/)
  assert.match(src, /priority: -2/)
  assert.match(src, /conversation\.hero\.workspace\.directoryFlow/)
  assert.match(src, /sidebar\.workspaces\.directoryFlow/)
  assert.match(src, /directoryPicker\/list/)
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
  assert.match(context, /carrier\?\.active !== true/)
  assert.match(context, /remote-access\/denied/)
})
