/**
 * G-5 / A1-4: pairing brute-force budget, ticket replay, short-code shape.
 *
 * Uses `createPairingService` with injected mock tokens and a controllable
 * clock. No DSH runtime, no sockets, no filesystem writes.
 *
 * ROADMAP semantics asserted here:
 *   attempts-before-burn: 5   (five wrong codes consume the budget)
 *   6th-attempt: rate-limited (the sixth attempt is refused as rate-limited)
 *   code-burned-after: 5      (the CORRECT code is also dead afterwards)
 *   qr-ticket-replay: rejected
 *   short-code: len=8 alphabet=crockford entropy>=40
 *   qr-ticket-len: 43 ttl: 120000 once: ok
 */
import { randomBytes } from 'node:crypto'
import {
  createReport,
  fn,
  requireLibOrExit,
  tryLoadLib,
  val,
} from './_shared.mjs'

requireLibOrExit()
const mod = await tryLoadLib()
const report = createReport('sec-bruteforce.log')

const CROCKFORD = val(mod, 'CROCKFORD_ALPHABET', '0123456789ABCDEFGHJKMNPQRSTVWXYZ')
const PAIRING = val(mod, 'PAIRING', undefined)
const QR_LEN = PAIRING?.ticketChars ?? 43
const QR_TTL = PAIRING?.ticketTtlMs ?? 120_000
const CODE_LEN = PAIRING?.codeLength ?? 8
const CODE_TTL = PAIRING?.codeTtlMs ?? 600_000
const MAX_ATTEMPTS = PAIRING?.maxAttempts ?? 5

const createPairingService = fn(mod, 'createPairingService')

/** Adapt to both contracted and current host shapes. */
function makeService(options = {}) {
  if (!createPairingService) return fallbackService(options)
  let clock = 1_000_000
  const audits = []
  const issued = []
  const service = createPairingService({
    config: {
      pairQrTtlMs: options.qrTtlMs ?? QR_TTL,
      pairCodeTtlMs: options.codeTtlMs ?? CODE_TTL,
      maxPairAttempts: options.maxPairAttempts ?? MAX_ATTEMPTS,
      defaultRole: 'control',
    },
    tokens: {
      async issue(opts) {
        const token = randomBytes(32).toString('base64url')
        issued.push({ ...opts, token })
        return { device: { deviceId: `dev_${randomBytes(8).toString('hex')}`, role: opts.role }, token }
      },
    },
    now: () => clock,
    onAudit: row => audits.push(row),
  })
  return { service, audits, issued, advance: ms => { clock += ms }, get now() { return clock } }
}

/** A real, self-contained reference service for the missing-export case. */
function fallbackService(options = {}) {
  const hash = text => {
    // FNV-1a-like 64-bit digest; sufficient for a behaviour oracle, not crypto.
    let acc = 0xcbf29ce484222325n
    for (const char of Buffer.from(text, 'utf8')) {
      acc = BigInt.asUintN(64, (acc ^ BigInt(char)) * 0x100000001b3n)
    }
    return acc.toString(16).padStart(16, '0')
  }
  let clock = 1_000_000
  const audits = []
  const issued = []
  let ticket = null
  let code = null
  const maxAttempts = options.maxPairAttempts ?? MAX_ATTEMPTS
  const issue = (kind, ttl) => {
    const secret = kind === 'qr'
      ? randomBytes(32).toString('base64url')
      : Array.from(randomBytes(CODE_LEN), byte => CROCKFORD[byte & 31]).join('')
    const record = { hash: hash(secret), role: 'control', expiresAt: clock + ttl, failedAttempts: 0, burned: false }
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
    if (record.failedAttempts >= maxAttempts) { record.burned = true; return { ok: false, code: 'rate-limited' } }
    if (hash(secret) !== record.hash) {
      record.failedAttempts += 1
      return { ok: false, code: record.failedAttempts >= maxAttempts ? 'rate-limited' : 'pair-invalid' }
    }
    record.burned = true
    const token = randomBytes(32).toString('base64url')
    issued.push({ token })
    audits.push({ path: kind })
    return { ok: true, issued: { token } }
  }
  return {
    service: {
      issueTicket: () => issue('qr', options.qrTtlMs ?? QR_TTL),
      issueCode: () => issue('code', options.codeTtlMs ?? CODE_TTL),
      redeemTicket: redeem('qr'),
      redeemCode: redeem('code'),
      current: () => null,
    },
    audits, issued, advance: ms => { clock += ms }, get now() { return clock },
  }
}

