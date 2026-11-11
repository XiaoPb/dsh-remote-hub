/**
 * A2-6 / G-8: approval waterfall bridge gate (D-5).
 *
 * Static source assertions over `host/src/approval-bridge.ts` (no DSH runtime):
 *   - `next()` is called for invisible sessions (owner requests not swallowed)
 *   - NO `approval.request(` call site
 *   - NO code path actively returns `'unavailable'`
 *   - outcomes are exactly `allowed-once | rejected | cancelled`
 *   - exactly one audit row per remote answer
 *
 * Writes `scripts/approval.log` (ROADMAP §4.3 / §4.7 grep it).
 */
import {
  PATHS,
  createReport,
  readText,
  requireLibOrExit,
} from './_shared.mjs'

requireLibOrExit()
const report = createReport('approval.log')

const src = readText(PATHS.approvalSrc)
// Strip block/line comments so prose in the design notes cannot satisfy or
// break a code-shape assertion; the real code is what matters.
const code = src
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .split('\n')
  .map(line => (line.trimStart().startsWith('//') ? '' : line))
  .join('\n')

const outcomes = ['allowed-once', 'rejected', 'cancelled']
const declaredOutcomes = /REMOTE_OUTCOMES\s*[^=]*=\s*\[([^\]]*)\]/u.exec(code)
const outcomeLiterals = declaredOutcomes
  ? [...declaredOutcomes[1].matchAll(/'([^']+)'/gu)].map(match => match[1])
  : []
const outcomesOk = outcomes.every(value => outcomeLiterals.includes(value))
  && outcomeLiterals.length === 3
  && !outcomeLiterals.includes('unavailable')
  && /RemoteApprovalOutcome/u.test(code)

const nextCalled = /\breturn\s+next\s*\(\s*\)/u.test(code)
  && /on\s*\(\s*['"`]approval\/request['"`]/u.test(code)
  && /resolveTargets/u.test(code)
  && /eligible\.length\s*===\s*0\s*\)\s*return\s+null/u.test(code.replace(/\s+/gu, ' '))

const approvalRequestSites = [...code.matchAll(/\bapproval\s*\.\s*request\s*\(/gu)].length
  + [...code.matchAll(/\bctx\s*\.\s*approval\s*\.\s*request\s*\(/gu)].length
const unavailableReturned = /\breturn\s+['"`]unavailable['"`]/u.test(code)
  || /['"`]unavailable['"`]\s*as\s+RemoteApprovalOutcome/u.test(code)
  || /resolve\s*\(\s*['"`]unavailable['"`]\s*\)/u.test(code)

// One audit row per accepted answer: `audit({...})` must appear exactly once
// in the answer path, and `answer()` must be the only place that calls it.
const auditCalls = [...code.matchAll(/\baudit\s*\(/gu)].length
const auditInAnswer = /answer\s*\([\s\S]*?audit\s*\(\s*\{/u.test(code)
  || (code.indexOf('audit(') > code.indexOf('answer(input)'))
const auditOk = auditCalls === 1 && auditInAnswer
  && /onAudit/u.test(code)

report.check(
  'remote-outcomes: subset-of[allowed-once,rejected,cancelled]',
  () => outcomesOk && /outcomeOptions:\s*REMOTE_OUTCOMES/u.test(code),
  `REMOTE_OUTCOMES=${JSON.stringify(outcomeLiterals)}`,
)
report.check(
  'unavailable-returned-by-bridge: 0',
  () => !unavailableReturned,
  'bridge must never actively return unavailable',
)
report.check(
  'owner-request-not-swallowed: ok',
  () => nextCalled,
  'invisible/unanswerable requests must be handed back via next()',
)
report.check(
  'next-called-for-invisible-session: 1',
  () => nextCalled && [...code.matchAll(/\bnext\s*\(\s*\)/gu)].length >= 1,
  'exactly one next() hand-back path for an invisible session',
)
report.check(
  'approval-request-call-sites: 0',
  () => approvalRequestSites === 0,
  `approval.request( call sites=${approvalRequestSites}`,
)
report.check(
  'audit-rows: 1',
  () => auditOk,
  `audit() call sites=${auditCalls}`,
)

report.finish()
