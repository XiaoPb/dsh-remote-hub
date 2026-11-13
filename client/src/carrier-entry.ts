/**
 * Carrier 安装入口。
 *
 * ## 时机（2026-11-12 调研修正）
 *
 * 旧假设「模块顶层执行即可」**不成立**：桌面 shell 在 boot 过程中会写
 *
 * ```js
 * globalThis.__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl }
 * ```
 *
 * 早于它注入会被覆盖。官方顺序是 shell 写完后 `r.resolve()` → `t.run()` 启动
 * cordis → `connection.apply`，因此 `__DSH_BOOT_READY__.promise` resolve
 * **晚于** shell 写入、**早于** `connection.apply`，是唯一安全窗口。
 *
 * ## 模式来源（2026-11-12 实机修正）
 *
 * CLI 配对只写磁盘 `carrier-mode.json`，不写浏览器 localStorage。若只看
 * localStorage，页面必须手动点「连接」才会接管。因此在 boot 窗口内主动
 * 向宿主查询一次（`admin.carrier`），把磁盘状态纳入判定。
 *
 * @module dsh-remote-hub/client/carrier-entry
 */
import {
  installCarrier,
  installCarrierResolvingMode,
  type CarrierInstallResult,
} from './carrier.js'

/**
 * 磁盘上的出站状态（含「是否为用户显式断开」）。
 *
 * 与「从未配对」的区别很重要：
 * - `{ mode: 'local', explicit: true }`  ← 用户在页面上点了「断开」，**否决接管**
 * - `{ mode: 'local', explicit: false }` ← 从未配对 / 查询失败，读 localStorage 即可
 */
type HostCarrierState =
  | { mode: 'local'; explicit: boolean }
  | { mode: 'cloud'; origin: string; token: string; targetId?: string; deviceLabel?: string }

/**
 * 通过同源管理端点读取磁盘上的出站状态。
 *
 * @returns 磁盘状态；查询失败时 `{ mode: 'local', explicit: false }`。
 */
async function queryHostCarrierMode(): Promise<HostCarrierState> {
  try {
    const rpcId = `carrier-${Math.random().toString(36).slice(2, 10)}`
    // 用**相对路径**：`/api/hub/admin.carrier` 会解析到本机 Host。
    //  - desktop（`dsh-app://app`）：Electron forwardWebRequest 转发到本机 Host
    //  - web（`http://host:port`）：本来就是同源
    // 不能用远端 origin 拼接——这个端点读的是**本机**的 carrier-mode.json。
    const response = await globalThis.fetch('/api/hub/admin.carrier', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method: 'hub/admin.carrier',
        payload: { args: {} },
      }),
    })
    if (!response.ok) return { mode: 'local', explicit: false }
    const parsed = await response.json() as {
      result?: {
        ok?: boolean
        value?: { mode?: Record<string, unknown>; exists?: unknown }
      }
    }
    const raw = parsed.result?.value?.mode
    // 「文件存在 + mode=local」= 用户显式断开（写盘的是 onDetach）。
    const exists = parsed.result?.value?.exists === true
    if (raw === undefined) return { mode: 'local', explicit: false }
    if (raw.mode === 'local') return { mode: 'local', explicit: exists }
    if (raw.mode !== 'cloud') return { mode: 'local', explicit: false }
    if (typeof raw.origin !== 'string' || typeof raw.token !== 'string') {
      return { mode: 'local', explicit: false }
    }
    return {
      mode: 'cloud',
      origin: raw.origin,
      token: raw.token,
      ...(typeof raw.targetId === 'string' && raw.targetId !== '' ? { targetId: raw.targetId } : {}),
      ...(typeof raw.deviceLabel === 'string' && raw.deviceLabel !== ''
        ? { deviceLabel: raw.deviceLabel }
        : {}),
    }
  } catch {
    return { mode: 'local', explicit: false }
  }
}

/**
 * 把「已停止接管」写进磁盘真源（`carrier-mode.json`）。
 *
 * 启动时磁盘优先，所以身份失效（401 / `device-revoked`）后**必须**先把这个
 * 状态落盘，否则重载会再次从磁盘读到 cloud 并连回同一个失效目标。
 *
 * 失败只告警、不抛出：调用方要在失败后仍然重载回本机。
 * @returns 写入完成。
 */
async function persistLocalMode(): Promise<void> {
  try {
    const rpcId = `carrier-local-${Math.random().toString(36).slice(2, 10)}`
    const response = await globalThis.fetch('/api/hub/admin.carrierWrite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method: 'hub/admin.carrierWrite',
        payload: { args: { mode: { mode: 'local' } } },
      }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
  } catch (error) {
    console.warn(
      `dsh-remote-hub: could not persist local mode (${error instanceof Error ? error.message : String(error)}); `
      + 'the on-disk target may still be cloud',
    )
  }
}

