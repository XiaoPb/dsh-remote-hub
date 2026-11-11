/**
 * dsh-remote-hub — browser half（"主控端"）。
 *
 * 由 web shell 的 `__ModuleLoader__` 载入本入口打成的 closure factory
 * （`lib/client.js`）。注册远程面板，并在同源模式下挂载官方 remote contribution。
 *
 * @module dsh-remote-hub/client
 */
import type { Context } from '@deepseek-ai/cordis'

import { applyRemoteHubClient, type ClientAssemblyOptions } from './plugin.js'

export { applyRemoteHubClient }
export { createTransport } from './transport.js'
export type { RemoteTransport, TransportOptions, ClientRequestEnvelope, ServerResponseEnvelope, StreamNextValue } from './transport.js'
export { createAccessStore } from './access.js'
export type { AccessStore, AccessSnapshot } from './access.js'
export { mountRemote } from './mount.js'
export type { MountedRemote, RemoteTarget } from './mount.js'
export { mountRemotePanel, renderPanel, visibleEndpoints } from './ui/index.js'
export type { RemotePanel, RemotePanelOptions } from './ui/index.js'
export { ApprovalSheet, OUTCOME_OPTIONS } from './ui/ApprovalSheet.js'
export type { ApprovalCardProps } from './ui/ApprovalSheet.js'

/**
 * 必需服务。
 *
 * ⚠️ **故意为空数组**：desktop 宿主不提供 `remote` / `slots`，声明式 inject 会让
 * client 激活失败 → web boot 整体中止（2026-11-11 桌面崩溃的直接死因）。
 * plugin.ts 里做**软探测**：服务在 → 装面板；服务缺 → 只装 transport + access，
 * 插件激活成功、面板不出现。fail-closed 且绝不拖垮宿主。
 */
export const inject: string[] = []

/**
 * Cordis 入口。
 * @param ctx - Client Cordis root。
 * @param options - 装配选项（由 loader 传入，可缺省）。
 */
export function apply(ctx: Context, options: ClientAssemblyOptions = {}): void {
  applyRemoteHubClient(ctx, options)
}
