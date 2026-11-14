/**
 * 本地插件页的**面板装配**：侧栏行 + 主面板 + 刷新提示。
 *
 * 这个文件是「本地插件页」这一侧的全部装配代码 —— 页面本身（`PluginManagerPage.tsx`）
 * 与它的 CSS / 文案 / 控制器都是官方源码的逐行副本，这里只负责：
 *
 * 1. 造一个**本机数据源**的控制器（`LocalPluginManagerController`，只换发送层）；
 * 2. 注册本插件的字典命名空间（`remoteHubLocalPlugins`）；
 * 3. 按官方 page 的 props 形状组装注入面（face + 导航 store + 头部 ref）；
 * 4. 在 `sidebar.panellist` / `main` / `shell.overlay` 上注册（**仅在接管中**，见 `lifecycle.ts`）；
 * 5. 面板卸载时把样式表、事件订阅、控制器一起收干净。
 *
 * ⚠️ 子槽位策略（ADR-004）：本页**不声明** `plugins.*` 子槽。那些槽是全局声明资源、已被官方页独占，
 * 这里不与之争抢，官方页行为因此 100% 不变；代价是该页不渲染内置官方插件卡与第三方配置入口。
 *
 * @module dsh-remote-hub/client/local-plugin-manager/panel
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'

import { LocalPluginManagerClient } from './transport.ts'
import { localLocale } from './official-shims-context.ts'
import { installStylesheet, removeStylesheet } from './css-modules.ts'
import { createNavigationStore } from './navigation-store.ts'
import { LocalPluginManagerController } from './local-controller.ts'
import { LocalPluginsPanelIcon } from './LocalPluginsPanelIcon.tsx'
import { PluginManagerPage } from './PluginManagerPage.tsx'
import { PluginRefreshToast } from './PluginRefreshToast.tsx'
import { configLedgerSource } from './config-ledger.ts'
import { tabLedgerSource } from './tab-ledger.ts'
import { createPluginHeaderRef } from './header-scroll.ts'
import { LOCAL_PANEL_KEY, LOCAL_PANEL_ORDER, LOCALE_NAMESPACE } from './locale-namespace.ts'
import { activeLanguage, bindLanguage, registerDictionaries, translate } from './panel-copy.ts'

/** 与官方 `ui-plugin-manager` 一致的九个 `plugins.*` 子槽声明。 */
const PLUGIN_CHILD_SLOTS = {
  'plugins.add.actions': { kind: 'list', scope: 'root' },
  'plugins.tab': { kind: 'list', scope: 'root' },
  'plugins.item': { kind: 'list', scope: 'root' },
  'plugins.bundle.activation': { kind: 'keyed', scope: 'root' },
  'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
  'plugins.row.config': { kind: 'keyed', scope: 'root' },
  'plugins.detail.actions': { kind: 'list', scope: 'root' },
  'plugins.detail.badge': { kind: 'list', scope: 'root' },
  'plugins.detail.section': { kind: 'list', scope: 'root' },
} as const

/** 侧栏行与主面板共用的 id（与官方 `plugins` 并列且互不冲突）。 */
export const LOCAL_PANEL_ID = LOCAL_PANEL_KEY

/** 样式表标识（`data-plugin-css` 的值，与编译期生成的 id 一致）。 */

/**
 * 除主页面外还要在挂载时注入的样式表。
 *
 * 官方页面把 `css.*` 类名分散在 `PluginManagerPage.module.css` 与若干原子组件里；
 * 少注入任何一张，对应控件就会退化成浏览器原生外观（2026-11-14 实机：按钮就是原生控件）。
 * 这里是**全部** vendored 样式表（`scripts/copy-client-css.mjs` 编译进 bundle 的那些）。
 */
