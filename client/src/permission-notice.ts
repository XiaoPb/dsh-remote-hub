export const REMOTE_PERMISSION_DENIED_EVENT = 'dsh-remote-hub:permission-denied'

export interface PermissionDeniedNotice {
  endpoint: string
  code: 'remote-access/denied'
  reason: string
  title: string
  message: string
}

export function permissionDeniedNotice(
  detail: { action?: unknown; reason?: unknown } | null | undefined,
  locale = 'zh',
): PermissionDeniedNotice {
  const endpoint = typeof detail?.action === 'string' ? detail.action : 'unknown'
  const reason = typeof detail?.reason === 'string' ? detail.reason : 'no-allow'
  const chinese = !locale || locale.toLowerCase().startsWith('zh')
  return {
    endpoint,
    code: 'remote-access/denied',
    reason,
    title: chinese ? '远端权限不足' : 'Remote permission required',
    message: chinese
      ? `当前配对权限或会话范围不允许此操作（${endpoint}）。远端没有被修改。请让目标主机管理员确认此设备的权限。`
      : `This paired device role or session scope does not allow this action (${endpoint}). Nothing was changed on the remote host. Ask the target host owner to review this device's permission.`,
  }
}

export function announcePermissionDenied(
  globalObject: {
    dispatchEvent?: (event: Event) => boolean
    CustomEvent?: typeof CustomEvent
    document?: { documentElement?: { lang?: string } }
    navigator?: { language?: string }
  },
  detail: { action?: unknown; reason?: unknown } | null | undefined,
): boolean {
  const EventCtor = globalObject.CustomEvent ?? globalThis.CustomEvent
  if (typeof EventCtor !== 'function' || typeof globalObject.dispatchEvent !== 'function') return false
  const locale = globalObject.document?.documentElement?.lang ?? globalObject.navigator?.language ?? 'zh'
  globalObject.dispatchEvent(new EventCtor(REMOTE_PERMISSION_DENIED_EVENT, {
    detail: permissionDeniedNotice(detail, locale),
  }))
  return true
}
