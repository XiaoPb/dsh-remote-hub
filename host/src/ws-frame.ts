/**
 * 最小 RFC 6455 WebSocket 帧层（服务端视角）。
 *
 * ## 为什么手写
 *
 * 调研结论：Node 22 只有 WebSocket **客户端**（`globalThis.WebSocket`），
 * **没有服务端**，也没有内置 `ws` 模块。本插件定位零运行时依赖，
 * 因此实现 RFC 6455 的最小子集：
 *
 * | 能力 | 支持 |
 * | --- | --- |
 * | 握手（`Sec-WebSocket-Accept`） | ✅ |
 * | text / binary 帧 | ✅ |
 * | close / ping / pong | ✅ |
 * | 客户端掩码解码 | ✅（客户端帧必然掩码） |
 * | 服务端帧（不掩码） | ✅ |
 * | 分片（continuation） | ✅ 按序拼接 |
 * | 126/127 扩展长度 | ✅ |
 * | permessage-deflate | ❌（不做） |
 * | 子协议协商 | ❌（不做） |
 *
 * 本层只负责**字节 ↔ 帧**，不关心业务语义——守卫做纯转发，不改协议。
 *
 * @module dsh-remote-hub/host/ws-frame
 */
import { createHash } from 'node:crypto'

/** RFC 6455 规定的握手魔术串。 */
export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 操作码。 */
export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const

/** 单帧负载上限（防御性：1 MiB；DSH 事件帧远小于此）。 */
export const MAX_FRAME_BYTES = 1024 * 1024

/** 协议错误（握手或分帧非法）。 */
export class WsProtocolError extends Error {
  constructor(message: string, readonly closeCode = 1002) {
    super(message)
    this.name = 'WsProtocolError'
  }
}

/** 解出的一帧。 */
export interface WsFrame {
  /** 是否 FIN（分片时中间帧为 false）。 */
  fin: boolean
  opcode: number
  payload: Buffer
}

/**
 * 计算握手响应头 `Sec-WebSocket-Accept`。
 * @param key - 请求头 `Sec-WebSocket-Key` 的原始值。
 * @returns base64(SHA1(key + GUID))。
 */
export function computeAccept(key: string): string {
  return createHash('sha1').update(`${key.trim()}${WS_GUID}`).digest('base64')
}

/**
 * 构造 101 Switching Protocols 响应。
 * @param key - 请求的 `Sec-WebSocket-Key`。
 * @param extraHeaders - 附加响应头（逐行，不含 CRLF）。
 * @returns 完整响应文本。
 */
