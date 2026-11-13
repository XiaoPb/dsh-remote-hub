/**
 * 本地插件管理的事件通道（Host 半边）。
 *
 * ## 为什么需要独立通道
 *
 * 官方页用 `ctx.remote.$on('plugin-manager/…')` 订阅事件 —— 那是**官方转发面**，接管后它订阅的是云端 Host。
 * 本地页需要的是**本机**事件，所以这里订阅本机 Cordis 的 4 个事件，并经一条**专属 WebSocket**
 * （`/api/hub/local-plugin-manager/events`）推给本机页面。
 *
 * ## 为什么不用官方转发
 *
 * `ctx.typertGateway.registerRemoteEvents(...)` **全进程唯一**（已被 `@deepseek-ai/dsh-api-remotes` 占用），
 * 且再注册一次就会把本机安装日志推给云端设备。本通道因此完全不碰它 —— 这同时是一条安全收益。
 *
 * ## 形状
 *
 * 有界环形缓冲（帧数 + 字节双上限）+ 单调递增 `seq`：
 * - 客户端建链时带 `?since=<seq>`，仍在缓冲里的直接补发，否则回 `reset`（要求全量刷新）；
 * - 慢消费者被丢弃时先 `dropped` 再 `reset`，绝不静默丢帧。
 *
 * @module dsh-remote-hub/host/local-plugin-manager/events
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'

import {
  LOCAL_PLUGIN_EVENT_BUFFER_BYTES,
  LOCAL_PLUGIN_EVENT_BUFFER_FRAMES,
  type LocalPluginEventFrame,
} from '@core/index.js'

/** 一条待发送的帧。 */
interface BufferedFrame {
  readonly frame: LocalPluginEventFrame
  readonly bytes: number
}

/** 事件总线的选项（测试可注入上限）。 */
export interface LocalPluginEventBusOptions {
  /** 最多保留多少帧。 */
  readonly maxFrames?: number
  /** 最多保留多少字节。 */
  readonly maxBytes?: number
}

/**
 * 官方 4 个事件 → 本通道帧类型的映射。
 *
 * 事件名与官方 `plugin-manager` 服务在 `ownerContext` 上 `emit` 的完全一致（见
 * `deepseek-harness/packages/boot/plugin-manager/src/index.ts`）。
 */
export const EVENT_KINDS = [
  ['plugin-manager/changed', 'changed'],
  ['plugin-manager/install-log', 'install-log'],
  ['plugin-manager/install-state', 'install-state'],
  ['plugin-manager/update-state', 'update-state'],
] as const

/** 本通道订阅的 4 个官方事件名。 */
export type LocalPluginEventName = (typeof EVENT_KINDS)[number][0]

/**
 * 把 Cordis 事件参数包成帧。
 * @param kind - 帧类型。
 * @param seq - 当前水位。
 * @param payload - 官方事件的首个参数。
 */
function frameFor(kind: (typeof EVENT_KINDS)[number][1], seq: number, payload: unknown): LocalPluginEventFrame {
  switch (kind) {
    case 'changed':
      return { type: 'changed', seq, change: (payload ?? {}) as { reason: string } }
    case 'install-log':
      return { type: 'install-log', seq, chunk: payload }
    case 'install-state':
      return { type: 'install-state', seq, progress: payload }
    case 'update-state':
      return { type: 'update-state', seq, progress: payload }
  }
}

/** 帧的序列化字节数（用于缓冲预算）。 */
function sizeOf(frame: LocalPluginEventFrame): number {
  try {
    return Buffer.byteLength(JSON.stringify(frame), 'utf8')
  } catch {
    return 0
  }
}

/**
 * 本机插件管理事件总线。
 *
 * 订阅 Cordis 事件 → 入环形缓冲 → 广播给所有已授权的本机 socket。
 */
export class LocalPluginEventBus {
  private readonly buffer: BufferedFrame[] = []
  private bufferBytes = 0
  private seq = 0
  private disposed = false
  private readonly disposers: (() => void)[] = []
  private readonly sockets = new Set<WebSocket>()
  private readonly server: WebSocketServer
  private readonly maxFrames: number
  private readonly maxBytes: number

  /**
   * @param ctx - Host Context（订阅 4 个 Cordis 事件）。
   * @param options - 缓冲上限（测试注入）。
   */
  constructor(private readonly ctx: Context, options: LocalPluginEventBusOptions = {}) {
    this.maxFrames = options.maxFrames ?? LOCAL_PLUGIN_EVENT_BUFFER_FRAMES
    this.maxBytes = options.maxBytes ?? LOCAL_PLUGIN_EVENT_BUFFER_BYTES
    this.server = new WebSocketServer({ noServer: true })
    for (const [name, kind] of EVENT_KINDS) {
      const off = ctx.on(name as never, ((payload: unknown) => {
        this.push(frameFor(kind, this.seq + 1, payload))
      }) as never)
      this.disposers.push(off)
    }
  }

  /** 当前水位（最近一次分配的 seq）。 */
  get watermark(): number {
    return this.seq
  }

