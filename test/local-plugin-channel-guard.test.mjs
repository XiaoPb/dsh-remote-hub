/**
 * 护栏：本地插件管理直连通道**不得**进入 RPC 名册、**不得**被授予任何角色。
 *
 * 这是需求硬约束「该接口不释放给 RPC，避免云端调用」的自动化守门员。
 * 任何一次「顺手把本地方法加进 FULL 矩阵」或「顺手用 rpc.intercept 挂路由」的改动，
 * 都会在这里或 {@link assertLocalPluginNotDelegated} 处失败。
 *
 * @module test/local-plugin-channel-guard
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PATHS, fn, read, testLoadLib, val } from './_helpers.mjs'

const mod = await testLoadLib()
const localSrc = read('core/src/local-plugin-manager.ts')
const capsSrc = read(PATHS.capabilitiesSrc)
const hostPluginSrc = read('host/src/plugin.ts')
const clientPluginSrc = read('client/src/plugin.ts')

const LOCAL_PLUGIN_METHODS = val(mod, 'LOCAL_PLUGIN_METHODS', undefined)
const LOCAL_PLUGIN_CHANNEL = val(mod, 'LOCAL_PLUGIN_CHANNEL', undefined)
const LOCAL_PLUGIN_ERRORS = val(mod, 'LOCAL_PLUGIN_ERRORS', undefined)
const ENDPOINT_TABLE = val(mod, 'ENDPOINT_TABLE', undefined)
const allActionsFor = fn(mod, 'allActionsFor')
const localPluginEndpoints = fn(mod, 'localPluginEndpoints')
const assertLocalPluginNotDelegated = fn(mod, 'assertLocalPluginNotDelegated')
const isNeverDelegated = fn(mod, 'isNeverDelegated')
const localPluginPath = fn(mod, 'localPluginPath')
const isLocalPluginMethod = fn(mod, 'isLocalPluginMethod')
const officialEndpointFor = fn(mod, 'officialEndpointFor')

test('契约模块导出 15 个方法，与官方 pluginManager 清单一一对应', () => {
  assert.ok(Array.isArray(LOCAL_PLUGIN_METHODS), 'LOCAL_PLUGIN_METHODS must be exported from the built bundle')
  assert.equal(LOCAL_PLUGIN_METHODS.length, 15)
  assert.equal(new Set(LOCAL_PLUGIN_METHODS).size, 15, 'method names must be unique')
  // 两个「重命名」方法（与官方 namespace 不同名）单独核对来源。
  const renamed = { listInventory: 'pluginInventory/list', fastestRegistry: 'pluginRegistryProbe/fastest' }
  for (const method of LOCAL_PLUGIN_METHODS) {
    assert.match(method, /^[A-Za-z][A-Za-z0-9]*$/u)
    assert.equal(isLocalPluginMethod(method), true, `${method} must be recognised`)
    // 每个本地方法都必须能追溯到一个官方 endpoint（audit-only，不代表授权）。
    const official = officialEndpointFor(method)
    assert.match(official, /^(?:pluginManager|pluginInventory|pluginRegistryProbe)\//u)
    if (Object.hasOwn(renamed, method)) assert.equal(official, renamed[method])
    else assert.equal(official, `pluginManager/${method}`)
  }
  // 除 probe 外，官方对应物都必须在 ENDPOINT_TABLE 里（probe 不在名册，属宿主自有服务）。
  for (const method of LOCAL_PLUGIN_METHODS) {
    const official = officialEndpointFor(method)
    if (official === 'pluginRegistryProbe/fastest') continue
    assert.ok(ENDPOINT_TABLE?.[official] !== undefined, `${official} must exist in ENDPOINT_TABLE`)
  }
  assert.equal(isLocalPluginMethod('notAMethod'), false)
})

test('通道前缀与路径构造稳定', () => {
  assert.equal(LOCAL_PLUGIN_CHANNEL, '/api/hub/local-plugin-manager')
  assert.equal(localPluginPath('listBundles'), '/api/hub/local-plugin-manager/listBundles')
  assert.equal(LOCAL_PLUGIN_ERRORS?.forbidden, 'local-plugin-manager/forbidden')
})

test('15 个本地 endpoint 全部登记在 ENDPOINT_TABLE（可追溯）', () => {
  const endpoints = [...localPluginEndpoints()]
  assert.equal(endpoints.length, 15, 'every local method must be registered as a hub fact')
  for (const endpoint of endpoints) {
    assert.equal(ENDPOINT_TABLE[endpoint].hub, true, `${endpoint} must be marked hub`)
    assert.equal(ENDPOINT_TABLE[endpoint].kind, 'global')
    assert.equal(ENDPOINT_TABLE[endpoint].stream, undefined, `${endpoint} is unary only`)
  }
})

test('本地插件通道不得被授予任何角色（含 full）', () => {
  assert.doesNotThrow(() => assertLocalPluginNotDelegated())
  for (const role of ['read-only', 'control', 'full']) {
    for (const action of allActionsFor(role)) {
      assert.equal(action.startsWith('hub/localPluginManager/'), false, `${role} must not hold ${action}`)
    }
  }
})

test('本地插件通道全部落在红线内（即使有人误加进矩阵也会被拒）', () => {
  for (const method of LOCAL_PLUGIN_METHODS) {
    const endpoint = `hub/localPluginManager/${method}`
    assert.equal(isNeverDelegated(endpoint), true, `${endpoint} must be a red line`)
  }
})

test('实现侧绝不使用 rpc.intercept / registerRemoteEvents / 全局 fetch 覆盖', () => {
  const forbidden = [
    ['rpc.intercept(', 'RPC 拦截器全进程唯一，已被 api-gateway 占用'],
    ['registerRemoteEvents(', '全局事件转发源唯一，已被 api-remotes 占用'],
    ['globalThis.fetch =', '不允许全局 fetch 覆盖'],
    ['window.fetch =', '不允许全局 fetch 覆盖'],
  ]
  for (const [needle, why] of forbidden) {
    for (const [label, src] of [['host/src/plugin.ts', hostPluginSrc], ['client/src/plugin.ts', clientPluginSrc]]) {
      assert.equal(src.includes(needle), false, `${label} must not contain ${needle} (${why})`)
    }
  }
})

test('本地方法名与能力矩阵源码无交集（静态双保险）', () => {
  for (const method of LOCAL_PLUGIN_METHODS) {
    const needle = `hub/localPluginManager/${method}`
    // ENDPOINT_TABLE 里有事实条目；ROLE_MATRIX 里出现即为缺陷。
    const occurrences = capsSrc.split(needle).length - 1
    assert.equal(occurrences, 1, `${needle} must appear exactly once in capabilities.ts (the ENDPOINT_TABLE fact)`)
  }
  // 契约文件本身只声明方法与错误码，不声明任何角色授权词汇。
  assert.equal(/ROLE_MATRIX|READ_ONLY\.global|CONTROL\.global|FULL\.global/u.test(localSrc), false)
})
