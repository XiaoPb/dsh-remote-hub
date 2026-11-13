import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ENDPOINT_TABLE, actionsFor } from '../lib/index.js'
test('session reference discovery is readable for every role on a bound session', () => {
 for(const endpoint of ['fileReferences/list','messageFeedback/list','sessionReferenceResolver/candidates']) {
  assert.equal(ENDPOINT_TABLE[endpoint].kind,'session')
  for(const role of ['read-only','control','full']) {
   assert.ok(actionsFor(role,'session').includes(endpoint),`${role}: ${endpoint}`)
   assert.equal(actionsFor(role,'global').includes(endpoint),false,role)
  }
 }
})
