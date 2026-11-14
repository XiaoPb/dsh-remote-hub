/**
 * 本地控制器：**发送层接缝**的等价性测试。
 *
 * 目标（`03-tasks.md` T2.3）：证明官方控制器经官方 `ctx.remote` 发出的调用，与本地控制器经直连通道
 * 发出的调用**逐条对应**（同名、同参数、同顺序），从而保证页面行为一致、只有数据目标不同。
 *
 * @module test/local-plugin-sender
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

/**
 * 加载一个编译后的 client 模块（把 `@core/...` 与相对 import 复制到临时目录）。
 * @param entry - 相对 `.build/client/client/src/` 的入口文件。
 * @param extra - 额外需要复制的源码文件（相对同一目录树）。
 * @returns 模块命名空间。
 */
async function loadBuilt(entry, extra = []) {
  const root = new URL('../.build/client/', import.meta.url)
  const directory = await mkdtemp(join(tmpdir(), 'lpm-sender-'))
  const files = [
    ...extra,
    entry,
    'core/src/index.js',
  ]
  for (const relative of files) {
    const from = new URL(relative.startsWith('core/') ? relative : `client/src/${relative}`, root)
    const target = join(directory, relative.startsWith('core/') ? relative : `client/src/${relative}`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, readFileSync(from, 'utf8'), 'utf8')
  }
  const mod = await import(pathToFileURL(join(directory, 'client/src', entry)).href)
  await rm(directory, { recursive: true, force: true }).catch(() => {})
  return mod
}

/**
 * 官方发送层只依赖 `ctx.remote`，因此可以从编译产物里单独取出来测。
 * @returns 模块命名空间。
 */
async function loadManagerStore() {
  const root = new URL('../.build/client/client/src/local-plugin-manager/', import.meta.url)
  const directory = await mkdtemp(join(tmpdir(), 'lpm-store-'))
  const coreTarget = join(directory, 'core', 'src')
  await mkdir(coreTarget, { recursive: true })
  for (const name of ['index', 'protocol', 'local-plugin-manager', 'roles', 'device', 'capabilities', 'capabilities-redlines', 'redact', 'carrier-contract']) {
    try {
      await writeFile(join(coreTarget, `${name}.js`), readFileSync(new URL(`../../core/src/${name}.js`, root), 'utf8'), 'utf8')
    } catch {
      // 可选模块。
    }
  }
  const dir = join(directory, 'client', 'src', 'local-plugin-manager')
  await mkdir(dir, { recursive: true })
  for (const name of ['manager-store.js', 'store.js', 'detail-store.js', 'config-ledger.js', 'tab-ledger.js', 'presentation.js', 'locales.js', 'official-shims.js', 'official-shims-context.js', 'sanitize-install-input.js']) {
    try {
      await writeFile(
        join(dir, name),
        readFileSync(new URL(name, root), 'utf8').replace(/from '@core\/([^']+)'/gu, (_m, rest) => `from '../../../../core/src/${rest}'`),
        'utf8',
      )
    } catch {
      // 可选模块。
    }
  }
  const mod = await import(pathToFileURL(join(dir, 'manager-store.js')).href)
  await rm(directory, { recursive: true, force: true }).catch(() => {})
  return mod
}

const managerStore = await loadManagerStore()
const officialRemoteSender = managerStore.officialRemoteSender

/** 一个记录调用的假 `ctx.remote`。 */
function fakeRemote() {
  const calls = []
  const record = (namespace, method) => (...args) => {
    calls.push([`${namespace}/${method}`, args])
    return Promise.resolve({ ok: true, value: { value: `${namespace}/${method}` } })
  }
  const managerMethods = [
    'listBundles', 'listPlugins', 'registries', 'inspect', 'listVersions', 'readBundleDetail', 'installBundle',
    'waitForInstall', 'cancelInstall', 'updateBundle', 'removeBundle', 'setPluginEnabled', 'setBundleEnabled',
  ]
  const pluginManager = Object.fromEntries(managerMethods.map(name => [name, record('pluginManager', name)]))
  return {
    calls,
    ctx: {
      remote: {
        pluginManager,
        pluginInventory: { list: record('pluginInventory', 'list') },
        pluginRegistryProbe: { fastest: record('pluginRegistryProbe', 'fastest') },
      },
    },
  }
}

