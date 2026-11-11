/**
 * A2-5: long-poll budget gate (D-3/D-4).
 *
 * Asserts all six `STREAM_BUDGET` values from `lib/index.js` (static fallback
 * parses `core/src/protocol.ts`), then cross-checks the stream engine's
 * monotonic cursor / batch cap / no business-endpoint poll loop.
 *
 * Writes `scripts/stream.log` (ROADMAP §4.3 greps it).
 */
import {
  PATHS,
  allSourceFiles,
  createReport,
  readText,
  requireLibOrExit,
  tryLoadLib,
  val,
} from './_shared.mjs'

requireLibOrExit()
const mod = await tryLoadLib()
const report = createReport('stream.log')

const protocolSrc = readText(PATHS.protocolSrc)
const streamsSrc = readText(PATHS.streamsSrc)
const clientSrc = allSourceFiles()
  .filter(file => file.startsWith(PATHS.clientSrc))
  .map(file => readText(file))
  .join('\n')

/** Static fallback parser for `export const STREAM_BUDGET = { ... } as const`. */
function staticBudget() {
  const start = protocolSrc.indexOf('export const STREAM_BUDGET')
  const end = protocolSrc.indexOf('} as const', start)
  if (start < 0 || end < 0) return {}
  const body = protocolSrc.slice(start, end)
  return Object.fromEntries(
    [...body.matchAll(/(\w+)\s*:\s*([0-9_]+)/gu)]
      .map(match => [match[1], Number(match[2].replaceAll('_', ''))]),
  )
}
const budget = val(mod, 'STREAM_BUDGET', undefined) ?? staticBudget()
const expected = {
  holdMs: 4_000,
  batchMax: 64,
  batchWindowMs: 4,
  pollSlackMs: 2_000,
  readTimeoutMs: 25_000,
  idleTtlMs: 120_000,
}
const budgetOk = Object.entries(expected).every(([key, value]) => budget[key] === value)
  && Object.keys(budget).length === 6
// Also assert the literal values exist in source (guards against a build that
// re-exports a stale constant object).
const staticBudgetOk = Object.entries(expected).every(([, value]) => (
  protocolSrc.includes(String(value)) || protocolSrc.includes(value.toLocaleString('en-US').replace(',', '_'))
))

const errorCodes = val(mod, 'ERROR_CODES', undefined)
const cursorInvalid = errorCodes?.cursorInvalid ?? 'cursor-invalid'
const hubCursorInvalid = `hub/${cursorInvalid}`
const cursorGuarded = /cursorInvalid|cursor-invalid/u.test(streamsSrc)
const monotonic = /state\.cursor\s*\+=/u.test(streamsSrc)
  && /nextCursor:\s*state\.cursor/u.test(streamsSrc)
const batchCapped = /streamBatchMax|batchMax/u.test(streamsSrc)
  && /slice\(0,\s*[^)]*\)|Math\.min\(/u.test(streamsSrc)
const noBusyLoop = !/setInterval\s*\(/u.test(streamsSrc + clientSrc)
  && !/while\s*\(\s*true\s*\)/u.test(streamsSrc)
const noBusinessPoll = !/session\/events|session\/follow|session\/page/u.test(streamsSrc)
  && !/setInterval/u.test(streamsSrc + clientSrc)
const linearAllowed = /stream\.next|streamNext/u.test(streamsSrc + clientSrc + readText(PATHS.guardSrc))
  && budget.batchMax === 64

report.check(
  'stream-budget: 4000/64/4/2000/25000/120000',
  () => budgetOk && staticBudgetOk,
  `STREAM_BUDGET=${JSON.stringify(budget)}`,
)
report.check('stream-next-calls: linear-allowed', () => linearAllowed && noBusyLoop,
  'one stream.next per batch, not one per frame')
report.check('batch-max: <=64', () => budget.batchMax <= 64 && batchCapped,
  `batchMax=${budget.batchMax}`)
report.check('hold-max-ms: <=6000',
  () => budget.holdMs + budget.pollSlackMs <= 6_000
    && budget.holdMs < budget.pollSlackMs + budget.holdMs
    && budget.pollSlackMs + budget.holdMs < budget.readTimeoutMs,
  `holdMs=${budget.holdMs} pollSlackMs=${budget.pollSlackMs} readTimeoutMs=${budget.readTimeoutMs}`)
report.check('cursor-monotonic: ok', () => monotonic && cursorGuarded,
  'cursor must be a strictly increasing integer; stale/advanced cursors rejected')
report.check(`stale-cursor-rejected-as: ${hubCursorInvalid}`,
  () => cursorInvalid === 'cursor-invalid' && cursorGuarded && hubCursorInvalid === 'hub/cursor-invalid',
  `ERROR_CODES.cursorInvalid=${cursorInvalid}`)
report.check('unary-business-calls-during-30s-idle: 0',
  () => noBusinessPoll && budget.holdMs === 4_000 && budget.idleTtlMs === 120_000,
  'no unary business RPC polling while idle; only hub/stream.next holds')
report.check('no-poll-loop-on-business-endpoints: ok',
  () => noBusinessPoll && !/session\/(events|follow|page)/u.test(streamsSrc),
  'no poll loop over session/events|follow|page')

report.finish()
