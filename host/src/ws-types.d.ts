/**
 * `ws` 的最小类型声明（仅覆盖本插件用到的 API）。
 *
 * 为什么不装 `@types/ws`：本插件只需要 `WebSocketServer({ noServer })` +
 * `handleUpgrade` + 少量 socket 方法，装完整类型包会引入新的 dev 依赖树。
 * 这里的声明**精确对应** `ws@8` 的实际运行时 API。
 *
 * @see https://github.com/websockets/ws/blob/master/doc/ws.md
 */
declare module 'ws' {
  import type { IncomingMessage } from 'node:http'
  import type { Duplex } from 'node:stream'
  import type { EventEmitter } from 'node:events'

  /** `ws@8` 的 WebSocket 实例（只列本插件用到的成员）。 */
  export class WebSocket extends EventEmitter {
    static readonly CONNECTING: 0
    static readonly OPEN: 1
    static readonly CLOSING: 2
    static readonly CLOSED: 3
    /** 只读就绪状态（0..3）。 */
    readonly readyState: number
    /** 就绪常量（实例上的别名，与官方一致）。 */
    readonly OPEN: 1
    /** 发送一帧。 */
    send(data: string | Buffer): void
    /** 主动关闭。 */
    close(code?: number, reason?: string): void
    /** 立即断开（不发 close 帧）。 */
    terminate(): void
    /** 发送 ping。 */
    ping(): void
    on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): this
    on(event: 'pong', listener: () => void): this
    on(event: 'close', listener: (code: number, reason: Buffer) => void): this
    on(event: 'error', listener: (error: Error) => void): this
    once(event: 'message', listener: (data: unknown, isBinary: boolean) => void): this
    once(event: 'pong', listener: () => void): this
    once(event: 'close', listener: (code: number, reason: Buffer) => void): this
    once(event: 'error', listener: (error: Error) => void): this
  }

  export interface WebSocketServerOptions {
    /** 不使用内部 HTTP server（由调用方 handleUpgrade）。 */
    noServer?: boolean
    perMessageDeflate?: boolean
  }

  /** `ws@8` 的服务端。 */
  export class WebSocketServer {
    constructor(options?: WebSocketServerOptions)
    /** 当前全部客户端连接。 */
    readonly clients: Set<WebSocket>
    /**
     * 接管一次已由 http server 收到的 upgrade。
     * @param request - 原始请求。
     * @param socket - 裸 socket。
     * @param head - 残留字节。
     * @param callback - 升级完成回调。
     */
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (websocket: WebSocket) => void,
    ): void
    /** 关闭服务端并等待回调。 */
    close(callback?: (error?: Error) => void): void
  }
}
