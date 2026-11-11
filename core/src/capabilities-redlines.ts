/**
 * 永不下放的 endpoint（红线，D-11）。与 `capabilities.ts` 的 allow-list 交集必须为空。
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

/** 整条 namespace 一律不下放的前缀（含结尾斜杠）。 */
export const NEVER_DELEGATED_NAMESPACES: readonly string[] = [
  'credentials/',
  'directoryPicker/',
  'pluginManager/',
  'pluginMarket/',
  'pluginInventory/',
  'account/',
  'remoteAccess/',
]

/** 逐方法红线（同 namespace 下只禁写方法，读方法可给）。 */
export const NEVER_DELEGATED_ENDPOINTS: readonly string[] = [
  'settings/update',
  'settings/replace',
  'settings/mutate',
  'settings/openSettingsDocument',
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
  if (NEVER_DELEGATED_INTERNALS.includes(endpoint)) return true
  return NEVER_DELEGATED_NAMESPACES.some(prefix => endpoint.startsWith(prefix))
}

/** 扁平的红线清单（文档与断言脚本共用；顺序稳定）。 */
export const NEVER_DELEGATED: readonly string[] = [
  ...NEVER_DELEGATED_ENDPOINTS,
  ...NEVER_DELEGATED_NAMESPACES.map(prefix => `${prefix}*`),
  ...NEVER_DELEGATED_INTERNALS,
]
