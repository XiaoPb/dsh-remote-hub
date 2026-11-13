/**
 * 守卫侧 Remote 流 mux 承载（路线 β）。
 *
 * ## 定位
 *
 * 浏览器页面的 `connection.openWebSocket('/api/remote.mux')` 打到守卫的
 * `/remote/ws`；守卫校验设备令牌、用 `connection.admitConnection` 认领 socket 后，
 * **由本模块扮演官方 `RemoteStreamMuxServer` 的角色**，把 mux 帧翻译成
 * `typertGateway.wireStream.open(...)` 调用。
 *
 * ## 协议（摘自官方 `RemoteStreamMuxConnection`，逐字对齐）
 *
 * 客户端 → 服务端：
 * | 帧 | 载荷 |
 * | --- | --- |
 * | `open` | `{ type, streamId, endpoint, payload }` |
 * | `item` | `{ type, streamId, value }`（uplink 输入） |
 * | `end` | `{ type, streamId }`（uplink 结束） |
 * | `cancel` | `{ type, streamId }` |
 *
 * 服务端 → 客户端：
 * | 帧 | 载荷 |
 * | --- | --- |
 * | `item` | `{ type, streamId, value }` |
 * | `end` | `{ type, streamId }` |
 * | `error` | `{ type, streamId, error }` |
 *
 * 全部是 **JSON 文本帧**；收到二进制帧 → `close(1003)`；畸形帧 → `close(1008)`；
 * 重复 `streamId` → 关闭 socket（唯一的协议违规）。
 *
 * ## 为什么用 `ws` 而不是自建帧层
 *
 * 官方 mux 服务端内部就是 `ws.WebSocketServer({ noServer: true })`（v8.22.2）。
 * 用同一个库能保证心跳、分片、背压、压缩行为与官方**完全一致**，
 * 避免复刻协议带来的漂移（见 docs/整机接管-M4决策点.md 路线 β）。
 *
 * @module dsh-remote-hub/host/guard-mux
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

import { WebSocket, WebSocketServer } from 'ws'

/** 默认心跳间隔（与官方一致）。 */
export const MUX_HEARTBEAT_MS = 2_000

/** 连续多少次未收到 pong 判定断链（与官方一致）。 */
export const MUX_MAX_MISSED_HEARTBEATS = 3

/** uplink 收件箱上限（与官方默认一致）。 */
export const MUX_UPLINK_BYTES = 1024 * 1024

/** 官方 mux 路由（守卫转发目标白名单校验用）。 */
export const MUX_PATH = '/api/remote.mux'

/** 一个逻辑流的开启器（对应 `typertGateway.wireStream.open`）。 */
export type MuxStreamOpener = (
  endpoint: string,
  payload: unknown,
  uplink: AsyncIterable<unknown>,
  peer: unknown,
  signal: AbortSignal,
) => Promise<AsyncIterable<unknown>>

/** 错误 → wire 形状（对应 `typertGateway.wireStream.failure`）。 */
export type MuxFailureMapper = (error: unknown) => unknown

export interface GuardMuxOptions {
  /** 开启逻辑流。 */
  open: MuxStreamOpener
  /** 错误映射。 */
  failure: MuxFailureMapper
  /** 心跳间隔。 */
  heartbeatIntervalMs?: number
  /** uplink 缓冲上限。 */
  uplinkBytes?: number
  /** 记录异常（**不得**包含令牌）。 */
  onError?: (message: string, error?: unknown) => void
}

/** mux 承载句柄。 */
export interface GuardMuxHandle {
  /**
   * 把一次已认领的升级请求接入 mux。
   * @param request - 原始 HTTP 请求。
   * @param socket - 已认领的裸 socket。
   * @param head - 升级残留字节。
   * @param peer - 由 admit 提供的 peer（身份凭据）。
   * @param deviceId - 已认证设备 id（连接索引；缺省时无法定向关闭）。
   */
  accept(request: IncomingMessage, socket: Duplex, head: Buffer, peer: unknown, deviceId?: string): void
  /**
   * 定向关闭某设备的全部物理连接与逻辑流。
   *
   * 让位/吊销/角色降级必须能走到这里：令牌在握手期校验过，**不会**自动让
   * 既有 socket 失效（设计 v0.3 §7）。
   * @param deviceId - 设备 id。
   * @returns 被关闭的连接数。
   */
  closeDevice(deviceId: string): number
  /** 关闭全部连接与心跳。 */
  close(): Promise<void>
  /** 当前物理连接数。 */
  readonly size: number
  /** 某设备当前的物理连接数（诊断与测试用）。 */
  connectionsOf(deviceId: string): number
}

/** WebSocket 关闭码：策略性关闭（policy violation）。 */
export const WS_CLOSE_POLICY = 1008

/**
 * 创建 mux 承载。
 * @param options - 依赖与调参。
 * @returns 句柄。
 */
