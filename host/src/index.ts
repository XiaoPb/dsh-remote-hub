/**
 * dsh-remote-hub — host half（"被控端"）。
 *
 * 跑在 DSH 宿主进程里：`dsh plugin --profile web add link:E:/Code/DSH/plugins/dsh-remote-hub`
 *
 * 装配顺序由 `plugin.ts` 强制（D-13）：
 *   config → devices → token → pairing → policy(registerPolicy) → streams
 *   → approvals → services(hub/*) → guard → tunnel
 *
 * `policy` **必须先于第一个 `createPeer`**：没有 policy 的 principal kind 会被
 * `decide()` 以 `no-allow` 全量拒绝（不是降级为只读）。
 *
 * 浏览器半边（`exports "./client"`）由同一个包的 `dsh.client` 声明载入。
 *
 * 本文件同时是**公共 API 面**：`core/` 的全部契约常量、host 的纯函数与
 * 子系统工厂都从这里 re-export，验收脚本 `import('../lib/index.js')` 直接消费。
 *
 * @module dsh-remote-hub
 */
import type { Context } from '@deepseek-ai/cordis'

// ── core：共享契约（两个半边与契约快照的唯一真源）────────────────────────────
export * from '@core/index.js'

// ── host：配置 ────────────────────────────────────────────────────────────────
export {
  Config,
  DEFAULT_CONFIG,
  validateConfig,
  assertLoopbackLiteral,
  assertPublicAuthorities,
  isAllowedAuthority,
  isLoopbackLiteral,
} from './config.js'
export type { Config as ConfigShape } from './config.js'
import type { Config as ConfigShape } from './config.js'
import { DEFAULT_CONFIG, applyRemoteHub } from './plugin.js'

// ── host：profile 出站配对档案 ────────────────────────────────────────────────
export { createOutboundTargetStore, outboundTargetView } from './outbound-targets.js'
export type { OutboundTargetRecord, OutboundTargetView } from './outbound-targets.js'

// ── host：设备表与令牌 ────────────────────────────────────────────────────────
export {
  createDeviceStore,
  dshHome,
  expandHome,
  parseDeviceRecord,
  parseDeviceTable,
} from './devices.js'
export type { DeviceStore } from './devices.js'
export {
  generateToken,
  hashToken,
  verifyTokenHash,
  isTokenShaped,
  createTokenService,
  TOKEN_LENGTH,
  TOKEN_HASH_LENGTH,
} from './token.js'
export type { TokenService, TokenServiceDeps } from './token.js'

// ── host：运行指标与运行时配置（页面 ③④ 区的数据源）────────────────────────
export { createMetricsCollector } from './metrics.js'
export type { HubMetrics, MetricsCollector } from './metrics.js'
export {
  createRuntimeConfigStore,
  CONFIG_WRITABLE_KEYS,
  CONFIG_READONLY_KEYS,
} from './runtime-config.js'
export type { RuntimeConfigStore, ConfigSnapshot, ConfigWritableKey } from './runtime-config.js'

// ── host：配对 ────────────────────────────────────────────────────────────────
export {
  createPairingService,
  generatePairCode,
  generatePairTicket,
  isPairCodeShaped,
  isPairTicketShaped,
} from './pairing.js'
export type { PairingService, PairingServiceDeps, IssuedPairing, RedeemResult } from './pairing.js'

// ── host：来源围栏与守卫 ──────────────────────────────────────────────────────
export {
  checkSource,
  checkLoopback,
  isLoopbackHostname,
  canonicalAuthority,
} from './fence.js'
export type { SourceOptions, SourceVerdict, FenceRequest } from './fence.js'
export {
  startGuard,
  PAIR_ISSUE_HEADER,
  PAIR_ISSUE_GLOBAL,
  GUARD_READ_TIMEOUT_MS,
} from './guard.js'
export type { GuardHandle, GuardDeps } from './guard.js'

// ── host：principal / 策略 / 派发 ────────────────────────────────────────────
export { remoteDevicePrincipal, remoteDeviceOf } from './principal.js'
export type { RemoteDevicePrincipal } from './principal.js'
export {
  registerDevicePolicy,
  visibleResourceIdsFromContext,
  createVisibleResourceTracker,
  filterVisible,
} from './policy.js'
export type {
  AccessPolicyHandles,
  DevicePolicyDeps,
  VisibleResourceTracker,
  VisibleResourceTrackerDeps,
} from './policy.js'
export { createDispatcher, DISPATCH_ORIGIN } from './dispatch.js'
export type { Dispatcher, DevicePeer } from './dispatch.js'

