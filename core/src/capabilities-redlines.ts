/**
 * 角色授权按 endpoint 类型拆分：只读 endpoint 在所有配对 role 共享；写入/执行 endpoint 只列入 Full。未知 endpoint 默认拒绝。
 *
 * 每一条的前缀都是**官方 namespace 原文**（`pluginManager` / `pluginMarket` 是
 * camelCase —— 文件名不是 namespace）。方法名清单的权威来源是 Typert 注册表；
 * 这里给的是「整条 namespace 一律不给」的前缀式红线，因此不需要逐方法枚举。
 *
 * 为什么整条禁（DESIGN §8.6.5）：
 * - `credentials/*`：明文凭据写入（`set`/`unset`）与凭据元数据读取（`describe`）。
 * - `settings` 的四个写方法：改宿主配置；`describe` 是只读，不在红线内。
 * - `directoryPicker/*`：`pick` 会在**宿主桌面**弹原生对话框，等于远程操控宿主 UI；
 *   `list`/`createDirectory` 同属宿主目录面，一并不外放。
 * - `pluginManager/*`、`pluginMarket/*`：安装/卸载/升级代码 = 远程代码执行。
 * - `pluginInventory/*`：已装插件清单会暴露攻击面。
 * - `account/*`：账号凭据与登录态。
 * - `dynamicCordisRunner/*`（已移出红线，0.3.2+）：由 Full 权限完全管理，所有方法仅允许 Full 角色调用。
 * - `remoteAccess/follow`：被 `decide()` **恒放行**，下放等于送出一份能力清单，
 *   且无法用策略拦（必须先在自己的 policy 里再判，见 `policy.ts` 的 `bindings()`
 *   注释）；v1 直接不给。
 * - `$events` / `$events/result`：Gateway 自有面；非 owner 由 `interactions:'none'` 挡住。
 *
 * **这些条目对 `read-only`、`control`、`full` 三档角色一律不外放**，包括 `full`：
 * `full` 是「能传文件、开终端」，不是 DSH owner。
 *
 * 红线分四层，`isNeverDelegated()` 是唯一判据，`scripts/redlines.mjs` 与
 * `test/full-administration.test.mjs` 都只调它：
 *   1. {@link NEVER_DELEGATED_ENDPOINTS} —— 逐条枚举；
 *   2. {@link NEVER_DELEGATED_BLANKET} —— 整条 namespace，无豁免；
 *   3. {@link NEVER_DELEGATED_NAMESPACES} —— 整条 namespace，但允许 {@link SHARED_READ_ENDPOINTS} 里的具名只读；
 *   4. {@link NEVER_DELEGATED_INTERNALS} —— Gateway 内部面。
 *
 * @module @core/capabilities-redlines
 */

/**
 * Read-only metadata/catalog endpoints shared by every paired role; these never return secret values.
 *
 * `credentials/describe` 在这里：它**只返回引用是否已设置、来源与是否可写**，
 * 从不返回密钥值（官方契约），因此与 `settings/describe` 同属元数据；
 * 远端设置页渲染 API Key 行需要它来显示「已设置 / 未设置」。
 *
 * 0.3.1：`pluginInventory/list`（已装插件清单）也放进共享只读——插件页在
 * 只读配对下也要能渲染清单；它只返回 Loader 条目与显示元数据，不含任何凭据。
 */
export const SHARED_READ_ENDPOINTS: readonly string[] = [
  'schedule/catalog', 'schedule/history', 'schedule/list',
  'pluginManager/listBundles', 'pluginManager/listPlugins', 'pluginManager/listVersionExemptions', 'pluginManager/registries', 'pluginManager/inspect',
  'pluginManager/listVersions', 'pluginManager/readBundleDetail',
  'pluginMarket/listIndexes', 'pluginMarket/search', 'pluginMarket/readEntryDetail',
  'pluginInventory/list',
  'settings/describe',
  'credentials/describe',
]

