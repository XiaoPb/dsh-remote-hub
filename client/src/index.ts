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
import { installOfficialPrimitives } from './local-plugin-manager/markdown.tsx'
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
 * 从宿主模块加载器取官方 `@deepseek-ai/dsh-client-ui-primitives`。
 *
 * ## 为什么要这段
 *
 * 本地插件页要复用官方的 Markdown 渲染器（`DetailDocument` → `MarkdownText`），
 * 与官方页保持一致的表格/代码高亮/数学公式渲染。那个包**不作为独立 npm 包发布**，
 * 但它由宿主模块加载器提供：官方 `dsh-client-ui-plugin-manager` 的 bundle 开头就是
 * `require("@deepseek-ai/dsh-client-ui-primitives")`。
 *
 * 我们与它处在同一个 `factory(require)` 语境（`lib/client.js` 的 `factory: (require) => {…}`），
 * 因此用完全相同的方式取用。模块系统 boot 之后 `__ModuleLoader__.create()` 已不可用，
 * 所以必须在这个时机拿。
 *
 * 取不到时不报错：本地页退回自带的轻量渲染（见 `markdown.tsx` 的 `fallbackMarkdownText`）。
 *
 * @returns 官方导出；取不到时 undefined。
 */
function loadOfficialPrimitives(): unknown {
  try {
    const require = (globalThis as { __DSH_REMOTE_HUB_REQUIRE__?: (id: string) => unknown })
      .__DSH_REMOTE_HUB_REQUIRE__
    if (typeof require !== 'function') return undefined
    return require('@deepseek-ai/dsh-client-ui-primitives')
  } catch {
    return undefined
  }
}

/**
 * Cordis 入口。
 * @param ctx - Client Cordis root。
 * @param options - 装配选项（由 loader 传入，可缺省）。
 */
export function apply(ctx: Context, options: ClientAssemblyOptions = {}): void {
  // 先把宿主提供的官方 primitives 交给本地插件页的 Markdown 渲染器
  // （须在任何渲染之前完成，且只在模块系统可用时成功）。
  installOfficialPrimitives(loadOfficialPrimitives())
  applyRemoteHubClient(ctx, options)
  // 云端路径 UI 内置（0.3.0）：等 slots/commandUi/sessions/conversation 就绪再注册，
  // 本机模式下它自身不注册任何槽位。
  applyCloudPaths(ctx)
}
