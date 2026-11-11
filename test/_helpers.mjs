/**
 * Shared helpers for `test/*.test.mjs`.
 *
 * `node --test test/*.test.mjs` may run before `pnpm build`, so importing
 * `lib/index.js` must never crash a test. When an export is missing, tests fall
 * back to a real static source assertion plus (where behaviour is needed) a
 * self-contained reference implementation of the same contract. Tests still
 * assert the mandated behaviour; they never silently skip.
 *
 * Only node builtins + node:test + node:assert/strict are used.
 * @module test/_helpers.mjs
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  fn,
  readPackage,
  satisfiesRange,
  val,
  versionMatrixLine,
} from '../scripts/_shared.mjs'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const PATHS = Object.freeze({
  lib: join(ROOT, 'lib', 'index.js'),
  packageJson: join(ROOT, 'package.json'),
  coreSrc: join(ROOT, 'core', 'src'),
  hostSrc: join(ROOT, 'host', 'src'),
  clientSrc: join(ROOT, 'client', 'src'),
  fenceSrc: join(ROOT, 'host', 'src', 'fence.ts'),
  approvalSrc: join(ROOT, 'host', 'src', 'approval-bridge.ts'),
  filesSrc: join(ROOT, 'host', 'src', 'files.ts'),
  guardSrc: join(ROOT, 'host', 'src', 'guard.ts'),
  streamsSrc: join(ROOT, 'host', 'src', 'streams.ts'),
  configSrc: join(ROOT, 'host', 'src', 'config.ts'),
  tokenSrc: join(ROOT, 'host', 'src', 'token.ts'),
  pairingSrc: join(ROOT, 'host', 'src', 'pairing.ts'),
  devicesSrc: join(ROOT, 'host', 'src', 'devices.ts'),
  capabilitiesSrc: join(ROOT, 'core', 'src', 'capabilities.ts'),
  redlinesSrc: join(ROOT, 'core', 'src', 'capabilities-redlines.ts'),
  protocolSrc: join(ROOT, 'core', 'src', 'protocol.ts'),
})

/**
 * `lib/index.js` namespace, or `{}` when the artifact is absent/unloadable.
 * Relative to test/: ../lib/index.js. Tests degrade to static assertions plus
 * reference implementations; they never crash on a missing build.
 */
export async function testLoadLib() {
  if (!existsSync(PATHS.lib)) return {}
  try {
    return await import('../lib/index.js')
  } catch {
    return {}
  }
}

/** UTF-8 file contents ('' when missing). */
export function read(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Token primitives: dynamic export first, real reference implementation second.
// ---------------------------------------------------------------------------
export function tokenPrimitives(mod) {
  const generateToken = fn(mod, 'generateToken') ?? (() => randomBytes(32).toString('base64url'))
  const hashToken = fn(mod, 'hashToken') ?? (token => createHash('sha256').update(token, 'utf8').digest('hex'))
  const verifyTokenHash = fn(mod, 'verifyTokenHash') ?? ((token, expected) => {
    if (typeof token !== 'string' || typeof expected !== 'string') return false
    if (!/^[0-9a-f]{64}$/u.test(expected)) return false
    const left = Buffer.from(hashToken(token), 'hex')
    const right = Buffer.from(expected, 'hex')
    return left.length === right.length && timingSafeEqual(left, right)
  })
  const isTokenShaped = fn(mod, 'isTokenShaped')
    ?? (value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value))
  return {
    generateToken,
    hashToken,
    verifyTokenHash,
    isTokenShaped,
    TOKEN_LENGTH: val(mod, 'TOKEN_LENGTH', 43),
    TOKEN_HASH_LENGTH: val(mod, 'TOKEN_HASH_LENGTH', 64),
    dynamic: Boolean(fn(mod, 'generateToken') && fn(mod, 'verifyTokenHash')),
  }
}

