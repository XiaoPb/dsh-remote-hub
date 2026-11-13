/**
 * 官方 `@deepseek-ai/*` 包的形状声明（**编译期专用，运行时零成本**）。
 *
 * ## 为什么是 `.d.ts`
 *
 * 这些声明必须用 `declare module` 增强 DSH 内置包的类型面。TypeScript 只在**非模块脚本**里允许
 * 「declare 一个不存在的模块名」（`TS2664: Invalid module name in augmentation`），所以本文件
 * 不能有顶层 import/export —— 它必须是一个全局脚本（`declare module` 本身就是导出）。
 *
 * 需要从 Context 上读的松耦合服务在 `official-shims-context.ts` 里（普通运行时模块）。
 *
 * @provenance shapes from DSH 0.2.2-rc.1
 */

declare module '@deepseek-ai/dsh-api-remotes/client' {
  export type PluginInstallRequestId = string & { readonly __brand?: 'PluginInstallRequestId' }
  export type PluginEntryId = string & { readonly __brand?: 'PluginEntryId' }
  export type Registry = string | null
  export type LocalizedText = string | { readonly en: string; readonly [locale: string]: string }
  export type ReadOnlyReason = 'management-required' | 'unaddressable'
  export type RestartReason = 'no-hmr' | 'package-moved' | 'host-module' | 'unmanaged-plugin' | 'module-comparison'
  export type PluginFiberPhase = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null
  export type PluginUpdateStep = 'check' | 'remove' | 'install'
  export type PluginInstallFailureKind =
    | 'pnpm-missing' | 'timeout' | 'not-found' | 'no-matching-version' | 'network'
    | 'disk-full' | 'permission' | 'build-blocked' | 'integrity' | 'unknown'
  export type PluginInspectProblem =
    | 'invalid-spec' | 'already-installed' | 'not-found' | 'not-a-package' | 'not-a-bundle' | 'network' | 'unknown'

  export interface IncompatiblePlugin {
    readonly name: string
    readonly version: string
    readonly runtimeVersion: string
    readonly requirements: Record<string, string>
  }

  export interface ManagementError {
    readonly code: string
    readonly diagnostic?: string
    readonly incompatible?: readonly IncompatiblePlugin[]
  }

  export interface PluginLocalizedMeta {
    readonly title?: LocalizedText
    readonly description?: LocalizedText
    readonly icon?: string
    readonly error?: string
  }

  export interface ChangeResult {
    readonly changed: boolean
    readonly application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
    readonly restartReason?: RestartReason
    readonly stage: 'install' | 'enable' | 'remove'
    readonly target: string
    readonly enabled?: boolean
    readonly error?: ManagementError
    readonly warnings?: readonly string[]
    readonly packageResult?: {
      readonly exitCode: number
      readonly output: string
      readonly truncated: boolean
      readonly logPath: string
      readonly kind?: PluginInstallFailureKind
    }
    readonly failedAt?: 'registry' | 'spec-host'
    readonly bundle?: string
    readonly version?: string
    readonly pendingBuilds?: readonly string[]
    readonly approvedBuilds?: readonly string[]
    readonly registries?: readonly Registry[]
  }

  export interface BundleRowInfo {
    readonly rowId: string
    readonly moduleName: string
    readonly meta?: PluginLocalizedMeta
    readonly entryId?: PluginEntryId
  }

  export interface BundleInfo {
    readonly name: string
    readonly official: boolean
    readonly availability: 'installation' | 'profile' | 'missing'
    readonly installTarget?: { readonly spec: string; readonly version: string }
    readonly version?: string
    readonly meta?: PluginLocalizedMeta
    readonly description?: string
    readonly listedByDefault?: boolean
    readonly enabled: boolean
    readonly installed: boolean
    readonly source?: string
    readonly optional: boolean
    readonly removable: boolean
    readonly updatable: boolean
    readonly readOnlyReason?: ReadOnlyReason
    readonly error?: ManagementError
    readonly rows: readonly BundleRowInfo[]
    readonly overrides: readonly string[]
  }

  export interface PluginInfo {
    readonly entryId: PluginEntryId
    readonly moduleName: string
    readonly meta?: PluginLocalizedMeta
    readonly enabled: boolean
    readonly fiberPhase: PluginFiberPhase
    readonly diagnostic?: string
    readonly patchId?: string
    readonly readOnlyReason?: ReadOnlyReason
  }

  export interface PluginRegistries {
    readonly registry: Registry
    readonly fallbackRegistries: readonly string[]
    readonly resolved: string | null
  }

  export type PluginSpecInspection =
    | {
      readonly status: 'accepted'
      readonly kind: 'registry' | 'path' | 'git' | 'tarball'
      readonly name?: string
      readonly version?: string
      readonly description?: string
      readonly bundle: boolean | null
      readonly registry: Registry
      readonly host?: string
    }
    | { readonly status: 'refused'; readonly problem: PluginInspectProblem; readonly reason: string; readonly registries?: readonly Registry[] }

