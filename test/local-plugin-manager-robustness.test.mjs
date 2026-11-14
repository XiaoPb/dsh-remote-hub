/**
 * 沙箱实测暴露的四个缺陷的回归测试（2026-11-14）。
 *
 * 这些行为都以「真实宿主里才会出现」的形态复现：单元测试此前看不到它们。
 *
 * @module test/local-plugin-manager-robustness
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { fn, testLoadLib, val } from './_helpers.mjs'

const mod = await testLoadLib()
const LocalPluginManagerService = val(mod, 'LocalPluginManagerService', undefined)
const LocalPluginError = val(mod, 'LocalPluginError', undefined)
const LOCAL_PLUGIN_ERRORS = val(mod, 'LOCAL_PLUGIN_ERRORS', {})

test('老版本 Host 缺方法：映射为 501 unavailable，而不是 500 upstream', async () => {
  // DSH 0.2.1-rc.4 的 pluginManager 没有 readBundleDetail / listVersions。
  const service = new LocalPluginManagerService({
    pluginManager: {
      listBundles: async () => [],
      listPlugins: async () => [],
      registries: async () => ({ registry: null }),
      // 模拟老版本：方法不存在，调用时抛 TypeError。
      listVersions: () => { throw new TypeError('pluginManager.listVersions is not a function') },
      readBundleDetail: () => { throw new TypeError('pluginManager.readBundleDetail is not a function') },
    },
  })
  for (const [method, args] of [['listVersions', ['pkg', {}]], ['readBundleDetail', ['pkg', 'zh', {}]]]) {
    await assert.rejects(service.call(method, args, {}), error => {
      assert.ok(error instanceof LocalPluginError)
      assert.equal(error.code, LOCAL_PLUGIN_ERRORS.unavailable, `${method} must be reported as unavailable`)
      assert.equal(error.status, 501)
      return true
    })
  }
})

test('真正的上游故障仍然是 500 upstream（501 只给「方法不存在」）', async () => {
  const service = new LocalPluginManagerService({
    pluginManager: { listBundles: async () => { throw new Error('disk on fire') } },
  })
  await assert.rejects(service.call('listBundles', [], {}), error => {
    assert.equal(error.code, LOCAL_PLUGIN_ERRORS.upstream)
    assert.equal(error.status, 500)
    return true
  })
})

test('事件通道路由只 admit 一次（避免 409 ownsSocket）', () => {
  // `admitConnection()` 会把 peer 标成 ownsSocket，只有 /ws 升级路径会释放它；
  // 我们的自有升级路由必须只用 `admit()`，否则第二个调用返回 409、socket 直接挂断。
  const source = readFileSync(new URL('../host/src/local-plugin-manager/index.ts', import.meta.url), 'utf8')
  assert.ok(!/connection\.requestRejection\(/u.test(source), 'must not call requestRejection (it re-runs admit)')
  assert.ok(!/connection\.admitConnection\(req\)/u.test(source), 'must not claim socket ownership for our own upgrade')
  assert.ok(/connection\.admit\(req\)/u.test(source), 'must use admit() for the Host/Origin fence + owner peer')
})

test('直连通道挂在独立 inject fiber 上（守卫装配失败也要可用）', () => {
  const source = readFileSync(new URL('../host/src/plugin.ts', import.meta.url), 'utf8')
  assert.ok(
    /inject\(\['pluginManager', 'connection', 'webServer'\]/u.test(source),
    'the local channel must inject its own deps, not ride along with the guard assembly',
  )
  // 守卫的装配依赖里没有 pluginManager；本地通道不能放在那里面。
  const guardInject = source.match(/inject\(\['connection', 'typertGateway', 'remoteAccess'\], scoped => \{[\s\S]*?\n {2}\}\)/u)
  if (guardInject !== null) {
    assert.ok(!guardInject[0].includes('applyLocalPluginManager'), 'the guard assembly must not mount the local channel')
  }
})

test('本地页请求 configForms（否则 fiber 作用域 proxy 抛错、面板被跳过）', () => {
  const source = readFileSync(new URL('../client/src/plugin.ts', import.meta.url), 'utf8')
  assert.match(
    source,
    /injectWhenReady\(ctx, \['slots', 'locale', 'configForms'\]/u,
    'the panel must declare configForms, the same way ui-plugin-manager does',
  )
})

test('子槽渲染器缺席时页面渲染为空，而不是抛错', () => {
  const page = readFileSync(new URL('../client/src/local-plugin-manager/PluginManagerPage.tsx', import.meta.url), 'utf8')
  // 允许两种形态：`renderContribution(renderSlot, 'plugins.*' …)`（模块级辅助，供子组件用），
  // 以及就地守卫的 `renderSlot === undefined ? null : renderSlot('plugins.add.actions' …)`。
  const guardedInline = /renderSlot === undefined \? null : renderSlot\('plugins\./gu
  const withoutInline = page.replace(guardedInline, 'renderContribution(renderSlot, \'plugins.')
  assert.ok(!/(?<![.\w])renderSlot\('plugins\./u.test(withoutInline), 'every plugins.* call must be guarded')
  assert.ok(/function renderContribution\(/u.test(page), 'renderContribution pins the absence check in one place')
  assert.ok(page.includes('renderSlot === undefined ? null : renderSlot('), 'absent renderer must render null')
})

/** 让 lint 知道 val 的用途（读取可选导出）。 */
void fn
