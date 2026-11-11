/**
 * 长轮询流引擎（D-3 / D-4）—— v1 **不起任何 WebSocket**。
 *
 * 为什么：官方 `@Remote({mode:'stream'})` 的下行在浏览器侧走 `/api/remote.mux`，
 * 而那条 socket 的 Peer 由 `admitConnection()` → `admit()` 从 `browserAuth` 得来
 * → **恒为 owner**。非 owner 设备拿不到。官方 LiveShare 对 viewer 也正是用
 * 「三条一元方法 + 轮询」（`viewer-channel.ts`）。
 *
 * 所以本插件把上游官方 stream 的帧缓存进一个 per-device、per-stream 的队列，
 * 由 `hub/stream.open` / `hub/stream.next` / `hub/stream.cancel` 三条**自己的**
 * Remote 方法消费。它们是普通一元方法（不是 Typert stream），因此同样过
 * 官方 `decide()`，不存在绕过 Gateway 的权限旁路（红线 R9）。
 *
 * 预算（全部单向递增，D-4）：
 * - `cursor` 是**单调整数**，不是字节偏移。服务端持有 `cursor`（已发放游标）。
 *   客户端必须带 `cursor === 服务端 cursor`；回退或超越 → `cursor-invalid`。
 * - 同一 cursor 重复拉取**不产生新帧**（第一次已把队列取空 → 第二次返回空批）。
 * - 单批 ≤ `streamBatchMax`；批量窗口 `streamBatchWindowMs` 只在已有一帧后才等。
 * - 持有上限 `streamHoldMs`；`hubReadTimeoutMs` 由 HTTP 层兜底。
 * - 空闲 `streamIdleTtlMs` 后回收（惰性清理，不用定时器，避免测试里泄漏）。
 *
 * 帧来源有两个：① 上游官方 stream（`openUpstream` 注入）；② 审批桥接投递的
 * `{ kind: 'approval', … }` 帧（`enqueue`，按 deviceId 广播）。两者共用同一个
 * 单增游标，所以客户端只看到一个流。
 *
 * @module dsh-remote-hub/host/streams
 */
import { randomUUID } from 'node:crypto'

import { ERROR_CODES, HUB_METHODS, LIMITS, STREAM_BUDGET, hubEndpoint } from '@core/index.js'
import { ENDPOINT_TABLE, openableStreams } from '@core/capabilities.js'
import type { RoleName } from '@core/index.js'

/** 一条待投递的帧。 */
export interface StreamFrame {
  /** 单调递增序号（服务内部用；客户端只看 `nextCursor`）。 */
  readonly seq: number
  /** 帧内容，原样 JSON 序列化给客户端。 */
  readonly payload: unknown
}

/** 终态错误码。 */
export type StreamTerminal =
  | typeof ERROR_CODES.deviceRevoked
  | typeof ERROR_CODES.streamCancelled
  | 'hub/stream-expired'
  | typeof ERROR_CODES.internal

/** `hub/stream.open` 的返回值。 */
export interface StreamOpenResult {
  streamId: string
  cursor: number
}

/** `hub/stream.next` 的返回值。 */
export interface StreamNextResult {
  items: unknown[]
  nextCursor: number
  done?: boolean
  terminal?: { code: StreamTerminal }
  truncated?: boolean
}

/** 打开上游官方 stream 的注入依赖（生产实现走 `ctx.typertGateway.stream`）。 */
export type OpenUpstream = (
  endpoint: string,
  args: Record<string, unknown>,
  peer: unknown,
  signal: AbortSignal,
) => Promise<AsyncIterable<unknown>>

export interface StreamEngineDeps {
  config: {
    streamHoldMs: number
    streamBatchMax: number
    streamBatchWindowMs: number
    streamReadTimeoutMs: number
    streamIdleTtlMs: number
    maxStreamsPerDevice: number
  }
  /** 注入上游 opener；缺省时流只有审批帧（便于纯函数测试）。 */
  openUpstream?: OpenUpstream
  /** 注入时钟。 */
  now?: () => number
  /** 每设备可打开的官方 stream endpoint 判定（默认用能力矩阵）。 */
  openable?: (role: RoleName) => readonly string[]
  /** 审计回调。 */
  onAudit?: (row: { deviceId: string; streamId?: string; action: string; at: string }) => void
}

interface StreamState {
  streamId: string
  deviceId: string
  role: RoleName
  endpoint: string
  /** 已发放给客户端的游标（下一帧从这里开始）。 */
  cursor: number
  queue: StreamFrame[]
  terminal: StreamTerminal | null
  lastPolledAt: number
  abort: AbortController
  pump: Promise<void> | null
}

