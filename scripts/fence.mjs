/**
 * A1-2 / G-2 source-fence gate.
 *
 * Six combinations plus two forged-forwarding-header groups. The verdicts come
 * from `checkSource` in `lib/index.js`; when that export is missing the script
 * uses the static reference implementation in `fence-cases.mjs` (still a real
 * three-segment check) and additionally asserts `host/src/fence.ts` declares
 * all three segments and reads none of the forwarded headers.
 *
 * Writes `scripts/fence.log` (ROADMAP §4.2 / §4.7 grep it).
 */
import {
  FENCE_CASES,
  SPOOF_HEADERS,
  checkSourceFallback,
  verdictStatus,
} from './fence-cases.mjs'
import {
  PATHS,
  createReport,
  fn,
  readText,
  requireLibOrExit,
  tryLoadLib,
} from './_shared.mjs'

requireLibOrExit()
const mod = await tryLoadLib()
const report = createReport('fence.log')

const dynamicCheckSource = fn(mod, 'checkSource')
const checkSource = dynamicCheckSource ?? checkSourceFallback
const fenceSrc = readText(PATHS.fenceSrc)

// Static contract check (always runs, even with the dynamic export present):
// three segments declared, forwarded headers never read.
const forwardHeaders = ['x-forwarded-for', 'true-client-ip', 'cf-connecting-ip']
const staticSegmentsOk = fenceSrc.includes('checkSource')
  && /publicAuthorities/u.test(fenceSrc)
  && /sec-fetch-site/u.test(fenceSrc)
  && /origin/u.test(fenceSrc)
  && /cross-site/u.test(fenceSrc)
  && /null/u.test(fenceSrc)
const staticNoForwardedReads = forwardHeaders.every(name => {
  // A mention inside a comment is fine; a `headers['x-forwarded-for']` read is not.
  const code = fenceSrc.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
  return !new RegExp(`headers\\s*\\[\\s*['"\`]${name}['"\`]\\s*\\]|header\\s*\\(\\s*req\\s*,\\s*['"\`]${name}['"\`]`, 'u').test(code)
})

const baseline = new Map()
for (const item of FENCE_CASES) {
  const verdict = checkSource({ headers: item.headers }, item.options)
  const status = verdictStatus(verdict)
  baseline.set(item.name, { status, verdict })
  report.check(
    `${item.name}: ${item.expected}`,
    () => status === item.expected && staticSegmentsOk && staticNoForwardedReads,
    `${item.name}: got ${status}, want ${item.expected}; verdict=${JSON.stringify(verdict)}`,
  )
}

// For each spoof header group, EVERY baseline case must keep its exact verdict
// (not merely "all 403" — that would mean the headers were trusted).
for (const spoof of SPOOF_HEADERS) {
  report.check(
    `${spoof.name}: same-verdict-as-baseline`,
    () => FENCE_CASES.every(item => {
      const spoofed = checkSource(
        { headers: { ...item.headers, ...spoof.headers } },
        item.options,
      )
      const expected = baseline.get(item.name)
      return verdictStatus(spoofed) === expected.status
        && spoofed.ok === expected.verdict.ok
    }) && staticNoForwardedReads,
    `${spoof.name}: at least one verdict changed when forwarding headers were added`,
  )
}

report.check(
  'all-fence-cases: ok',
  () => report.failures.length === 0
    && FENCE_CASES.every(item => baseline.get(item.name).status === item.expected)
    && staticSegmentsOk
    && staticNoForwardedReads
    && [
      baseline.get('host-loopback-no-origin').status,
      baseline.get('host-public-declared').status,
    ].every(status => status === 200)
    && [
      baseline.get('host-public-undeclared').status,
      baseline.get('origin-null').status,
      baseline.get('origin-cross-authority').status,
      baseline.get('sec-fetch-site-cross-site').status,
    ].every(status => status === 403),
  'all six fence combinations and both spoof groups must hold',
)

report.finish()
