/**
 * 角色授权按 endpoint 类型拆分：只读 endpoint 在所有配对 role 共享；写入/执行 endpoint 只列入 Full。未知 endpoint 默认拒绝。
 *
 * 每一条的前缀都是**官方 namespace 原文**（`pluginManager` / `pluginMarket` 是
 * camelCase —— 文件名不是 namespace）。方法名清单的权威来源是 Typert 注册表；
 * 这里给的是「整条 namespace 一律不给」的前缀式红线，因此不需要逐方法枚举。
 *
 * 为什么整条禁：
 * - `credentials/*`：明文凭据写入（`set`/`unset`）与凭据元数据读取（`describe`）。
 * - `settings` 的四个写方法：改宿主配置；`describe` 是只读，不在红线内。
 * - `directoryPicker/*`：`pick` 会在**宿主桌面**弹原生对话框，等于远程操控宿主 UI。
 * - `pluginManager/*`、`pluginMarket/*`：安装/卸载/升级代码 = 远程代码执行。
 * - `pluginInventory/*`：已装插件清单会暴露攻击面。
 * - `account/*`：账号凭据与登录态。
 * - `remoteAccess/follow`：被 `decide()` **恒放行**，下放等于送出一份能力清单，
 *   且无法用策略拦（必须先在自己的 policy 里再判，见 `policy.ts` 的 `bindings()`
 *   注释）；v1 直接不给。
 * - `$events` / `$events/result`：Gateway 自有面；非 owner 由 `interactions:'none'` 挡住。
 *
 * @module @core/capabilities-redlines
 */

/** Read-only metadata/catalog endpoints shared by every paired role; these never return secret values. */
export const SHARED_READ_ENDPOINTS: readonly string[] = [
  'pluginInventory/list',
  'schedule/catalog', 'schedule/history', 'schedule/list',
  'pluginManager/listBundles', 'pluginManager/listPlugins', 'pluginManager/listVersionExemptions', 'pluginManager/registries', 'pluginManager/inspect',
  'pluginMarket/listIndexes', 'pluginMarket/search',
  'credentials/describe', 'settings/describe', 'directoryPicker/list',
  'account/getState', 'account/getProfile', 'account/getBalance',
  'account/watch', 'account/watchExpiry', 'account/getUnnotifiedBonuses', 'account/hasRunningAccountTasks',
  'dynamicCordisRunner/inventory', 'remoteAccess/follow',
]

/** Full-only mutations and administrative actions. Dynamic execution retains upstream approval checks. */
export const FULL_ADMIN_ENDPOINTS: readonly string[] = [
  'pluginManager/cancelInstall', 'pluginManager/installBundle', 'pluginManager/removeBundle',
  'pluginManager/setBundleEnabled', 'pluginManager/setPluginEnabled', 'pluginManager/setVersionExemption', 'pluginManager/waitForInstall',
  'pluginMarket/setIndexes',
  'credentials/set', 'credentials/unset',
  'settings/mutate', 'settings/update', 'settings/replace', 'settings/openSettingsDocument',
  'directoryPicker/createDirectory',
  'account/ackBonusNotified', 'account/startSignIn', 'account/cancelSignIn', 'account/signOut',
  'dynamicCordisRunner/syncInspectManifest', 'dynamicCordisRunner/invoke', 'dynamicCordisRunner/reportClientGuardFailure',
  'dynamicCordisRunner/reportRenderFailure', 'dynamicCordisRunner/resolveInspectQuery', 'dynamicCordisRunner/resolveRequestRun',
  'dynamicCordisRunner/runHostHalf', 'dynamicCordisRunner/settleUserRun', 'dynamicCordisRunner/stopFromPanel', 'dynamicCordisRunner/undefineFromPanel',
  'workspace/delete',
]

/** Explicit endpoints which remain unavailable to paired devices. */
export const NEVER_DELEGATED_ENDPOINTS: readonly string[] = [
  'directoryPicker/pick',
]

/** Namespaces with explicit safe reads and Full-only writes are not blanket redlines. */
export const NEVER_DELEGATED_NAMESPACES: readonly string[] = [
  'remoteAccess/', 'pluginManager/', 'pluginMarket/',
]

/** Gateway 自有面（不是 `<ns>/<method>` 形状，单独列出以便断言）。 */
export const NEVER_DELEGATED_INTERNALS: readonly string[] = [
  '$events',
  '$events/result',
]

/**
 * 一个 endpoint 是否落在红线内。
 * @param endpoint - `<namespace>/<method>` 或内部名。
 * @returns 命中任一红线时为 true。
 */
export function isNeverDelegated(endpoint: string): boolean {
  if (NEVER_DELEGATED_ENDPOINTS.includes(endpoint)) return true
  if (SHARED_READ_ENDPOINTS.includes(endpoint) || FULL_ADMIN_ENDPOINTS.includes(endpoint)) return false
  if (NEVER_DELEGATED_INTERNALS.includes(endpoint)) return true
  return NEVER_DELEGATED_NAMESPACES.some(prefix => endpoint.startsWith(prefix))
}

/** 扁平的红线清单（文档与断言脚本共用；顺序稳定）。 */
export const NEVER_DELEGATED: readonly string[] = [
  ...NEVER_DELEGATED_ENDPOINTS,
  ...NEVER_DELEGATED_NAMESPACES.map(prefix => `${prefix}*`),
  ...NEVER_DELEGATED_INTERNALS,
]
