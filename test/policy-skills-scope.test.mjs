import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerAlias } from './panel-alias-loader.mjs'

await registerAlias()
const policyModule = await import('../lib/index.js')

test('skills/list uses only per-device visible session bindings', () => {
  let registered
  const remoteAccess = {
    registerPolicy(_kind, policy) { registered = policy; return () => {} },
    invalidate() {},
    allows() { return true },
  }
  const ctx = { reflect: { get: name => name === 'remoteAccess' ? remoteAccess : undefined } }
  const devices = { get: () => ({ role: 'control', revokedAt: null }) }
  policyModule.registerDevicePolicy(ctx, {
    devices,
    visibleResourceIds: () => ({ session: ['session-visible'] }),
  })
  const bindings = registered.bindings({ kind: 'remote-device', deviceId: 'device-1', role: 'control' })
  const visible = bindings.find(item => item.resource.kind === 'session' && item.resource.id === 'session-visible')
  const hidden = bindings.find(item => item.resource.kind === 'session' && item.resource.id === 'session-hidden')
  const global = bindings.find(item => item.resource.kind === 'global')
  assert.ok(global)
  assert.ok(global.role.actions.includes('skills/list'), 'role action union includes action names')
  assert.equal(policyModule.ENDPOINT_TABLE['skills/list'].kind, 'session')
  assert.ok(visible)
  assert.ok(visible.role.actions.includes('skills/list'))
  assert.equal(hidden, undefined)
})
