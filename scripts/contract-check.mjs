/**
 * A2-3 contract snapshot + capability-matrix / dependency gates.
 *
 * Prints the eight acceptance lines from ROADMAP §4.3 and writes
 * `out/contract.json` — deliberately WITHOUT any method-name vocabulary table
 * (D-1: REMOTE_METHODS/REMOTE_EVENTS were removed; the official envelope is
 * the only wire shape). Every line is backed by a real dynamic assertion when
 * `lib/index.js` exports the helper, and by a real static source-text
 * assertion when that export is missing (never a silent skip).
 */
import { existsSync } from 'node:fs'
import {
  PATHS,
  allSourceFiles,
  createReport,
  fn,
  readPackage,
  readText,
  requireLibOrExit,
  tryImport,
  tryLoadLib,
  val,
  writeJson,
} from './_shared.mjs'

requireLibOrExit()
const mod = await tryLoadLib()
const report = createReport('contract-check.log')

const pkg = readPackage()
const capsSrc = readText(PATHS.capabilitiesSrc)
const redlinesSrc = readText(PATHS.redlinesSrc)
const protocolSrc = readText(PATHS.protocolSrc)
const allTs = allSourceFiles()

// ---------------------------------------------------------------------------
// Static fallbacks. These parse the actual first-party sources; they are real
// assertions (a drifted table/matrix fails them), not canned "ok" strings.
// ---------------------------------------------------------------------------

/** Extract a `export const NAME = [ '...', ... ]` string array. */
function staticStringArray(src, name) {
  const match = new RegExp(`export const ${name}\\b[^=]*=\\s*\\[([\\s\\S]*?)\\]`, 'u').exec(src)
  if (!match) return []
  return [...match[1].matchAll(/'([^']*)'/gu)].map(entry => entry[1])
}

/** Extract a `export const NAME = { 'key': {...} } as const` object's keys/values. */
function staticConstObject(src, name, valuePattern = "'([^']*)'") {
  const start = src.indexOf(`export const ${name}`)
  if (start < 0) return {}
  const open = src.indexOf('{', start)
  const close = src.indexOf('} as const', open)
  if (open < 0 || close < 0) return {}
  const body = src.slice(open + 1, close)
  const result = {}
  const re = new RegExp(`([A-Za-z_$][\\w$]*)\\s*:\\s*${valuePattern}`, 'gu')
  for (const entry of body.matchAll(re)) {
    const raw = entry[2]
    result[entry[1]] = /^\d[\d_]*$/u.test(raw) ? Number(raw.replaceAll('_', '')) : raw
  }
  return result
}

/** Endpoint table keys, parsed from `core/src/capabilities.ts`. */
function staticEndpointTable(src) {
  const start = src.indexOf('export const ENDPOINT_TABLE')
  const end = src.indexOf('export type RoleMatrix', start)
  const body = start < 0 ? '' : src.slice(start, end < 0 ? src.length : end)
  return new Set([...body.matchAll(/^\s*'([A-Za-z0-9_$.-]+\/[A-Za-z0-9_$.-]+)'\s*:/gmu)].map(m => m[1]))
}

/** All endpoint literals inside each role's matrix block. */
function staticRoleActions(src, roleConst) {
  const start = src.indexOf(`const ${roleConst}: RoleMatrix`)
  if (start < 0) return []
  const next = src.indexOf('\n}\n', start)
  const body = src.slice(start, next < 0 ? src.length : next)
  return [...body.matchAll(/'([A-Za-z0-9_$.-]+\/[A-Za-z0-9_$.-]+)'/gu)].map(m => m[1])
}

const tableKeys = staticEndpointTable(capsSrc)
const matrixActions = {
  'read-only': staticRoleActions(capsSrc, 'READ_ONLY'),
  control: staticRoleActions(capsSrc, 'CONTROL'),
  full: staticRoleActions(capsSrc, 'FULL'),
}
const allMatrixActions = [...new Set(Object.values(matrixActions).flat())]

