/**
 * 本地插件页的槽位契约增强（`plugins.*` 子槽）。
 *
 * 由 `scripts/fix-local-plugin-types.mjs` 从 vendored 的 `slot-contract.ts` 提升到这里：TypeScript 只允许
 * 「declare 一个已存在的模块」（module augmentation），而 vendored 文件是 module（有 import/export），
 * 因此增强必须放在**全局脚本**（.d.ts，无顶层 import/export）。
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Additional MenuItemButton rows after installation: 72px high, with a title and a description capped at two lines. */
    'plugins.add.actions': { kind: 'list'; scope: 'root'; owner: PluginAddActionsProps }
    /**
     * Tabs after the page's own Installed tab, such as Discover: `label` names the tab and `order` places it. The
     * page renders the selected entry under its header and tabs; the entry draws its own content and installs
     * through the owner's `install`.
     */
    'plugins.tab': { kind: 'list'; scope: 'root'; owner: PluginTabProps }
    /** Optional guidance after the user enables a bundle from the list, keyed by npm package name. */
    'plugins.bundle.activation': { kind: 'keyed'; scope: 'root'; owner: PluginActivationOwnerProps }
    /**
     * One official plugin the Plugins page lists in its Official group after
     * the official bundles: `label` is the card's title and `order` its place.
     * The page renders the entry as the card's one-liner (`view: 'summary'`)
     * and, once the card is opened, as the body of the plugin's own page
     * (`view: 'page'`). OCCUPIED by the official settings pages, one companion
     * package per host-plane namespace; a bundle's configuration belongs in
     * `plugins.bundle.config` or `plugins.row.config` instead.
     */
    'plugins.item': { kind: 'list'; scope: 'root'; owner: PluginConfigViewProps }
    /**
     * A bundle's own configuration, keyed by the bundle's package name and
     * rendered on the bundle's page between its description and its rows
     * (`view: 'page'` only).
     */
    'plugins.bundle.config': { kind: 'keyed'; scope: 'root'; owner: PluginConfigViewProps }
    /**
     * The configuration of one row a bundle declares, keyed by
     * `<package name>#<row id>` with the row id as the bundle's patch declares
     * it: the row on the bundle's page gains a configure control that opens
     * the entry's page, headed by the plugin's display title and description.
     * An absent description falls back to the entry's `view: 'summary'`.
     */
    'plugins.row.config': { kind: 'keyed'; scope: 'root'; owner: PluginConfigViewProps }
    /**
     * Controls at the head of a detail page, before the page's own switch and
     * uninstall, rendered with the page's subject. An entry renders null for a
     * subject it has no control for.
     */
    'plugins.detail.actions': { kind: 'list'; scope: 'root'; owner: PluginDetailProps }
    /**
     * Tags beside a detail page's title, after the version, beta, and problem
     * tags the page draws itself, rendered with the page's subject.
     */
    'plugins.detail.badge': { kind: 'list'; scope: 'root'; owner: PluginDetailProps }
    /**
     * Sections under a detail page's own content: after the source on a bundle's
     * page, after the configuration on a row's or an official plugin's page.
     * An entry draws its own section chrome and renders null for a subject it
     * has nothing for.
     */
    'plugins.detail.section': { kind: 'list'; scope: 'root'; owner: PluginDetailProps }
  }
}