  export interface RegistryVersion {
    readonly version: string
    readonly publishedAt?: string
    readonly tags: readonly string[]
    readonly prerelease: boolean
    readonly deprecated?: string
    readonly bundle: boolean
    readonly incompatible?: IncompatiblePlugin
  }

  export type PluginVersion = RegistryVersion

  export interface RegistryAttempt {
    readonly registry: Registry
    readonly problem?: string
    readonly reason?: string
  }

  export type PluginVersionList =
    | {
      readonly status: 'listed'
      readonly installed: string
      readonly registry: Registry
      readonly attempts: readonly RegistryAttempt[]
      readonly versions: readonly RegistryVersion[]
      readonly omitted: number
    }
    | { readonly status: 'refused'; readonly problem: string; readonly reason: string; readonly attempts: readonly RegistryAttempt[] }

  export interface PluginUpdateResult {
    readonly from: string
    readonly to: string
    readonly step: PluginUpdateStep
    readonly result: ChangeResult
    readonly restore?: ChangeResult
  }

  export interface PluginInstallLogChunk {
    readonly requestId?: PluginInstallRequestId
    readonly jobId: string
    readonly argv: readonly string[]
    readonly cwd: string
    readonly stream: 'stdout' | 'stderr'
    readonly text: string
    readonly exitCode?: number | null
  }

  export interface PluginInstallProgress {
    readonly requestId: PluginInstallRequestId
    readonly phase: 'installing' | 'cancelling' | 'applying'
    readonly attempt?: { readonly registry: Registry; readonly index: number; readonly total: number }
  }

  export interface PluginUpdateProgress {
    readonly requestId: PluginInstallRequestId
    readonly step: PluginUpdateStep
  }

  export interface PluginInstallCancellation {
    readonly status: 'cancelled' | 'too-late' | 'not-running'
  }

  export type BundleDetail =
    | { readonly status: 'found'; readonly origin: 'locale' | 'readme'; readonly path: string; readonly markdown: string }
    | { readonly status: 'none' }

  export interface RemoteFailure {
    readonly code: string
    readonly message: string
    readonly details?: Record<string, unknown>
  }
}

declare module '@deepseek-ai/dsh-client-ui-settings/client' {
  export interface ConfigFormSnapshot<T> { readonly [key: string]: unknown }
  export interface ConfigForm<T> {
    getSnapshot(): ConfigFormSnapshot<T>
    mutate(operations: readonly unknown[], revision: number): unknown
    readonly scope?: unknown
  }
  export interface ConfigForms { get<T>(id: string): ConfigForm<T> }
  export interface SettingsDescribeFace {
    getSnapshot(): { readonly view?: { readonly namespaces?: readonly { readonly ns: string }[] } }
  }
  export interface SettingsMirrorSnapshot { readonly [key: string]: unknown }
}

declare module '@deepseek-ai/dsh-client-locale/client' {
  export interface LocaleSnapshot { readonly active: string; readonly locales: readonly string[]; readonly revision: number }
}

declare module '@deepseek-ai/dsh-package-manifest' {
  export type LocalizedText = string | { readonly en: string; readonly [locale: string]: string }
  export interface PluginLocalizedMeta {
    readonly title?: LocalizedText
    readonly description?: LocalizedText
    readonly icon?: string
    readonly error?: string
  }
}

declare module '@deepseek-ai/dsh-client-product-analytics/client' {
  export const __productAnalyticsBrand: unique symbol
}

declare module '@deepseek-ai/dsh-client-ui-layout/client' {
  export type MainPanelId = string & { readonly __brand?: 'MainPanelId' }
}

declare module '@deepseek-ai/dsh-client-ui-sidebar/client' {
  export interface SidebarPanelIconOwnerProps { readonly size: number; readonly active: boolean }
}

declare module '@deepseek-ai/dsh-client-ui-renderer/client' {
  export const __rendererBrand: unique symbol
}

declare module '@deepseek-ai/dsh-api-remote-access/client' {
  export const __remoteAccessBrand: unique symbol
}

declare module '@deepseek-ai/dsh-plugin-manager/types' {
  export type PluginEntryId = string & { readonly __brand?: 'PluginEntryId' }
  export type PluginInstallRequestId = string & { readonly __brand?: 'PluginInstallRequestId' }
  export type PluginInstallLogChunk = unknown
  export type PluginInstallProgress = unknown
  export type PluginUpdateProgress = unknown
}

declare module '@deepseek-ai/dsh-official-bundles' {
  export const EXPERIMENTAL_BUNDLES: ReadonlySet<string>
}

