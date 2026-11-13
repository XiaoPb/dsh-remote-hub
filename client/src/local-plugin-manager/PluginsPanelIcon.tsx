/**
 * @provenance @deepseek-ai/dsh-client-ui-plugin-manager/src/client/PluginsPanelIcon.tsx @ 0.2.2-rc.1
 * Vendored verbatim from the official plugin manager client. Only imports were rewritten (see
 * scripts/vendor-local-plugin-ui.mjs) so this plugin reuses the official page byte-for-byte while
 * keeping its host-provided runtime surface. Do not hand-edit: regenerate instead.
 */
/** The sidebar's Plugins entry icon; the sidebar owns the button, label, and selected state around it. */

import type { ReactNode } from 'react'
import { IconPluginPinwheelOutlineRegular } from './primitives.ts'
import type { PropsRuntime } from './official-stubs.ts'
import type {} from './official-stubs.ts'

/**
 * Render the plugin glyph at the size the sidebar asks for.
 * @param props - the sidebar's icon share: the requested edge and whether the panel is selected.
 * @returns the icon element.
 */
export function PluginsPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <IconPluginPinwheelOutlineRegular size={size} />
}
