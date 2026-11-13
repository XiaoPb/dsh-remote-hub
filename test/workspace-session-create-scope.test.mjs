import assert from 'node:assert/strict'
import { test } from 'node:test'
import { actionsFor } from '../lib/index.js'
test('session/create is workspace-scoped for control/full but not read-only', () => {
 assert.equal(actionsFor('read-only','workspace').includes('session/create'),false)
 assert.equal(actionsFor('control','workspace').includes('session/create'),true)
 assert.equal(actionsFor('full','workspace').includes('session/create'),true)
 assert.equal(actionsFor('control','global').includes('session/create'),true)
})