  /** 当前缓冲帧数（诊断用）。 */
  get buffered(): number {
    return this.buffer.length
  }

  /**
   * 入队一帧并广播。
   * @param frame - 帧（`seq` 由 {@link LocalPluginEventBus} 分配，调用方传入的会被忽略）。
   */
  private push(frame: LocalPluginEventFrame): void {
    if (this.disposed) return
    this.seq += 1
    const stamped = { ...frame, seq: this.seq } as LocalPluginEventFrame
    const bytes = sizeOf(stamped)
    this.buffer.push({ frame: stamped, bytes })
    this.bufferBytes += bytes
    this.trim()
    const text = JSON.stringify(stamped)
    for (const socket of this.sockets) {
      if (socket.readyState !== socket.OPEN) continue
      try {
        socket.send(text)
      } catch {
        this.sockets.delete(socket)
      }
    }
  }

  /**
   * 丢弃最旧的帧直到回到预算内；丢弃过就补一条 `dropped` + `reset`，
   * 让客户端知道「有断档，请全量刷新」而不是静默少几条。
   */
  private trim(): void {
    const overflow = this.buffer.length - this.maxFrames
    if (overflow > 0) {
      const removed = this.buffer.splice(0, overflow).length
      this.bufferBytes = this.buffer.reduce((sum, entry) => sum + entry.bytes, 0)
      this.announceDrop(removed)
      return
    }
    while (this.bufferBytes > this.maxBytes && this.buffer.length > 1) {
      const entry = this.buffer.shift()
      if (entry === undefined) break
      this.bufferBytes -= entry.bytes
      this.announceDrop(1)
    }
  }

  /** 追加 `dropped` + `reset`（只进缓冲，不递归 trim）。 */
  private announceDrop(count: number): void {
    if (count <= 0) return
    this.seq += 1
    const dropped: LocalPluginEventFrame = { type: 'dropped', seq: this.seq, count }
    this.buffer.push({ frame: dropped, bytes: sizeOf(dropped) })
    this.seq += 1
    const reset: LocalPluginEventFrame = { type: 'reset', seq: this.seq }
    this.buffer.push({ frame: reset, bytes: sizeOf(reset) })
    for (const socket of this.sockets) {
      if (socket.readyState !== socket.OPEN) continue
      try {
        socket.send(JSON.stringify(dropped))
        socket.send(JSON.stringify(reset))
      } catch {
        this.sockets.delete(socket)
      }
    }
  }

  /**
   * 从缓冲里取出 `since` 之后的帧。
   * @param since - 客户端水位（省略表示只要 `hello`）。
   * @returns `{ frames, reset }`；断档时 `reset` 为 true 且 `frames` 为空。
   */
  replay(since: number | undefined): { frames: LocalPluginEventFrame[]; reset: boolean } {
    if (since === undefined) return { frames: [], reset: false }
    const first = this.buffer[0]
    // 客户端水位早于缓冲起点 ⇒ 已经断档。
    if (first !== undefined && first.frame.seq > since + 1) return { frames: [], reset: true }
    return { frames: this.buffer.filter(entry => entry.frame.seq > since).map(entry => entry.frame), reset: false }
  }

  /**
   * 接受一次已通过认证与 owner 校验的升级。
   * @param req - 升级请求（读取 `since` 查询参数）。
   * @param socket - 底层 socket。
   * @param head - 已读字节。
   */
  accept(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.server.handleUpgrade(req, socket, head, (websocket) => {
      this.sockets.add(websocket)
      websocket.on('close', () => { this.sockets.delete(websocket) })
      websocket.on('error', () => { this.sockets.delete(websocket) })
      websocket.on('message', (data: unknown) => {
        // 客户端目前只发 `ping`（保活）；未知帧忽略。
        void data
      })
      this.send(websocket, { type: 'hello', seq: this.seq })
      const since = Number(new URL(req.url ?? '/', 'http://local').searchParams.get('since') ?? '')
      if (Number.isFinite(since) && since > 0) {
        const { frames, reset } = this.replay(since)
        if (reset) this.send(websocket, { type: 'reset', seq: this.seq })
        else for (const frame of frames) this.send(websocket, frame)
      }
    })
  }

  /** 安全发送一帧。 */
  private send(websocket: WebSocket, frame: LocalPluginEventFrame): void {
    if (websocket.readyState !== websocket.OPEN) return
    try {
      websocket.send(JSON.stringify(frame))
    } catch {
      this.sockets.delete(websocket)
    }
  }

  /** 关闭全部 socket、停止订阅、清空缓冲。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const off of this.disposers.splice(0)) {
      try {
        off()
      } catch {
        // 卸载期异常不得影响宿主收尾。
      }
    }
    for (const socket of this.sockets) {
      try {
        socket.close(1001, 'channel closed')
      } catch {
        // 已断开。
      }
    }
    this.sockets.clear()
    this.buffer.length = 0
    this.bufferBytes = 0
    void this.server.close()
  }
}