function staticRedlineHit(action) {
  const namespaces = staticStringArray(redlinesSrc, 'NEVER_DELEGATED_NAMESPACES')
  const endpoints = staticStringArray(redlinesSrc, 'NEVER_DELEGATED_ENDPOINTS')
  const internals = staticStringArray(redlinesSrc, 'NEVER_DELEGATED_INTERNALS')
  return endpoints.includes(action)
    || internals.includes(action)
    || namespaces.some(prefix => prefix !== '' && action.startsWith(prefix))
}

function staticUntraceable() {
  return allMatrixActions.filter(action => !tableKeys.has(action)).sort()
}

function staticContainment() {
  const ro = new Set(matrixActions['read-only'])
  const control = new Set(matrixActions.control)
  const full = new Set(matrixActions.full)
  if (ro.size === 0 || control.size === 0 || full.size === 0) return false
  return [...ro].every(action => control.has(action))
    && [...control].every(action => full.has(action))
}

// ---------------------------------------------------------------------------
// 1. Capability actions traceable + untraceable count
// ---------------------------------------------------------------------------

const untraceableFn = fn(mod, 'untraceableActions')
const untraceable = untraceableFn
  ? [...untraceableFn()].sort()
  : staticUntraceable()

report.check(
  'capability-actions: traceable to endpoint-table-or-typert-enumeration',
  () => {
    if (untraceableFn) {
      const table = val(mod, 'ENDPOINT_TABLE', undefined)
      if (!table || typeof table !== 'object') return false
      const keys = new Set(Object.keys(table))
      for (const role of ['read-only', 'control', 'full']) {
        const actionsFn = fn(mod, 'allActionsFor')
        if (!actionsFn) break
        for (const action of actionsFn(role)) {
          // A table hit, or a namespace enumerated outside the table
          // (pluginManager/pluginMarket) — the latter is checked by the
          // redline-namespace line below, and such actions are never delegated.
          if (!keys.has(action) && !staticRedlineHit(action)) return false
        }
      }
      return untraceable.length === 0
    }
    return tableKeys.size > 0 && allMatrixActions.length > 0 && untraceable.length === 0
  },
  `untraceable capability actions: ${untraceable.join(', ') || 'none'}`,
)

report.check(
  'untraceable-actions: 0',
  () => untraceable.length === 0,
  `untraceableActions() must be empty, got ${untraceable.join(', ')}`,
)

// ---------------------------------------------------------------------------
// 2. Role containment
// ---------------------------------------------------------------------------

const containmentFn = fn(mod, 'assertRoleContainment')
report.check(
  'role-containment: read-only subset control subset full',
  () => {
    if (containmentFn) containmentFn() // throws when containment is broken
    const actionsFn = fn(mod, 'allActionsFor')
    if (actionsFn) {
      const ro = new Set(actionsFn('read-only'))
      const control = new Set(actionsFn('control'))
      const full = new Set(actionsFn('full'))
      return [...ro].every(a => control.has(a)) && [...control].every(a => full.has(a))
    }
    return staticContainment()
  },
  'read-only ⊆ control ⊆ full (allActionsFor / static matrix parse)',
)

// ---------------------------------------------------------------------------
// 3. Deprecated session/page must be absent from the matrix
// ---------------------------------------------------------------------------

const deprecatedFn = fn(mod, 'deprecatedActionsInMatrix')
const dynamicDeprecated = deprecatedFn ? [...deprecatedFn()] : []
// ROADMAP T2.1 / A2-3 require `session/page` (@deprecated, superseded by
// `session/events`) to be ABSENT from the *matrix*. When the built helper is
// missing — or returns the legacy "known deprecated list" instead of the
// matrix-intersection list — fall back to parsing the matrix source itself.
// The line is always printed; the assertion is always real.
const deprecated = allMatrixActions.filter(a => a === 'session/page')
report.check(
  'deprecated-session-page: absent',
  () => {
    if (deprecatedFn) deprecatedFn() // must not throw
    // Spec: `deprecatedActionsInMatrix()` length MUST be 0; a non-zero
    // result fails the gate. The static matrix parse is the second, independent
    // check (ROADMAP T2.1: `session/page` must not appear in the matrix).
    return deprecated.length === 0
      && (!deprecatedFn || dynamicDeprecated.length === 0)
  },
  `session/page must be absent from the matrix; got ${deprecated.join(', ') || 'none'}`
    + ` (deprecatedActionsInMatrix()=${dynamicDeprecated.join(', ') || 'none'})`,
)

