/**
 * 传输替身：官方 `openStream` 契约 → `hub/stream.*` 长轮询（路线 A Task 4）。
 *
 * 官方契约（docs/verification/05 §1）：`open('/api', endpoint, payload, signal,
 * uplink)` 返回 `AsyncIterable<unknown>`，**每个值是一帧事件**（不是批）；
 * `channel` 只可能是 `/api`（createWebConnectionRpc:1233 的唯一合法值）。
 *
 * 映射：
 *  - `open`   → `hub/stream.open({endpoint, args})` → `{streamId, cursor}`；
 *  - 迭代     → 反复 `hub/stream.next({streamId, cursor, holdMs})`，把 `items`
 *               **展平逐个 yield**；`terminal` / `done` → 生成器 return；
 *  - 取消     → `signal.aborted` 或 `iterator.return()` → `hub/stream.cancel`；
 *  - 重启     → `stream-not-found`（守卫重启/流回收）时重开流（官方 endpoint
 *               自带追赶语义）；其它终态错误上抛；
 *  - 空批     → 等 `pollSlackMs` 再拉（不洪泛，同 transport.ts 的节奏）。
 *
 * 预算复用 `STREAM_BUDGET`（holdMs=4000 / pollSlackMs=2000 / readTimeoutMs=25000）。
 *
 * @module dsh-remote-hub/client/carrier-transport
 */
import { ERROR_CODES, HUB_METHODS, STREAM_BUDGET, hubEndpoint } from '@core/protocol.js'
import type { StreamNextValue } from './transport.js'

/** 一元调用器（transport.ts 的 `call()`，同一守卫入口、同一信封）。 */
export type UnaryCall = (method: string, args: Record<string, unknown>) => Promise<unknown>

export interface CarrierTransportOptions {
  /** 一元调用器：直接用 `transport.ts` 的 `call()`。 */
  call: UnaryCall
  /** 注入时钟（测试用）。 */
  now?: () => number
  /** 注入 sleep（测试用；默认全局 setTimeout）。 */
  delay?: (ms: number) => Promise<void>
}

/** 判定一个错误码是否值得重开流（守卫重启/流被回收）。 */
export function isStreamRestartable(code: string | undefined): boolean {
  return code === ERROR_CODES.streamNotFound
}

/** 从未知错误对象里读错误码（RemoteHubError 与裸信封两种形状）。 */
export function errorCodeOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null) {
    const record = error as { code?: unknown; error?: { code?: unknown } }
    if (typeof record.code === 'string') return record.code
    if (typeof record.error?.code === 'string') return record.error.code
  }
  return undefined
}

const defaultDelay = (ms: number): Promise<void> =>
  new Promise(resolve => { setTimeout(resolve, ms) })

/** 单次 stream.next 的形状校验（transport.ts 同判据）。 */
function asNextValue(value: unknown): StreamNextValue | undefined {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { items?: unknown }).items)) {
    return undefined
  }
  return value as StreamNextValue
}

/**
 * 创建官方 `openStream` 实现。
 * @param options - 一元调用器与注入依赖。
 * @returns `open(endpoint, payload, signal, uplink)` 形状的函数。
 */
export function createOpenStream(options: CarrierTransportOptions): {
  open: (endpoint: string, payload: unknown, signal: AbortSignal, uplink?: AsyncIterable<unknown>) => AsyncIterable<unknown>
} {
  const call = options.call
  const delay = options.delay ?? defaultDelay

  const open = async function* (
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
    _uplink?: AsyncIterable<unknown>,
  ): AsyncGenerator<unknown, void, undefined> {
    const args = (payload as { args?: Record<string, unknown> } | undefined)?.args
      ?? (payload as Record<string, unknown> | undefined)
      ?? {}
    let restarts = 0
    let activeStreamId: string | undefined

    try {
      while (!signal.aborted) {
      // ── open（首次或重启时）─────────────────────────────────────────────
      let streamId: string
      let cursor: number
      try {
        const opened = await call(hubEndpoint(HUB_METHODS.streamOpen), { endpoint, args }) as
          | { streamId?: unknown; cursor?: unknown }
          | undefined
        if (opened === undefined || typeof opened.streamId !== 'string') {
          throw new Error(`carrier-transport: stream.open refused for ${endpoint}`)
        }
        streamId = opened.streamId
        cursor = typeof opened.cursor === 'number' ? opened.cursor : 0
        activeStreamId = streamId
      } catch (error) {
        if (!isStreamRestartable(errorCodeOf(error)) || restarts >= 3) throw error
        restarts += 1
        await delay(STREAM_BUDGET.pollSlackMs)
        continue
      }

      // ── next 循环 ──────────────────────────────────────────────────────
      let broken = false
      while (!broken && !signal.aborted) {
        let batch: StreamNextValue
        try {
          const value = await call(hubEndpoint(HUB_METHODS.streamNext), {
            streamId,
            cursor,
            holdMs: STREAM_BUDGET.holdMs,
          })
          const parsed = asNextValue(value)
          if (parsed === undefined) throw new Error('carrier-transport: malformed stream.next result')
          batch = parsed
        } catch (error) {
          const code = errorCodeOf(error)
          if (code === ERROR_CODES.streamCancelled || signal.aborted) {
            return // 调用方取消：正常结束。
          }
          if (isStreamRestartable(code) && restarts < 3) {
            restarts += 1
            await delay(STREAM_BUDGET.pollSlackMs)
            broken = true // 回到外层重开流。
            break
          }
          throw error
        }
        cursor = batch.nextCursor
        for (const item of batch.items) {
          yield item // 官方逐值消费：展平，不透批。
          if (signal.aborted) return // 消费方在项间中止：立即退出。
        }
        if (batch.terminal !== undefined || batch.done === true) {
          return // 上游终止（官方 endpoint 自己的语义）。
        }
        if (batch.items.length === 0) {
          await delay(STREAM_BUDGET.pollSlackMs) // 空批不洪泛。
        }
      }
    }
    } finally {
      // 生成器被消费方 return/throw 或 signal 中止时回收远端流（best-effort）。
      if (activeStreamId !== undefined) await cancelStreamQuietly(call, activeStreamId)
    }
  }

  return { open }
}

/**
 * 生成器 return 时取消远端流的辅助：官方消费 `for await` 断开时生成器的
 * `finally` 会执行，所以取消逻辑放在用户侧 `finally` 里即可。此函数供
 * 组装处直接复用。
 * @param call - 一元调用器。
 * @param streamId - 远端流 id。
 */
export async function cancelStreamQuietly(call: UnaryCall, streamId: string): Promise<void> {
  try {
    await call(hubEndpoint(HUB_METHODS.streamCancel), { streamId })
  } catch {
    // best-effort；服务端 120s idle TTL 兜底回收。
  }
}
