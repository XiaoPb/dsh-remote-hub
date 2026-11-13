/**
 * M3：WebSocket 帧层测试（RFC 6455 子集）。
 *
 * 覆盖：握手 accept 计算、编码/解码往返、掩码、扩展长度、
 * 分片拼接、控制帧约束、非法帧拒绝。
 *
 * @module test/ws-frame.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const ws = await import('../lib/index.js')

/** 按客户端方式编码（带掩码）。 */
function clientFrame(opcode, payload, fin = true, mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d])) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const masked = Buffer.from(data)
  for (let i = 0; i < masked.length; i += 1) masked[i] = data[i] ^ mask[i & 3]

  let header
  if (data.length < 126) {
    header = Buffer.alloc(2)
    header[1] = 0x80 | data.length
  } else if (data.length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 0x80 | 126
    header.writeUInt16BE(data.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(data.length), 2)
  }
  header[0] = (fin ? 0x80 : 0) | opcode
  return Buffer.concat([header, mask, masked])
}

describe('握手', () => {
  it('computeAccept 匹配 RFC 6455 §1.3 官方示例', () => {
    // RFC 6455 的示例 key 与期望 accept
    assert.equal(
      ws.computeAccept('dGhlIHNhbXBsZSBub25jZQ=='),
      's3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
    )
  })

  it('handshakeResponse 含必需的三个头', () => {
    const response = ws.handshakeResponse('dGhlIHNhbXBsZSBub25jZQ==')
    assert.match(response, /101 Switching Protocols/u)
    assert.match(response, /Upgrade: websocket/u)
    assert.match(response, /Connection: Upgrade/u)
    assert.match(response, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/u)
  })
})

describe('编码 / 解码往返', () => {
  it('服务端编码的帧格式正确（fin/opcode/长度/不掩码）', () => {
    const encoded = ws.encodeFrame(ws.OPCODE.text, Buffer.from('hello'))
    assert.equal(encoded[0], 0x81, 'FIN + text')
    assert.equal(encoded[1], 5, '长度 5 且 MASK=0')
    assert.equal(encoded.subarray(2).toString(), 'hello')
  })

  it('服务端编码 + 客户端掩码往返一致', () => {
    // 服务端发送 → 客户端接收：本层编码给服务端用。
    const encoded = ws.encodeFrame(ws.OPCODE.text, Buffer.from('roundtrip'))
    assert.equal(encoded.subarray(2).toString(), 'roundtrip')
    // 反向：客户端掩码帧被服务端解析器读出。
    const parser = new ws.FrameParser()
    const frames = parser.push(clientFrame(ws.OPCODE.text, 'roundtrip'))
    assert.equal(frames[0].payload.toString(), 'roundtrip')
  })

  it('默认帧是 FIN（单帧消息）', () => {
    const encoded = ws.encodeFrame(ws.OPCODE.text, Buffer.from('x'))
    assert.equal((encoded[0] & 0x80) !== 0, true, 'FIN 位必须置位')
  })

  it('fin=false 可编码分片', () => {
    const encoded = ws.encodeFrame(ws.OPCODE.text, Buffer.from('x'), false)
    assert.equal((encoded[0] & 0x80) !== 0, false, 'FIN 位必须为 0')
  })

  it('客户端掩码帧可被正确解掩码', () => {
    const parser = new ws.FrameParser()
    const frames = parser.push(clientFrame(ws.OPCODE.text, 'masked-payload'))
    assert.equal(frames[0].payload.toString(), 'masked-payload')
  })

  it('126 扩展长度（16 位）', () => {
    const payload = 'x'.repeat(200)
    const parser = new ws.FrameParser()
    const frames = parser.push(clientFrame(ws.OPCODE.binary, payload))
    assert.equal(frames[0].payload.length, 200)
  })

  it('127 扩展长度（64 位）', () => {
    const payload = Buffer.alloc(70_000, 0x41)
    const parser = new ws.FrameParser()
    const frames = parser.push(clientFrame(ws.OPCODE.binary, payload))
    assert.equal(frames[0].payload.length, 70_000)
  })

  it('二进制的空负载', () => {
    const parser = new ws.FrameParser()
    const frames = parser.push(clientFrame(ws.OPCODE.binary, ''))
    assert.equal(frames[0].payload.length, 0)
  })
})

