/**
 * @provenance @deepseek-ai/dsh-client-ui-plugin-manager/src/client/config-ledger.ts @ 0.2.2-rc.1
 * Vendored verbatim from the official plugin manager client. Only imports were rewritten (see
 * scripts/vendor-local-plugin-ui.mjs) so this plugin reuses the official page byte-for-byte while
 * keeping its host-provided runtime surface. Do not hand-edit: regenerate instead.
 */
/**
 * Which plugins bring their own configuration to the Plugins page, read from
 * the three slots the page declares: the official plugins listed beside the
 * official bundles, the bundles with a form on their page, and the rows with a
 * page of their own. The projection follows the slot ledgers and the active
 * locale and keeps its snapshot until one of them moves.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { localLocale, localSlots, resolveLabel } from './official-shims-context.ts'
import type { HostObservable } from './store.ts'
import type {} from './slot-contract.ts'

/** One official plugin as the page lists it: its registration id and its title in the active locale. */
export interface OfficialItem {
  readonly id: string
  readonly label: string
}

/**
 * The plugins carrying configuration: the official plugins in ledger order,
 * the package names of the bundles with a page-level form, and the keys
 * ({@link rowConfigKey}) of the rows with a page.
 */
export interface ConfigLedger {
  readonly items: readonly OfficialItem[]
  readonly bundles: ReadonlySet<string>
  readonly rows: ReadonlySet<string>
}

/**
 * The key a row's configuration registers under.
 * @param bundle - the bundle's package name.
 * @param rowId - the row id the bundle's patch declares.
 * @returns the `plugins.row.config` key.
 */
export function rowConfigKey(bundle: string, rowId: string): string {
  return `${bundle}#${rowId}`
}

const SLOTS = ['plugins.item', 'plugins.bundle.config', 'plugins.row.config'] as const

/**
 * Project the configuration ledgers as one observable the page binds.
 * @param ctx - the page plugin's context, whose slot registry and locale the projection follows.
 * @returns the ledger source; its snapshot changes only when a ledger or the locale does.
 */
export function configLedgerSource(ctx: ClientContext): HostObservable<ConfigLedger> {
  let versions: readonly number[] = []
  let revision = -1
  let ledger: ConfigLedger = { items: [], bundles: new Set(), rows: new Set() }
  const keysOf = (name: 'plugins.bundle.config' | 'plugins.row.config'): ReadonlySet<string> =>
    new Set(localSlots(ctx).entries(name).flatMap(entry => entry.options.key === undefined ? [] : [entry.options.key]))
  return {
    getSnapshot: () => {
      const next = SLOTS.map(name => localSlots(ctx).getVersion(name))
      const current = localLocale(ctx).getSnapshot().revision
      if (current !== revision || next.some((version, index) => version !== versions[index])) {
        versions = next
        revision = current
        ledger = {
          items: localSlots(ctx).entries('plugins.item').map(entry => ({
            /* v8 ignore next -- list-slot registration requires id */
            id: entry.options.id ?? '',
            label: resolveLabel(entry.options.label) ?? '',
          })),
          bundles: keysOf('plugins.bundle.config'),
          rows: keysOf('plugins.row.config'),
        }
      }
      return ledger
    },
    subscribe: (listener) => {
      const offs = [...SLOTS.map(name => localSlots(ctx).subscribe(name, listener)), localLocale(ctx).subscribe(listener)]
      return () => { for (const off of offs) off() }
    },
  }
}
