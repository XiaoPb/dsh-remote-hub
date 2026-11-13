import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerAlias } from './panel-alias-loader.mjs'
await registerAlias()
const { createTransport } = await import('../.build/client/client/src/transport.js')
test('local owner config save wraps editable fields in the declared patch argument', async () => {
  let request
  const patch = { singleController: true, bridgeApprovals: true, defaultRole: 'full', maxPairAttempts: 5 }
  const transport = createTransport({ origin: 'http://127.0.0.1:8843', fetchImpl: async (url, init) => {
    request = JSON.parse(init.body)
    assert.equal(url, '/api/hub/admin.configPatch')
    return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { ok: true, config: patch } } }), { status: 200 })
  } })
  const result = await transport.patchConfig(patch)
  assert.deepEqual(request.payload.args, { patch })
  assert.deepEqual(result.config, patch)
  transport.close()
})