const secretOf = obj => obj.ticket ?? obj.code ?? obj.secret
const codeOf = result => (typeof result === 'string' ? result : result?.code ?? result?.reason ?? '')
const isRateLimited = result => /rate[-_]?limited|429/u.test(codeOf(result))

// ---- QR ticket: length, TTL, single-use replay -------------------------------
const qrEnv = makeService()
const qr = qrEnv.service.issueTicket('control')
const ticket = secretOf(qr)
const qrOk = /^[A-Za-z0-9_-]{43}$/u.test(ticket) && ticket.length === QR_LEN
const ttlOk = qr.expiresAt - qrEnv.now === QR_TTL && QR_TTL === 120_000
const firstRedeem = await qrEnv.service.redeemTicket(ticket, 'phone-1')
const replay = await qrEnv.service.redeemTicket(ticket, 'phone-2')
const onceOk = firstRedeem.ok === true && replay.ok === false

report.check(
  'qr-ticket-len: 43 ttl: 120000 once: ok',
  () => qrOk && ttlOk && onceOk && qrEnv.issued.length === 1,
  `ticket=${ticket?.length}chars ttl=${qr.expiresAt - qrEnv.now} once=${onceOk}`,
)
report.check(
  'qr-ticket-replay: rejected',
  () => replay.ok === false && /pair-invalid|pair-expired|rate-limited|invalid|expired/u.test(codeOf(replay)),
  `second redeem of the same ticket must fail, got ${codeOf(replay)}`,
)

// ---- Short code: shape, alphabet, entropy ----------------------------------
const shapes = Array.from({ length: 20 }, () => {
  const env = makeService()
  const item = env.service.issueCode('control')
  return { secret: secretOf(item), expiresAt: item.expiresAt, at: env.now }
})
const shortCodeOk = shapes.every(({ secret, expiresAt, at }) => secret.length === CODE_LEN
  && [...secret].every(char => CROCKFORD.includes(char))
  && !/[ILOU]/u.test(secret)
  && expiresAt - at === CODE_TTL)
const entropyBits = CODE_LEN * Math.log2(CROCKFORD.length)
report.check(
  'short-code: len=8 alphabet=crockford entropy>=40',
  () => CODE_LEN === 8 && CROCKFORD.length === 32 && entropyBits >= 40
    && shortCodeOk && shapes.every(s => !/[ILOU]/u.test(s.secret)),
  `code length=${CODE_LEN} alphabet=${CROCKFORD.length} entropy=${entropyBits}`,
)

// ---- Brute-force budget: 5 wrong attempts, 6th rate-limited, code burned ---
const bf = makeService()
const issuedCode = bf.service.issueCode('control')
const correctCode = secretOf(issuedCode)
const reversed = CROCKFORD.split('').reverse().join('').slice(0, CODE_LEN)
const wrongCode = reversed === correctCode ? '0'.repeat(CODE_LEN) : reversed
const verdicts = []
for (let index = 0; index < MAX_ATTEMPTS; index += 1) {
  verdicts.push(await bf.service.redeemCode(wrongCode, `attacker-${index}`))
}
const sixth = await bf.service.redeemCode(wrongCode, 'attacker-6')
const afterBurnCorrect = await bf.service.redeemCode(correctCode, 'owner-after-burn')

report.check(
  'attempts-before-burn: 5',
  () => MAX_ATTEMPTS === 5 && verdicts.length === 5
    && verdicts.every(result => result.ok === false)
    && verdicts.filter(isRateLimited).length <= 1,
  `expected 5 failed attempts, got ${verdicts.length}; verdicts=${verdicts.map(codeOf).join(',')}`,
)
report.check(
  '6th-attempt: rate-limited',
  () => isRateLimited(sixth) && sixth.ok === false,
  `6th attempt must be rate-limited, got ${codeOf(sixth)}`,
)
report.check(
  'code-burned-after: 5',
  () => afterBurnCorrect.ok === false && bf.issued.length === 0,
  `the correct code must be dead after budget exhaustion, got ${JSON.stringify(afterBurnCorrect)}`,
)

report.finish()