const STYLESHEET_IDS: readonly string[] = [
  // ⚠️ 顺序 = 层叠顺序，必须与官方页面的模块图一致：原子组件先、页面后。
  // 否则同优先级的规则会被页面样式压掉 —— 例如「添加插件」弹窗：
  // `Modal.module.css` 的 `.dialog { width: min(380px,100%) }` 会盖住
  // `PluginManagerPage.module.css` 的 `.installDialog { width: min(560px,100%) }`，
  // 弹窗只有 380px 宽（2026-11-14 实测）。
  'Button.module.css',
  'Checkbox.module.css',
  'CommandText.module.css',
  'DetailDocument.module.css',
  'Input.module.css',
  'Menu.module.css',
  'MenuSurface.module.css',
  'Modal.module.css',
  'Pill.module.css',
  'SegmentedTabs.module.css',
  'ShortcutKeys.module.css',
  'StateDot.module.css',
  'Switch.module.css',
  'Tag.module.css',
  'TerminalBlock.module.css',
  'Toast.module.css',
  'Tooltip.module.css',
  // 页面样式最后注入：它自己的布局覆盖（如弹窗宽度）才能生效。
  'PluginManagerPage.module.css',
]

/** 宿主槽位注册表的最小形状。 */
interface SlotsFace {
  register(options: Record<string, unknown>, component: unknown): () => void
  inject?(name: string, setup: () => void): (() => void) | undefined
}

/** 一个已装配的本地插件页。 */
export interface LocalPluginsPanel {
  /** 面板 id。 */
  readonly panelId: string
  /** 卸载：撤销全部注册、断开事件订阅、移除样式表。 */
  dispose(): void
}

/**
 * 把一个事件帧转交给控制器（与官方页 `ctx.remote.$on(...)` 的四处回调一一对应）。
 * @param controller - 本地控制器。
 * @param frame - 直连通道推来的事件帧。
 */
function applyEventFrame(
  controller: LocalPluginManagerController,
  frame: { readonly type: string; readonly [key: string]: unknown },
): void {
  const refresh = (): void => {
    controller.details.reset()
    if (controller.getSnapshot().status !== 'idle') void controller.load()
  }
  switch (frame.type) {
    case 'changed':
      refresh()
      return
    case 'install-log':
      controller.appendLog(frame.chunk as never)
      return
    case 'install-state':
      controller.installProgress(frame.progress as never)
      return
    case 'update-state':
      controller.updateProgress(frame.progress as never)
      return
    default:
      return
  }
}

/**
 * 装配本地插件页。
 *
 * @param ctx - 已就绪 `slots` / `locale` 的客户端 Context。
 * @param options - 可注入自定义传输（测试用）。
 * @returns 句柄；宿主缺少必需服务时返回 `undefined`（安静不挂）。
 */
