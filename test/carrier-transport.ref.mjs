/**
 * carrier-transport 的行为等价参考实现（测试专用）。
 *
 * 仅当 `.build/client` 发射产物无法解析 `@core/*` 别名时由
 * `test/carrier-transport.test.mjs` 加载。执行语义与
 * `client/src/carrier-transport.ts` 1:1；漂移由测试里的源码级静态断言拦截。
 *
 * @module test/carrier-transport.ref.mjs
 */

/** 判定一个错误码是否值得重开流（守卫重启/流被回收）。 */
export function isStreamRestartable(code) {
  return code === 'stream-not-found'
}

/** 从未知错误对象里读错误码。 */
export function errorCodeOf(error) {
  if (typeof error === 'object' && error !== null) {
    if (typeof error.code === 'string') return error.code
    if (typeof error.error?.code === 'string') return error.error.code
  }
  return undefined
}

const defaultDelay = ms => new Promise(resolve => { setTimeout(resolve, ms) })

/** 单次 stream.next 的形状校验。 */
function asNextValue(value) {
  if (typeof value !== 'object' || value === null || !Array.isArray(value.items)) return undefined
  return value
}

/**
 * 创建官方 `openStream` 实现（与 carrier-transport.ts 相同的决策表）。
 * @param options - `{ call, delay }`。
 */
export function createOpenStream(options) {
  const call = options.call
  const delay = options.delay ?? defaultDelay

  async function* cancelQuietly(streamId) {
    try { await call('hub/stream.cancel', { streamId }) } catch { /* best-effort */ }
  }

  const open = async function* (endpoint, payload, signal, _uplink) {
    const args = payload?.args ?? payload ?? {}
    let restarts = 0
    let activeStreamId

    try {
      while (!signal.aborted) {
        let streamId
        let cursor
        try {
          const opened = await call('hub/stream.open', { endpoint, args })
          if (opened === undefined || typeof opened.streamId !== 'string') {
            throw new Error(`carrier-transport: stream.open refused for ${endpoint}`)
          }
          streamId = opened.streamId
          cursor = typeof opened.cursor === 'number' ? opened.cursor : 0
          activeStreamId = streamId
        } catch (error) {
          if (!isStreamRestartable(errorCodeOf(error)) || restarts >= 3) throw error
          restarts += 1
          await delay(2000)
          continue
        }

        let broken = false
        while (!broken && !signal.aborted) {
          let batch
          try {
            const value = await call('hub/stream.next', { streamId, cursor, holdMs: 4000 })
            const parsed = asNextValue(value)
            if (parsed === undefined) throw new Error('carrier-transport: malformed stream.next result')
            batch = parsed
          } catch (error) {
            const code = errorCodeOf(error)
            if (code === 'stream-cancelled' || signal.aborted) return
            if (isStreamRestartable(code) && restarts < 3) {
              restarts += 1
              await delay(2000)
              broken = true
              break
            }
            throw error
          }
          cursor = batch.nextCursor
          for (const item of batch.items) {
            yield item
            if (signal.aborted) return
          }
          if (batch.terminal !== undefined || batch.done === true) return
          if (batch.items.length === 0) await delay(2000)
        }
      }
    } finally {
      if (activeStreamId !== undefined) {
        try { await call('hub/stream.cancel', { streamId: activeStreamId }) } catch { /* best-effort */ }
      }
    }
  }

  return { open }
}
