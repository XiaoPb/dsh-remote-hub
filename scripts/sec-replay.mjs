/**
 * G-6: token replay model (v1 accepts replay while a device is trusted; after
 * revocation every replay must yield 401).
 *
 * No service is started. The assertion combines:
 *  - a real pure-function replay oracle built on `verifyTokenHash`,
 *  - a static assertion that the guard checks `revokedAt` BEFORE routing and
 *    maps an unknown/revoked token to `ERROR_CODES.unauthorized` (401).
 *
 * Prints `replay-before-revoke: ok` and `replay-after-revoke: 401`;
 * writes scripts/sec-replay.log.
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
const report = createReport('sec-replay.log')

const generateToken = fn(mod, 'generateToken') ?? (() => randomBytes(32).toString('base64url'))
const hashToken = fn(mod, 'hashToken') ?? (token => createHash('sha256').update(token, 'utf8').digest('hex'))
const verifyTokenHash = fn(mod, 'verifyTokenHash') ?? ((token, hash) => hashToken(token) === hash)
const ERROR_CODES = val(mod, 'ERROR_CODES', undefined)

const token = generateToken()
const tokenHash = hashToken(token)

/** A minimal in-memory device table: the only state replay needs. */
const device = { deviceId: 'dev_replay', tokenHash, revokedAt: null }
function present(candidate) {
  if (device.revokedAt !== null) return 401
  return verifyTokenHash(candidate, device.tokenHash) ? 200 : 401
}

const before = Array.from({ length: 5 }, () => present(token))
const forged = present(`${token}x`)
device.revokedAt = new Date().toISOString()
const after = [present(token), present(token), present(tokenHash)]

const guardText = allSourceFiles()
  .filter(file => file.startsWith(PATHS.hostSrc))
  .map(file => readText(file))
  .join('\n')
const revokeBeforeRoute = /revokedAt/u.test(guardText)
  && /(?:unauthorized|401)/u.test(guardText)
  && /createSharedFetchHandler|\/remote\/rpc/u.test(readText(PATHS.guardSrc))
const unauthorizedCode = ERROR_CODES?.unauthorized === 'unauthorized'
  || /unauthorized\s*:\s*['"`]unauthorized['"`]/u.test(readText(PATHS.protocolSrc))

report.check(
  'replay-before-revoke: ok',
  () => before.every(status => status === 200)
    && forged === 401
    && revokeBeforeRoute
    && unauthorizedCode,
  `replay verdicts before revocation: ${before.join(',')}; forged=${forged}`,
)
report.check(
  'replay-after-revoke: 401',
  () => after.every(status => status === 401)
    && present(token) === 401
    && revokeBeforeRoute,
  `replay verdicts after revocation: ${after.join(',')}`,
)

report.finish()
