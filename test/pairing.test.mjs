import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PATHS, pairingService, read, secretOf, testLoadLib } from './_helpers.mjs'

const mod = await testLoadLib()

test('QR ticket: 43 chars, TTL 15s (rotate), single-use burn', async () => {
  const env = pairingService(mod)
  const issued = env.service.issueTicket('control')
  const ticket = secretOf(issued)
  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/u)
  // 15 秒轮换：凭据窗口极短，配对成功即换长期设备令牌（见 redeem 断言）。
  assert.equal(issued.expiresAt - env.now, 15_000)
  assert.equal(issued.role, 'control')
  const first = await env.service.redeemTicket(ticket, 'phone')
  assert.equal(first.ok, true)
  const replay = await env.service.redeemTicket(ticket, 'phone-2')
  assert.equal(replay.ok, false)
  assert.equal(env.issued.length, 1)
  if (!env.dynamic) assert.match(read(PATHS.pairingSrc), /ticketBytes|PAIRING\.ticket/u)
})

test('short code: 8 Crockford chars (no I L O U), entropy >= 40 bits', () => {
  const env = pairingService(mod)
  assert.equal(env.CROCKFORD.length, 32)
  assert.equal(8 * Math.log2(env.CROCKFORD.length) >= 40, true)
  for (let index = 0; index < 30; index += 1) {
    const issued = env.service.issueCode('control')
    const code = secretOf(issued)
    assert.equal(code.length, 8)
    assert.equal([...code].every(char => env.CROCKFORD.includes(char)), true)
    assert.doesNotMatch(code, /[ILOU]/u)
    assert.equal(issued.expiresAt - env.now, 15_000)
  }
})

test('5 wrong attempts burn the code; 6th is rate-limited; correct code is dead', async () => {
  const env = pairingService(mod)
  assert.equal(env.maxAttempts, 5)
  const issued = env.service.issueCode('control')
  const correct = secretOf(issued)
  const reversed = env.CROCKFORD.split('').reverse().join('').slice(0, 8)
  const wrong = reversed === correct ? '0'.repeat(8) : reversed

  const verdicts = []
  for (let index = 0; index < 5; index += 1) {
    verdicts.push(await env.service.redeemCode(wrong, `attacker-${index}`))
  }
  assert.equal(verdicts.length, 5)
  assert.equal(verdicts.every(result => result.ok === false), true)

  const sixth = await env.service.redeemCode(wrong, 'attacker-6')
  assert.equal(sixth.ok, false)
  assert.match(String(sixth.code ?? sixth.reason ?? ''), /rate[-_]?limited/u)

  const afterBurn = await env.service.redeemCode(correct, 'owner')
  assert.equal(afterBurn.ok, false, 'correct code must also be dead after the budget is exhausted')
  assert.equal(env.issued.length, 0)
})

test('expired ticket is rejected and does not issue a token', async () => {
  const env = pairingService(mod, { qrTtlMs: 1_000 })
  const issued = env.service.issueTicket('control')
  env.advance(1_001)
  const result = await env.service.redeemTicket(secretOf(issued), 'late-phone')
  assert.equal(result.ok, false)
  assert.equal(env.issued.length, 0)
})
