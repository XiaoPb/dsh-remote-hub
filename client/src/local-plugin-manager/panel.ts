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

/** 侧栏行与主面板共用的 id（与官方 `plugins` 并列且互不冲突）。 */
export const LOCAL_PANEL_ID = LOCAL_PANEL_KEY

/** 样式表标识（`data-plugin-css` 的值，与编译期生成的 id 一致）。 */
const STYLESHEET_ID = 'PluginManagerPage.module.css'

/** 宿主槽位注册表的最小形状。 */
interface SlotsFace {
  register(options: Record<string, unknown>, component: unknown): () => void
  inject?(name: string, setup: () => void): unknown
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
  const declare = (name: string, setup: () => void): void => {
    if (typeof slots.inject === 'function') slots.inject(name, setup)
    else setup()
  }

  // ③ 样式：编译期打进 bundle 的那份 CSS，挂载时注入一次（卸载时移除）。
  installStylesheet(STYLESHEET_ID)

  // ④ 主面板：官方页面组件 + 本地 face。不声明 `plugins.*` 子槽（ADR-004）。
  declare('main', () => {
    disposers.push(slots.register({
      name: 'main',
      key: LOCAL_PANEL_ID,
      locale: LOCALE_NAMESPACE,
      store: { ...navigation, create: () => instance },
      inject: () => ({ ...face, createHeaderRef: createPluginHeaderRef }),
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
      subscription.dispose()
      transport.dispose()
      controller.dispose()
      removeStylesheet(STYLESHEET_ID)
    },
  }
}