export interface StreamEngine {
  /**
   * 打开一条流。
   * @returns `{ streamId, cursor }`，或 `null`（目标不被允许 / 超并发上限）。
   */
  open(options: {
    deviceId: string
    role: RoleName
    endpoint: string
    args: Record<string, unknown>
    peer: unknown
  }): Promise<StreamOpenResult | null>
  /**
   * 拉取下一批。
   * @returns 批次；未知 `streamId` → `null`（守卫翻译成 `stream-not-found`）。
   */
  next(options: {
    deviceId: string
    streamId: string
    cursor: number
    holdMs?: number
  }): Promise<StreamNextResult | null>
  /** 取消一条流。 */
  cancel(deviceId: string, streamId: string): Promise<{ ok: boolean }>
  /** 给一台设备投一帧（审批桥接用）。 */
  enqueue(deviceId: string, payload: unknown): void
  /** 把一台设备的所有流标记为 `device-revoked`（下一次轮询即可见，≤ holdMs）。 */
  markRevoked(deviceId: string): void
  /** 丢弃一台设备的全部流。 */
  dropDevice(deviceId: string): Promise<void>
  /** 清理所有流。 */
  dispose(): Promise<void>
  /** 诊断：`hub/stream.next` 调用计数（验收脚本断言线性增长）。 */
  readonly pollCount: number
  /** 诊断：业务方法被一元轮询的次数（必须恒为 0）。 */
  readonly businessPollCount: number
}

const smallest = (a: number, b: number): number => (a < b ? a : b)

/**
 * 创建流引擎。
 * @param deps - 配置与注入依赖。
 * @returns `StreamEngine`。
 */
export function createStreamEngine(deps: StreamEngineDeps): StreamEngine {
  const now = deps.now ?? (() => Date.now())
  const streams = new Map<string, StreamState>()
  const openable = deps.openable ?? ((role: RoleName) => openableStreams(role))
  let pollCount = 0
  let businessPollCount = 0
  let disposed = false

  /** 惰性回收过期流：任何 stream 方法调用时顺带做一次。 */
  const sweep = (): void => {
    const at = now()
    for (const [id, state] of streams) {
      if (at - state.lastPolledAt > deps.config.streamIdleTtlMs) {
        state.terminal = 'hub/stream-expired'
        state.abort.abort()
        void state.pump
        streams.delete(id)
      }
    }
  }

  const stateFor = (deviceId: string, streamId: string): StreamState | undefined => {
    const state = streams.get(streamId)
    return state?.deviceId === deviceId ? state : undefined
  }

  const startPump = async (state: StreamState, args: Record<string, unknown>, peer: unknown): Promise<void> => {
    if (deps.openUpstream === undefined) return
    let upstream: AsyncIterable<unknown>
    try {
      upstream = await deps.openUpstream(state.endpoint, args, peer, state.abort.signal)
    } catch {
      state.terminal = ERROR_CODES.internal
      return
    }
    try {
      for await (const frame of upstream) {
        if (state.abort.signal.aborted) break
        state.queue.push({ seq: state.cursor + state.queue.length, payload: frame })
        // 队列上限保护：超出若干批就丢最旧的帧（流是增量，丢帧优于 OOM）。
        const cap = deps.config.streamBatchMax * 16
        if (state.queue.length > cap) state.queue.splice(0, state.queue.length - cap)
      }
      if (!state.abort.signal.aborted && state.terminal === null) state.terminal = 'hub/stream-expired'
    } catch {
      if (!state.abort.signal.aborted) state.terminal = ERROR_CODES.internal
    }
  }

  return {
    get pollCount() { return pollCount },
    get businessPollCount() { return businessPollCount },
    async open(options) {
      sweep()
      if (disposed) return null
      const allowed = new Set(openable(options.role))
      const fact = ENDPOINT_TABLE[options.endpoint]
      // 三条判据任一不满足 → 统一错误，**不区分原因**（避免成为 endpoint 探测器）。
      if (fact?.stream !== true || !allowed.has(options.endpoint)) return null
      if (deps.openUpstream === undefined) return null

      const perDevice = [...streams.values()].filter(s => s.deviceId === options.deviceId).length
      if (perDevice >= deps.config.maxStreamsPerDevice) {
        // 达到上限时回收最旧的一条，而不是无限增长。
        const oldest = [...streams.values()]
          .filter(s => s.deviceId === options.deviceId)
          .sort((a, b) => a.lastPolledAt - b.lastPolledAt)[0]
        if (oldest !== undefined) {
          oldest.abort.abort()
          streams.delete(oldest.streamId)
        }
      }

      const state: StreamState = {
        streamId: randomUUID(),
        deviceId: options.deviceId,
        role: options.role,
        endpoint: options.endpoint,
        cursor: 0,
        queue: [],
        terminal: null,
        lastPolledAt: now(),
        abort: new AbortController(),
        pump: null,
      }
      streams.set(state.streamId, state)
      state.pump = startPump(state, options.args, options.peer)
      deps.onAudit?.({
        deviceId: options.deviceId,
        streamId: state.streamId,
        action: hubEndpoint(HUB_METHODS.streamOpen),
        at: new Date(now()).toISOString(),
      })
      return { streamId: state.streamId, cursor: state.cursor }
    },

    async next(options) {
      pollCount += 1
      sweep()
      const state = stateFor(options.deviceId, options.streamId)
      if (state === undefined) return null
      state.lastPolledAt = now()

      // 终态：收到即停止，不再持有。
      if (state.terminal !== null) {
        return {
          items: [],
          nextCursor: state.cursor,
          done: true,
          terminal: { code: state.terminal },
        }
      }

      // 游标单向递增：回退或超越已发放游标都拒。
      if (!Number.isSafeInteger(options.cursor) || options.cursor < 0
        || options.cursor < state.cursor || options.cursor > state.cursor) {
        return {
          items: [],
          nextCursor: state.cursor,
          terminal: { code: ERROR_CODES.cursorInvalid as StreamTerminal },
        }
      }

      const hold = smallest(
        typeof options.holdMs === 'number' && options.holdMs > 0 ? options.holdMs : deps.config.streamHoldMs,
        smallest(deps.config.streamHoldMs, deps.config.streamReadTimeoutMs),
      )
      const deadline = now() + hold
      // 持有等待：队列里出现第一帧就返回（随后再等一个很短的批量窗口凑批）。
      while (state.queue.length === 0 && now() < deadline && state.terminal === null) {
        await new Promise<void>(resolve => setTimeout(resolve, smallest(16, Math.max(1, deadline - now()))))
      }
      if (state.queue.length > 0 && deps.config.streamBatchWindowMs > 0) {
        await new Promise<void>(resolve => setTimeout(resolve, deps.config.streamBatchWindowMs))
      }

      const batch = state.queue.splice(0, deps.config.streamBatchMax)
      // 批量帧的 seq 重新按当前 cursor 连续编号，保证严格单调。
      const items = batch.map((frame, index) => {
        void frame.seq
        return { cursor: state.cursor + index, payload: frame.payload }
      })
      state.cursor += items.length

      // 响应体上限：超限截断该批并置 truncated。
      let truncated = false
      let visible = items
      const rough = JSON.stringify(visible).length
      if (rough > LIMITS.maxResponseBodyBytes) {
        const ratio = LIMITS.maxResponseBodyBytes / Math.max(rough, 1)
        visible = items.slice(0, Math.max(1, Math.floor(items.length * ratio)))
        // 被截掉的帧放回队列头部，下一轮补发（cursor 不跳）。
        state.queue.unshift(...batch.slice(visible.length))
        state.cursor -= items.length - visible.length
        truncated = true
      }

      deps.onAudit?.({
        deviceId: options.deviceId,
        streamId: state.streamId,
        action: hubEndpoint(HUB_METHODS.streamNext),
        at: new Date(now()).toISOString(),
      })
      return { items: visible, nextCursor: state.cursor, truncated }
    },

    async cancel(deviceId, streamId) {
      sweep()
      const state = stateFor(deviceId, streamId)
      if (state === undefined) return { ok: false }
      state.terminal = ERROR_CODES.streamCancelled
      state.abort.abort()
      await state.pump
      return { ok: true }
    },

    enqueue(deviceId, payload) {
      for (const state of streams.values()) {
        if (state.deviceId !== deviceId || state.terminal !== null) continue
        state.queue.push({ seq: state.cursor + state.queue.length, payload })
      }
    },

    markRevoked(deviceId) {
      for (const state of streams.values()) {
        if (state.deviceId !== deviceId) continue
        state.terminal = ERROR_CODES.deviceRevoked
        state.abort.abort()
      }
    },

    async dropDevice(deviceId) {
      const entries = [...streams.values()].filter(s => s.deviceId === deviceId)
      for (const state of entries) {
        state.abort.abort()
        streams.delete(state.streamId)
        await state.pump
      }
    },

    async dispose() {
      disposed = true
      const entries = [...streams.values()]
      streams.clear()
      for (const state of entries) {
        state.abort.abort()
        await state.pump
      }
    },
  }
}