// ---------------------------------------------------------------------------
// Pairing service: dynamic export or a real reference implementation matching
// the contracted semantics (5 wrong attempts, 6th rate-limited, correct dead).
// ---------------------------------------------------------------------------
export function pairingService(mod, overrides = {}) {
  const CROCKFORD = val(mod, 'CROCKFORD_ALPHABET', '0123456789ABCDEFGHJKMNPQRSTVWXYZ')
  const PAIRING = val(mod, 'PAIRING', undefined)
  const qrTtl = PAIRING?.ticketTtlMs ?? 120_000
  const codeTtl = PAIRING?.codeTtlMs ?? 600_000
  const maxAttempts = PAIRING?.maxAttempts ?? 5
  const createPairingService = fn(mod, 'createPairingService')
  const issued = []
  const audits = []
  let clock = 1_000_000

  const tokens = {
    async issue(options) {
      const token = randomBytes(32).toString('base64url')
      issued.push({ ...options, token })
      return { device: { deviceId: `dev_${issued.length}`, role: options.role }, token }
    },
  }

  if (createPairingService) {
    const service = createPairingService({
      config: {
        pairQrTtlMs: overrides.qrTtlMs ?? qrTtl,
        pairCodeTtlMs: overrides.codeTtlMs ?? codeTtl,
        maxPairAttempts: overrides.maxPairAttempts ?? maxAttempts,
        defaultRole: 'control',
      },
      tokens,
      now: () => clock,
      onAudit: row => audits.push(row),
    })
    return {
      service, issued, audits, CROCKFORD, maxAttempts, qrTtl, codeTtl,
      advance: ms => { clock += ms }, get now() { return clock }, dynamic: true,
    }
  }

  // Reference implementation (no lib export).
  const hash = text => createHash('sha256').update(text, 'utf8').digest('hex')
  let ticket = null
  let code = null
  const make = (kind, ttl) => {
    const secret = kind === 'qr'
      ? randomBytes(32).toString('base64url')
      : Array.from(randomBytes(8), byte => CROCKFORD[byte & 31]).join('')
    const record = { hash: hash(secret), role: 'control', expiresAt: clock + ttl, failed: 0, burned: false }
    if (kind === 'qr') ticket = record
    else code = record
    const out = { role: 'control', expiresAt: record.expiresAt }
    out[kind === 'qr' ? 'ticket' : 'code'] = secret
    return out
  }
  const redeem = kind => async secret => {
    const record = kind === 'qr' ? ticket : code
    if (!record || record.burned) return { ok: false, code: 'pair-invalid' }
    if (clock > record.expiresAt) { record.burned = true; return { ok: false, code: 'pair-expired' } }
    if (record.failed >= maxAttempts) { record.burned = true; return { ok: false, code: 'rate-limited' } }
    if (hash(secret) !== record.hash) {
      record.failed += 1
      return { ok: false, code: record.failed >= maxAttempts ? 'rate-limited' : 'pair-invalid' }
    }
    record.burned = true
    const minted = await tokens.issue({ label: 'test', role: 'control' })
    audits.push({ path: kind })
    return { ok: true, issued: { token: minted.token } }
  }
  return {
    service: {
      issueTicket: () => make('qr', overrides.qrTtlMs ?? qrTtl),
      issueCode: () => make('code', overrides.codeTtlMs ?? codeTtl),
      redeemTicket: redeem('qr'),
      redeemCode: redeem('code'),
      current: () => null,
    },
    issued, audits, CROCKFORD, maxAttempts, qrTtl, codeTtl,
    advance: ms => { clock += ms }, get now() { return clock }, dynamic: false,
  }
}

/** Extract `ticket` / `code` / `secret` from either host shape. */
export const secretOf = obj => obj.ticket ?? obj.code ?? obj.secret

/** Static fallback for `checkSource` (three-segment fence). */
export { checkSourceFallback, verdictStatus, FENCE_CASES, SPOOF_HEADERS } from '../scripts/fence-cases.mjs'

/** Parse a `export const NAME = { ... } as const` object into a plain object. */
export function staticConstObject(src, name) {
  const start = src.indexOf(`export const ${name}`)
  if (start < 0) return {}
  const open = src.indexOf('{', start)
  const close = src.indexOf('} as const', open)
  if (open < 0 || close < 0) return {}
  const body = src.slice(open + 1, close)
  return Object.fromEntries(
    [...body.matchAll(/(\w+)\s*:\s*'([^']*)'|(\w+)\s*:\s*([0-9_]+)/gu)]
      .map(match => [match[1] ?? match[3], match[2] ?? Number(String(match[4]).replaceAll('_', ''))]),
  )
}

/** Parse `export const NAME = [ '...' ]`. */
export function staticStringArray(src, name) {
  const match = new RegExp(`export const ${name}\\b[^=]*=\\s*\\[([\\s\\S]*?)\\]`, 'u').exec(src)
  return match ? [...match[1].matchAll(/'([^']*)'/gu)].map(entry => entry[1]) : []
}

/** All `<ns>/<method>` literals in a named role matrix block. */
export function staticRoleActions(src, roleConst) {
  const start = src.indexOf(`const ${roleConst}: RoleMatrix`)
  const end = src.indexOf('\n}\n', start)
  const body = start < 0 ? '' : src.slice(start, end < 0 ? src.length : end)
  return [...body.matchAll(/'([A-Za-z0-9_$.-]+\/[A-Za-z0-9_$.-]+)'/gu)].map(match => match[1])
}

/** Endpoint-table keys from core/src/capabilities.ts. */
export function staticEndpointKeys(src) {
  const start = src.indexOf('export const ENDPOINT_TABLE')
  const end = src.indexOf('export type RoleMatrix', start)
  const body = start < 0 ? '' : src.slice(start, end < 0 ? src.length : end)
  return new Set([...body.matchAll(/^\s*'([A-Za-z0-9_$.-]+\/[A-Za-z0-9_$.-]+)'\s*:/gmu)].map(m => m[1]))
}

export { readPackage, satisfiesRange, versionMatrixLine, fn, val }
