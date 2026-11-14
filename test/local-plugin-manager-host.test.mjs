/**
 * 本地插件管理直连服务：方法契约、参数校验、错误归一与 owner 闸门。
 *
 * 覆盖 `dev/plans/local-plugins-page/03-tasks.md` 的 T1.3/T1.4 验收：
 * - 15 个方法逐个对应官方调用（参数位置、返回值原样透传）；
 * - 参数校验（arity / 类型 / 未知 options 字段）→ `bad-request`；
 * - 官方错误码原样透传，其它异常归为 `upstream`；
 * - 官方服务缺席 → `unavailable`（503）而不是抛未捕获异常；
 * - `assertOwnerPeer`：`remote-device` 一律 403。
 *
 * @module test/local-plugin-manager-host
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fn, testLoadLib, val } from './_helpers.mjs'

const mod = await testLoadLib()
const LocalPluginManagerService = val(mod, 'LocalPluginManagerService', undefined)
const LocalPluginError = val(mod, 'LocalPluginError', undefined)
const assertOwnerPeer = fn(mod, 'assertOwnerPeer')
const failureBody = fn(mod, 'failureBody')
const asLocalPluginError = fn(mod, 'asLocalPluginError')
const LOCAL_PLUGIN_ERRORS = val(mod, 'LOCAL_PLUGIN_ERRORS', {})

/** 一个记录调用的官方 pluginManager 桩。 */
function stubManager(overrides = {}) {
  const calls = []
  const record = (name, value) => async (...args) => {
    calls.push([name, args])
    return value
  }
  const base = {
    listBundles: record('listBundles', [{ name: 'a' }]),
    listPlugins: record('listPlugins', [{ entryId: 'e' }]),
    registries: record('registries', { registry: null }),
    inspect: record('inspect', { status: 'accepted' }),
    listVersions: record('listVersions', { status: 'listed' }),
    readBundleDetail: record('readBundleDetail', { status: 'none' }),
    installBundle: record('installBundle', { changed: true }),
    waitForInstall: record('waitForInstall', null),
    cancelInstall: record('cancelInstall', { status: 'not-running' }),
    updateBundle: record('updateBundle', { step: 'check' }),
    removeBundle: record('removeBundle', { changed: true }),
    setPluginEnabled: record('setPluginEnabled', { changed: true }),
    setBundleEnabled: record('setBundleEnabled', { changed: true }),
  }
  return { manager: { ...base, ...overrides }, calls }
}

/** 构造服务（无 inventory / probe）。 */
function serviceOf(manager) {
  assert.equal(typeof LocalPluginManagerService, 'function', 'LocalPluginManagerService must be exported')
  return new LocalPluginManagerService({ pluginManager: manager })
}

/** 断言一次调用以指定错误码失败。 */
async function rejectsWith(promise, code) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof LocalPluginError, `expected LocalPluginError, got ${String(error)}`)
    assert.equal(error.code, code)
    return true
  })
}

test('契约方法：15 个，逐个透传官方返回值', async () => {
  const { manager, calls } = stubs()
  const service = serviceOf(manager)
  const cases = [
    ['listBundles', [], 'listBundles'],
    ['listPlugins', [], 'listPlugins'],
    ['registries', [], 'registries'],
    ['inspect', ['pkg@1'], 'inspect'],
    ['listVersions', ['pkg'], 'listVersions'],
    ['readBundleDetail', ['pkg', 'zh-CN'], 'readBundleDetail'],
    ['installBundle', ['pkg@1'], 'installBundle'],
    ['waitForInstall', ['req'], 'waitForInstall'],
    ['cancelInstall', ['req'], 'cancelInstall'],
    ['updateBundle', ['pkg', '2.0.0'], 'updateBundle'],
    ['removeBundle', ['pkg'], 'removeBundle'],
    ['setPluginEnabled', ['e', true], 'setPluginEnabled'],
    ['setBundleEnabled', ['pkg', false], 'setBundleEnabled'],
  ]
  for (const [method, args, upstream] of cases) {
    calls.length = 0
    const value = await service.call(method, args)
    assert.equal(calls.length, 1, `${method} must call the official service once`)
    assert.equal(calls[0][0], upstream)
    assert.ok(value !== undefined, `${method} must return the official value`)
  }
})

test('listInventory / fastestRegistry 依赖可选服务，缺席时给出明确结果', async () => {
  const { manager } = stubs()
  const withoutOptional = serviceOf(manager)
  await rejectsWith(withoutOptional.call('listInventory', []), LOCAL_PLUGIN_ERRORS.unavailable)
  assert.equal(await withoutOptional.call('fastestRegistry', []), null)

  const inventory = { list: async () => ({ entries: [], agentPresets: [], managementAvailable: true }) }
  const probe = { fastest: async () => 'https://registry.npmmirror.com/' }
  const full = new LocalPluginManagerService({ pluginManager: manager, pluginInventory: inventory, pluginRegistryProbe: probe })
  assert.deepEqual(await full.call('listInventory', []), { entries: [], agentPresets: [], managementAvailable: true })
  assert.equal(await full.call('fastestRegistry', []), 'https://registry.npmmirror.com/')
})

