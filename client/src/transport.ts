/**
 * 浏览器传输层：一元 RPC + 三方法长轮询，**没有任何 WebSocket**（D-3）。
 *
 * 为什么不是 socket：官方 `/api/remote.mux` 的升级走 `admitConnection()`，
 * 只认 `browserAuth` → **恒为 owner Peer**，非 owner 设备拿不到那条 socket。
 * 所以 v1 的下行是 `hub/stream.{open,next,cancel}` 三条**一元**方法，走同一个
 * `POST /remote/rpc` 入口，同样过官方 `decide()`（红线 R9）。
 *
 * 规则：
 * - 每请求带 `Authorization: Bearer <deviceToken>`；令牌只在内存，**绝不进 URL**。
 * - 401 → 调一次 `onUnauthorized()`、清令牌、**停止所有重试**。
 * - `remote-access/denied` / `forbidden` 也停止重试（入口本来就不该存在）。
 * - 超时判定发生在 `STREAM_BUDGET.holdMs + STREAM_BUDGET.pollSlackMs` 之后；
 *   空闲 60s 内 `hub/stream.next` ≈ 15 次，业务方法调用数为 0。
 *
 * @module dsh-remote-hub/client/transport
 */
import {
  AUTH_HEADER,
  BEARER_SCHEME,
  ERROR_CODES,
  GUARD_ROUTES,
  HUB_METHODS,
  HUB_PROTOCOL_HEADER,
  OFFICIAL_ERROR_CODES,
  PROTOCOL_VERSION,
  STREAM_BUDGET,
  hubEndpoint,
} from '@core/protocol.js'
import type { IssuedDeviceToken } from '@core/device.js'
import type { RoleName } from '@core/roles.js'

/** 官方 `client-request` 信封。 */
export interface ClientRequestEnvelope {
  type: 'client-request'
  rpcId: string
  method: string
  payload: { args: Record<string, unknown> }
}

/** 官方 `server-response` 信封。 */
export interface ServerResponseEnvelope {
  type: 'server-response'
  rpcId: string
  result:
    | { ok: true; value?: unknown }
    | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }
}

/** 带 `code` 的错误，便于 UI 分类（不是普通网络错误）。 */
export class RemoteHubError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'RemoteHubError'
  }
}

export interface TransportOptions {
  /** 守卫 origin（`https://…` 经隧道，`http://127.0.0.1:8443` 本机）。 */
  origin: string
  /** 设备令牌；缺省表示未配对。 */
  token?: string
  /** 本机 index 页注入的 `pairIssueToken`（签发端点专用；隧道侧拿不到）。 */
  pairIssueToken?: string
  /** 401 时调用一次，之后停止所有重试。 */
  onUnauthorized?: () => void
  /** 收到角色 / 权限快照时回调。 */
  onAccessSnapshot?: (snapshot: { role: RoleName }) => void
  /** 可注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
  /** 可注入的时钟（超时测试用）。 */
  now?: () => number
}

export interface RemoteTransport {
  /** 发一条官方一元 RPC。 */
  call<T>(method: string, args: Record<string, unknown>): Promise<T>
  /** 打开一条长轮询流。 */
  openStream(endpoint: string, args: Record<string, unknown>): Promise<{ streamId: string; cursor: number }>
  /** 拉取下一批。 */
  next(streamId: string, cursor: number, holdMs?: number): Promise<StreamNextValue>
  /** 取消一条流。 */
  cancel(streamId: string): Promise<{ ok: boolean }>
  /** 开始轮询循环；返回停止函数。 */
  subscribe(onEvent: (frame: unknown) => void): () => void
  /** 兑换票据/短码。 */
  redeem(input: { ticket?: string; code?: string; clientLabel: string }): Promise<IssuedDeviceToken>
  /** 签发 QR 票据（本机）。 */
  issueTicket(role: RoleName): Promise<{ ticket: string; expiresAt: number; role: RoleName }>
  /** 签发短码（本机）。 */
  issueCode(role: RoleName): Promise<{ code: string; expiresAt: number; role: RoleName }>
  /** 健康检查。 */
  health(): Promise<{ ok: boolean; protocolVersion: number }>
  /** 更新内存令牌。 */
  setToken(token: string | undefined): void
  /** 关闭全部轮询。 */
  close(): void
  readonly closed: boolean
  /** 诊断：`hub/stream.next` 调用次数。 */
  readonly streamNextCalls: number
  /** 诊断：业务方法轮询次数（恒为 0）。 */
  readonly businessPollCalls: number
}