/**
 * **同步**读取宿主的出站状态（磁盘真源）。
 *
 * ## 为什么必须是同步的
 *
 * 页面实测时序（2026-11-12，CDP 探针）：
 * ```
 * 42–108ms  connection 多次读取 __DSH_TRANSPORT__ → 全部 undefined
 * 118ms     carrier 才写入 transport
 * ```
 * `connection.apply()` 在 cordis 启动时**同步**读取 transport 并闭包捕获 fetch。
 * 只要在它之前用 `await` 做过任何事（哪怕一次 fetch），注入就一定晚于捕获，
 * 结果是「transport 注入了、页面 RPC 仍走本机」。
 *
 * localStorage 是新会话的可靠来源，但**首次访问/换浏览器**时是空的；此时只能
 * 问磁盘。用同步 XHR 是唯一能在 `connection.apply` 之前拿到磁盘值的办法。
 * 它只在「缓存里没有 cloud」这一条冷路径上发生，代价是一次本地 HTTP 往返。
 *
 * @returns 磁盘状态；失败时返回 null（走 localStorage 兜底）。
 */
function readHostCarrierModeSync(): HostCarrierState | null {
  try {
    const Xhr = (globalThis as { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest
    if (Xhr === undefined) return null
    const request = new Xhr()
    request.open('POST', '/api/hub/admin.carrier', false) // false = 同步
    request.setRequestHeader('content-type', 'application/json')
    request.send(JSON.stringify({
      type: 'client-request',
      rpcId: `carrier-sync-${Math.random().toString(36).slice(2, 10)}`,
      method: 'hub/admin.carrier',
      payload: { args: {} },
    }))
    if (request.status < 200 || request.status >= 300) return null
    const parsed = JSON.parse(request.responseText) as {
      result?: { value?: { mode?: Record<string, unknown>; exists?: unknown } }
    }
    const raw = parsed.result?.value?.mode
    const exists = parsed.result?.value?.exists === true
    if (raw === undefined) return { mode: 'local', explicit: false }
    if (raw.mode === 'local') return { mode: 'local', explicit: exists }
    if (raw.mode !== 'cloud') return { mode: 'local', explicit: false }
    if (typeof raw.origin !== 'string' || typeof raw.token !== 'string') {
      return { mode: 'local', explicit: false }
    }
    return {
      mode: 'cloud',
      origin: raw.origin,
      token: raw.token,
      ...(typeof raw.targetId === 'string' && raw.targetId !== '' ? { targetId: raw.targetId } : {}),
      ...(typeof raw.deviceLabel === 'string' && raw.deviceLabel !== ''
        ? { deviceLabel: raw.deviceLabel }
        : {}),
    }
  } catch {
    // 同步 XHR 被 CSP/浏览器策略禁用 → 退回 localStorage。
    return null
  }
}

/**
 * 在当前时机安装 carrier（必要时查询宿主状态）。
 * @returns 安装结果。
 */
export function ensureCarrier(): Promise<CarrierInstallResult> {
  return installCarrierResolvingMode({
    // 同步来源优先：会在 boot 回调里**立即**取值，不产生 await。
    fetchModeSync: readHostCarrierModeSync,
    fetchMode: queryHostCarrierMode,
    persistLocal: persistLocalMode,
  })
}

/**
 * 把 carrier 引导函数挂到全局（保留为公共 API，供宿主或测试显式触发）。
 *
 * 正常路径不需要调用它：`lib/carrier-boot.js` 作为独立 IIFE 被内联进
 * `lib/client.js` 的 bundle 顶层，模块求值时就会 `void ensureCarrier()`。
 * @returns 无。
 */
export function bootCarrierFromGlobal(): void {
  const target = globalThis as { __DSH_REMOTE_HUB_BOOTED__?: boolean }
  if (target.__DSH_REMOTE_HUB_BOOTED__ === true) return
  target.__DSH_REMOTE_HUB_BOOTED__ = true
  try {
    void ensureCarrier()
  } catch (error) {
    // 引导失败绝不能让 bundle 求值抛错（宿主会判 entry 激活失败）。
    try { console.warn(`dsh-remote-hub: carrier boot failed (${String(error)})`) } catch { /* 忽略 */ }
  }
}
// carrier 现在由 tsdown 打成独立 IIFE（lib/carrier-boot.js），内联进 client.js 的
// bundle 顶层（factory 之前）。模块求值即开始引导——
// 在 IIFE 场景下这就是 bundle 求值时，早于 connection.apply()。
void ensureCarrier()

export { installCarrier }
