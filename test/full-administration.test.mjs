import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as mod from '../lib/index.js'
import { allActionsFor, FULL_ADMIN_ENDPOINTS, SHARED_READ_ENDPOINTS, isNeverDelegated } from '../lib/index.js'

test('all shared read catalogs are available in every role', () => {
  for (const endpoint of SHARED_READ_ENDPOINTS) {
    // 共享只读目录不可能同时属于 Full 专属管理面（模块加载期已断言交集为空）。
    assert.equal(FULL_ADMIN_ENDPOINTS.includes(endpoint), false, `${endpoint} must not be Full-only`)
    for (const role of ['read-only', 'control', 'full']) assert.ok(allActionsFor(role).includes(endpoint), `${role}: ${endpoint}`)
  }
})

test('full administration writes remain Full-only', () => {
  for (const endpoint of FULL_ADMIN_ENDPOINTS) {
    assert.ok(allActionsFor('full').includes(endpoint), endpoint)
    assert.equal(allActionsFor('control').includes(endpoint), false, endpoint)
    assert.equal(allActionsFor('read-only').includes(endpoint), false, endpoint)
  }
})

test('host-native picker and unknown administration remain denied', () => {
  for (const endpoint of ['directoryPicker/pick', 'pluginManager/unknownRead', 'pluginMarket/unknownWrite', 'remoteAccess/changeRole', 'hub/admin.outboundTargets']) {
    assert.equal(allActionsFor('full').includes(endpoint), false, endpoint)
  }
  assert.equal(isNeverDelegated('directoryPicker/pick'), true)
  assert.equal(isNeverDelegated('pluginManager/unknownRead'), true)
  assert.equal(isNeverDelegated('pluginManager/listPlugins'), false)
  assert.equal(allActionsFor('read-only').includes('pluginManager/listPlugins'), true)
  assert.equal(isNeverDelegated('pluginManager/unknownWrite'), true)
})

test('account and host-native picker are red lines for every role', () => {
  const redlines = [
    'settings/openSettingsDocument',
    // 宿主桌面原生弹框：永不下放（云端浏览走 directoryPicker/list|createDirectory）
    'directoryPicker/pick',
    'account/getState', 'account/getProfile', 'account/getBalance',
    'remoteAccess/follow',
    // 未登记的 credentials / settings 方法仍然拒绝
    'credentials/rotate', 'credentials/reveal', 'settings/import',
  ]
  for (const endpoint of redlines) {
    assert.equal(isNeverDelegated(endpoint), true, `${endpoint} must be never-delegated`)
    for (const role of ['read-only', 'control', 'full']) {
      assert.equal(allActionsFor(role).includes(endpoint), false, `${role} must not hold ${endpoint}`)
    }
  }
})

test('0.3.0: built-in cloud paths need Full to browse and create remote directories', () => {
  for (const endpoint of ['directoryPicker/list', 'directoryPicker/createDirectory', 'workspaceFiles/list']) {
    assert.ok(allActionsFor('full').includes(endpoint), `full must be able to call ${endpoint}`)
    assert.equal(isNeverDelegated(endpoint), false, `${endpoint} must not be a red line`)
  }
  for (const endpoint of ['directoryPicker/list', 'directoryPicker/createDirectory']) {
    assert.equal(allActionsFor('control').includes(endpoint), false, `control must not call ${endpoint}`)
    assert.equal(allActionsFor('read-only').includes(endpoint), false, `read-only must not call ${endpoint}`)
  }
})

test('0.2.6: Full may write configuration, credentials and install plugins', () => {
  const fullOnly = [
    'settings/update', 'settings/replace', 'settings/mutate',
    'credentials/set', 'credentials/unset',
    'pluginManager/installBundle', 'pluginManager/updateBundle', 'pluginManager/removeBundle',
    'pluginManager/setPluginEnabled', 'pluginManager/setBundleEnabled',
    'pluginManager/setVersionExemption', 'pluginManager/cancelInstall', 'pluginManager/waitForInstall',
    'pluginMarket/setIndexes',
  ]
  for (const endpoint of fullOnly) {
    assert.ok(allActionsFor('full').includes(endpoint), `full must be able to call ${endpoint}`)
    assert.equal(allActionsFor('control').includes(endpoint), false, `control must not call ${endpoint}`)
    assert.equal(allActionsFor('read-only').includes(endpoint), false, `read-only must not call ${endpoint}`)
    assert.equal(isNeverDelegated(endpoint), false, `${endpoint} must not be a red line any more`)
  }
})

test('0.2.6: providers and models can be discovered by every role', () => {
  for (const endpoint of ['llm/listProviders', 'llm/listConfigurableProviders', 'llm/discoverModels', 'session/modelCatalog', 'settings/describe']) {
    for (const role of ['read-only', 'control', 'full']) {
      assert.ok(allActionsFor(role).includes(endpoint), `${role} must be able to call ${endpoint}`)
    }
  }
  // credentials/describe 只返回「是否已设置」，三档都要能看设置页的 Key 行。
  assert.equal(isNeverDelegated('credentials/describe'), false)
  assert.ok(allActionsFor('read-only').includes('credentials/describe'))
})

test('0.3.1: plugin surfaces are readable by every role', () => {
  const readable = [
    'pluginManager/listBundles', 'pluginManager/listPlugins', 'pluginManager/listVersionExemptions',
    'pluginManager/registries', 'pluginManager/inspect', 'pluginManager/listVersions', 'pluginManager/readBundleDetail',
    'pluginMarket/listIndexes', 'pluginMarket/search', 'pluginMarket/readEntryDetail',
  ]
  for (const endpoint of readable) {
    for (const role of ['read-only', 'control', 'full']) {
      assert.ok(allActionsFor(role).includes(endpoint), `${role} must be able to read ${endpoint}`)
    }
    assert.equal(isNeverDelegated(endpoint), false, `${endpoint} must not be a red line`)
  }
})

test('0.3.1: plugin writes are Full and take effect without owner approval', () => {
  const writes = [
    'pluginManager/installBundle', 'pluginManager/updateBundle', 'pluginManager/removeBundle',
    'pluginManager/cancelInstall', 'pluginManager/waitForInstall',
    'pluginManager/setBundleEnabled', 'pluginManager/setPluginEnabled', 'pluginManager/setVersionExemption',
    'pluginMarket/setIndexes',
  ]
  for (const endpoint of writes) {
    assert.ok(allActionsFor('full').includes(endpoint), `full must be able to call ${endpoint}`)
    assert.equal(allActionsFor('control').includes(endpoint), false, `control must not call ${endpoint}`)
    assert.equal(allActionsFor('read-only').includes(endpoint), false, `read-only must not call ${endpoint}`)
    assert.equal(mod.APPROVAL_REQUIRED_ENDPOINTS.includes(endpoint), false, `${endpoint} must not require approval any more`)
  }
})

test('official login state (account/*) stays uncontrollable', () => {
  for (const endpoint of ['account/getState', 'account/getProfile', 'account/getBalance', 'account/signOut', 'account/startSignIn']) {
    assert.equal(isNeverDelegated(endpoint), true, `${endpoint} must stay a red line`)
  }
})