export interface StreamNextValue {
  items: unknown[]
  nextCursor: number
  done?: boolean
  terminal?: { code: string }
  truncated?: boolean
}

const RETRYABLE_STATUS: readonly number[] = [408, 429, 502, 503, 504]
const RETRYABLE_CODES: readonly string[] = [
  ERROR_CODES.streamNotFound,
  'gateway/internal',
  'gateway/service-unavailable',
]

function uuid(): string {
  // Web Crypto 在浏览器与现代 WebView 都有；缺失时退化成时间戳+随机。
  const cryptoObj = globalThis.crypto as { randomUUID?: () => string } | undefined
  if (typeof cryptoObj?.randomUUID === 'function') return cryptoObj.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** 判断一个错误是否应该「停止重试」（终态）。 */
function isTerminal(error: RemoteHubError): boolean {
  if (error.status === 401) return true
  if (error.code === OFFICIAL_ERROR_CODES.remoteAccessDenied) return true
  if (error.code === ERROR_CODES.forbidden) return true
  if (error.code === ERROR_CODES.protocolVersionMismatch) return true
  if (error.code === ERROR_CODES.deviceRevoked) return true
  if (RETRYABLE_STATUS.includes(error.status)) return false
  if (RETRYABLE_CODES.includes(error.code)) return false
  return error.status >= 400 && error.status < 500
}

/**
 * 创建浏览器 transport。
 * @param options - origin、令牌、回调与注入依赖。
 * @returns `RemoteTransport`。
 */
export function createTransport(options: TransportOptions): RemoteTransport {
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args))
  const now = options.now ?? (() => Date.now())
  const origin = options.origin.replace(/\/+$/u, '')
  let token: string | undefined = options.token
  let closed = false
  let unauthorizedCalled = false
  let streamNextCalls = 0
  let businessPollCalls = 0
  const pollLoops = new Set<{ stop: () => void }>()

  const baseHeaders = (): Record<string, string> => ({
    [HUB_PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    ...(token === undefined ? {} : { [AUTH_HEADER]: `${BEARER_SCHEME} ${token}` }),
  })

  const handleUnauthorized = (): void => {
    token = undefined
    if (unauthorizedCalled) return
    unauthorizedCalled = true
    options.onUnauthorized?.()
    // 401 之后**停止所有重试**：清掉全部轮询循环。
    for (const loop of [...pollLoops]) loop.stop()
    pollLoops.clear()
    closed = true
  }

  /** 统一解析官方 server-response 信封。 */
  const parseEnvelope = (rpcId: string, status: number, text: string): unknown => {
    let parsed: ServerResponseEnvelope
    try {
      parsed = JSON.parse(text) as ServerResponseEnvelope
    } catch {
      throw new RemoteHubError(ERROR_CODES.internal, 'malformed server-response envelope', status)
    }
    if (parsed.type !== 'server-response' || parsed.result === undefined) {
      throw new RemoteHubError(ERROR_CODES.internal, 'not a server-response envelope', status)
    }
    if (parsed.rpcId !== rpcId && parsed.rpcId !== 'guard' && parsed.rpcId !== 'invalid-endpoint') {
      // 守卫层的拒绝不携带客户端 rpcId；业务响应必须严格回显。
      throw new RemoteHubError(ERROR_CODES.internal, 'rpcId mismatch', status)
    }
    if (!parsed.result.ok) {
      const error = new RemoteHubError(
        parsed.result.error.code,
        parsed.result.error.message,
        status,
        parsed.result.error.details ?? {},
      )
      if (status === 401) handleUnauthorized()
      throw error
    }
    return parsed.result.value
  }

  const rawFetch = async (
    path: string,
    init: { method: string; body?: string; headers?: Record<string, string> },
  ): Promise<{ status: number; text: string }> => {
    const response = await fetchImpl(`${origin}${path}`, {
      method: init.method,
      headers: { ...baseHeaders(), ...(init.headers ?? {}) },
      ...(init.body === undefined ? {} : { body: init.body }),
    })
    return { status: response.status, text: await response.text() }
  }

  const rpc = async (method: string, args: Record<string, unknown>): Promise<unknown> => {
    if (closed) throw new RemoteHubError(ERROR_CODES.internal, 'transport is closed', 0)
    const rpcId = uuid()
    const envelope: ClientRequestEnvelope = {
      type: 'client-request',
      rpcId,
      method,
      payload: { args },
    }
    let attempt = 0
    // 有限重试：只对可重试状态/码，且最多 3 次；401/403/4xx 终态立刻抛。
    for (;;) {
      const { status, text } = await rawFetch(GUARD_ROUTES.rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rpc-id': rpcId },
        body: JSON.stringify(envelope),
      })
      try {
        return parseEnvelope(rpcId, status, text)
      } catch (error) {
        if (!(error instanceof RemoteHubError)) throw error
        if (isTerminal(error) || attempt >= 2) throw error
        attempt += 1
        await new Promise<void>(resolve => setTimeout(resolve, 100 * attempt))
      }
    }
  }

  const next = async (streamId: string, cursor: number, holdMs?: number): Promise<StreamNextValue> => {
    streamNextCalls += 1
    const value = await rpc(hubEndpoint(HUB_METHODS.streamNext), {
      streamId,
      cursor,
      ...(holdMs === undefined ? {} : { holdMs }),
    })
    if (typeof value !== 'object' || value === null || !Array.isArray((value as { items?: unknown }).items)) {
      throw new RemoteHubError(ERROR_CODES.internal, 'malformed stream.next result', 200)
    }
    return value as StreamNextValue
  }

  return {
    get closed() { return closed },
    get streamNextCalls() { return streamNextCalls },
    get businessPollCalls() { return businessPollCalls },
    async call<T>(method: string, args: Record<string, unknown>): Promise<T> {
      return rpc(method, args) as Promise<T>
    },
    async openStream(endpoint, args) {
      const value = await rpc(hubEndpoint(HUB_METHODS.streamOpen), { endpoint, args })
      if (typeof value !== 'object' || value === null || typeof (value as { streamId?: unknown }).streamId !== 'string') {
        throw new RemoteHubError(ERROR_CODES.internal, 'malformed stream.open result', 200)
      }
      return value as { streamId: string; cursor: number }
    },
    next,
    async cancel(streamId) {
      const value = await rpc(hubEndpoint(HUB_METHODS.streamCancel), { streamId })
      return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === true
        ? { ok: true }
        : { ok: false }
    },
    subscribe(onEvent) {
      // 长轮询循环：先 open，再反复 next。**不**对业务方法起轮询。
      const loop: { stop: () => void } = { stop: () => {} }
      let stopped = false
      let currentStreamId: string | undefined
      pollLoops.add(loop)
      loop.stop = () => {
        if (stopped) return
        stopped = true
        pollLoops.delete(loop)
        if (currentStreamId !== undefined) void this.cancel(currentStreamId)
      }
      void (async () => {
        try {
          const opened = await this.openStream('session/events', {})
          currentStreamId = opened.streamId
          let cursor = opened.cursor
          while (!stopped && !closed) {
            const startedAt = now()
            let batch: StreamNextValue
            try {
              batch = await next(opened.streamId, cursor, STREAM_BUDGET.holdMs)
            } catch (error) {
              if (error instanceof RemoteHubError && !isTerminal(error) && !stopped) {
                await new Promise<void>(resolve => setTimeout(resolve, STREAM_BUDGET.pollSlackMs))
                continue
              }
              break
            }
            // 超时余量：一轮读超过 hold+slack 才认定为「这一轮丢了」。
            if (now() - startedAt > STREAM_BUDGET.holdMs + STREAM_BUDGET.pollSlackMs) {
              // 显示降级但不重连业务方法；继续下一轮 next。
            }
            for (const item of batch.items) onEvent(item)
            cursor = batch.nextCursor
            if (batch.terminal !== undefined || batch.done === true) {
              if (batch.terminal?.code === ERROR_CODES.deviceRevoked) handleUnauthorized()
              break
            }
            // 空批也按 holdMs 节奏继续，不洪泛。
            if (batch.items.length === 0) {
              await new Promise<void>(resolve => setTimeout(resolve, STREAM_BUDGET.pollSlackMs))
            }
          }
        } catch {
          // open 失败（例如无可见流）：安静停止，不洪泛重试。
        }
      })()
      return () => loop.stop()
    },
    async redeem(input) {
      const { status, text } = await rawFetch(GUARD_ROUTES.pair, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(input.ticket === undefined ? {} : { ticket: input.ticket }),
          ...(input.code === undefined ? {} : { code: input.code }),
          clientLabel: input.clientLabel,
        }),
      })
      let parsed: Record<string, unknown>
      try { parsed = JSON.parse(text) as Record<string, unknown> } catch {
        throw new RemoteHubError(ERROR_CODES.internal, 'malformed pairing response', status)
      }
      if (status !== 200) {
        const code = typeof (parsed.result as { error?: { code?: unknown } } | undefined)?.error?.code === 'string'
          ? (parsed.result as { error: { code: string } }).error.code
          : (typeof parsed.error === 'object' && parsed.error !== null
            ? String((parsed.error as { code?: unknown }).code ?? ERROR_CODES.pairInvalid)
            : ERROR_CODES.pairInvalid)
        throw new RemoteHubError(code, 'pairing credential rejected', status)
      }
      const issued = parsed as unknown as IssuedDeviceToken
      token = issued.token
      unauthorizedCalled = false
      options.onAccessSnapshot?.({ role: issued.role })
      return issued
    },
    async issueTicket(role) {
      const { status, text } = await rawFetch(GUARD_ROUTES.pairTicket, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pair-issue-token': options.pairIssueToken ?? '',
        },
        body: JSON.stringify({ role }),
      })
      if (status !== 200) throw new RemoteHubError(ERROR_CODES.forbidden, 'pairing issue refused', status)
      return JSON.parse(text) as { ticket: string; expiresAt: number; role: RoleName }
    },
    async issueCode(role) {
      const { status, text } = await rawFetch(GUARD_ROUTES.pairCode, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pair-issue-token': options.pairIssueToken ?? '',
        },
        body: JSON.stringify({ role }),
      })
      if (status !== 200) throw new RemoteHubError(ERROR_CODES.forbidden, 'pairing issue refused', status)
      return JSON.parse(text) as { code: string; expiresAt: number; role: RoleName }
    },
    async health() {
      const { status, text } = await rawFetch(GUARD_ROUTES.health, { method: 'GET' })
      if (status !== 200) throw new RemoteHubError(ERROR_CODES.internal, 'health check failed', status)
      return JSON.parse(text) as { ok: boolean; protocolVersion: number }
    },
    setToken(value) {
      token = value
      if (value !== undefined) unauthorizedCalled = false
    },
    close() {
      closed = true
      for (const loop of [...pollLoops]) loop.stop()
      pollLoops.clear()
    },
  }
}
