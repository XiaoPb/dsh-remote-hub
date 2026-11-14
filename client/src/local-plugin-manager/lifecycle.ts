/**
 * 本地插件页的**可见性**：只在「接管云端设备」期间出现。
 *
 * ## 判定
 *
 * 与侧栏「云端设备」图标的绿点是同一判据（`client/src/panel/NavIcon.ts` 的 `isCloudNavigationConnected`）：
 *
 * ```ts
 * __DSH_REMOTE_HUB_CARRIER__.active === true && __DSH_TRANSPORT__.streamBaseUrl 非空
 * ```
 *
 * 也就是说：只有当 carrier 真的接管了另一个 Host 时，官方「插件」页才会显示别人的插件 ——
 * 此时才有必要给出「本机那份」。断开接管后 carrier 卸下，官方页自己就回到本机，本地页也随之消失。
 *
 * ## 为什么要轮询
 *
 * 接管/断开的入口有几条（页面按钮、CLI 配对、守卫侧吊销），它们最终都写 `carrier-mode.json`
 * 或改 `__DSH_TRANSPORT__`，**没有**一条统一的浏览器事件。侧栏图标已经是 1s 轮询，这里沿用同一频率，
 * 并在 `connection/reset`（重连）时立即重新求值，避免最长 1s 的错位。
 *
 * @module dsh-remote-hub/client/local-plugin-manager/lifecycle
 */

/** 轮询间隔（与侧栏「云端设备」图标一致）。 */
export const CARRIER_POLL_MS = 1000

/** 承载 carrier 状态的两个全局。 */
interface CarrierGlobals {
  __DSH_REMOTE_HUB_CARRIER__?: { readonly active?: boolean }
  __DSH_TRANSPORT__?: { readonly streamBaseUrl?: string }
}

/**
 * 当前是否正处于云端接管中（= 是否应显示本地插件页）。
 * @param globalObject - 可注入的全局对象（测试用）。
 * @returns 接管中为 true。
 */
export function isTakeoverActive(globalObject: unknown = globalThis): boolean {
  const value = globalObject as CarrierGlobals
  const active = value.__DSH_REMOTE_HUB_CARRIER__?.active === true
  const base = value.__DSH_TRANSPORT__?.streamBaseUrl
  return active && typeof base === 'string' && base !== ''
}

/**
 * 观察接管状态；状态翻转时回调。
 * @param onChange - 状态变化回调（只在**翻转**时触发，且在订阅后立即求值一次）。
 * @param options - 可注入的全局对象、轮询间隔与调度器（测试用）。
 * @returns 停止观察的函数。
 */
export function watchTakeover(
  onChange: (active: boolean) => void,
  options: {
    readonly globalObject?: unknown
    readonly intervalMs?: number
    readonly setInterval?: (callback: () => void, ms: number) => unknown
    readonly clearInterval?: (handle: unknown) => void
  } = {},
): () => void {
  const globalObject = options.globalObject ?? globalThis
  const intervalMs = options.intervalMs ?? CARRIER_POLL_MS
  // 浏览器与 Node 的 setInterval 返回类型不同；统一按 unknown 句柄处理。
  const schedule = options.setInterval ?? ((callback, ms) => setInterval(callback, ms) as unknown)
  const cancel = options.clearInterval ?? ((handle) => { clearInterval(handle as ReturnType<typeof setInterval>) })
  // window 可能在无头环境（Node 里的 vm 沙箱、SSR）里没有 addEventListener；轮询始终可用。
  const browserWindow = globalObject as { addEventListener?: unknown }
  const canListen = typeof browserWindow.addEventListener === 'function'
  let current = isTakeoverActive(globalObject)
  let stopped = false
  const onReconnect = (): void => {
    if (stopped) return
    const next = isTakeoverActive(globalObject)
    if (next === current) return
    current = next
    onChange(next)
  }
  onChange(current)
  const handle = schedule(() => {
    if (stopped) return
    const next = isTakeoverActive(globalObject)
    if (next === current) return
    current = next
    onChange(next)
  }, intervalMs)
  if (canListen) (browserWindow as Window).addEventListener('connection/reset', onReconnect)
  return () => {
    if (stopped) return
    stopped = true
    cancel(handle)
    if (canListen) (browserWindow as Window).removeEventListener('connection/reset', onReconnect)
  }
}