// ── host：流 / 审批 / 文件 ────────────────────────────────────────────────────
export {
  createStreamEngine,
  gatewayStreamOpener,
} from './streams.js'
export type {
  StreamEngine,
  StreamEngineDeps,
  StreamFrame,
  StreamOpenResult,
  StreamNextResult,
  StreamTerminal,
  OpenUpstream,
} from './streams.js'
export {
  createApprovalBridge,
  deviceTargetsResolver,
  REMOTE_OUTCOMES,
  ANSWER_APPROVAL_ENDPOINT,
} from './approval-bridge.js'
export type {
  ApprovalBridge,
  ApprovalBridgeDeps,
  ApprovalFrame,
  ApprovalAuditRow,
  RemoteApprovalOutcome,
  AnswerApprovalResult,
} from './approval-bridge.js'
export {
  createSensitiveApprovalGate,
  requiresApproval,
  summarizeForApproval,
  APPROVAL_CACHE_MS,
} from './sensitive-approval.js'
export type {
  SensitiveApprovalDecision,
  SensitiveApprovalGate,
  SensitiveApprovalRequest,
} from './sensitive-approval.js'
export {
  UPLOAD_ENDPOINT,
  PREVIEW_TEXT_ENDPOINT,
  PREVIEW_BINARY_ENDPOINT,
  PREVIEW_LIST_ENDPOINT,
  PREVIEW_STAT_ENDPOINT,
  EXACT_FETCH_UPLOAD_ROUTE,
  MAX_FILE_BYTES,
  classifyPreviewError,
  previewTextArgs,
  previewBinaryArgs,
} from './files.js'
export type { PreviewTextArgs, PreviewBinaryArgs } from './files.js'

// ── host：自有 Remote 面 / 隧道 ──────────────────────────────────────────────
export { registerRemoteServices, HubStreamsService, HubDevicesService, HubAdminService, lanAddresses, readCarrierFile, writeCarrierFile } from './services/index.js'

// WebSocket 帧层（RFC 6455 子集；守卫的 /remote/ws 用它做纯转发）。
export {
  OPCODE,
  MAX_FRAME_BYTES,
  WS_GUID,
  WsProtocolError,
  FrameParser,
  computeAccept,
  handshakeResponse,
  encodeFrame,
  decodeFrame,
  closePayload,
} from './ws-frame.js'

// 守卫 WebSocket 端点（A3 形态：校验 + 认领 + 移交）。
export {
  GUARD_WS_PATH,
  HUB_WS_TARGET_PARAM,
  DEFAULT_WS_TARGET,
  ALLOWED_TARGET_PREFIXES,
  createGuardWsRoute,
} from './guard-ws.js'

// 守卫侧 Remote 流 mux 承载（路线 β：复用 ws@8，行为与官方 gateway 一致）。
export {
  createGuardMux,
  parseClientFrame,
  UplinkInbox,
  MUX_PATH,
  MUX_HEARTBEAT_MS,
  MUX_MAX_MISSED_HEARTBEATS,
  MUX_UPLINK_BYTES,
  WS_CLOSE_POLICY,
} from './guard-mux.js'

// 测试与外部工具用：`ws` 的 WebSocket 客户端（守卫 mux 内部同源依赖）。
export { WebSocket } from 'ws'
export type { HubServicesDeps, RemoteServicesHandle, AdminDeps } from './services/index.js'
export {
  startTunnel,
  tunnelArgv,
  isPermanentRefusal,
  publicUrlFromLog,
  nextBackoff,
  PERMANENT_REFUSALS,
} from './tunnel.js'
export type { TunnelHandle, BackoffState } from './tunnel.js'

// ── host：本地插件管理直连服务（不经 RPC，owner-only）───────────────────────
export {
  LocalPluginManagerService,
  LocalPluginError,
  asLocalPluginError,
  badRequest,
  unavailable,
  failureBody,
  readService,
  resolveLocalPluginUpstreams,
} from './local-plugin-manager/service.js'
export type {
  LocalPluginCallContext,
  LocalPluginUpstreams,
} from './local-plugin-manager/service.js'
export {
  applyLocalPluginManager,
  assertOwnerPeer,
  rejectUpgrade,
} from './local-plugin-manager/index.js'
export type { LocalPluginChannelHandle } from './local-plugin-manager/index.js'
export { LocalPluginEventBus, EVENT_KINDS } from './local-plugin-manager/events.js'
export type { LocalPluginEventBusOptions, LocalPluginEventName } from './local-plugin-manager/events.js'
export { createDetailFileHandler, readBundleImageAtRuntime, DETAIL_LIMITS } from './local-plugin-manager/detail-file.js'
export { detailImageResponse } from './local-plugin-manager/response.js'

// ── 插件入口 ──────────────────────────────────────────────────────────────────
export { applyRemoteHub, probeServices, name, hostInstanceId, assertGuardPortFree, resolveGuardPort, MAX_PORT_SCAN, HOST_STATUS_FILE } from './plugin.js'
export type { RemoteHubHost } from './plugin.js'

/**
 * 必需服务。
 *
 * ⚠️ **故意为空数组**（2026-11-11 桌面崩溃根因）：desktop 宿主不提供
 * `connection` / `typertGateway` / `remoteAccess`，声明式硬 inject 会让插件
 * 激活失败 → web boot 整体中止。真正的依赖检查在 `plugin.ts` 的
 * `applyRemoteHub()` 里做**软探测**：服务在 → `ctx.inject([...])` 就绪时装配；
 * 服务缺 → 告警 + 整体休眠（守卫不监听 = 零暴露），绝不抛错拖垮宿主。
 */
export const inject: readonly string[] = []

/**
 * Cordis 入口。
 * @param ctx - Host Context。
 * @param config - 已按 `Config` 解析的配置。
 */
export function apply(ctx: Context, config?: ConfigShape): void {
  applyRemoteHub(ctx, config ?? DEFAULT_CONFIG)
}
