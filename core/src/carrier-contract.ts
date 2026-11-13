/**
 * Carrier 传输契约类型（Task 1 spike 产出，见 `docs/verification/05-transport-contract.md`）。
 *
 * 这是 `globalThis.__DSH_TRANSPORT__` 的 TypeScript 形状，按
 * `@deepseek-ai/dsh-client-connection` 0.2.2-rc.1 的 `client.browser.js` 源码
 * 钉死（apply → installConnection → createWebConnectionRpc）。
 *
 * 消费者：`client/src/carrier-entry.ts`（安装点）与
 * `client/src/carrier-transport.ts`（openStream 实现）。
 *
 * @module @core/carrier-contract
 */

/** 官方 client-request 信封（dsh-client-connection `rpc.d.ts:62-67` 同形）。 */
export interface CarrierClientRequest {
  readonly type: 'client-request'
  readonly rpcId: string
  readonly method: string
  readonly payload: unknown
}

/** 官方 server-response 信封（rpc.d.ts:69-73 同形）。 */
export interface CarrierServerResponse {
  readonly type: 'server-response'
  readonly rpcId: string
  readonly result:
    | { readonly ok: true; readonly value?: unknown }
    | {
      readonly ok: false
      readonly error: { readonly code: string; readonly message: string; readonly details: object }
    }
}

/**
 * `__DSH_TRANSPORT__` 契约。官方只读取以下成员（client.browser.js:1387、
 * :1423、:1506）；本插件只提供 `fetch` 与 `openStream`。
 */
export interface DshTransport {
  /** 一元 RPC 的 fetch 覆盖；缺省 = globalThis.fetch。 */
  fetch?: typeof globalThis.fetch
  /**
   * 流载体：`open('/api', endpoint, payload, signal, uplink)` 的实现。
   * 返回的 AsyncIterable 的每个值是一帧事件（官方逐值消费，无批包装）。
   */
  openStream?: (
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
    uplink?: AsyncIterable<unknown>,
  ) => AsyncIterable<unknown>
  /** 官方仍想开 WS 时的钩子（提供 openStream 后官方流不走 WS）。 */
  createWebSocket?: (url: string) => WebSocket
  /** WS 用的 HTTP origin（仅 createWebSocket 场景需要）。 */
  streamBaseUrl?: string
  /** 声明 carrier 自己拥有 Host（影响官方 isLoopback 判定）。 */
  ownsHost?: boolean
  /** 整个 rpc 调用器替换（最重级；本插件不用）。 */
  rpc?: unknown
}

/** Carrier mode hint shared by local Host and renderer; bearer lives only in Host archive. */
export interface CarrierMode {
  /** `local` = 官方直连本机；`cloud` = 经目标设备守卫。 */
  readonly mode: 'local' | 'cloud'
  /** cloud 模式：目标守卫 origin。 */
  readonly origin?: string
  /** 本地 Host 配对档案 opaque id；不含 secret。 */
  readonly targetId?: string
  /** cloud bearer 仅为旧版兼容/运行时内存输入，不写入 localStorage。 */
  readonly token?: string
  /** cloud 模式：设备展示名（UI 角标用，非敏感）。 */
  readonly deviceLabel?: string
}

/** localStorage 键（carrier 与 UI 的唯一共享键）。 */
export const MODE_KEY = 'remote-hub.mode'

/** 从 localStorage 读模式；不存在/损坏时返回 local。 */
export function readCarrierMode(storage?: Storage): CarrierMode {
  let raw: string | null = null
  try {
    raw = (storage ?? globalThis.localStorage)?.getItem(MODE_KEY) ?? null
  } catch {
    raw = null
  }
  if (typeof raw !== 'string' || raw === '') return { mode: 'local' }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { mode: 'local' }
    const value = parsed as Record<string, unknown>
    if (value.mode !== 'cloud') return { mode: 'local' }
    if (typeof value.origin !== 'string' || value.origin === '') return { mode: 'local' }
    return {
      mode: 'cloud',
      origin: value.origin,
      ...(typeof value.targetId === 'string' && value.targetId !== '' ? { targetId: value.targetId } : {}),
      ...(typeof value.token === 'string' && value.token !== '' ? { token: value.token } : {}),
      ...(typeof value.deviceLabel === 'string' && value.deviceLabel !== '' ? { deviceLabel: value.deviceLabel } : {}),
    }
  } catch {
    return { mode: 'local' }
  }
}

/** 写模式（UI 的「接管/切回」唯一入口）。传 local 即清除 cloud 字段。 */
export function writeCarrierMode(mode: CarrierMode, storage?: Storage): void {
  const target = storage ?? globalThis.localStorage
  if (mode.mode === 'local') {
    try { target?.removeItem(MODE_KEY) } catch { /* 无痕模式等：忽略 */ }
    return
  }
  try {
    const hint = {
      mode: 'cloud',
      ...(typeof mode.origin === 'string' ? { origin: mode.origin } : {}),
      ...(typeof mode.targetId === 'string' ? { targetId: mode.targetId } : {}),
      ...(typeof mode.deviceLabel === 'string' ? { deviceLabel: mode.deviceLabel } : {}),
    }
    target?.setItem(MODE_KEY, JSON.stringify(hint))
  } catch { /* 忽略 */ }
}
