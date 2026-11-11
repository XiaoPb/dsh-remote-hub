/**
 * 角色名与三档角色的语义边界。
 *
 * 角色由 **Host 在配对时**绑定到设备，客户端不可自称（红线 R5）。真正的判定入口
 * 是 DSH 官方的 `ctx.remoteAccess.registerPolicy('remote-device', policy)` 里
 * 的 `bindings()` / `decide()`；本文件只定义名字与包含关系的断言工具，
 * 矩阵本身在 `capabilities.ts`。
 *
 * @module @core/roles
 */

export const ROLE_READ_ONLY = 'read-only'
export const ROLE_CONTROL = 'control'
export const ROLE_FULL = 'full'

export type RoleName = typeof ROLE_READ_ONLY | typeof ROLE_CONTROL | typeof ROLE_FULL

/** 顺序即强度（最弱 → 最强），用于包含关系断言与 UI 排序。 */
export const ROLE_NAMES: readonly RoleName[] = [ROLE_READ_ONLY, ROLE_CONTROL, ROLE_FULL]

/** 角色的中文标签（本机 UI 与 Android 共用同一份文案来源）。 */
export const ROLE_LABELS: Readonly<Record<RoleName, { zh: string; en: string }>> = {
  [ROLE_READ_ONLY]: { zh: '只读', en: 'Read-only' },
  [ROLE_CONTROL]: { zh: '可操作', en: 'Control' },
  [ROLE_FULL]: { zh: '完全', en: 'Full' },
}

/** 运行期入参校验（配置与会话请求都走这里，避免各写一份）。 */
export function isRoleName(value: unknown): value is RoleName {
  return typeof value === 'string' && (ROLE_NAMES as readonly string[]).includes(value)
}

/**
 * 角色的强度序。用于「不得降级」类判断（例如吊销时不允许把 full 改成 read-only
 * 而不重建 Peer）。
 * @param role - 角色名。
 * @returns 0 / 1 / 2（越强越大）。
 */
export function roleRank(role: RoleName): number {
  return ROLE_NAMES.indexOf(role)
}

/**
 * `a` 是否弱于或等于 `b`（用于矩阵包含关系断言）。
 * @param a - 候选弱角色。
 * @param b - 候选强角色。
 * @returns 当 `roleRank(a) <= roleRank(b)` 时为 true。
 */
export function roleAtMost(a: RoleName, b: RoleName): boolean {
  return roleRank(a) <= roleRank(b)
}
