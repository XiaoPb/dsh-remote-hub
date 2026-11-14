/**
 * @provenance @deepseek-ai/dsh-client-ui-plugin-manager/src/client/slot-contract.ts @ 0.2.2-rc.1
 * Vendored verbatim from the official plugin manager client. Only imports were rewritten (see
 * scripts/vendor-local-plugin-ui.mjs) so this plugin reuses the official page byte-for-byte while
 * keeping its host-provided runtime surface. Do not hand-edit: regenerate instead.
 */
/**
 * The slots the Plugins page declares for other plugins. Three carry a
 * plugin's own configuration: the official plugins listed beside the official
 * bundles, one bundle's configuration on its page, and one row's configuration
 * opened from that row. Three more take contributions to any detail page —
 * its head actions, the badges beside its title, and the sections under its
 * own content — from a plugin that has something to say about bundles, rows,
 * or official plugins it does not own. A registrant merges this contract with
 * `import type` and registers through `ctx.slots`; it never imports this
 * package at runtime.
 *
 * A contributed tab, such as Discover, installs through the page's own dialog.
 *
 * Entries accept `page` for the form with its own save control and `summary`
 * for an official card's one-liner or a row's missing-description fallback.
 * Bundle configuration renders only `page`. A detail contribution is rendered
 * with the subject of the open page and decides from it whether to render at
 * all. The page draws the title, icon, and crumb itself.
 */

import type {} from './official-stubs.ts'
import type { BundleInfo } from './official-stubs.ts'
import type { ConfigForm, ConfigFormSnapshot } from './official-stubs.ts'

/** The view the page asks a configuration entry for. */
export interface PluginConfigViewProps {
  /** `summary` renders the one-liner alone, as text or inline nodes; `page` renders the form with its save control. */
  readonly view: 'summary' | 'page'
  /** Host-owned configuration values and write actions for this page's entry. */
  readonly form?: ConfigPageForm | undefined
}

/** One row of a bundle as a detail contribution sees it. */
export interface PluginRowRef {
  /** The row id as the bundle's patch declares it. */
  readonly rowId: string
  /** The module the row names. */
  readonly moduleName: string
  /** Whether the row's entry runs. */
  readonly enabled: boolean
}

/** One bundle as a detail contribution sees it: the facts a contribution decides on, never the page's own state. */
export interface PluginPackageRef {
  /** The package name. */
  readonly name: string
  /** The installed version, when the Host reports one. */
  readonly version?: string
  /** Whether the profile declares the package dependency. */
  readonly installed: boolean
  /** Readable package location; missing entries can retain a dependency declaration. */
  readonly availability: BundleInfo['availability']
  /** Whether the installation offers this package in Official. */
  readonly official: boolean
  /** Whether the bundle is switched on. */
  readonly enabled: boolean
  /** The rows the bundle declares. */
  readonly rows: readonly PluginRowRef[]
}

/** What a detail page is about: a bundle, one row of a bundle, or an official plugin listed by its `plugins.item` id. */
export type PluginsSubject =
  | { readonly kind: 'bundle'; readonly pkg: PluginPackageRef }
  | { readonly kind: 'row'; readonly pkg: PluginPackageRef; readonly row: PluginRowRef }
  | { readonly kind: 'item'; readonly id: string }

/** The owner props every detail contribution is rendered with. */
export interface PluginDetailProps {
  /** The subject of the open page; an entry renders null for a subject it has nothing for. */
  readonly subject: PluginsSubject
}

/** One user-requested bundle activation and navigation to its configuration page. */
export interface PluginActivationOwnerProps {
  readonly packageName: string
  /** Dismiss guidance for this activation. */
  readonly onDismiss: () => void
  /** Dismiss guidance and open this bundle's detail page. */
  readonly onOpenDetails: () => void
}

/** An exact version a tab asks the Plugins page to install, with the text the install dialog shows for it. */
export interface PluginTabInstall {
  /** The install spec, such as `name@version` or a pinned `git+https` URL. */
  readonly spec: string
  /** The registry to ask first for this install only; absent keeps the dialog's registry choice. */
  readonly registry?: string
  /** Display name of the plugin, already localized. */
  readonly title: string
  /** The version being installed. */
  readonly version: string
}

/** Owner props of a page tab another plugin contributes, such as Discover. */
export interface PluginTabProps {
  /**
   * Install an exact version the person already confirmed: the page's install dialog opens at its check and progress
   * screens, without the spec form, and names the plugin and version above the spec.
   * @param target - the spec, optional registry, and display text.
   */
  readonly install: (target: PluginTabInstall) => void
  /**
   * Switch to the Installed tab and open a bundle's page, whose back button returns to the calling tab.
   * @param packageName - npm package name of the bundle.
   */
  readonly openPackage: (packageName: string) => void
}

/** Add-plugin menu actions, independent of any selected bundle or Session. */
export interface PluginAddActionsProps {
  /** Close the add-plugin menu before starting the contributed action. */
  readonly onDismiss: () => void
}



/** Reactive page values and commands supplied by the configuration page owner. */
export interface ConfigPageForm {
  /** Accepted Host values; refreshed by the page owner. */
  readonly state: ConfigFormSnapshot<Record<string, unknown>>
  /** Submit all field edits together with the revision the editor read. */
  readonly mutate: ConfigForm<Record<string, unknown>>['mutate']
}
