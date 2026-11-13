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
import { join } from 'node:path'
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

// WebSocket 红线（2026-11-12 修订，路线 β）：
//
// 整机接管**必须**有 WS（架构说明 D-3 新版）。约束从「禁止能力」改为
// 「限定实现方式与依赖」：
//
//   ❌ 不得用 EventSource 自建事件通道
//   ✅ 可用 `ws`（DSH 已有传递依赖；与官方 gateway 同库同版本，行为一致）
//   ✅ 守卫是独立 http server，必须自己监听 upgrade（官方 webServer.registerUpgrade
//      只覆盖 Host 自己的 server，覆盖不到守卫的独立监听）
//   ❌ 守卫不得自己解 mux 业务协议（交给 guard-mux 的 wireStream 适配）
const forbiddenSource = [
  /\bEventSource\b/u,
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
  'event-source-absent: ok',
  () => allTs.length > 0 && sourceHits.length === 0,
  `EventSource hits: ${sourceHits.join(', ') || 'none'}`,
)
report.check(
  'ws-declared-for-takeover: ok',
  () => {
    // 路线 β：ws 必须是**声明过的**依赖（不是靠传递依赖碰运气）。
    const declared = Object.keys(pkg.dependencies ?? {}).includes('ws')
    return declared && readText(PATHS.hostSrc + '/guard-mux.ts').replace(/\\/g, '/').includes('guard-mux')
  },
  'ws must be a declared dependency (route β); takeover relies on it for the mux carrier',
)
report.check(
  'ws-via-official-api: ok',
  () => {
    const guardSrc = readText(join(PATHS.hostSrc, 'guard-ws.ts'))
    // 守卫必须只做「校验 + 移交」，不得自己解帧或建上游连接。
    return !guardSrc.includes('new WebSocket')
      && !guardSrc.includes('FrameParser')
      && guardSrc.includes('handoff')
  },
  'guard-ws must validate + hand off only (no upstream WebSocket, no frame parsing)',
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
// 7b. Carrier 契约（路线 A）：fetch 改道不改写信封、错误码透传、模式键稳定。
// ---------------------------------------------------------------------------

const carrierSrc = readText(`${PATHS.clientSrc}/carrier.ts`)
const carrierEntrySrc = readText(`${PATHS.clientSrc}/carrier-entry.ts`)
const carrierTransportSrc = readText(`${PATHS.clientSrc}/carrier-transport.ts`)
const contractCarrierSrc = readText(`${PATHS.coreSrc}/carrier-contract.ts`)

report.check(
  'carrier-envelope-passthrough: ok',
  () => carrierSrc.includes('...init')
    && carrierSrc.includes('GUARD_ROUTES.rpc')
    && carrierSrc.includes('isApiRequest'),
  'carrier must forward the official client-request envelope byte-identical to /remote/rpc',
)
report.check(
  'carrier-error-transparency: ok',
  () => !carrierSrc.includes("code: '")
    || (carrierSrc.includes('isIdentityFailure') && carrierSrc.includes('ERROR_CODES.deviceRevoked')),
  'carrier must pass official error codes through untouched (only identity failure triggers fallback)',
)
report.check(
  'carrier-install-timing: ok',
  () => carrierEntrySrc.includes('installCarrierResolvingMode')
    && carrierEntrySrc.includes('__DSH_BOOT_READY__')
    && carrierEntrySrc.includes('admin.carrier')
    && carrierSrc.includes('__DSH_TRANSPORT__'),
  'carrier must install __DSH_TRANSPORT__ AFTER desktop boot resolves '
    + '(the desktop shell writes { ownsHost, streamBaseUrl } during boot and would overwrite an earlier install)',
)
report.check(
  'carrier-ws-contract: ok',
  () => ['createWebSocket', 'streamBaseUrl', 'ownsHost'].every(field => carrierSrc.includes(field))
    && !/openStream:\s*options\.openStream\s*\?\?/.test(carrierSrc)
    && !carrierSrc.includes('openStream: options.openStream'),
  'carrier transport must expose createWebSocket + streamBaseUrl + ownsHost, '
    + 'and MUST NOT provide openStream under ANY option (a present rpc.open makes the official Remote mux never start)',
)
report.check(
  'carrier-fallback-persists-before-reload: ok',
  () => carrierSrc.includes('persistLocal') && carrierSrc.includes('then(() => reload())')
    && carrierEntrySrc.includes('persistLocal: persistLocalMode'),
  'identity failure must persist local mode to disk BEFORE reloading '
    + '(disk is the boot-time source of truth; clearing only localStorage causes a 401 reload loop)',
)
report.check(
  'carrier-stream-mapping: ok',
  () => ['streamOpen', 'streamNext', 'streamCancel'].every(method => carrierTransportSrc.includes(`HUB_METHODS.${method}`))
    && carrierTransportSrc.includes('yield item'),
  'openStream contract must map to hub/stream.{open,next,cancel} with flat per-item yields',
)
report.check(
  'carrier-mode-key: ok',
  () => contractCarrierSrc.includes("MODE_KEY = 'remote-hub.mode'")
    && contractCarrierSrc.includes("value.mode !== 'cloud'"),
  'mode state must live at the stable localStorage key with fail-closed local fallback',
)

// 设备管理路由必须与签发端同门控（回环 + 进程内令牌），不得成为裸管理面。
const guardSrc = readText(PATHS.guardSrc)
report.check(
  'device-admin-loopback-gated: ok',
  () => guardSrc.includes('GUARD_ROUTES.devicesRevoke')
    && guardSrc.includes('device admin is loopback-only')
    && (guardSrc.match(/checkLoopback\(req\)/gu) ?? []).length >= 2,
  'device admin routes must require loopback + pairIssueToken (same gate as pairing issue)',
)
report.check(
  'ws-no-privilege-escalation: ok',
  () => {
    const pluginSrc = readText(PATHS.pluginSrc ?? `${PATHS.hostSrc}/plugin.ts`)
    // WS 的 Peer 必须用 remote-device（角色矩阵生效），不得再用 owner 升权。
    // 官方事实（api-gateway/lib/index.js）：$events 只要求 interactions=answer，
    // 只有 $events/result 才强制 owner——所以非 owner 能看事件流。
    const admitBlock = pluginSrc.slice(
      pluginSrc.indexOf('admit: (request, device)'),
      pluginSrc.indexOf('admit: (request, device)') + 1200,
    )
    return admitBlock.includes('remoteDevicePrincipal')
      && admitBlock.includes("interactions: 'answer'")
      && !/principal:\s*\{\s*kind:\s*'owner'\s*\}/u.test(pluginSrc)
  },
  'WS Peer must speak for remote-device with the device role (not owner); '
    + 'the role matrix must apply to the long connection too',
)
report.check(
  'ws-device-connections-droppable: ok',
  () => {
    const muxSrc = readText(`${PATHS.hostSrc}/guard-mux.ts`)
    const pluginSrc = readText(PATHS.pluginSrc ?? `${PATHS.hostSrc}/plugin.ts`)
    return muxSrc.includes('closeDevice') && muxSrc.includes('byDevice')
      && pluginSrc.includes('dropDevice')
      && pluginSrc.includes("dropDevice(deviceId, 'revoked')")
      && pluginSrc.includes("dropDevice(deviceId, 'displaced')")
      && pluginSrc.includes("dropDevice(deviceId, 'role-changed')")
  },
  'revoke / displace / role-change must close that device\'s existing WS and Peer '
    + '(tokens are checked at handshake, so a live socket never expires by itself)',
)
report.check(
  'guard-port-auto-shift: ok',
  () => {
    const pluginSrc = readText(PATHS.pluginSrc ?? `${PATHS.hostSrc}/plugin.ts`)
    // 端口被占必须**自动顺延**而不是整体失败；同时保留严格模式供调用方选择。
    return pluginSrc.includes('export async function resolveGuardPort')
      && pluginSrc.includes('MAX_PORT_SCAN')
      && pluginSrc.includes('export async function assertGuardPortFree')
      && /resolvedPort !== requestedPort/u.test(pluginSrc)
  },
  'guard port must auto-shift to the next free port instead of failing the whole assembly '
    + '(tunnel and pair links derive from guard.origin, so a shift is safe)',
)
report.check(
  'dsh-home-respected: ok',
  () => {
    const devicesSrc = readText(PATHS.devicesSrc ?? `${PATHS.hostSrc}/devices.ts`)
    const servicesSrc = readText(PATHS.servicesSrc ?? `${PATHS.hostSrc}/services/index.ts`)
    return devicesSrc.includes('export function dshHome')
      && devicesSrc.includes('process.env.DSH_HOME')
      && servicesSrc.includes('dshHome()')
  },
  'persistence paths must honor DSH_HOME (dsh-box/multi-instance isolation); '
    + 'hardcoding homedir() writes sandbox state into the real ~/.dsh',
)
report.check(
  'duplicate-load-fails-closed: ok',
  () => {
    const policySrc = readText(`${PATHS.hostSrc}/policy.ts`)
    const servicesSrc = readText(`${PATHS.hostSrc}/services/index.ts`)
    return !policySrc.includes('onDuplicatePolicy')
      && !servicesSrc.includes('alreadyRegistered')
      && servicesSrc.includes('new HubStreamsService(ctx, deps.streams)')
      && servicesSrc.includes('new HubDevicesService(ctx, deps)')
  },
  'duplicate policy/service registration must fail rather than reuse another assembly\'s dependencies',
)
report.check(
  'single-controller-enforced: ok',
  () => guardSrc.includes('config.singleController')
    // 2026-11-12 修订：单控只**踢连接**（displaceOthers，标记 displacedAt），
    // 不再吊销配对（旧实现调 tokens.revoke，会让被挤设备必须重新扫码）。
    && guardSrc.includes('displaceOthers')
    && guardSrc.includes('displacedAt')
    && !guardSrc.includes('revokeOthers')
    && readText(PATHS.configSrc).includes('singleController'),
  'single-controller must DISPLACE (drop the connection, keep the pairing) rather than revoke, and be configurable',
)
report.check(
  'pairing-qr-encoder: ok',
  () => {
    const qrSrc = readText(`${PATHS.clientSrc}/panel/qr.ts`)
    return qrSrc.includes('QR_MAX_BYTES = 106')
      && qrSrc.includes('export function encodeQr')
      && qrSrc.includes('rsRemainder')
  },
  'pairing page must ship its own QR encoder (no network dependency at runtime)',
)

// 局域网信任域：只放宽到私网，公网必须走隧道/VPN。
const fenceSrc = readText(PATHS.fenceSrc)
const configSrc = readText(PATHS.configSrc)
report.check(
  'lan-private-only: ok',
  () => configSrc.includes('assertBindableHost')
    && configSrc.includes('function isPrivateAddress')
    && fenceSrc.includes('allowPrivate')
    && fenceSrc.includes('checkPrivatePeer'),
  'LAN mode must accept private authorities only (RFC1918/ULA) and keep public access tunnel/VPN-gated',
)
report.check(
  'lan-no-public-bind: ok',
  () => {
    // lan 模式的绑定断言必须显式拒绝公网字面量。
    const body = configSrc.slice(configSrc.indexOf('export function assertBindableHost'))
    const fn = body.slice(0, body.indexOf('\n}\n') + 3)
    return fn.includes('isPrivateAddress') && fn.includes('public exposure must go through the tunnel')
  },
  'binding a public address must be refused even in LAN mode',
)

// 扫码：必须能在没有 BarcodeDetector 的 Windows/Electron 上工作（自研解码器）。
report.check(
  'scanner-self-contained: ok',
  () => {
    const scannerSrc = readText(`${PATHS.clientSrc}/panel/QrScanner.ts`)
    const decoderSrc = readText(`${PATHS.clientSrc}/panel/qr-decode.ts`)
    return scannerSrc.includes('getUserMedia')
      && scannerSrc.includes('getTracks')
      && decoderSrc.includes('export function decodeQrGray')
      && decoderSrc.includes('export function decodeQrMatrix')
  },
  'camera scanning must ship its own QR decoder (Electron on Windows lacks BarcodeDetector)',
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
      // 7 条基础路由（health/pairTicket/pairCode/pair/rpc/devices/devicesRevoke）
      // + 2 条管理端点（stats/config；2026-11-11 四区改造新增）= 9。
      && Object.keys(guardRoutes).length === 9
      && Object.keys(streamBudget).length === 6
  },
  'out/contract.json must have exactly six keys and no method-name vocabulary',
)

report.finish()
