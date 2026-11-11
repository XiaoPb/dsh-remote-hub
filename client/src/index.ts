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
}