describe('分包读取', () => {
  it('半个帧返回空，补齐后产出', () => {
    const parser = new ws.FrameParser()
    const full = clientFrame(ws.OPCODE.text, 'split-me')
    assert.equal(parser.push(full.subarray(0, 3)).length, 0, '不足一帧时应返回空')
    const frames = parser.push(full.subarray(3))
    assert.equal(frames.length, 1)
    assert.equal(frames[0].payload.toString(), 'split-me')
  })

  it('一次喂入多帧全部产出', () => {
    const parser = new ws.FrameParser()
    const frames = parser.push(Buffer.concat([
      clientFrame(ws.OPCODE.text, 'a'),
      clientFrame(ws.OPCODE.text, 'b'),
      clientFrame(ws.OPCODE.text, 'c'),
    ]))
    assert.deepEqual(frames.map(f => f.payload.toString()), ['a', 'b', 'c'])
  })
})

describe('分片（continuation）', () => {
  it('两个分片拼成一条消息', () => {
    const parser = new ws.FrameParser()
    const chunks = Buffer.concat([
      clientFrame(ws.OPCODE.text, 'part1-', false),
      clientFrame(ws.OPCODE.continuation, 'part2', true),
    ])
    const frames = parser.push(chunks)
    assert.equal(frames.length, 1, '分片应合并为一条消息')
    assert.equal(frames[0].payload.toString(), 'part1-part2')
    assert.equal(parser.pending, false)
  })

  it('三个分片', () => {
    const parser = new ws.FrameParser()
    const frames = parser.push(Buffer.concat([
      clientFrame(ws.OPCODE.binary, 'a', false),
      clientFrame(ws.OPCODE.continuation, 'b', false),
      clientFrame(ws.OPCODE.continuation, 'c', true),
    ]))
    assert.equal(frames[0].payload.toString(), 'abc')
  })
})

describe('控制帧', () => {
  it('ping / pong 原样产出', () => {
    const parser = new ws.FrameParser()
    const frames = parser.push(clientFrame(ws.OPCODE.ping, 'hb'))
    assert.equal(frames[0].opcode, ws.OPCODE.ping)
    assert.equal(frames[0].payload.toString(), 'hb')
  })

  it('close 帧负载可解析状态码', () => {
    const parser = new ws.FrameParser()
    const payload = ws.closePayload(4401, 'auth')
    const frames = parser.push(clientFrame(ws.OPCODE.close, payload))
    assert.equal(frames[0].opcode, ws.OPCODE.close)
    assert.equal(frames[0].payload.readUInt16BE(0), 4401)
    assert.equal(frames[0].payload.subarray(2).toString(), 'auth')
  })
})

describe('非法帧拒绝', () => {
  it('客户端未掩码的帧必须拒绝', () => {
    const parser = new ws.FrameParser()
    // 手工构造一个不带掩码的帧
    const payload = Buffer.from('nope')
    const header = Buffer.from([0x81, payload.length])
    assert.throws(() => parser.push(Buffer.concat([header, payload])), /must be masked/u)
  })

  it('RSV 位非零必须拒绝', () => {
    const parser = new ws.FrameParser()
    const frame = clientFrame(ws.OPCODE.text, 'x')
    frame[0] |= 0x40   // 打开 RSV1
    assert.throws(() => parser.push(frame), /RSV/u)
  })

  it('无前置分片却收到 continuation 必须拒绝', () => {
    const parser = new ws.FrameParser()
    assert.throws(() => parser.push(clientFrame(ws.OPCODE.continuation, 'x')), /continuation/u)
  })

  it('超长帧必须拒绝（1009）', () => {
    const parser = new ws.FrameParser()
    const header = Buffer.alloc(10)
    header[0] = 0x82
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(ws.MAX_FRAME_BYTES + 1), 2)
    assert.throws(() => parser.push(header), /too large/u)
  })
})
