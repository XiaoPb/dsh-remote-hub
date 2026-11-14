/**
 * 本地插件页的控制器：官方 `PluginManagerController` 的**只换数据源**版本。
 *
 * ## 为什么这么薄
 *
 * 官方控制器（vendored 的 `manager-store.ts`）已经把「怎么读、怎么安装、怎么取消、怎么报错、怎么提示」
 * 全部写好了；它唯一与环境绑定的是「调用发往哪里」。本插件在 vendored 副本里把那 15 处调用收敛成
 * `PluginManagerSender` 接缝（ADR-010），于是这里只需要：
 *
 * ```ts
 * class LocalPluginManagerController extends PluginManagerController {
 *   constructor(ctx, transport) { super(ctx, new LocalPluginManagerSender(transport)) }
 * }
 * ```
 *
 * 页面的状态机、对话框、进度与文案因此与官方页**逐行一致**，差异只在数据到达本机插件管理服务而不是云端。
 *
 * @module dsh-remote-hub/client/local-plugin-manager/local-controller
 */
import type { Context } from '@deepseek-ai/cordis'

import type {
  BundleDetail,
  BundleInfo,
  ChangeResult,
  PluginEntryId,
  PluginInfo,
  PluginInstallCancellation,
  PluginInstallRequestId,
  PluginRegistries,
  PluginSpecInspection,
  PluginUpdateResult,
  PluginVersionList,
  Registry,
} from './official-stubs.ts'
import { PluginManagerController, type PluginManagerSender } from './manager-store.ts'
import type { LocalPluginManagerClient, LocalPluginAnswer } from './transport.ts'

/**
 * 把直连通道的 `Answer` 形状转成控制器期待的形状。
 *
 * 两者本来就同构（`{ ok, value } | { ok, error }`），这里只做一次**防御性规范化**：
 * 保证 `error.details` 是对象，避免下游 `failureOf` 之类在 `details` 缺省时读到 undefined。
 * @param answer - 直连通道的返回值。
 * @returns 规范化后的返回值。
 */
function normalize<T>(answer: LocalPluginAnswer<T>): LocalPluginAnswer<T> {
  if (answer.ok) return answer
  return {
    ok: false,
    error: {
      code: answer.error.code,
      message: answer.error.message,
      details: answer.error.details ?? {},
    },
  }
}

/**
 * 本机数据源的发送层。
 *
 * 每个方法对应一条 `POST /api/hub/local-plugin-manager/<method>`（见 `transport.ts` 与 `02-contract.md`）；
 * 参数顺序与官方 `pluginManager` 方法**逐位一致**，所以 vendored 控制器的调用点无需任何改写。
 */
export class LocalPluginManagerSender implements PluginManagerSender {
  /**
   * @param transport - 本机直连客户端。
   */
  constructor(private readonly transport: LocalPluginManagerClient) {}

  listBundles(): Promise<LocalPluginAnswer<readonly BundleInfo[]>> {
    return this.transport.call<readonly BundleInfo[]>('listBundles').then(normalize)
  }

  listPlugins(): Promise<LocalPluginAnswer<readonly PluginInfo[]>> {
    return this.transport.call<readonly PluginInfo[]>('listPlugins').then(normalize)
  }

  listInventory(): Promise<LocalPluginAnswer<{ readonly managementAvailable?: boolean }>> {
    return this.transport.call<{ readonly managementAvailable?: boolean }>('listInventory').then(normalize)
  }

  registries(): Promise<LocalPluginAnswer<PluginRegistries>> {
    return this.transport.call<PluginRegistries>('registries').then(normalize)
  }

  fastestRegistry(): Promise<LocalPluginAnswer<string | null>> {
    return this.transport.call<string | null>('fastestRegistry').then(normalize)
  }

  inspect(
    spec: string,
    options: { readonly registry?: Registry },
    signal?: AbortSignal,
  ): Promise<LocalPluginAnswer<PluginSpecInspection>> {
    return this.transport.call<PluginSpecInspection>('inspect', [spec, options], signal).then(normalize)
  }

  listVersions(name: string, options: { readonly registry?: Registry }): Promise<LocalPluginAnswer<PluginVersionList>> {
    return this.transport.call<PluginVersionList>('listVersions', [name, options]).then(normalize)
  }

  readBundleDetail(
    name: string,
    language: string,
    options: { readonly npmFileSources?: readonly string[] },
  ): Promise<LocalPluginAnswer<BundleDetail>> {
    return this.transport.call<BundleDetail>('readBundleDetail', [name, language, options]).then(normalize)
  }

  installBundle(spec: string, options: Record<string, unknown>): Promise<LocalPluginAnswer<ChangeResult>> {
    return this.transport.call<ChangeResult>('installBundle', [spec, options]).then(normalize)
  }

  waitForInstall(requestId: PluginInstallRequestId): Promise<LocalPluginAnswer<ChangeResult | null>> {
    return this.transport.call<ChangeResult | null>('waitForInstall', [requestId]).then(normalize)
  }

  cancelInstall(requestId: PluginInstallRequestId): Promise<LocalPluginAnswer<PluginInstallCancellation>> {
    return this.transport.call<PluginInstallCancellation>('cancelInstall', [requestId]).then(normalize)
  }

  updateBundle(
    name: string,
    version: string,
    options: { readonly registry?: Registry; readonly requestId?: PluginInstallRequestId },
  ): Promise<LocalPluginAnswer<PluginUpdateResult>> {
    return this.transport.call<PluginUpdateResult>('updateBundle', [name, version, options]).then(normalize)
  }

  removeBundle(name: string): Promise<LocalPluginAnswer<ChangeResult>> {
    return this.transport.call<ChangeResult>('removeBundle', [name]).then(normalize)
  }

  setPluginEnabled(id: PluginEntryId, enabled: boolean): Promise<LocalPluginAnswer<ChangeResult>> {
    return this.transport.call<ChangeResult>('setPluginEnabled', [id, enabled]).then(normalize)
  }

  setBundleEnabled(name: string, enabled: boolean): Promise<LocalPluginAnswer<ChangeResult>> {
    return this.transport.call<ChangeResult>('setBundleEnabled', [name, enabled]).then(normalize)
  }
}

/**
 * 本机插件页控制器。
 *
 * 除构造器外**没有任何覆写**：凡是官方页能做的（安装/取消/审批/版本/更新/卸载/详情/进度/提示），
 * 这里都通过同一条 `sender` 发往本机通道。
 */
export class LocalPluginManagerController extends PluginManagerController {
  /**
   * @param ctx - 客户端 Context（只用于配置表单、语言、详情图片 URL 等与数据源无关的服务）。
   * @param transport - 本机直连客户端。
   */
  constructor(ctx: Context, transport: LocalPluginManagerClient) {
    super(ctx, new LocalPluginManagerSender(transport))
  }
}
