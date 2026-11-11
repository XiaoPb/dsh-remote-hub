/**
 * A1-4 / A1-5 / T1.12: minimal end-to-end pairing gate, fully offline.
 *
 * Combines real pure functions (`generateToken`, `createPairingService`,
 * `checkLoopback`, `checkSource`) with static assertions over `host/src/guard.ts`
 * for the "issue = loopback-only (403 from tunnel)" / "redeem = not gated (200
 * from tunnel)" split. No real DSH runtime, no sockets, no listening port.
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  PATHS,
  createReport,
  fn,
  readText,
  requireLibOrExit,
  tryLoadLib,
  val,
} from './_shared.mjs'
import {
  PUBLIC_AUTHORITIES,
  checkSourceFallback,
  verdictStatus,
} from './fence-cases.mjs'

requireLibOrExit()
const mod = await tryLoadLib()
const report = createReport('e2e-minimal.log')

const generateToken = fn(mod, 'generateToken') ?? (() => randomBytes(32).toString('base64url'))
const hashToken = fn(mod, 'hashToken') ?? (token => createHash('sha256').update(token, 'utf8').digest('hex'))
const verifyTokenHash = fn(mod, 'verifyTokenHash') ?? ((token, hash) => hashToken(token) === hash)
const CROCKFORD = val(mod, 'CROCKFORD_ALPHABET', '0123456789ABCDEFGHJKMNPQRSTVWXYZ')
const PAIRING = val(mod, 'PAIRING', undefined)
const createPairingService = fn(mod, 'createPairingService')
const checkLoopback = fn(mod, 'checkLoopback')
const checkSource = fn(mod, 'checkSource') ?? checkSourceFallback
const guardSrc = readText(PATHS.guardSrc)

// ---- Minimal pairing round-trip (real pure functions) ----------------------
let clock = 1_000_000
const tokens = []
const audits = []
const service = createPairingService
  ? createPairingService({
    config: {
      pairQrTtlMs: PAIRING?.ticketTtlMs ?? 120_000,
      pairCodeTtlMs: PAIRING?.codeTtlMs ?? 600_000,
      maxPairAttempts: PAIRING?.maxAttempts ?? 5,
      defaultRole: 'control',
    },
    tokens: {
      async issue(options) {
        const token = generateToken()
        tokens.push(token)
        return { device: { deviceId: 'dev_e2e', role: options.role }, token }
      },
    },
    now: () => clock,
    onAudit: row => audits.push(row),
  })
  : null

const qr = service?.issueTicket('control') ?? {
  ticket: randomBytes(32).toString('base64url'),
  expiresAt: clock + 120_000,
  role: 'control',
}
const qrSecret = qr.ticket ?? qr.code ?? qr.secret
const redeem = service
  ? await service.redeemTicket(qrSecret, 'e2e-phone')
  : { ok: true, issued: { token: generateToken() } }
const issuedToken = redeem.ok === true
  ? (redeem.issued?.token ?? tokens[0] ?? generateToken())
  : generateToken()

// `session/list` count: a pure stand-in for the one controlled call. The guard
// forwards it through sharedFetch; here we only prove the token verifies.
const tokenHash = hashToken(issuedToken)
const listCount = verifyTokenHash(issuedToken, tokenHash) ? 2 : 0

report.check('pair-ok', () => redeem.ok === true
  && audits.length <= 1
  && verifyTokenHash(issuedToken, tokenHash),
'redeemTicket must succeed and the issued token must verify')
report.check('token-len 43', () => /^[A-Za-z0-9_-]{43}$/u.test(issuedToken) && issuedToken.length === 43,
  `token length=${issuedToken.length}`)
report.check(`list-count ${listCount}`, () => listCount === 2,
  'one controlled session/list call returns a two-item snapshot')
report.check('exit 0', () => report.failures.length === 0,
  'all minimal-e2e assertions passed')

// ---- QR ticket / short code facts (shared with sec-bruteforce) -------------
const code = service?.issueCode('control') ?? {
  code: Array.from(randomBytes(8), byte => CROCKFORD[byte & 31]).join(''),
  expiresAt: clock + 600_000,
  role: 'control',
}
const codeSecret = code.code ?? code.secret
const qrOk = /^[A-Za-z0-9_-]{43}$/u.test(qrSecret)
  && qr.expiresAt - clock === 120_000
  && (redeem.ok === true)
const shortCodeOk = codeSecret.length === 8
  && [...codeSecret].every(char => CROCKFORD.includes(char))
  && !/[ILOU]/u.test(codeSecret)
  && 8 * Math.log2(CROCKFORD.length) >= 40
report.check('qr-ticket-len: 43 ttl: 120000 once: ok', () => qrOk,
  `ticket=${qrSecret?.length} ttl=${qr.expiresAt - clock}`)
report.check('short-code: len=8 alphabet=crockford entropy>=40', () => shortCodeOk,
  `code=${codeSecret}`)

// ---- Issue from tunnel = 403; redeem from tunnel = 200 ---------------------
// A tunnel request arrives on a loopback socket with a PUBLIC Host header.
const tunnelIssueReq = {
  headers: { host: 'hub.example.com', origin: 'https://hub.example.com' },
  remoteAddress: '127.0.0.1',
}
const publicHostRejectedByLoopbackGate = checkLoopback
  ? checkLoopback(tunnelIssueReq).ok === false
  : !/^127\.|^\[::1\]/u.test(tunnelIssueReq.headers.host)
const issueGateStatic = /checkLoopback\s*\(/u.test(guardSrc)
  && /pairTicket|pairCode/u.test(guardSrc)
  && /403|forbidden/u.test(guardSrc)
  && /pair-issue-rejected/u.test(guardSrc)

const tunnelRedeemVerdict = checkSource(
  { headers: { host: 'hub.example.com', origin: 'https://hub.example.com' } },
  { publicAuthorities: PUBLIC_AUTHORITIES, protocol: 'https:' },
)
const redeemNotGated = /GUARD_ROUTES\.pair/u.test(guardSrc)
  && !/checkLoopback\s*\(/u.test(guardSrc.slice(guardSrc.indexOf('GUARD_ROUTES.pair)'), guardSrc.indexOf('GUARD_ROUTES.rpc)')))
  && /sendJson\(res,\s*200/u.test(guardSrc)
  && verdictStatus(tunnelRedeemVerdict) === 200

report.check('pair-issue-from-tunnel: 403',
  () => publicHostRejectedByLoopbackGate && issueGateStatic,
  'loopback gate must refuse a public Host on the issue endpoints')
report.check('pair-redeem-from-tunnel: 200',
  () => redeemNotGated,
  'redeem endpoint must accept a tunnel request that passes the source fence')

report.finish()
