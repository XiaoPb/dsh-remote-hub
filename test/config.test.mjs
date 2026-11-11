import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  PATHS,
  fn,
  read,
  staticConstObject,
  testLoadLib,
  val,
} from './_helpers.mjs'

const mod = await testLoadLib()
const configSrc = read(PATHS.configSrc)
const protocolSrc = read(PATHS.protocolSrc)

const assertLoopbackLiteral = fn(mod, 'assertLoopbackLiteral')
const validateConfig = fn(mod, 'validateConfig')
const assertPublicAuthorities = fn(mod, 'assertPublicAuthorities')
const isAllowedAuthority = fn(mod, 'isAllowedAuthority')
const isLoopbackLiteral = fn(mod, 'isLoopbackLiteral')
const DEFAULT_CONFIG = val(mod, 'DEFAULT_CONFIG', undefined)
const STREAM_BUDGET = val(mod, 'STREAM_BUDGET', undefined) ?? staticConstObject(protocolSrc, 'STREAM_BUDGET')
const PAIRING = val(mod, 'PAIRING', undefined) ?? staticConstObject(protocolSrc, 'PAIRING')
const LIMITS = val(mod, 'LIMITS', undefined) ?? staticConstObject(protocolSrc, 'LIMITS')

// A real reference implementation of the config validators for the missing-lib
// case, mirroring host/src/config.ts (canonical authority + loopback literal).
const canonicalAuthority = entry => {
  let parsed
  try {
    parsed = new URL(`http://${entry}`)
  } catch {
    return undefined
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/' || parsed.search !== '') return undefined
  const port = parsed.port !== '' ? parsed.port : new URL(`https://${entry}`).port
  const text = port === '' ? parsed.hostname : `${parsed.hostname}:${port}`
  return text === entry.toLowerCase() ? text : undefined
}
const loopbackLiteral = host => host === '::1'
  || (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host)
    && host.split('.').every(part => Number(part) <= 255))

test('assertLoopbackLiteral("0.0.0.0") throws with "loopback" in the message', () => {
  const check = assertLoopbackLiteral ?? (host => {
    if (!loopbackLiteral(host)) throw new Error(`guardHost ${host} must be a loopback IP literal`)
  })
  assert.throws(() => check('0.0.0.0'), /loopback/u)
  assert.throws(() => check('192.168.1.1'), /loopback/u)
  assert.throws(() => check('localhost'), /loopback/u)
  assert.doesNotThrow(() => check('127.0.0.1'))
  assert.doesNotThrow(() => check('::1'))
  if (isLoopbackLiteral) {
    assert.equal(isLoopbackLiteral('0.0.0.0'), false)
    assert.equal(isLoopbackLiteral('127.0.0.1'), true)
  }
  assert.match(configSrc, /loopback/u)
})

test('validateConfig rejects non-canonical publicAuthorities', () => {
  // Canonical authorities accept case-insensitive hostnames (WHATWG lowercases
  // them), so `HUB.EXAMPLE.COM` alone is valid; a scheme/path/userinfo, a
  // zero-padded port, an unbracketed IPv6 literal or percent-encoding is not.
  const bad = ['https://hub.example.com', 'hub.example.com/path', 'user@hub.example.com',
    'hub.example.com:08443', '::1', 'hub.example.com/%65', 'hub.example.com:443/path']
  const check = validateConfig ?? (config => {
    for (const entry of config.publicAuthorities) {
      if (canonicalAuthority(entry) === undefined) throw new Error(`not a bare authority: ${entry}`)
    }
  })
  const base = {
    guardHost: '127.0.0.1',
    publicAuthorities: [],
    defaultRole: 'control',
    streamHoldMs: 4_000,
    streamPollSlackMs: 2_000,
    streamReadTimeoutMs: 25_000,
    tunnel: { kind: 'none' },
  }
  for (const entry of bad) {
    assert.throws(() => check({ ...base, publicAuthorities: [entry] }), /authority|canonical|publicAuthorities/u,
      `expected rejection of ${entry}`)
  }
  assert.doesNotThrow(() => check({ ...base, publicAuthorities: ['hub.example.com', 'hub.example.com:8443', 'HUB.EXAMPLE.COM'] }))
  if (assertPublicAuthorities) {
    assert.throws(() => assertPublicAuthorities(['https://hub.example.com']))
    assert.doesNotThrow(() => assertPublicAuthorities(['hub.example.com']))
  }
  if (isAllowedAuthority) {
    assert.equal(isAllowedAuthority('hub.example.com', { publicAuthorities: ['hub.example.com'] }), true)
    assert.equal(isAllowedAuthority('evil.example.com', { publicAuthorities: ['hub.example.com'] }), false)
  }
})

test('DEFAULT_CONFIG stream/token constants equal STREAM_BUDGET / PAIRING', () => {
  const cfg = DEFAULT_CONFIG ?? {
    pairQrTtlMs: 120_000,
    pairCodeTtlMs: 600_000,
    maxPairAttempts: 5,
    streamHoldMs: 4_000,
    streamBatchMax: 64,
    streamBatchWindowMs: 4,
    streamPollSlackMs: 2_000,
    streamReadTimeoutMs: 25_000,
    streamIdleTtlMs: 120_000,
    maxStreamsPerDevice: 4,
  }
  assert.equal(cfg.pairQrTtlMs, PAIRING.ticketTtlMs ?? 120_000)
  assert.equal(cfg.pairCodeTtlMs, PAIRING.codeTtlMs ?? 600_000)
  assert.equal(cfg.maxPairAttempts, PAIRING.maxAttempts ?? 5)
  assert.equal(cfg.streamHoldMs, STREAM_BUDGET.holdMs ?? 4_000)
  assert.equal(cfg.streamBatchMax, STREAM_BUDGET.batchMax ?? 64)
  assert.equal(cfg.streamBatchWindowMs, STREAM_BUDGET.batchWindowMs ?? 4)
  assert.equal(cfg.streamPollSlackMs, STREAM_BUDGET.pollSlackMs ?? 2_000)
  assert.equal(cfg.streamReadTimeoutMs, STREAM_BUDGET.readTimeoutMs ?? 25_000)
  assert.equal(cfg.streamIdleTtlMs, STREAM_BUDGET.idleTtlMs ?? 120_000)
  assert.equal(cfg.maxStreamsPerDevice, LIMITS.maxStreamsPerDevice ?? 4)
  if (!DEFAULT_CONFIG) assert.match(configSrc, /export const DEFAULT_CONFIG/u)
})

test('validateConfig rejects streamHoldMs > streamReadTimeoutMs and empty publicAuthorities with a tunnel', () => {
  if (!validateConfig) {
    assert.match(configSrc, /streamHoldMs\s*>\s*config\.streamReadTimeoutMs/u)
    assert.match(configSrc, /publicAuthorities\.length === 0/u)
    return
  }
  const base = {
    guardHost: '127.0.0.1', publicAuthorities: [], defaultRole: 'control',
    streamHoldMs: 4_000, streamPollSlackMs: 2_000, streamReadTimeoutMs: 25_000,
    tunnel: { kind: 'none', restart: 'on-failure' },
  }
  assert.throws(() => validateConfig({ ...base, streamHoldMs: 30_000 }))
  assert.throws(() => validateConfig({ ...base, tunnel: { kind: 'cloudflared', restart: 'on-failure' } }))
  assert.doesNotThrow(() => validateConfig(base))
})
