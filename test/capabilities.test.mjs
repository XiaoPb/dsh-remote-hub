import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  PATHS,
  fn,
  read,
  staticEndpointKeys,
  staticRoleActions,
  staticStringArray,
  testLoadLib,
  val,
} from './_helpers.mjs'

const mod = await testLoadLib()
const capsSrc = read(PATHS.capabilitiesSrc)
const redlinesSrc = read(PATHS.redlinesSrc)

const allActionsFor = fn(mod, 'allActionsFor')
const assertRoleContainment = fn(mod, 'assertRoleContainment')
const assertNoRedlineDelegated = fn(mod, 'assertNoRedlineDelegated')
const untraceableActions = fn(mod, 'untraceableActions')
const isNeverDelegated = fn(mod, 'isNeverDelegated')
const openableStreams = fn(mod, 'openableStreams')
const ENDPOINT_TABLE = val(mod, 'ENDPOINT_TABLE', undefined)

const actionsFor = role => (allActionsFor
  ? [...allActionsFor(role)]
  : [...new Set([
    ...staticRoleActions(capsSrc, 'READ_ONLY'),
    ...staticRoleActions(capsSrc, role === 'read-only' ? 'READ_ONLY' : role === 'control' ? 'CONTROL' : 'FULL'),
    ...(role === 'full' ? staticRoleActions(capsSrc, 'FULL') : []),
  ])])

test('role containment: read-only subset control subset full', () => {
  if (assertRoleContainment) assert.doesNotThrow(() => assertRoleContainment())
  const ro = new Set(actionsFor('read-only'))
  const control = new Set(actionsFor('control'))
  const full = new Set(actionsFor('full'))
  assert.ok(ro.size > 0 && control.size > ro.size && full.size > control.size)
  for (const action of ro) assert.ok(control.has(action), `control is missing ${action}`)
  for (const action of control) assert.ok(full.has(action), `full is missing ${action}`)
})

test('every capability action is traceable to ENDPOINT_TABLE', () => {
  const table = ENDPOINT_TABLE ?? staticEndpointKeys(capsSrc)
  const keys = table instanceof Set ? table : new Set(Object.keys(table))
  assert.ok(keys.size > 50, 'endpoint table must be populated')
  for (const role of ['read-only', 'control', 'full']) {
    for (const action of actionsFor(role)) {
      assert.match(action, /^[A-Za-z0-9_$.-]+\/[A-Za-z0-9_$.-]+$/u)
      assert.ok(keys.has(action), `${role} action ${action} is not in ENDPOINT_TABLE`)
    }
  }
  if (untraceableActions) assert.deepEqual([...untraceableActions()], [])
  else assert.equal(staticRoleActions(capsSrc, 'READ_ONLY').filter(a => !keys.has(a)).length, 0)
})

test('allow-list ∩ red-lines = empty', () => {
  if (assertNoRedlineDelegated) assert.doesNotThrow(() => assertNoRedlineDelegated())
  const namespaces = Array.isArray(val(mod, 'NEVER_DELEGATED_NAMESPACES', undefined))
    ? [...mod.NEVER_DELEGATED_NAMESPACES]
    : staticStringArray(redlinesSrc, 'NEVER_DELEGATED_NAMESPACES')
  const endpoints = Array.isArray(val(mod, 'NEVER_DELEGATED_ENDPOINTS', undefined))
    ? [...mod.NEVER_DELEGATED_ENDPOINTS]
    : staticStringArray(redlinesSrc, 'NEVER_DELEGATED_ENDPOINTS')
  const redline = action => (isNeverDelegated
    ? isNeverDelegated(action)
    : endpoints.includes(action) || namespaces.some(prefix => action.startsWith(prefix)))
  for (const action of actionsFor('full')) assert.equal(redline(action), false, `${action} is a red-line`)
  assert.ok(namespaces.includes('pluginManager/'))
  assert.ok(namespaces.includes('pluginMarket/'))
})

test('openableStreams(read-only) contains only stream methods', () => {
  const table = ENDPOINT_TABLE ?? staticEndpointKeys(capsSrc)
  const streamKeys = table instanceof Set
    ? [...staticEndpointKeys(capsSrc)].filter(key => /stream:\s*true/u.test(capsSrc.split(`'${key}'`)[1] ?? ''))
    : Object.entries(table).filter(([, fact]) => fact.stream === true).map(([key]) => key)
  const streams = openableStreams ? [...openableStreams('read-only')] : streamKeys.filter(key => actionsFor('read-only').includes(key))
  assert.ok(streams.length > 0, 'read-only must be able to monitor streams')
  for (const endpoint of streams) {
    assert.match(endpoint, /^[A-Za-z0-9_$.-]+\/[A-Za-z0-9_$.-]+$/u)
    assert.ok(streamKeys.includes(endpoint) || /observe|follow|changes|list/u.test(endpoint),
      `${endpoint} is not declared as a stream method`)
  }
  // No write-style stream endpoint is openable by read-only.
  assert.equal(streams.some(endpoint => /attach|create|close/u.test(endpoint)), false)
})
