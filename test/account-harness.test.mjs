/**
 * 夹具自检：确保 P4 之后所有测试都能用「账号登录 + 公钥登记」建连。
 *
 * @module test/account-harness
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { bootstrappedAccount } from './_account-harness.mjs'

test('account harness enrols a client and verifies a signed request', async () => {
  const env = await bootstrappedAccount('basic')
  try {
    const { key, enrolled } = await env.enroll('control')
    assert.equal(enrolled.client.roleCeiling, 'control')
    assert.match(enrolled.lease.lease, /^cli_[0-9a-f]{24}\.\d+\.[A-Za-z0-9_-]+$/u)

    const verdict = await env.verify(enrolled, key)
    assert.equal(verdict.ok, true, verdict.ok ? '' : verdict.reason)
    assert.equal(verdict.claims.activeRole, 'control')
    assert.equal(verdict.claims.clientId, enrolled.client.clientId)
  } finally {
    env.cleanup()
  }
})