export function createGuardMux(options: GuardMuxOptions): GuardMuxHandle {
  const heartbeatMs = options.heartbeatIntervalMs ?? MUX_HEARTBEAT_MS
  const uplinkBytes = options.uplinkBytes ?? MUX_UPLINK_BYTES
  const server = new WebSocketServer({ noServer: true })
  const missed = new WeakMap<WebSocket, number>()
  /**
   * 设备 → 物理连接索引。
   *
   * 用途：让位、吊销、角色降级时**定向**关闭既有 socket。没有这张表时只能
   * 全局 `close()`（会波及无关设备），或者什么都不做——令牌已失效，但已建立
   * 的连接仍能继续读写（设计 v0.3 §7 指出的缺口）。
   */
  const byDevice = new Map<string, Set<WebSocket>>()
  let timer: NodeJS.Timeout | undefined

  /** 记录一次「活着」的信号。 */
  const alive = (socket: WebSocket): void => { missed.set(socket, 0) }

  /** 首个连接后启动心跳（`unref()` 避免拖住进程退出）。 */
  const startHeartbeat = (): void => {
    if (timer !== undefined) return
    timer = setInterval(() => {
      for (const socket of server.clients) {
        if (socket.readyState !== socket.OPEN) continue
        const count = missed.get(socket) ?? 0
        if (count >= MUX_MAX_MISSED_HEARTBEATS) {
          setImmediate(() => {
            if ((missed.get(socket) ?? 0) >= MUX_MAX_MISSED_HEARTBEATS) socket.terminate()
          })
          continue
        }
        missed.set(socket, count + 1)
        socket.ping()
      }
    }, heartbeatMs)
    timer.unref()
  }

  /**
   * 服务一个已升级的物理连接。
   * @param socket - 已升级的 WebSocket。
   * @param peer - 设备身份。
   */
  async function serve(socket: WebSocket, peer: unknown): Promise<void> {    const streams = new Map<string, ActiveStream>()
    alive(socket)

    const closed = new Promise<void>(resolve => {
      socket.once('close', () => { resolve() })
      socket.once('error', () => { socket.terminate() })
      socket.on('pong', () => { alive(socket) })
    })

    socket.on('message', (data: unknown, isBinary: boolean) => {
      alive(socket)
      if (isBinary) {
        socket.close(1003, 'text messages required')
        return
      }
      let message: ClientFrame
      try {
        message = parseClientFrame(String(data))
      } catch {
        socket.close(1008, 'invalid Remote stream request')
        return
      }
      try {
        dispatch(message)
      } catch (error) {
        options.onError?.('mux dispatch failed', error)
        socket.close(1011, 'Remote stream dispatch failed')
      }
    })

    /** 分发一帧。 */
    const dispatch = (message: ClientFrame): void => {
      switch (message.type) {
        case 'open': {
          if (streams.has(message.streamId)) {
            throw new Error(`duplicate Remote stream id ${JSON.stringify(message.streamId)}`)
          }
          const abort = new AbortController()
          const inbox = new UplinkInbox(uplinkBytes, abort)
          const active: ActiveStream = { abort, inbox, stop: reason => { abort.abort(reason); inbox.fail(reason) } }
          streams.set(message.streamId, active)
          void pump(message.streamId, message.endpoint, message.payload, active).finally(() => {
            streams.delete(message.streamId)
          })
          return
        }
        case 'item':
          streams.get(message.streamId)?.inbox.push(message.value)
          return
        case 'end':
          streams.get(message.streamId)?.inbox.end()
          return
        case 'cancel':
          streams.get(message.streamId)?.stop(new Error('Remote stream cancelled'))
          return
        default:
          return
      }
    }

    /**
     * 拉取一条逻辑流并下行帧。
     * @param streamId - 流 id。
     * @param endpoint - 端点。
     * @param payload - 参数。
     * @param active - 活跃流状态。
     */
    const pump = async (
      streamId: string,
      endpoint: string,
      payload: unknown,
      active: ActiveStream,
    ): Promise<void> => {
      let failed = false
      let failure: unknown
      try {
        const source = await options.open(endpoint, payload, active.inbox.iterable(), peer, active.abort.signal)
        for await (const value of source) {
          if (socket.readyState !== socket.OPEN) break
          socket.send(JSON.stringify({ type: 'item', streamId, value }))
        }
      } catch (error) {
        failed = true
        failure = error
      }
      active.inbox.fail(new Error('Remote stream ended'))
      if (socket.readyState !== socket.OPEN) return
      try {
        if (failed) {
          socket.send(JSON.stringify({ type: 'error', streamId, error: options.failure(failure) }))
        } else if (!active.abort.signal.aborted) {
          socket.send(JSON.stringify({ type: 'end', streamId }))
        }
      } catch (error) {
        options.onError?.('mux terminal frame failed', error)
        socket.close(1011, 'Remote stream failure could not be delivered')
      }
    }

    await closed
    // 物理连接关闭：停掉所有未完成的逻辑流。
    const remaining = [...streams.values()]
    for (const stream of remaining) stream.stop(new Error('Remote stream socket closed'))
  }

  return {
    accept(request, socket, head, peer, deviceId) {
      startHeartbeat()
      server.handleUpgrade(request, socket, head, websocket => {
        // 先登记再服务：登记必须在 handleUpgrade 回调内完成，否则 closeDevice
        // 可能落在「socket 已建立但尚未索引」的窗口里。
        if (deviceId !== undefined && deviceId !== '') {
          const set = byDevice.get(deviceId) ?? new Set<WebSocket>()
          set.add(websocket)
          byDevice.set(deviceId, set)
          websocket.once('close', () => {
            const current = byDevice.get(deviceId)
            if (current === undefined) return
            current.delete(websocket)
            if (current.size === 0) byDevice.delete(deviceId)
          })
        }
        void serve(websocket, peer)
      })
    },
    closeDevice(deviceId) {
      const sockets = byDevice.get(deviceId)
      if (sockets === undefined || sockets.size === 0) return 0
      // 先复制再关闭：`close` 会触发上面登记的监听器改集合。
      const targets = [...sockets]
      byDevice.delete(deviceId)
      for (const socket of targets) {
        // close(1008) 让浏览器收到明确的策略性终止原因，而不是异常断开。
        try { socket.close(WS_CLOSE_POLICY, 'device disconnected by policy') } catch { /* 已关闭 */ }
        // close 帧可能永远得不到对端响应（半开连接），兜底 terminate。
        setImmediate(() => {
          try { if (socket.readyState !== WebSocket.CLOSED) socket.terminate() } catch { /* 已关闭 */ }
        })
      }
      return targets.length
    },
    connectionsOf(deviceId) {
      return byDevice.get(deviceId)?.size ?? 0
    },
    get size() {
      return server.clients.size
    },
    async close() {
      if (timer !== undefined) { clearInterval(timer); timer = undefined }
      byDevice.clear()
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    },
  }
}

