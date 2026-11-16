/**
 * 展示层语义化：角色名 / 错误码 → 中文文案、时间与相对时间格式化。
 *
 * 为什么集中在这里：错误码到文案的映射在设置页与云端设备页都要用
 * （`dev/ui-redesign/plan-optimization.md §8`），两处各写一份必然漂移；
 * 测试也按同一张表断言「页面不直接显示错误码」。
 *
 * @module dsh-remote-hub/client/rhui/format
 */
import { ROLE_LABELS, type RoleName } from '@core/roles.js'

/** 角色显示名（「完全控制」比 core 的「完全」更适合按钮/标签）。 */
export function formatRole(role: string | undefined | null): string {
  if (role === 'full') return '完全控制'
  if (role === 'control') return '可操作'
  if (role === 'read-only') return '只读'
  return role ?? '未知'
}

/** 角色上限文案（「上限 可操作」）。 */
export function formatRoleCeiling(role: string | undefined | null): string {
  return `上限 ${formatRole(role)}`
}

/** 三段式角色选项（segmented 控件用）。 */
export const ROLE_OPTIONS: readonly { value: RoleName; label: string }[] = [
  { value: 'read-only', label: '只读' },
  { value: 'control', label: '可操作' },
  { value: 'full', label: '完全控制' },
]

/** 角色选项（权限上限/角色选择展示名；与 `ROLE_LABELS` 同源，但补全「控制」后缀）。 */
export function roleOptionLabel(role: RoleName): string {
  return formatRole(role)
}

/** core 的短标签（无障碍名称用，避免「完全控制」被读成两段）。 */
export function shortRoleLabel(role: RoleName): string {
  return ROLE_LABELS[role]?.zh ?? role
}

/**
 * 错误码 → 页面文案（`dev/ui-redesign/plan-optimization.md §8` + `handoff §4`）。
 *
 * 原则：错误码**永远不直接给用户看**；未收录的码回落到「操作失败，请重试」，
 * 技术细节留给调用方在折叠区展示。
 */
export const AUTH_ERROR_TEXT: Readonly<Record<string, string>> = {
  'auth-invalid-credentials': '用户名或口令不正确',
  'auth-account-disabled': '该账号已被管理员禁用',
  'auth-account-not-found': '账号不存在',
  'auth-account-exists': '用户名已被占用',
  'auth-last-admin': '不能禁用或删除最后一个管理员',
  'auth-self-action': '不能对自己执行该操作',
  'auth-mfa-required': '该账号需先绑定两步验证',
  'auth-mfa-invalid': '验证码不正确，请重试',
  'auth-mfa-expired': '验证已过期，请重新登录',
  'auth-password-change-required': '需先在目标机完成首次设置',
  'auth-current-password-invalid': '当前口令不正确',
  'auth-password-weak': '口令不满足当前策略，请按清单逐项补齐',
  'auth-password-unchanged': '新口令不能与当前口令相同',
  'auth-role-exceeded': '权限不足：请到目标机设置页调整上限',
  'auth-forbidden': '该操作需要先完成双因素验证，或当前账号无权执行',
  'auth-rate-limited': '尝试过多，请稍后再试',
  'auth-lease-expired': '访问凭据已过期，请重新登录',
  'auth-lease-not-expired': '还没到续租窗口',
  'auth-client-invalid': '客户端已被撤销或不可信，请重新登录',
  'auth-proof-invalid': '请求签名无效，请刷新页面后重试',
  'auth-unauthorized': '登录已失效，请重新登录',
  'auth-unavailable': '认证服务不可用',
  displaced: '另一台设备接管了这台机器',
  revoked: '访问已被撤销，请重新登录',
  'rate-limited': '尝试过多，请稍后再试',
  'network-unreachable': '无法访问目标地址',
  'origin-invalid': '地址格式不正确：需要形如 http://主机:端口，且不带路径',
}

/**
 * 取错误码对应的中文文案。
 * @param code - 服务端错误码（`AuthApiError.code` 等）。
 * @param fallback - 未收录时的兜底文案。
 * @returns 页面可显示的文案。
 */
export function authErrorText(code: string | undefined | null, fallback = '操作失败，请重试'): string {
  if (typeof code !== 'string' || code === '') return fallback
  return AUTH_ERROR_TEXT[code] ?? fallback
}

/** 绝对时间（`2026-11-14 03:20:43`）。 */
export function formatDateTime(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  const date = typeof value === 'number' ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (input: number): string => String(input).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 相对时间：`刚刚` / `N 分钟前` / `N 小时前` / `昨天 HH:MM` / `M月D日`。
 * @param value - 毫秒时间戳或 ISO 字符串。
 * @param now - 当前时间（测试注入）。
 * @returns 展示文案；无值时 `未记录`。
 */
export function formatRelative(value: number | string | null | undefined, now: number = Date.now()): string {
  if (value === null || value === undefined || value === '') return '未记录'
  const at = typeof value === 'number' ? value : Date.parse(value)
  if (Number.isNaN(at)) return '未记录'
  const delta = now - at
  if (delta < 0) return formatDateTime(at)
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 6 * 3_600_000) return `${Math.floor(delta / 3_600_000)} 小时前`
  const date = new Date(at)
  const today = new Date(now)
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate()
  const pad = (input: number): string => String(input).padStart(2, '0')
  if (sameDay) return `今天 ${pad(date.getHours())}:${pad(date.getMinutes())}`
  const yesterday = new Date(now - 24 * 3_600_000)
  if (date.getFullYear() === yesterday.getFullYear()
    && date.getMonth() === yesterday.getMonth()
    && date.getDate() === yesterday.getDate()) {
    return `昨天 ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }
  return `${date.getMonth() + 1}月${date.getDate()}日`
}
