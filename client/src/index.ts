/**
 * dsh-remote-hub — browser half（"主控端"）。
 *
 * 由 web shell 的 `__ModuleLoader__` 载入本入口打成的 closure factory
 * （`lib/client.js`）。注册远程面板，并在同源模式下挂载官方 remote contribution。
 *
 * @module dsh-remote-hub/client
 */
import type { Context } from '@deepseek-ai/cordis'

// Carrier 安装：**不在 factory 内**。
//
// ⚠️ 2026-11-12 页面实测：整个 bundle 被包在 `__ModuleLoader__.load({factory})` 里，
// factory 由 DSH 启动 cordis 时才调用，而官方 `connection.apply()` 在同一次启动里
// **同步**读取 `__DSH_TRANSPORT__` 并闭包捕获 fetch。CDP 时序探针实测：
//   connection 54ms 读取（undefined），carrier 125ms 才写入 → 接管失效。
//
// 现在 carrier 由 tsdown 单独打成 `lib/carrier-boot.js`（IIFE），并在
// `lib/client.js` 的 **banner** 里同步内联执行——位置在 factory 之前。
// 本入口只负责插件本身的装配，不再触发 carrier。

import { applyRemoteHubClient, getRemoteHubClient, type ClientAssemblyOptions } from './plugin.js'
import { applyCloudPaths } from './paths/mount.js'

export { applyRemoteHubClient, getRemoteHubClient }
export { installCarrier, createCarrier, isApiRequest, isIdentityFailure } from './carrier.js'
export type { CarrierInstallResult, CarrierOptions, CarrierFallback } from './carrier.js'
export { createTransport } from './transport.js'
export type { RemoteTransport, TransportOptions, ClientRequestEnvelope, ServerResponseEnvelope, StreamNextValue } from './transport.js'
export { createAccessStore } from './access.js'
export type { AccessStore, AccessSnapshot } from './access.js'
export { mountRemote } from './mount.js'
export type { MountedRemote, RemoteTarget } from './mount.js'
export { mountRemotePanel, renderPanel, visibleEndpoints } from './ui/index.js'
export type { RemotePanel, RemotePanelOptions } from './ui/index.js'
export { renderRemoteHubPage, createRemoteHubPageComponent, createSettingsActions, classifyPairSecret, normalizeOrigin, remainingSeconds, buildPairLink, parsePairLink, PAIR_LINK_MARKER } from './panel/RemoteHubPage.js'
export type { RemoteHubPageState, RemoteHubPageActions, RemoteHubPageDeps, CloudDeviceRow, GuardStatus, IssuedPairing, HubInjected } from './panel/RemoteHubPage.js'
export { encodeQr, encodeCodewords, QR_SIZE, QR_MAX_BYTES } from './panel/qr.js'
export { decodeQrGray, decodeQrMatrix } from './panel/qr-decode.js'
export { QrScanner } from './panel/QrScanner.js'
export type { QrMatrix } from './panel/qr.js'
export { renderNavIcon } from './panel/NavIcon.js'
export { ApprovalSheet, OUTCOME_OPTIONS } from './ui/ApprovalSheet.js'
export type { ApprovalCardProps } from './ui/ApprovalSheet.js'
// 云端路径 UI（0.3.0 起内置，原独立伴生包 @xiaopb/dsh-remote-paths）。
export { applyCloudPaths } from './paths/mount.js'
export { cloudPathContext, pathRpc, OPEN_REMOTE_FILES, RemoteFilesDialog, RemoteDirectoryFlow } from './paths/index.js'
export type { CloudPathContext, DirectoryListing, WorkspaceListing, PathEntry } from './paths/context.js'

/**
 * 必需服务。
 *
 * ⚠️ **故意为空数组**：本 entry `inject: []` 立即激活，绝不因等待服务而 pending
 * 到 web boot 收尾被 qZ 判死（2026-11-11 桌面崩溃的死因）。`remote`（api-gateway
 * client 提供）与 `slots`（dsh-client-ui-renderer client 提供）都**晚于**本 entry
 * 就绪，plugin.ts 用 `ctx.inject(deps, cb)` 做**延迟装配**：服务就绪自动挂载、
 * 永不就绪安静不挂；装配异常 try/catch 降级。fail-closed 且绝不拖垮宿主。
 */
export const inject: string[] = []

/**
 * Cordis 入口。
 * @param ctx - Client Cordis root。
 * @param options - 装配选项（由 loader 传入，可缺省）。
 */
export function apply(ctx: Context, options: ClientAssemblyOptions = {}): void {
  applyRemoteHubClient(ctx, options)
  // 云端路径 UI 内置（0.3.0）：等 slots/commandUi/sessions/conversation 就绪再注册，
  // 本机模式下它自身不注册任何槽位。
  applyCloudPaths(ctx)
}
