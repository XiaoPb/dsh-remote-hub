import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PATHS, read, testLoadLib, tokenPrimitives } from './_helpers.mjs'

const mod = await testLoadLib()
const t = tokenPrimitives(mod)

test('token shape: 43-char base64url, 100 distinct samples', () => {
  assert.equal(t.TOKEN_LENGTH, 43)
  const tokens = Array.from({ length: 100 }, () => t.generateToken())
  for (const token of tokens) {
    assert.match(token, /^[A-Za-z0-9_-]{43}$/u)
    assert.equal(t.isTokenShaped(token), true)
  }
  assert.equal(new Set(tokens).size, 100, 'tokens must be distinct (256-bit entropy source)')
  assert.equal(t.isTokenShaped('short'), false)
  assert.equal(t.isTokenShaped(`${tokens[0]}x`), false)
  if (!t.dynamic) assert.match(read(PATHS.tokenSrc), /randomBytes\(32\)|TOKEN_LENGTH\s*=\s*43/u)
})

test('hashToken: sha256 hex64, deterministic', () => {
  assert.equal(t.TOKEN_HASH_LENGTH, 64)
  const token = t.generateToken()
  const hash = t.hashToken(token)
  assert.match(hash, /^[0-9a-f]{64}$/u)
  assert.equal(t.hashToken(token), hash)
  assert.notEqual(hash, token)
  if (!t.dynamic) assert.match(read(PATHS.tokenSrc), /createHash\('sha256'\)/u)
})

test('verifyTokenHash: constant-time, never throws, unequal lengths share one path', () => {
  const token = t.generateToken()
  const hash = t.hashToken(token)
  assert.equal(t.verifyTokenHash(token, hash), true)
  assert.doesNotThrow(() => t.verifyTokenHash(`${token}x`, hash))
  assert.equal(t.verifyTokenHash(`${token}x`, hash), false)
  // Length-inequality and malformed-hash candidates go down the same path.
  assert.doesNotThrow(() => t.verifyTokenHash('x', hash))
  assert.equal(t.verifyTokenHash('x', hash), false)
  assert.doesNotThrow(() => t.verifyTokenHash(token, 'deadbeef'))
  assert.equal(t.verifyTokenHash(token, 'deadbeef'), false)
  assert.doesNotThrow(() => t.verifyTokenHash(token, 'not-hex-at-all'))
  assert.equal(t.verifyTokenHash(token, 'not-hex-at-all'), false)
  assert.doesNotThrow(() => t.verifyTokenHash(null, undefined))
  assert.equal(t.verifyTokenHash(null, undefined), false)
  if (!t.dynamic) assert.match(read(PATHS.tokenSrc), /timingSafeEqual/u)
})

test('hash is a one-way derivation: a different token never verifies', () => {
  const token = t.generateToken()
  const hash = t.hashToken(token)
  for (let index = 0; index < 50; index += 1) {
    const other = t.generateToken()
    assert.equal(t.verifyTokenHash(other, hash), false)
  }
})
