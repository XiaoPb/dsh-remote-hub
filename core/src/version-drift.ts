/**
 * **版本相关端点**：在受支持的 DSH 版本之间会增删的官方 endpoint。
 *
 * ## 为什么单独成册
 *
 * 本插件声明支持 **DSH 0.2.2-rc.1 与 0.2.2-rc.2**（rc.3 与 rc.2 端点完全一致，
 * 顺带兼容）。但这两个版本的 Typert 注册表**并不相同**：合计 18 个端点
 * 在这一侧有、那一侧没有（数据来自两版 `@deepseek-ai/dsh-api-remotes` 产物实测）。
 *
 * 把这类端点写进静态能力矩阵会立刻出事：
 * - 登记 rc.1 独有的 → 在 rc.2 上被 `audit-permissions` 判「矩阵有、注册表没有」；
 * - 反之亦然。
 *
 * 所以它们**不进矩阵、也不进红线**，只在这里登记「它属于版本差异，因此两端都算
 * 已归类」。运行时若真的被调用，`decide()` 仍按未授权拒绝 —— 安全语义不变，
 * 只是不再让 CI 把版本漂移误判成漏登记。
 *
 * @module dsh-remote-hub/core/version-drift
 */

/** 只在某个 DSH 版本线里存在的官方 endpoint。 */
export interface VersionDriftEntry {
  /** 该端点存在的版本（人读用，同时被审计脚本核对）。 */
  readonly releases: readonly string[]
  /** 为什么它会变（迁移/更名/新功能）。 */
  readonly reason: string
}

/**
 * 0.2.2-rc.1 ↔ 0.2.2-rc.2 之间的端点漂移。
 *
 * 键是端点名，值是它存在于哪些版本。未列出的版本即没有该端点。
 */
export const VERSION_DRIFT: Readonly<Record<string, VersionDriftEntry>> = Object.freeze({
  // ── 仅 0.2.2-rc.1 ────────────────────────────────────────────────────────
  'account/ackBonusNotified': { releases: ['0.2.2-rc.1'], reason: 'rc.2 改为统一的通知通道（getNotifications / reportNotificationEvent）' },
  'account/getUnnotifiedBonuses': { releases: ['0.2.2-rc.1'], reason: '同上：奖励通知并入通用通知接口' },
  'officeToPdf/generation': { releases: ['0.2.2-rc.1'], reason: 'rc.2 起命名空间迁移为 officeKit/*' },
  'officeToPdf/render': { releases: ['0.2.2-rc.1'], reason: '同上：命名空间迁移为 officeKit/*' },
  'subagents/interruptByParent': { releases: ['0.2.2-rc.1'], reason: 'rc.2 改为按用户意图中断 interruptByUser' },

  // ── 仅 0.2.2-rc.2（及 rc.3）──────────────────────────────────────────────
  'account/getNotificationContent': { releases: ['0.2.2-rc.2', '0.2.2-rc.3'], reason: 'rc.2 新增的通用通知接口' },
  'account/getNotifications': { releases: ['0.2.2-rc.2', '0.2.2-rc.3'], reason: 'rc.2 新增的通用通知接口' },
  'account/reportNotificationEvent': { releases: ['0.2.2-rc.2', '0.2.2-rc.3'], reason: 'rc.2 新增的通用通知接口' },
  'agentTeams/setEnabled': { releases: ['0.2.2-rc.2', '0.2.2-rc.3'], reason: 'rc.2 新增的 Agent Teams 开关' },
  'mcpManager/probe': { releases: ['0.2.2-rc.2', '0.2.2-rc.3'], reason: 'rc.2 新增的 MCP 管理面' },
  'mcpManager/restart': { releases: ['0.2.2-rc.2', '0.2.2-rc.3'], reason: 'rc.2 新增的 MCP 管理面' },
  'mcpManager/watch': { releases: ['0.2.2-rc.2', '0.2.2-rc.3'], reason: 'rc.2 新增的 MCP 管理面' },
  'officeKit/generation': { releases: ['0.2.2-rc.2', '0.2.2-rc.3'], reason: '由 officeToPdf/generation 更名而来' },
  'officeKit/render': { releases: ['0.2.2-rc.2', '0.2.2-rc.3'], reason: '由 officeToPdf/render 更名而来' },
  'subagents/interruptByUser': { releases: ['0.2.2-rc.2', '0.2.2-rc.3'], reason: '由 interruptByParent 更名而来' },
  'terminal/watch': { releases: ['0.2.2-rc.2', '0.2.2-rc.3'], reason: 'rc.2 新增的终端订阅' },
  'web/listProviders': { releases: ['0.2.2-rc.2', '0.2.2-rc.3'], reason: 'rc.2 新增的搜索提供方列举' },
  'workspaceFiles/search': { releases: ['0.2.2-rc.2', '0.2.2-rc.3'], reason: 'rc.2 新增的工作区文件检索' },
})

/**
 * 该端点是否属于「版本差异」。
 * @param endpoint - `namespace/method` 形式的端点名。
 * @returns 命中版本漂移表时为 true。
 */
export function isVersionDrift(endpoint: string): boolean {
  return Object.prototype.hasOwnProperty.call(VERSION_DRIFT, endpoint)
}
