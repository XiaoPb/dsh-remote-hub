/**
 * @provenance @deepseek-ai/dsh-client-ui-plugin-manager/src/client/tab-ledger.ts @ 0.2.2-rc.1
 * Vendored verbatim from the official plugin manager client. Only imports were rewritten (see
 * scripts/vendor-local-plugin-ui.mjs) so this plugin reuses the official page byte-for-byte while
 * keeping its host-provided runtime surface. Do not hand-edit: regenerate instead.
 */
/** The tabs other plugins contribute to the Plugins page through `plugins.tab`, in the active locale. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { localLocale, localSlots, resolveLabel } from './official-shims-context.ts'
import type { HostObservable } from './store.ts'
import type {} from './slot-contract.ts'

/** One contributed tab: its registration id and its label in the active locale. */
export interface PluginTab {
  readonly id: string
  readonly label: string
}

/**
 * Project the `plugins.tab` ledger as one observable the page binds.
 * @param ctx - the page plugin's context, whose slot registry and locale the projection follows.
 * @returns the tab source; its snapshot changes only when the ledger or the locale does.
 */
export function tabLedgerSource(ctx: ClientContext): HostObservable<readonly PluginTab[]> {
  let version = -1
  let revision = -1
  let tabs: readonly PluginTab[] = []
  return {
    getSnapshot: () => {
      const next = localSlots(ctx).getVersion('plugins.tab')
      const current = localLocale(ctx).getSnapshot().revision
      if (next !== version || current !== revision) {
        version = next
        revision = current
        tabs = localSlots(ctx).entries('plugins.tab').map(entry => ({
          /* v8 ignore next -- list-slot registration requires id */
          id: entry.options.id ?? '',
          label: resolveLabel(entry.options.label) ?? '',
        }))
      }
      return tabs
    },
    subscribe: (listener) => {
      const offs = [localSlots(ctx).subscribe('plugins.tab', listener), localLocale(ctx).subscribe(listener)]
      return () => { for (const off of offs) off() }
    },
  }
}