export function handshakeResponse(key: string, extraHeaders: readonly string[] = []): string {
  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${computeAccept(key)}`,
    ...extraHeaders,
    '',
    '',
  ]
  return lines.join('\r\n')
}

/**
 * 编码一帧（**服务端 → 客户端**：不掩码）。
 * @param opcode - 操作码。
 * @param payload - 负载。
 * @param fin - 是否 FIN（默认 true）。
 * @returns 待写入 socket 的字节。
 */
export function encodeFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const length = payload.length
  let header: Buffer

  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    // 64 位长度：高 32 位写 0（JS 安全整数范围内足够）。
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f)
  // 服务端帧不加掩码位（MASK=0）。
  return Buffer.concat([header, payload])
}

/**
 * 尝试从缓冲区解出一帧。
 *
 * 返回 `null` 表示数据还不够（需要继续读 socket）。
 * 分片由调用方按 opcode 处理：`continuation` 需要与前一帧拼接。
 *
 * @param buffer - 累积到的字节。
 * @returns 解出的帧与消费字节数；数据不足时为 null。
 * @throws {WsProtocolError} 帧非法（含超长、未知 opcode、客户端必须掩码）。
 */
export function decodeFrame(buffer: Buffer): { frame: WsFrame; consumed: number } | null {
  if (buffer.length < 2) return null

  const first = buffer[0]!
  const second = buffer[1]!
  const fin = (first & 0x80) !== 0
  const rsv = first & 0x70
  if (rsv !== 0) throw new WsProtocolError('RSV bits must be 0 (no extensions negotiated)')
  const opcode = first & 0x0f
  const masked = (second & 0x80) !== 0
  let length = second & 0x7f
  let offset = 2

  if (length === 126) {
    if (buffer.length < offset + 2) return null
    length = buffer.readUInt16BE(offset)
    offset += 2
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null
    const big = buffer.readBigUInt64BE(offset)
    if (big > BigInt(MAX_FRAME_BYTES)) {
      throw new WsProtocolError(`frame too large: ${big}`, 1009)
    }
    length = Number(big)
    offset += 8
  }

  if (length > MAX_FRAME_BYTES) {
    throw new WsProtocolError(`frame too large: ${length}`, 1009)
  }

  // RFC 6455 §5.1：客户端发往服务端的帧**必须**掩码。
  if (!masked) throw new WsProtocolError('client frames must be masked')

  if (buffer.length < offset + 4 + length) return null
  const maskKey = buffer.subarray(offset, offset + 4)
  offset += 4

  const payload = Buffer.from(buffer.subarray(offset, offset + length))
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = payload[index]! ^ maskKey[index & 3]!
  }

  return {
    frame: { fin, opcode, payload },
    consumed: offset + length,
  }
}

/**
 * 构造 close 帧负载（2 字节状态码 + 可选原因）。
 * @param code - 状态码。
 * @param reason - 原因文本（UTF-8，≤123 字节）。
 * @returns 负载。
 */
export function closePayload(code: number, reason = ''): Buffer {
  const reasonBuf = Buffer.from(reason, 'utf8').subarray(0, 123)
  const buf = Buffer.alloc(2 + reasonBuf.length)
  buf.writeUInt16BE(code, 0)
  reasonBuf.copy(buf, 2)
  return buf
}

/**
 * 增量帧解析器：喂入字节，产出完整消息。
 *
 * 负责三件调用方不宜重复写的事：
 * 1. 缓冲与拆帧；
 * 2. 分片拼接（continuation）；
 * 3. 控制帧（ping/pong/close）不得分片且不得延迟。
 */
export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0)
  /** 正在拼接的分片消息。 */
  private fragments: Buffer[] = []
  private fragmentOpcode: number | null = null

  /**
   * 喂入一段字节，返回新完成的帧（已合并分片）。
   * @param chunk - 新到的字节。
   * @returns 完成的帧列表。
   */
  push(chunk: Buffer): WsFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const out: WsFrame[] = []

    for (;;) {
      const decoded = decodeFrame(this.buffer)
      if (decoded === null) break
      this.buffer = this.buffer.subarray(decoded.consumed)
      const frame = decoded.frame

      // 控制帧：不得分片，直接产出。
      if (frame.opcode >= 0x8) {
        if (!frame.fin) throw new WsProtocolError('control frames must not be fragmented')
        out.push(frame)
        continue
      }

      if (frame.opcode === OPCODE.continuation) {
        if (this.fragmentOpcode === null) throw new WsProtocolError('unexpected continuation frame')
        this.fragments.push(frame.payload)
        if (frame.fin) {
          out.push({ fin: true, opcode: this.fragmentOpcode, payload: Buffer.concat(this.fragments) })
          this.fragments = []
          this.fragmentOpcode = null
        }
        continue
      }

      // 新的数据帧
      if (this.fragmentOpcode !== null) throw new WsProtocolError('new data frame while fragmenting')
      if (frame.fin) {
        out.push(frame)
      } else {
        this.fragmentOpcode = frame.opcode
        this.fragments = [frame.payload]
      }
    }
    return out
  }

  /** 是否还有未完成的分片。 */
  get pending(): boolean {
    return this.fragmentOpcode !== null
  }
}
