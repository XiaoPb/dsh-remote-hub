import type { ReactNode } from 'react'

/**
 * 官方数据结构 / 槽位契约的**类型再导出**（编译期专用，产物零成本）。
 *
 * vendored 官方 UI 原本从内置包导入类型；现在统一从这里取，而官方形状由
 * `./official-shims-types.ts`（全局 `declare module` 脚本）声明。
 *
 * @module dsh-remote-hub/client/local-plugin-manager/official-stubs
 */

export type {
  BundleDetail,
  BundleInfo,
  BundleRowInfo,
  ChangeResult,
  IncompatiblePlugin,
  LocalizedText,
  ManagementError,
  PluginEntryId,
  PluginFiberPhase,
  PluginInfo,
  PluginInspectProblem,
  PluginInstallCancellation,
  PluginInstallFailureKind,
  PluginInstallLogChunk,
  PluginInstallProgress,
  PluginInstallRequestId,
  PluginLocalizedMeta,
  PluginRegistries,
  PluginSpecInspection,
  PluginUpdateProgress,
  PluginUpdateResult,
  PluginUpdateStep,
  PluginVersion,
  PluginVersionList,
  Registry,
  RegistryAttempt,
  RegistryVersion,
  ReadOnlyReason,
  RemoteFailure,
  RestartReason,
} from '@deepseek-ai/dsh-api-remotes/client'

export type {
  ConfigForm,
  ConfigFormSnapshot,
  ConfigForms,
  SettingsDescribeFace,
  SettingsMirrorSnapshot,
} from '@deepseek-ai/dsh-client-ui-settings/client'

export type { LocaleSnapshot } from '@deepseek-ai/dsh-client-locale/client'

export type { HostObservable, SnapshotSelectorHook } from './store.ts'

export type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
export type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

// ── 槽位 / 渲染契约（本插件侧自己拥有，与官方同形）───────────────────────────────

/** 槽位运行时 props（只用其签名）。 */
export interface PropsRuntime<_Names extends string = string> {
  /** 宿主标准 kit（面板注册的 props 由槽位渲染器提供；这里保持开放形状）。 */
  readonly [key: string]: any
}

/** 槽位语言 props。 */
export interface PropsLocale<_Namespace extends string = string> {
  t(key: string, params?: Record<string, string>): string
}

/** 槽位渲染授权（消费者侧形状）。 */
export type PropsRenderSlots<_Names extends string = string> = {
  renderSlot(name: string, owner: object, options?: { only?: string; entryKey?: string }): ReactNode
}

/** 注册方注入面。 */
export interface InjectFace<Face> {
  readonly __face?: Face
}

/** 注入面（face 的成员直接摊到 props 上，与官方的 InjectFace<PluginManagerFace> 形状一致）。 */
export type InjectFaceProps<Face> = InjectFace<Face> & Face


/** store 座位。 */
export interface PropsStore<Handle> {
  useStore<R>(selector: (snapshot: any) => R): R
  actions: any
  readonly __handle?: Handle
}

/** 语言命名空间表。 */
export type LocaleNamespaceMap = Record<string, unknown>