/**
 * Full-only mutations and administrative actions.
 *
 * 这里**只能放红线以外**的 endpoint：红线条目一律不进任何角色的矩阵，
 * `assertMatrixIntegrity()` 会在插件加载期拦下这种写法。
 *
 * ## 权限演进
 *
 * - 0.2.6：Full 允许写配置与安装插件（`settings/{update,replace,mutate}`、
 *   `credentials/{set,unset}`、`pluginManager/*` 写方法、`pluginMarket/setIndexes`）。
 * - 0.3.0：`directoryPicker/{list,createDirectory}` 给 Full（内置云端路径 UI）。
 * - 0.3.1：**取消 owner 逐次审批**（用户明确要求 Full 完全放开、直接生效）。
 *   这些动作现在只要配对角色是 `full` 就会真正执行；
 *   **密钥掩码与审计不变**（见 `core/redact.ts` 与各 `onAudit`）。
 */
export const FULL_ADMIN_ENDPOINTS: readonly string[] = [
  'pluginManager/cancelInstall', 'pluginManager/installBundle', 'pluginManager/removeBundle', 'pluginManager/updateBundle',
  'pluginManager/setBundleEnabled', 'pluginManager/setPluginEnabled', 'pluginManager/setVersionExemption', 'pluginManager/waitForInstall',
  'pluginMarket/setIndexes',
  'settings/update', 'settings/replace', 'settings/mutate',
  'credentials/set', 'credentials/unset',
  // 0.3.0：云端路径浏览/新建目录（内置的 remote-paths UI 使用）。只给 Full；
  // 宿主原生弹框 `directoryPicker/pick` 仍是红线。
  'directoryPicker/list', 'directoryPicker/createDirectory',
  'workspace/delete',
  // 0.3.2：动态 Cordis 包管理（Full 权限专属）- 所有方法完全开放给 Full。
  'dynamicCordisRunner/define', 'dynamicCordisRunner/run', 'dynamicCordisRunner/stop', 'dynamicCordisRunner/undefine',
  'dynamicCordisRunner/list', 'dynamicCordisRunner/syncInspectManifest',
  'dynamicCordisRunner/getDefinition', 'dynamicCordisRunner/queryRunning',
  'dynamicCordisRunner/getClientCode', 'dynamicCordisRunner/inventory', 'dynamicCordisRunner/invoke',
  'dynamicCordisRunner/reportClientGuardFailure', 'dynamicCordisRunner/reportRenderFailure',
  'dynamicCordisRunner/resolveInspectQuery', 'dynamicCordisRunner/resolveRequestRun',
  'dynamicCordisRunner/runHostHalf', 'dynamicCordisRunner/settleUserRun',
  'dynamicCordisRunner/stopFromPanel', 'dynamicCordisRunner/undefineFromPanel',
]

/**
 * 每次调用都必须经 **owner 审批** 才能放行的 endpoint。
 *
 * ## 0.3.1：已清空（默认不拦截任何人）
 *
 * 用户明确要求 Full **完全放开**、直接生效，因此原先的 13 个审批项全部取消，
 * 插件安装/卸载/启停与写配置/写 API Key 现在**只要角色是 Full 就直接执行**。
 *
 * 保留这个常量与 `host/src/sensitive-approval.ts` 整套机制，是为了：
 * 1. 需要时可以只往这里加一条就恢复逐次审批（不用改 dispatch 与测试结构）；
 * 2. 审计与**密钥掩码**照旧生效——写入类 endpoint 仍走脱敏后再落审计。
 *
 * ⚠️ 安全代价（写在这里，不要删除）：Full 配对 = 远程代码执行 + 可写宿主配置与凭据。
 * 只给可信设备发放 `full`；不确定时用 `control`。
 */
export const APPROVAL_REQUIRED_ENDPOINTS: readonly string[] = []

/**
 * 载荷里含**明文密钥**的 endpoint：审批卡、审计、诊断都必须先把这些字段掩码。
 *
 * 掩码是「一眼能看出改了什么、但看不出密钥」的形状（`sk-****8f2a`），
 * 且**永不**出现在日志、`host-status.json` 或 `hub/stream.*` 帧里。
 */
