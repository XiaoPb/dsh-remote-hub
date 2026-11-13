import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allActionsFor, FULL_ADMIN_ENDPOINTS, SHARED_READ_ENDPOINTS, isNeverDelegated } from '../lib/index.js'

test('all read-only catalogs and state are available in every role', () => {
  for (const endpoint of SHARED_READ_ENDPOINTS) {
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
  assert.equal(allActionsFor('read-only').includes('credentials/describe'), true)
  assert.equal(isNeverDelegated('pluginManager/unknownWrite'), true)
})
