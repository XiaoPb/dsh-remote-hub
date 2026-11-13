/**
 * 云端路径 UI 的**延迟装配**（0.3.0 起内置）。
 *
 * ## 为什么是延迟装配
 *
 * 主 client 入口 `inject: []` 立即激活（见 `index.ts` 的说明），而 `slots` /
 * `commandUi` 由宿主的 renderer / command 插件提供，**晚于**本 entry 就绪。
 * 因此这里与导航图标等其他宿主槽位采用同一套路：`ctx.inject(deps, cb)` 等齐服务
 * 再注册；服务始终不来就安静不注册；装配异常只降级、绝不拖垮宿主。
 *
 * ## 为什么在同一个 bundle 里
 *
 * DSH 的 `dsh.client` 声明是**按包**生效的（`resolveMeta` 只认 roster 条目的
 * 包名根 specifier），一个包只能声明一份 client bundle，且固定读 `exports["./client"]`。
 * 想把云端路径 UI 做成「同一包第二个 roster 条目」是行不通的——那条 roster 的
 * specifier 是子路径，`exactPackageSpecifier()` 直接返回 undefined，
 * 客户端 bundle 根本不会被加载。所以它必须并入主 `client.js`，
 * 再按「载体是否激活」在运行期决定是否注册槽位。
 *
 * @module dsh-remote-hub/client/paths/mount
 */
import type { Context } from '@deepseek-ai/cordis'

import { apply, type PathsContext } from './index.js'

/** 云端路径 UI 需要的宿主服务。 */
const PATHS_DEPS = ['slots', 'commandUi', 'sessions', 'conversation'] as const

/** 只注册一次（宿主可能因 HMR 重新装配）。 */
let mounted = false

/** 上一次装配的销毁器。 */
let disposeCurrent: (() => void) | null = null

/**
 * 装配云端路径 UI；服务未就绪时安静返回。
 *
 * @param ctx - Client Cordis root。
 * @returns 是否完成装配。
 */
export function applyCloudPaths(ctx: Context): boolean {
  const host = ctx as unknown as {
    inject?: (deps: readonly string[], callback: (scoped: Context) => (() => void) | void) => unknown
    slots?: unknown
    commandUi?: unknown
    sessions?: unknown
    conversation?: unknown
  }
  if (typeof host.inject !== 'function') return false
  try {
    host.inject(PATHS_DEPS, scoped => {
      const scopedHost = scoped as unknown as PathsContext
      // 服务齐了才装配；任一缺席（例如 desktop 没有 commandUi）就整体跳过，
      // 不注册半套 UI，避免出现「按钮在、点了没反应」。
      if (scopedHost.slots === undefined || scopedHost.commandUi === undefined
        || scopedHost.sessions === undefined || scopedHost.conversation === undefined) return
      try {
        apply(scopedHost)
        mounted = true
      } catch (error) {
        // 云端路径是增强功能：装配失败只降级，不影响接管本身。
        globalThis.dispatchEvent?.(new CustomEvent('dsh-remote-hub:paths-degraded', { detail: { message: String(error) } }))
      }
      return () => {
        mounted = false
        disposeCurrent = null
      }
    })
    return true
  } catch {
    return false
  }
}

/** 云端路径 UI 是否已装配（诊断用）。 */
export function isCloudPathsMounted(): boolean {
  return mounted
}

/** 显式销毁（测试用）。 */
export function disposeCloudPaths(): void {
  disposeCurrent?.()
  disposeCurrent = null
  mounted = false
}