/**
 * 生产环境的上游 opener：把 `ctx.typertGateway.stream({...})` 包成注入形状。
 *
 * `stream()` 接受已解码的命名参数（`args`）与 `peer`，返回 `AsyncIterable<unknown>`，
 * 正是本引擎需要的形状。这里不自己解码参数、不自己解析 endpoint —— 那是 Gateway
 * 的职责（D-1 的直接收益）。
 * @param ctx - Host Context（需 `typertGateway`）。
 * @returns `OpenUpstream`。
 */
export function gatewayStreamOpener(ctx: unknown): OpenUpstream {
  // 走 reflect.props 读（与 probeServices 同理由）：插件 fiber 的裸读会抛
  // `cannot get property … without inject`（cordis proxy get trap）。
  const gateway = (ctx as {
    reflect?: { props?: Record<string, unknown> }
  }).reflect?.props?.typertGateway as {
    stream(request: {
      namespace: string
      method: string
      args: Record<string, unknown>
      peer: unknown
      signal: AbortSignal
    }): Promise<AsyncIterable<unknown>>
  } | undefined
  if (gateway === undefined) {
    throw new Error('dsh-remote-hub: ctx.typertGateway is unavailable; cannot open upstream streams')
  }
  return async (endpoint, args, peer, signal) => {
    const slash = endpoint.indexOf('/')
    if (slash < 1) throw new Error(`invalid stream endpoint ${endpoint}`)
    return gateway.stream({
      namespace: endpoint.slice(0, slash),
      method: endpoint.slice(slash + 1),
      args,
      peer,
      signal,
    })
  }
}