/** 活跃逻辑流。 */
interface ActiveStream {
  readonly abort: AbortController
  readonly inbox: UplinkInbox
  readonly stop: (reason: unknown) => void
}

/** 客户端帧（与官方 `RemoteStreamClientMessage` 对齐）。 */
type ClientFrame =
  | { readonly type: 'open'; readonly streamId: string; readonly endpoint: string; readonly payload: unknown }
  | { readonly type: 'item'; readonly streamId: string; readonly value: unknown }
  | { readonly type: 'end'; readonly streamId: string }
  | { readonly type: 'cancel'; readonly streamId: string }

/**
 * 解析并校验一帧客户端消息。
 * @param text - 原始文本。
 * @returns 校验通过的帧。
 * @throws 形状非法时。
 */
export function parseClientFrame(text: string): ClientFrame {
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null) throw new Error('frame must be an object')
  const frame = value as Record<string, unknown>
  const type = frame.type
  if (typeof frame.streamId !== 'string' || frame.streamId === '') throw new Error('streamId required')
  const streamId = frame.streamId
  switch (type) {
    case 'open': {
      if (typeof frame.endpoint !== 'string' || frame.endpoint === '') throw new Error('endpoint required')
      return { type: 'open', streamId, endpoint: frame.endpoint, payload: frame.payload }
    }
    case 'item':
      return { type: 'item', streamId, value: frame.value }
    case 'end':
      return { type: 'end', streamId }
    case 'cancel':
      return { type: 'cancel', streamId }
    default:
      throw new Error(`unknown frame type ${JSON.stringify(type)}`)
  }
}

/** uplink 收件箱：把浏览器发来的 `item` 变成 Host 可消费的 AsyncIterable。 */
export class UplinkInbox {
  private readonly values: unknown[] = []
  private readonly waiters: { resolve: (value: IteratorResult<unknown>) => void; reject: (error: unknown) => void }[] = []
  private ended = false
  private failure: unknown
  private bytes = 0

  constructor(private readonly maxBytes: number, private readonly abort: AbortController) {}

  /** 入队一个值；超限即中止流（与官方一致）。 */
  push(value: unknown, byteLength?: number): void {
    if (this.ended || this.failure !== undefined) return
    this.bytes += byteLength ?? 0
    if (this.bytes > this.maxBytes) {
      const error = new Error('uplink inbox overflow')
      this.abort.abort(error)
      this.fail(error)
      return
    }
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter.resolve({ done: false, value })
    else this.values.push(value)
  }

  /** 正常结束。 */
  end(): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined })
  }

  /** 失败结束。 */
  fail(error: unknown): void {
    if (this.failure !== undefined) return
    this.failure = error
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  /**
   * 取得可迭代视图。
   * @returns AsyncIterable。
   */
  iterable(): AsyncIterable<unknown> {
    const self = this
    return {
      [Symbol.asyncIterator](): AsyncIterator<unknown> {
        return {
          next(): Promise<IteratorResult<unknown>> {
            if (self.values.length > 0) {
              return Promise.resolve({ done: false, value: self.values.shift() })
            }
            if (self.failure !== undefined) return Promise.reject(self.failure)
            if (self.ended) return Promise.resolve({ done: true, value: undefined })
            return new Promise((resolve, reject) => { self.waiters.push({ resolve, reject }) })
          },
        }
      },
    }
  }
}
