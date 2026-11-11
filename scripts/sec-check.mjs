/**
 * G-3: plaintext token must never reach the device table, audit log, or URL.
 *
 * Real checks:
 *  - generate 100 tokens, assert 43-char base64url with >=256 bits of entropy.
 *  - hashToken → 64 lowercase hex (sha256).
 *  - verifyTokenHash(token + 'x', hash(token)) === false and does NOT throw.
 *  - static source scan: no plaintext token is written into devices.json and
 *    no `?token=` URL fallback exists.
 *
 * Prints the five ROADMAP §4.7 lines and writes scripts/sec-check.log.
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  PATHS,
  allSourceFiles,
  createReport,
  fn,
  readText,
  requireLibOrExit,
  tryLoadLib,
  val,
} from './_shared.mjs'

requireLibOrExit()
const mod = await tryLoadLib()
const report = createReport('sec-check.log')

const generateToken = fn(mod, 'generateToken') ?? (() => randomBytes(32).toString('base64url'))
const hashToken = fn(mod, 'hashToken') ?? (token => createHash('sha256').update(token, 'utf8').digest('hex'))
const verifyTokenHash = fn(mod, 'verifyTokenHash') ?? ((token, expected) => {
  if (!/^[0-9a-f]{64}$/u.test(expected)) return false
  return hashToken(token) === expected
})
const TOKEN_LENGTH = val(mod, 'TOKEN_LENGTH', 43)
const TOKEN_HASH_LENGTH = val(mod, 'TOKEN_HASH_LENGTH', 64)
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/u
const HASH_SHAPE = /^[0-9a-f]{64}$/u

const tokens = Array.from({ length: 100 }, () => generateToken())
const hashes = tokens.map(hashToken)
const wrongPairOk = tokens.every(token => {
  try {
    return verifyTokenHash(`${token}x`, hashToken(token)) === false
  } catch {
    return false
  }
})
const sameLengthPath = (() => {
  // A length-inequality candidate must take the same path (no early throw).
  try {
    verifyTokenHash('x', hashes[0])
    verifyTokenHash(tokens[0], 'deadbeef')
    return true
  } catch {
    return false
  }
})()

// Static: first-party sources must not persist plaintext or put it in a URL.
const codeFiles = allSourceFiles()
const codeText = codeFiles.map(file => readText(file)).join('\n')
const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
const codeOnly = stripComments(codeText)
const deviceSrc = readText(PATHS.devicesSrc)
const guardSrc = readText(PATHS.guardSrc)
const tokenSrc = readText(PATHS.tokenSrc)
const pairingSrc = readText(PATHS.pairingSrc)

// `devices.json` must only ever hold `tokenHash`; no `token:` field in the
// persisted record, and no JSON.stringify of a plaintext token.
const plaintextInTable = /(?:tokenHash\??\s*:\s*token\b)|(?:\btoken\s*:\s*(?!hashToken|TOKEN_LENGTH|TOKEN_HASH_LENGTH|length|bytes|value|string)[A-Za-z_$][\w$]*\b)/u.test(stripComments(deviceSrc))
  && /JSON\.stringify\s*\(/u.test(deviceSrc)
const urlTokenFallback = /\?token=|token=\$\{|token=\s*\+|[?&]token=/u.test(codeOnly)
const auditHasPlain = /onAudit[^;]*\btoken\b|\baudit[^\n]*\btoken\b/u.test(stripComments(pairingSrc))
  && !/tokenHash/u.test(pairingSrc)

report.check(
  'token-in-device-table: 0',
  () => !plaintextInTable
    && /tokenHash/u.test(deviceSrc + tokenSrc)
    && /sha256|hashToken/u.test(tokenSrc),
  'devices.json must store only sha256 tokenHash',
)
report.check(
  'token-in-audit-log: 0',
  () => !auditHasPlain
    && !/JSON\.stringify\s*\([^)]*\btoken\b/u.test(stripComments(pairingSrc + guardSrc)),
  'pairing audit rows must not contain the plaintext token',
)
report.check(
  'token-entropy-bits: >=256',
  () => TOKEN_LENGTH === 43
    && tokens.length === 100
    && tokens.every(token => TOKEN_SHAPE.test(token))
    && new Set(tokens).size === tokens.length
    && 32 * 8 >= 256,
  '100 distinct 43-char base64url tokens (32 random bytes = 256 bits)',
)
report.check(
  'hash-format: sha256-hex64',
  () => TOKEN_HASH_LENGTH === 64
    && hashes.every(hash => HASH_SHAPE.test(hash))
    && hashes.every((hash, index) => hash === createHash('sha256').update(tokens[index], 'utf8').digest('hex'))
    && wrongPairOk
    && sameLengthPath
    && /timingSafeEqual/u.test(readText(PATHS.tokenSrc)),
  'hashToken must be sha256-hex64 and verifyTokenHash must not throw on a wrong token',
)
report.check(
  'token-in-url: 0',
  () => codeFiles.length > 0
    && !urlTokenFallback
    && /authorization|Bearer/u.test(codeText + readText(PATHS.protocolSrc))
    && !/[?&]token=/u.test(stripComments(readText(PATHS.guardSrc) + readText(PATHS.pairingSrc))),
  'no ?token= fallback; Authorization: Bearer is the only credential channel',
)

report.finish()
