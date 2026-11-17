/**
 * 展示层语义化：角色名 / 错误码 → 文案、时间与相对时间格式化。
 *
 * 所有面向用户的字符串通过 `t()` 输出，支持中英双语。
 * 语言由 `detectLocale()` 自动从 `<html lang>` 或 `navigator.language` 检测。
 *
 * @module dsh-remote-hub/client/rhui/format
 */
import { ROLE_LABELS, type RoleName } from '@core/roles.js'
import { t } from './i18n.js'

/** 角色显示名。 */
export function formatRole(role: string | undefined | null): string {
  if (role === 'full') return t('roleFull')
  if (role === 'control') return t('roleControl')
  if (role === 'read-only') return t('roleReadOnly')
  return role ?? t('roleUnknown')
}

/** 角色上限文案。 */
export function formatRoleCeiling(role: string | undefined | null): string {
  return `${t('roleCeilingPrefix')}${formatRole(role)}`
}

/**
 * 三段式角色选项（segmented 控件用）。
 *
 * ⚠️ 必须**每次调用**重新求值，不能做成模块级 `const` 常量：
 * `t()` 读的是模块级当前语言，而宿主/用户可以在页面已加载后切语言
 * （「设置 → 通用 → 语言」）。`const ROLE_OPTIONS = [{ label: t(...) }]`
 * 会把文案冻结在模块加载那一刻，切语言后角色下拉仍停在旧语言。
 * @returns 角色选项（当前语言）。
 */
export function roleOptions(): readonly { value: RoleName; label: string }[] {
  return [
    { value: 'read-only', label: t('roleReadOnly') },
    { value: 'control', label: t('roleControl') },
    { value: 'full', label: t('roleFull') },
  ]
}

/** 角色选项展示名。 */
export function roleOptionLabel(role: RoleName): string {
  return formatRole(role)
}

/** core 的短标签（无障碍名称用）。 */
export function shortRoleLabel(role: RoleName): string {
  return ROLE_LABELS[role]?.zh ?? role
}

/**
 * 错误码 → 页面文案（**函数形式**：同 {@link roleOptions}，
 * 不能在模块加载时把 `t()` 的结果冻结成常量）。
 * @param code - 错误码。
 * @returns 当前语言下的文案。
 */
export function authErrorTextMap(): Readonly<Record<string, string>> {
  return {
    'auth-invalid-credentials': t('errInvalidCredentials'),
    'auth-account-disabled': t('errAccountDisabled'),
    'auth-account-not-found': t('errInvalidCredentials'),
    'auth-account-exists': t('errDefault'),
    'auth-last-admin': t('errDefault'),
    'auth-self-action': t('errDefault'),
    'auth-mfa-required': t('errDefault'),
    'auth-mfa-invalid': t('errMfaInvalid'),
    'auth-mfa-expired': t('errMfaExpired'),
    'auth-password-change-required': t('errPasswordChangeRequired'),
    'auth-current-password-invalid': t('errCurrentPasswordInvalid'),
    'auth-password-weak': t('errPasswordWeak'),
    'auth-password-unchanged': t('errPasswordUnchanged'),
    'auth-role-exceeded': t('errForbidden'),
    'auth-forbidden': t('errForbidden'),
    'auth-rate-limited': t('errRateLimited'),
    'auth-lease-expired': t('errMfaExpired'),
    'auth-lease-not-expired': t('errDefault'),
    'auth-client-invalid': t('errMfaExpired'),
    'auth-proof-invalid': t('errDefault'),
    'auth-unauthorized': t('errMfaExpired'),
    'auth-unavailable': t('serviceUnavailable'),
    displaced: t('errDefault'),
    revoked: t('errMfaExpired'),
    'rate-limited': t('errRateLimited'),
    'network-unreachable': t('errDefault'),
    'origin-invalid': t('errDefault'),
  }
}

/** 取错误码对应的文案。 */
export function authErrorText(code: string | undefined | null, fallback?: string): string {
  const fb = fallback ?? t('errDefault')
  if (typeof code !== 'string' || code === '') return fb
  return authErrorTextMap()[code] ?? fb
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
 * 相对时间（双语输出）。
 * @param value - 毫秒时间戳或 ISO 字符串。
 * @param now - 当前时间（测试注入）。
 */
export function formatRelative(value: number | string | null | undefined, now: number = Date.now()): string {
  if (value === null || value === undefined || value === '') return t('timeNotRecorded')
  const at = typeof value === 'number' ? value : Date.parse(value)
  if (Number.isNaN(at)) return t('timeNotRecorded')
  const delta = now - at
  if (delta < 0) return formatDateTime(at)
  if (delta < 60_000) return t('timeJustNow')
  if (delta < 3_600_000) return t('timeMinutesAgo', { n: String(Math.floor(delta / 60_000)) })
  if (delta < 6 * 3_600_000) return t('timeHoursAgo', { n: String(Math.floor(delta / 3_600_000)) })
  const date = new Date(at)
  const today = new Date(now)
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate()
  const pad = (input: number): string => String(input).padStart(2, '0')
  if (sameDay) return t('timeToday', { time: `${pad(date.getHours())}:${pad(date.getMinutes())}` })
  const yesterday = new Date(now - 24 * 3_600_000)
  if (date.getFullYear() === yesterday.getFullYear()
    && date.getMonth() === yesterday.getMonth()
    && date.getDate() === yesterday.getDate()) {
    return t('timeYesterday', { time: `${pad(date.getHours())}:${pad(date.getMinutes())}` })
  }
  return t('timeMonthDay', { month: String(date.getMonth() + 1), day: String(date.getDate()) })
}