export const SECRET_BEARING_ENDPOINTS: readonly string[] = [
  'credentials/set', 'credentials/unset',
  'settings/update', 'settings/replace', 'settings/mutate',
]

/** Explicit endpoints which remain unavailable to paired devices, for every role including Full. */
export const NEVER_DELEGATED_ENDPOINTS: readonly string[] = [
  // 宿主桌面上的**原生弹框**：等于远程操控宿主 UI，永不下放。
  // （云端目录浏览走 `directoryPicker/list|createDirectory`，由 Full 使用。）
  'directoryPicker/pick',
  'settings/openSettingsDocument',
]

/**
 * 整组禁用的 namespace 红线（DESIGN §8.6.5）：**没有任何豁免**，整条前缀对全部角色关闭。
 *
 * `settings/`、`credentials/`、`pluginInventory/` 不在这里 —— 它们各有显式放行的条目
 * （`settings/describe` 与 `pluginInventory/list` 共享只读、`settings/{update,replace,mutate}`
 * 与 `credentials/{set,unset}` 为 Full 专属），因此改为「前缀红线 + 具名豁免」，
 * 未登记的方法仍然拒绝，见 {@link NEVER_DELEGATED_ENDPOINTS} 与
 * {@link NEVER_DELEGATED_NAMESPACES}。
 */
export const NEVER_DELEGATED_BLANKET: readonly string[] = [
  'account/',
]

/**
 * 整组禁用、但允许具名豁免的 namespace。
 *
 * - `directoryPicker/`：豁免 `list` / `createDirectory`，宿主原生弹框 `pick` 与未来新增方法仍默认拒绝；
 * - `pluginInventory/`：豁免 `list`（三档共享只读），未登记方法默认拒绝。
 */
export const NEVER_DELEGATED_NAMESPACES: readonly string[] = [
  'remoteAccess/', 'pluginManager/', 'pluginMarket/', 'credentials/', 'settings/', 'directoryPicker/', 'pluginInventory/',
]

/** Gateway 自有面（不是 `<ns>/<method>` 形状，单独列出以便断言）。 */
export const NEVER_DELEGATED_INTERNALS: readonly string[] = [
  '$events',
  '$events/result',
]

/**
 * 一个 endpoint 是否落在红线内。
 *
 * 判定顺序很重要：**豁免（共享只读 / Full 专属）优先于前缀红线**，所以
 * `pluginManager/listPlugins`、`pluginManager/installBundle`、`credentials/set`
 * 都不会被前缀误伤；而 `account/*` 没有任何豁免，整条关闭；
 * `dynamicCordisRunner/*` 所有方法由 Full 专属管理，见 capabilities.ts；
 * 未登记的 `credentials/*`、`settings/*` 方法依旧拒绝。
 *
 * @param endpoint - `<namespace>/<method>` 或内部名。
 * @returns 命中任一红线时为 true。
 */
export function isNeverDelegated(endpoint: string): boolean {
  if (NEVER_DELEGATED_ENDPOINTS.includes(endpoint)) return true
  if (SHARED_READ_ENDPOINTS.includes(endpoint) || FULL_ADMIN_ENDPOINTS.includes(endpoint)) return false
  if (NEVER_DELEGATED_INTERNALS.includes(endpoint)) return true
  if (NEVER_DELEGATED_BLANKET.some(prefix => endpoint.startsWith(prefix))) return true
  return NEVER_DELEGATED_NAMESPACES.some(prefix => endpoint.startsWith(prefix))
}

/** 扁平的红线清单（文档与断言脚本共用；顺序稳定）。 */
export const NEVER_DELEGATED: readonly string[] = [
  ...NEVER_DELEGATED_ENDPOINTS,
  ...NEVER_DELEGATED_BLANKET.map(prefix => `${prefix}*`),
  ...NEVER_DELEGATED_NAMESPACES.map(prefix => `${prefix}*`),
  ...NEVER_DELEGATED_INTERNALS,
]