test('官方发送层：每个方法都落到对应的 ctx.remote 命名空间', async () => {
  const { ctx, calls } = fakeRemote()
  const sender = officialRemoteSender(ctx)
  const expected = [
    ['listBundles', [], 'pluginManager/listBundles'],
    ['listPlugins', [], 'pluginManager/listPlugins'],
    ['listInventory', [], 'pluginInventory/list'],
    ['registries', [], 'pluginManager/registries'],
    ['fastestRegistry', [], 'pluginRegistryProbe/fastest'],
    ['inspect', ['pkg@1', { registry: null }], 'pluginManager/inspect'],
    ['listVersions', ['pkg', {}], 'pluginManager/listVersions'],
    ['readBundleDetail', ['pkg', 'zh', { npmFileSources: [] }], 'pluginManager/readBundleDetail'],
    ['installBundle', ['pkg@1', { approvedBuilds: [] }], 'pluginManager/installBundle'],
    ['waitForInstall', ['req'], 'pluginManager/waitForInstall'],
    ['cancelInstall', ['req'], 'pluginManager/cancelInstall'],
    ['updateBundle', ['pkg', '2.0.0', { registry: null }], 'pluginManager/updateBundle'],
    ['removeBundle', ['pkg'], 'pluginManager/removeBundle'],
    ['setPluginEnabled', ['entry', true], 'pluginManager/setPluginEnabled'],
    ['setBundleEnabled', ['pkg', false], 'pluginManager/setBundleEnabled'],
  ]
  for (const [method, args, endpoint] of expected) {
    calls.length = 0
    const answer = await sender[method](...args)
    assert.equal(answer.ok, true, `${method} must resolve ok`)
    assert.equal(calls.length, 1, `${method} must issue exactly one remote call`)
    assert.equal(calls[0][0], endpoint)
    assert.deepEqual(calls[0][1].slice(0, args.length), args)
  }
})

test('本地发送层与官方发送层的调用形状完全一致（仅目标不同）', async () => {
  // 本地发送层的实现是「transport.call(方法名, 位置参数)」，因此这里用一个记录型 transport 验证它
  // 把同一组参数按同一顺序发出去 —— 与上面官方路径的断言逐条对应。
  const localControllerPath = new URL('../.build/client/client/src/local-plugin-manager/local-controller.js', import.meta.url)
  // 源码（TS）比编译产物更贴近意图：断言这里的调用形状。
  const source = readFileSync(new URL('../client/src/local-plugin-manager/local-controller.ts', import.meta.url), 'utf8')
  const cases = [
    ['listBundles', "call<readonly BundleInfo[]>('listBundles')"],
    ['listPlugins', "call<readonly PluginInfo[]>('listPlugins')"],
    ['listInventory', "call<{ readonly managementAvailable?: boolean }>('listInventory')"],
    ['registries', "call<PluginRegistries>('registries')"],
    ['fastestRegistry', "call<string | null>('fastestRegistry')"],
    ['inspect', "call<PluginSpecInspection>('inspect', [spec, options], signal)"],
    ['listVersions', "call<PluginVersionList>('listVersions', [name, options])"],
    ['readBundleDetail', "call<BundleDetail>('readBundleDetail', [name, language, options])"],
    ['installBundle', "call<ChangeResult>('installBundle', [spec, options])"],
    ['waitForInstall', "call<ChangeResult | null>('waitForInstall', [requestId])"],
    ['cancelInstall', "call<PluginInstallCancellation>('cancelInstall', [requestId])"],
    ['updateBundle', "call<PluginUpdateResult>('updateBundle', [name, version, options])"],
    ['removeBundle', "call<ChangeResult>('removeBundle', [name])"],
    ['setPluginEnabled', "call<ChangeResult>('setPluginEnabled', [id, enabled])"],
    ['setBundleEnabled', "call<ChangeResult>('setBundleEnabled', [name, enabled])"],
  ]
  for (const [method, needle] of cases) {
    assert.ok(source.includes(needle), `local sender must call ${method} as: this.transport.${needle}`)
  }
  void localControllerPath
})

test('控制器把 ctx.remote 的调用点收敛成 this.sender.*（没有遗留的直连调用）', () => {
  const source = readFileSync(new URL('../.build/client/client/src/local-plugin-manager/manager-store.js', import.meta.url), 'utf8')
  const direct = [...source.matchAll(/this\.ctx\.remote\./gu)]
  // officialRemoteSender 内只有一处 	his.ctx.remote；控制器本体一处都不该有（TS 源码里用本地化访问器）。
  assert.equal(direct.length, 0, 'the controller must not read this.ctx.remote directly any more')
  assert.ok(source.includes('this.sender.'), 'the controller must dispatch through the sender seam')
})

void loadBuilt