// ---------------------------------------------------------------------------
// 4. Allow-list × red-line intersection
// ---------------------------------------------------------------------------

const noRedlineFn = fn(mod, 'assertNoRedlineDelegated')
const neverDelegatedFn = fn(mod, 'isNeverDelegated')
const allActionsFn = fn(mod, 'allActionsFor')
const fullActions = allActionsFn ? [...allActionsFn('full')] : matrixActions.full
const intersections = fullActions.filter(action => (
  neverDelegatedFn ? neverDelegatedFn(action) : staticRedlineHit(action)
))

report.check(
  'allowlist-x-redlines-intersection: empty',
  () => {
    if (noRedlineFn) noRedlineFn() // throws when any redline was delegated
    return intersections.length === 0 && fullActions.length > 0
  },
  `redline endpoints found in full matrix: ${intersections.join(', ') || 'none'}`,
)

// ---------------------------------------------------------------------------
// 5. Red-line namespace enumeration
// ---------------------------------------------------------------------------

const namespaces = Array.isArray(val(mod, 'NEVER_DELEGATED_NAMESPACES', undefined))
  ? [...mod.NEVER_DELEGATED_NAMESPACES]
  : staticStringArray(redlinesSrc, 'NEVER_DELEGATED_NAMESPACES')
report.check(
  'redline-namespace-check: pluginManager,pluginMarket enumerated',
  () => namespaces.includes('pluginManager/')
    && namespaces.includes('pluginMarket/')
    && readText(PATHS.redlinesSrc).includes('pluginManager')
    && readText(PATHS.redlinesSrc).includes('pluginMarket'),
  'NEVER_DELEGATED_NAMESPACES must enumerate pluginManager/ and pluginMarket/',
)

// ---------------------------------------------------------------------------
// 6. No WebSocket / EventSource / upgrade handlers anywhere, no `ws` dep
// ---------------------------------------------------------------------------

