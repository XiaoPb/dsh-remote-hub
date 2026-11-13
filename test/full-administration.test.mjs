import assert from 'node:assert/strict'
import { test } from 'node:test'
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

test('credentials, account, plugin inventory and host directory surfaces are red lines for every role', () => {
  const redlines = [
    'credentials/describe', 'credentials/set', 'credentials/unset',
    'settings/update', 'settings/replace', 'settings/mutate', 'settings/openSettingsDocument',
    'directoryPicker/pick', 'directoryPicker/list', 'directoryPicker/createDirectory',
    'pluginInventory/list',
    'account/getState', 'account/getProfile', 'account/getBalance',
    'remoteAccess/follow',
  ]
  for (const endpoint of redlines) {
    assert.equal(isNeverDelegated(endpoint), true, `${endpoint} must be never-delegated`)
    for (const role of ['read-only', 'control', 'full']) {
      assert.equal(allActionsFor(role).includes(endpoint), false, `${role} must not hold ${endpoint}`)
    }
  }
  // `full` 是「能传文件、开终端」，不是 DSH owner：它不得持有任何红线 endpoint。
  const leaked = allActionsFor('full').filter(isNeverDelegated)
  assert.deepEqual(leaked, [])
})
