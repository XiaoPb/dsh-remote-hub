/**
 * @provenance @deepseek-ai/dsh-client-ui-plugin-manager/src/client/PluginRefreshToast.tsx @ 0.2.2-rc.1
 * Vendored verbatim from the official plugin manager client. Only imports were rewritten (see
 * scripts/vendor-local-plugin-ui.mjs) so this plugin reuses the official page byte-for-byte while
 * keeping its host-provided runtime surface. Do not hand-edit: regenerate instead.
 */
/** Refresh failure feedback hosted outside the Plugins panel's lifetime. */
import type { ReactNode } from 'react'
import { IconWarningOutlineRegular, Toast } from './primitives.ts'
import type { InjectFace, PropsLocale } from './official-stubs.ts'
import type { PluginManagerFace } from './manager-store.ts'
import { noticeText } from './presentation.ts'

/** The controller's shared notice source and dismissal action. */
export type PluginRefreshToastFace = Pick<PluginManagerFace, 'dismissNotice'> & {
  hooks: Pick<PluginManagerFace['hooks'], 'pluginManager'>
}

/** Render inputs bound from the shared controller and plugin dictionary. */
export type PluginRefreshToastProps = InjectFace<PluginRefreshToastFace> & PropsLocale<'pluginManager'>

/**
 * Display refresh failures even after navigation leaves the Plugins panel.
 * @param props - shared notice hook, dismissal action, and locale seat.
 * @returns the refresh failure toast, or null for other notices.
 */
export function PluginRefreshToast({ usePluginManager, dismissNotice, t }: PluginRefreshToastProps): ReactNode {
  const notice = usePluginManager(state => state.notice)
  if (notice?.kind !== 'refresh-failed') return null
  return (
    <Toast
      key={notice.seq}
      text={noticeText(notice, t)}
      icon={<IconWarningOutlineRegular />}
      onDone={dismissNotice}
    />
  )
}