export function mountLocalPluginsPanel(
  ctx: Context,
  options: { readonly transport?: LocalPluginManagerClient } = {},
): LocalPluginsPanel | undefined {
  const slots = (ctx as unknown as { slots?: SlotsFace }).slots
  if (slots === undefined || typeof slots.register !== 'function') return undefined

  // ① 数据源：本机直连通道（不经 __DSH_TRANSPORT__，永远指向本进程的 DSH）。
  const transport = options.transport ?? new LocalPluginManagerClient()
  const controller = new LocalPluginManagerController(ctx, transport)
  const subscription = transport.subscribe({
    onFrame: frame => { applyEventFrame(controller, frame as never) },
    // 断档（服务端缓冲不够）⇒ 重新读一遍，与官方页处理 `connection/reset` 的方式一致。
    onReset: () => {
      controller.details.reset()
      if (controller.getSnapshot().status !== 'idle') void controller.load()
    },
  })

  // 字典：本插件命名空间（remoteHubLocalPlugins），九种语言，词表来自官方副本。
  bindLanguage(activeLanguage(ctx))

  // ② 官方页的注入面：配置账本、tab 账本、文本解析、导航 store、头部 ref。
  const configLedger = configLedgerSource(ctx)
  const face = controller.inject(
    configLedger,
    tabLedgerSource(ctx),
    text => (localLocale(ctx) as unknown as { resolveText(value: unknown): string }).resolveText(text),
  )
  const navigation = createNavigationStore()
  const instance = navigation.create()

  const disposers: (() => void)[] = [registerDictionaries(ctx)]
  // `slots.inject(name, setup)` 返回**等待器**的释放函数，不是 setup 的释放函数：
  // 注册动作发生在 setup 内，它的 disposer 必须由调用方自己收集，否则永远没人释放。
  const waiters: (() => void)[] = []
  const declare = (name: string, setup: () => void): void => {
    if (typeof slots.inject === 'function') {
      const stop = slots.inject(name, setup)
      if (typeof stop === 'function') waiters.push(stop)
    } else {
      setup()
    }
  }

  // ③ 样式：把 vendored 的每一张样式表都注入一次（卸载时全部移除）。
  //    只注入主页面那张会让原子组件退回浏览器默认外观 —— 按钮就是原生 `<button>`。
  const installed: string[] = []
  for (const id of STYLESHEET_IDS) {
    try {
      installStylesheet(id)
      installed.push(id)
    } catch (error) {
      // 某张表没打进 bundle：其余样式照常注入，不整体失败。
      // 打开 `globalThis.__DSH_REMOTE_HUB_DEBUG__ = true` 可看到具体原因。
      const debug = (globalThis as { __DSH_REMOTE_HUB_DEBUG__?: boolean }).__DSH_REMOTE_HUB_DEBUG__ === true
      if (typeof console !== 'undefined') console.warn(`dsh-remote-hub: stylesheet ${id} was not injected`, debug ? error : '')
    }
  }

  // ④ 主面板：官方页面组件 + 本地 face。
  //
  // ⚠️ 必须声明 `children`（哪怕只是「借位」）：宿主渲染器只有在条目声明了 children 时才会把
  // `renderSlot` 放进渲染 kit（`ui-renderer/scoped-slots.tsx` 的 `if (entry.children !== undefined)`）。
  // 不声明 → `props.renderSlot === undefined` → 「内置插件配置」点进去一片空白（2026-11-14 实测）。
  //
  // 真正的**声明权**仍在官方页：宿主规定一个子槽只能有一个声明者，官方页先声明，这里再申明会抛
  // `slot "plugins.item" is already declared`（已实测）。因此下面的 `children` 表只是让渲染器把
  // `renderSlot` 交给本页，页面的 `renderContribution()` 对每个 key 都做了 try/catch：
  // 若本注册确实持有该声明就正常渲染，否则退化为「没有贡献者」。
  // 只要官方页持有声明，配置贡献者就正常注册、本页正常渲染（`renderSlot` 的解析只看注册表，不看 parent）。
  declare('main', () => {
    disposers.push(slots.register({
      name: 'main',
      key: LOCAL_PANEL_ID,
      locale: LOCALE_NAMESPACE,
      store: { ...navigation, create: () => instance },
      inject: () => ({
        ...face,
        createHeaderRef: createPluginHeaderRef,
        // 页头标题：官方页的文案是「插件」，这里必须改成「本地插件」，
        // 否则本页与官方页标题一模一样，用户在两个页签之间分不清哪个是本机的。
        localTitle: translate('panel'),
      }),
      // 不声明 children：官方页持有声明权，这里只渲染（见下方注释与 ADR-004）。
    }, PluginManagerPage as unknown as (props: unknown) => ReactNode))
  })

  // ⑤ 刷新提示（官方页放在 shell.overlay 上的同一个组件）。
  declare('shell.overlay', () => {
    disposers.push(slots.register({
      name: 'shell.overlay',
      id: 'local-plugins.refresh-toast',
      locale: LOCALE_NAMESPACE,
      inject: () => ({ hooks: { pluginManager: face.hooks.pluginManager }, dismissNotice: face.dismissNotice }),
    }, PluginRefreshToast as unknown as (props: unknown) => ReactNode))
  })

  // ⑥ 侧栏行：同一枚官方 pinwheel + 绿点（见 LocalPluginsPanelIcon 的说明）。
  declare('sidebar.panellist', () => {
    disposers.push(slots.register({
      name: 'sidebar.panellist',
      id: LOCAL_PANEL_ID,
      order: LOCAL_PANEL_ORDER,
      label: () => translate('panel'),
      locale: LOCALE_NAMESPACE,
    }, LocalPluginsPanelIcon as unknown as (props: unknown) => ReactNode))
  })

  return {
    panelId: LOCAL_PANEL_ID,
    dispose() {
      for (const dispose of [...disposers].reverse()) {
        try {
          dispose()
        } catch {
          // 卸载期异常不得影响宿主收尾。
        }
      }
      disposers.length = 0
      for (const stop of waiters.splice(0)) {
        try {
          stop()
        } catch {
          // 等待器释放失败不影响其余收尾。
        }
      }
      subscription.dispose()
      transport.dispose()
      controller.dispose()
      for (const id of installed) removeStylesheet(id)
      installed.length = 0
    },
  }
}