test('参数校验：缺少/类型错误 → bad-request（含 details.parameter）', async () => {
  const { manager } = stubs()
  const service = serviceOf(manager)
  const invalid = [
    ['inspect', []],
    ['inspect', [42]],
    ['readBundleDetail', ['pkg']],
    ['setPluginEnabled', ['e', 'yes']],
    ['setBundleEnabled', ['pkg', 1]],
    ['installBundle', [{ not: 'a string' }]],
  ]
  for (const [method, args] of invalid) {
    await assert.rejects(service.call(method, args), error => {
      assert.equal(error.code, LOCAL_PLUGIN_ERRORS.badRequest)
      assert.equal(typeof error.details.parameter, 'string')
      assert.equal(error.status, 400)
      return true
    })
  }
})

test('参数校验：未知 options 字段被拒绝（与 Gateway 的 exact-arguments 同精神）', async () => {
  const { manager } = stubs()
  const service = serviceOf(manager)
  await assert.rejects(service.call('installBundle', ['pkg@1', { approvedBuilds: [], bogus: 1 }]), error => {
    assert.equal(error.code, LOCAL_PLUGIN_ERRORS.badRequest)
    assert.equal(error.details.field, 'bogus')
    return true
  })
  // 允许的字段原样透传给官方服务。
  const { manager: m2, calls } = stubs()
  await serviceOf(m2).call('installBundle', ['pkg@1', { approvedBuilds: ['esbuild'], saveExact: true }])
  assert.deepEqual(calls[0][1][1], { approvedBuilds: ['esbuild'], saveExact: true })
})

test('官方错误码原样透传，非结构化异常归一为 upstream', async () => {
  const { manager } = stubs({
    removeBundle: async () => {
      const error = new Error('No such bundle: x')
      error.code = 'plugin-manager/unknown-bundle'
      error.details = { name: 'x' }
      throw error
    },
    listBundles: async () => {
      throw new TypeError('boom')
    },
  })
  const service = serviceOf(manager)
  await assert.rejects(service.call('removeBundle', ['x']), error => {
    assert.equal(error.code, 'plugin-manager/unknown-bundle')
    assert.deepEqual(error.details, { name: 'x' })
    assert.equal(error.status, 404)
    return true
  })
  await assert.rejects(service.call('listBundles', []), error => {
    assert.equal(error.code, LOCAL_PLUGIN_ERRORS.upstream)
    assert.match(error.message, /boom/u)
    assert.equal(error.status, 500)
    return true
  })
})

test('abort signal 透传给 inspect / listVersions', async () => {
  const seen = []
  const { manager } = stubs({
    inspect: async (_spec, _options, signal) => {
      seen.push(signal)
      return { status: 'refused' }
    },
    listVersions: async (_name, _options, signal) => {
      seen.push(signal)
      return { status: 'refused' }
    },
  })
  const controller = new AbortController()
  const service = serviceOf(manager)
  await service.call('inspect', ['pkg@1'], { signal: controller.signal })
  await service.call('listVersions', ['pkg'], { signal: controller.signal })
  assert.equal(seen.length, 2)
  assert.equal(seen[0], controller.signal)
  assert.equal(seen[1], controller.signal)
})

test('owner 闸门：remote-device 一律 403，owner / 进程内直调放行', () => {
  assert.equal(typeof assertOwnerPeer, 'function')
  assert.doesNotThrow(() => assertOwnerPeer({ principal: { kind: 'owner' } }, 'route'))
  assert.doesNotThrow(() => assertOwnerPeer(undefined, 'route'))
  for (const kind of ['remote-device', 'browser', 'grant']) {
    assert.throws(() => assertOwnerPeer({ principal: { kind } }, 'route'), error => {
      assert.equal(error.code, LOCAL_PLUGIN_ERRORS.forbidden)
      assert.equal(error.status, 403)
      return true
    })
  }
})

test('failureBody / asLocalPluginError 形状稳定', () => {
  const error = asLocalPluginError(new Error('x'))
  const body = failureBody(error)
  assert.deepEqual(Object.keys(body).sort(), ['code', 'details', 'message'])
  assert.equal(body.code, LOCAL_PLUGIN_ERRORS.upstream)
})

/** 返回一个全新的桩集合（避免测试间共享 calls 数组）。 */
function stubs(overrides = {}) {
  return stubManager(overrides)
}
