import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOutboundTargetStore } from '../.build/host/host/src/outbound-targets.js'

let home
let store
before(async () => {
  home = await mkdtemp(join(tmpdir(), 'remote-hub-outbound-'))
  store = createOutboundTargetStore(home)
})
after(async () => {
  await rm(home, { recursive: true, force: true })
})

test('stores bearers under DSH_HOME and only returns opaque, secret-free views', async () => {
  const token = 'A'.repeat(32)
  const view = await store.save({ origin: 'http://example.test:8443/', token, deviceLabel: 'remote' })
  assert.equal(view.origin, 'http://example.test:8443')
  assert.equal('token' in view, false)
  assert.match(view.id, /^[0-9a-f]{64}$/u)
  assert.equal((await store.get(view.id))?.token, token)
  const text = await readFile(store.path, 'utf8')
  assert.ok(text.includes(token), 'bearer is persisted only in the protected host file')
  if (process.platform !== 'win32') {
    assert.equal((await stat(store.path)).mode & 0o777, 0o600)
    assert.equal((await stat(join(home, 'remote-hub'))).mode & 0o777, 0o700)
  }
})

test('keeps separate credentials for the same origin and replaces only identical pairings', async () => {
  const first = await store.save({ origin: 'http://same.test:8443', token: 'a'.repeat(32), deviceLabel: 'first' })
  const second = await store.save({ origin: 'http://same.test:8443', token: 'b'.repeat(32), deviceLabel: 'second' })
  assert.notEqual(first.id, second.id)
  assert.equal((await store.list()).length, 3)
  await store.save({ origin: 'http://same.test:8443/', token: 'a'.repeat(32), deviceLabel: 'renamed' })
  assert.equal((await store.list()).length, 3)
  assert.equal((await store.get(first.id))?.deviceLabel, 'renamed')
})

test('rejects non-origin URLs, malformed tokens, and tampered IDs', async () => {
  await assert.rejects(store.save({ origin: 'http://example.test/path', token: 'x'.repeat(32) }), /bare HTTP/u)
  await assert.rejects(store.save({ origin: 'http://example.test', token: 'short' }), /token/u)
  const id = '0'.repeat(64)
  assert.equal(await store.get(id), undefined)
  assert.equal(await store.forget('not-an-id'), false)
})