const forbiddenSource = [
  /\bnew\s+WebSocket\b/u,
  /\bEventSource\b/u,
  /\bregisterUpgrade\b/u,
  /\bon\s*\(\s*['"`]upgrade['"`]/u,
]
const sourceHits = []
for (const file of allTs) {
  const text = readText(file)
  for (const pattern of forbiddenSource) {
    if (pattern.test(text)) sourceHits.push(`${file}:${pattern.source}`)
  }
}
const depKeys = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
]
report.check(
  'ws-absent: ok',
  () => allTs.length > 0
    && sourceHits.length === 0
    && !depKeys.includes('ws'),
  `ws/EventSource/upgrade hits: ${sourceHits.join(', ') || 'none'}; ws dep: ${depKeys.includes('ws')}`,
)

// ---------------------------------------------------------------------------
// 7. No `@deepseek-ai/dsh-client-runtime` dependency (D-8 / F21)
// ---------------------------------------------------------------------------

// A dependency declaration or an import specifier is a hard violation (D-8 /
// F21: the package does not exist in 0.2.2-rc.1). Comments/TODOs may quote the
// historical name as documentation, so they are stripped before matching.
const clientImports = allSourceFiles()
  .filter(file => file.startsWith(PATHS.clientSrc))
  .flatMap(file => {
    const text = readText(file)
    const strip = text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
    return [...strip.matchAll(/\bfrom\s+['"`]([^'"`]+)['"`]|\bimport\s*\(\s*['"`]([^'"`]+)['"`]/gu)]
      .map(match => match[1] ?? match[2])
      .filter(name => name.includes('dsh-client-runtime'))
      .map(name => `${file}:${name}`)
  })
const declaredDeps = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
]
const depHits = declaredDeps.filter(name => name.includes('dsh-client-runtime'))
const runtimeHits = [...depHits, ...clientImports]
report.check(
  'no-dsh-client-runtime: ok',
  () => runtimeHits.length === 0,
  `dsh-client-runtime dependency/import hits: ${runtimeHits.join(', ') || 'none'}`,
)

// ---------------------------------------------------------------------------
// 8. out/contract.json — six keys, zero method-name vocabulary
// ---------------------------------------------------------------------------

// ROADMAP T3.10: the envelope snapshot comes from the official connection
// package's public schema exports. When that optional package is unavailable
// in the profile, write the documented fallback shape verbatim.
let officialEnvelopeSnapshot = { package: '@deepseek-ai/dsh-client-connection', exported: true }
const connection = await tryImport('@deepseek-ai/dsh-client-connection')
if (connection !== null) {
  officialEnvelopeSnapshot = {
    package: '@deepseek-ai/dsh-client-connection',
    clientRequestSchema: connection.clientRequestSchema !== undefined,
    serverResponseSchema: connection.serverResponseSchema !== undefined,
    exported: connection.clientRequestSchema !== undefined && connection.serverResponseSchema !== undefined,
  }
}

const guardRoutes = val(mod, 'GUARD_ROUTES', undefined) ?? staticConstObject(protocolSrc, 'GUARD_ROUTES')
const streamBudget = val(mod, 'STREAM_BUDGET', undefined)
  ?? staticConstObject(protocolSrc, 'STREAM_BUDGET', '([0-9_]+)')
const errorCodes = val(mod, 'ERROR_CODES', undefined) ?? staticConstObject(protocolSrc, 'ERROR_CODES')
const roleNames = Array.isArray(val(mod, 'ROLE_NAMES', undefined)) ? [...mod.ROLE_NAMES] : ['read-only', 'control', 'full']
const roleLabels = val(mod, 'ROLE_LABELS', undefined) ?? { 'read-only': { zh: '只读', en: 'Read-only' }, control: { zh: '可操作', en: 'Control' }, full: { zh: '完全', en: 'Full' } }

const contract = {
  guardRoutes,
  protocolVersion: val(mod, 'PROTOCOL_VERSION', Number(/PROTOCOL_VERSION\s*=\s*(\d+)/u.exec(protocolSrc)?.[1] ?? 1)),
  errorCodes,
  // Capability *facts* (roles, labels, containment, per-role counts) — NOT a
  // method-name vocabulary. Android mirrors these, not the endpoint table.
  capabilities: {
    roles: roleNames,
    labels: roleLabels,
    containment: 'read-only<=control<=full',
    actionCounts: Object.fromEntries(roleNames.map(role => [
      role,
      allActionsFn ? allActionsFn(role).length : new Set(matrixActions[role] ?? []).size,
    ])),
  },
  streamBudget,
  officialEnvelopeSnapshot,
}

writeJson(PATHS.contractJson, contract)

const contractText = readText(PATHS.contractJson)
const methodVocabulary = /\b(?:session|workspaceFiles|workspace|terminal|job|goals|fileUploads|userQuestions|settings|hub|credentials|directoryPicker|pluginManager|pluginMarket|pluginInventory|account|remoteAccess)\/[A-Za-z0-9_$.-]+/u
const requiredKeys = ['guardRoutes', 'protocolVersion', 'errorCodes', 'capabilities', 'streamBudget', 'officialEnvelopeSnapshot']
report.check(
  'contract-snapshot: written',
  () => {
    const parsed = JSON.parse(contractText)
    return existsSync(PATHS.contractJson)
      && requiredKeys.every(key => Object.prototype.hasOwnProperty.call(parsed, key))
      && Object.keys(parsed).length === requiredKeys.length
      && !methodVocabulary.test(contractText)
      && !contractText.includes('REMOTE_METHODS')
      && !contractText.includes('HUB_METHODS')
      && Object.keys(guardRoutes).length === 5
      && Object.keys(streamBudget).length === 6
  },
  'out/contract.json must have exactly six keys and no method-name vocabulary',
)

report.finish()
