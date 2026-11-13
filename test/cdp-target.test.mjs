import assert from 'node:assert/strict'
import { test } from 'node:test'
import { safeTargetUrl, selectPageTarget } from '../scripts/cdp-target.mjs'

const first = { type: 'page', id: 'page-a', url: 'http://127.0.0.1:3091/?token=secret-a' }
const second = { type: 'page', id: 'page-b', url: 'http://127.0.0.1:3091/?token=secret-b' }

test('one page target can be selected implicitly', () => {
  assert.equal(selectPageTarget([first]).id, 'page-a')
})

test('multiple page targets require explicit ID or exact URL', () => {
  assert.throws(() => selectPageTarget([first, second]), /multiple page targets/u)
  assert.equal(selectPageTarget([first, second], 'page-b').id, 'page-b')
  assert.equal(selectPageTarget([first, second], first.url).id, 'page-a')
})

test('target selection errors sanitize query credentials', () => {
  assert.throws(() => selectPageTarget([first], 'http://127.0.0.1:3091/?token=secret-c'), error => {
    assert.equal(error.message.includes('secret-c'), false)
    assert.equal(error.message.includes('token='), false)
    return true
  })
})
test('ambiguity diagnostics never print URL query tokens', () => {
  assert.equal(safeTargetUrl(first.url), 'http://127.0.0.1:3091/')
  assert.throws(() => selectPageTarget([first, second]), error => {
    assert.equal(error.message.includes('secret-a'), false)
    assert.equal(error.message.includes('secret-b'), false)
    return true
  })
})
