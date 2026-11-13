import assert from 'node:assert/strict'
import { test } from 'node:test'
import { announcePermissionDenied, permissionDeniedNotice, REMOTE_PERMISSION_DENIED_EVENT } from '../.build/client/client/src/permission-notice.js'

test('permission refusal is explicit and bilingual without request payloads', () => {
  const zh = permissionDeniedNotice({ action: 'workspace/create', reason: 'no-allow' }, 'zh-CN')
  assert.equal(zh.endpoint, 'workspace/create')
  assert.match(zh.message, /没有被修改/u)
  const en = permissionDeniedNotice({ action: 'credentials/set', reason: 'no-allow' }, 'en-US')
  assert.match(en.message, /Nothing was changed/u)
  assert.equal(JSON.stringify(zh).includes('token'), false)
})

test('denied notification emits only the sanitized details', () => {
  let event
  const target = {
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail } },
    document: { documentElement: { lang: 'en' } },
    dispatchEvent(value) { event = value },
  }
  assert.equal(announcePermissionDenied(target, { action: 'settings/mutate', reason: 'no-allow', token: 'secret' }), true)
  assert.equal(event.type, REMOTE_PERMISSION_DENIED_EVENT)
  assert.equal(event.detail.endpoint, 'settings/mutate')
  assert.equal(JSON.stringify(event.detail).includes('secret'), false)
})
