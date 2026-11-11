/**
 * A2-2 / G-7 red-line gates.
 *
 * For each red-line endpoint the verdict is computed from
 * `isNeverDelegated(ep)` AND `allActionsFor('full')` (the strongest role), never
 * hard-coded. A missing export degrades to a static parse of
 * `core/src/capabilities-redlines.ts` + `core/src/capabilities.ts`, but the
 * mandated line is still printed and still backed by a real assertion.
 *
 * ROADMAP §4.3 / §4.7 greps `scripts/redlines.log`.
 */
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
const report = createReport('redlines.log')

const REDLINE_ENDPOINTS = [
  'credentials/describe', 'credentials/set', 'credentials/unset',
  'settings/update', 'settings/replace', 'settings/mutate', 'settings/openSettingsDocument',
  'directoryPicker/pick', 'directoryPicker/list', 'directoryPicker/createDirectory',
  'pluginInventory/list',
  'account/getState', 'account/getProfile', 'account/getBalance',
  'remoteAccess/follow',
]

const neverDelegatedFn = fn(mod, 'isNeverDelegated')
const allActionsFn = fn(mod, 'allActionsFor')
const assertNoRedlineFn = fn(mod, 'assertNoRedlineDelegated')
const namespaces = Array.isArray(val(mod, 'NEVER_DELEGATED_NAMESPACES', undefined))
  ? [...mod.NEVER_DELEGATED_NAMESPACES]
  : [...readText(PATHS.redlinesSrc).matchAll(/^\s*'([A-Za-z]+\/)'/gmu)].map(m => m[1])
const redlineSrc = readText(PATHS.redlinesSrc)
const capsSrc = readText(PATHS.capabilitiesSrc)

// Static fallback: parse the literal endpoint/namespace/internal arrays.
function staticStringArray(src, name) {
  const match = new RegExp(`export const ${name}\\b[^=]*=\\s*\\[([\\s\\S]*?)\\]`, 'u').exec(src)
  return match ? [...match[1].matchAll(/'([^']*)'/gu)].map(m => m[1]) : []
}
const staticEndpoints = staticStringArray(redlineSrc, 'NEVER_DELEGATED_ENDPOINTS')
const staticNamespaces = staticStringArray(redlineSrc, 'NEVER_DELEGATED_NAMESPACES')
const staticInternals = staticStringArray(redlineSrc, 'NEVER_DELEGATED_INTERNALS')
const staticRedline = ep => staticEndpoints.includes(ep)
  || staticInternals.includes(ep)
  || staticNamespaces.some(prefix => ep.startsWith(prefix))

/** All action literals from a named role matrix block. */
function staticRoleActions(roleConst) {
  const start = capsSrc.indexOf(`const ${roleConst}: RoleMatrix`)
  const end = capsSrc.indexOf('\n}\n', start)
  const body = start < 0 ? '' : capsSrc.slice(start, end < 0 ? capsSrc.length : end)
  return [...body.matchAll(/'([A-Za-z0-9_$.-]+\/[A-Za-z0-9_$.-]+)'/gu)].map(m => m[1])
}
const fullActions = allActionsFn
  ? new Set(allActionsFn('full'))
  : new Set([...staticRoleActions('FULL'), ...staticRoleActions('CONTROL'), ...staticRoleActions('READ_ONLY')])

const isRedline = ep => (neverDelegatedFn ? neverDelegatedFn(ep) : staticRedline(ep))

// One real assertion per endpoint: red-lined AND never granted to `full`.
for (const ep of REDLINE_ENDPOINTS) {
  report.check(
    `redline ${ep}: denied`,
    () => isRedline(ep) && !fullActions.has(ep),
    `${ep}: isNeverDelegated=${isRedline(ep)}, inFullMatrix=${fullActions.has(ep)}`,
  )
}

// $events / $events/result are Gateway internals. The device Peer is created
// with `interactions: 'none'` (D-13), so the stream cannot even be opened.
const internals = Array.isArray(val(mod, 'NEVER_DELEGATED_INTERNALS', undefined))
  ? [...mod.NEVER_DELEGATED_INTERNALS]
  : staticInternals
// `interactions: 'none'` fixes the device Peer (D-13); the static fact lives
// in whichever host module owns createPeer (today `host/src/dispatch.ts`).
const hostText = allSourceFiles()
  .filter(file => file.startsWith(PATHS.hostSrc))
  .map(file => readText(file))
  .join('\n')
const interactionsNone = /\binteractions\s*:\s*['"`]none['"`]/u.test(hostText)
  || /\binteractions\s*=\s*['"`]none['"`]/u.test(hostText)
report.check(
  'redline events-stream: rejected-by-interactions-none',
  () => ['$events', '$events/result'].every(ep => internals.includes(ep) && isRedline(ep))
    && interactionsNone,
  '$events/$events/result must be internal red-lines and Peer interactions must be none',
)

report.check(
  'redline-namespace-check: pluginManager,pluginMarket enumerated',
  () => namespaces.includes('pluginManager/')
    && namespaces.includes('pluginMarket/')
    && redlineSrc.includes('pluginManager')
    && redlineSrc.includes('pluginMarket')
    && isRedline('pluginManager/install')
    && isRedline('pluginMarket/install'),
  'pluginManager/ and pluginMarket/ must be enumerated namespace red-lines',
)

report.check(
  'allowlist-x-redlines-intersection: empty',
  () => {
    if (assertNoRedlineFn) assertNoRedlineFn()
    const intersections = [...fullActions].filter(ep => isRedline(ep))
    return intersections.length === 0 && fullActions.size > 0
  },
  `allow-list ∩ red-lines = ${[...fullActions].filter(ep => isRedline(ep)).join(', ') || 'empty'}`,
)

report.check(
  'redlines: all-denied',
  () => REDLINE_ENDPOINTS.every(ep => isRedline(ep) && !fullActions.has(ep))
    && report.failures.length === 0,
  `all ${REDLINE_ENDPOINTS.length} red-line endpoints must be denied for role full`,
)

report.finish()
