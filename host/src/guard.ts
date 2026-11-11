/**
 * 守卫（guard）：**唯一**外部入口，只绑回环字面量的独立 `node:http` 监听。
 *
 * 五条路由（`GUARD_ROUTES`），其余一律 404 —— 包括 `/api/*`：
 * 那不是守卫的路由，而是守卫用 `peer` 身份交给
 * `ctx.connection.createSharedFetchHandler('/api')` 的 DSH RPC 面（D-2）。
 * 单独给三条 stream 方法开 HTTP 路由会绕开 Gateway 的参数校验与 `decide()`
 * （红线 R9），所以它们走 `rpc` 入口。
 *
 * 装配链（每个请求，顺序固定）：
 *   ① 路由白名单（不在表里 → 404）
 *   ② `X-Hub-Protocol` 版本头（不符 → 400，不隐式降级）
 *   ③ 三段来源围栏 `checkSource`（D-9）
 *   ④ 按路由分支：
 *      - health：无鉴权，最小事实
 *      - pairTicket/pairCode：**双条件回环** + `pairIssueToken`（红线 R4）
 *      - pair：一次性票据/短码 + 预算 + 限流，**不**加回环门控（D-15）
 *      - rpc：Bearer 令牌 → 设备→Peer → 官方信封 → `sharedFetch.fetch(request, peer)`
 *   ⑤ 请求体上限（8 MiB）、响应原样回写（含 multipart 附件投影）
 *
 * **不起任何 WebSocket**：没有 `upgrade` 监听、没有 `ws` 依赖（D-3）。
 *
 * @module dsh-remote-hub/host/guard
 */
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import {
  AUTH_HEADER,
  BEARER_SCHEME,
  ERROR_CODES,
  GUARD_ROUTES,
  HUB_PROTOCOL_HEADER,
  LIMITS,
  PROTOCOL_VERSION,
  STREAM_BUDGET,
} from '@core/index.js'
import { isRoleName } from '@core/roles.js'

import type { Config } from './config.js'
import { assertLoopbackLiteral } from './config.js'
import type { Dispatcher } from './dispatch.js'
import { checkLoopback, checkSource, type FenceRequest } from './fence.js'
import type { PairingService } from './pairing.js'
import type { TokenService } from './token.js'

/** 注入到 index 页的全局名（host 的 `webserver/index-inject` 会写这一行）。 */
export const PAIR_ISSUE_GLOBAL = '__DSH_REMOTE_HUB__'

/** 签发端要求携带的进程内令牌头。 */
export const PAIR_ISSUE_HEADER = 'x-pair-issue-token'

/**
 * pairIssueToken 的落盘文件（相对 `~/.dsh/remote-hub/`）。
 *
 * **无界面 host 的 CLI 对接通道**：服务器上没有 GUI 页面可注入，所以插件把
 * 进程内随机值以 `0600` 写进这个文件，CLI（`dsh-remote-hub-pair`）读它来签发。
 * 安全性质不变：文件只在本机盘上、属于同一 Unix 用户；隧道侧拿不到它；
 * 每次插件启动重新生成，旧文件即失效。
 */
export const PAIR_ISSUE_PIN_FILE = 'pair-issue-pin'

/** 守卫句柄。 */
export interface GuardHandle {
  /** 隧道应指向的 origin（例如 `http://127.0.0.1:8443`）。 */
  origin: string
  port: number
  /** 注入 index 页的进程内随机值；**绝不经隧道、绝不写日志**。 */
  pairIssueToken: string
  /** 关闭监听 → 丢弃全部在途 socket。 */
  dispose(): Promise<void>
}

export interface GuardDeps {
  config: Config
  tokens: TokenService
  pairing: PairingService
  dispatcher: Dispatcher
  /** 结构化审计（越权尝试、配对、流越界）。日志**不得**含令牌/票据/短码/Authorization。 */
  audit?: (event: string, fields: Record<string, unknown>) => void
  /** 注入 `pairIssueToken`（测试用；缺省随机生成）。 */
  pairIssueToken?: string
}

/** 守卫层错误：带一个码与 HTTP 状态。 */
interface GuardError {
  code: string
  status: number
  message: string
}

function failure(code: string, status: number, message: string): GuardError {
  return { code, status, message }
}

/** 构造官方 `server-response` 失败信封。 */
function rpcFailureBody(rpcId: string, error: GuardError): string {
  return JSON.stringify({
    type: 'server-response',
    rpcId,
    result: {
      ok: false,
      error: { code: error.code, message: error.message, details: {} },
    },
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

/** 读取请求体，超出上限即拒（防令牌洪泛 / 超大 body）。 */
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > limit) return null
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown } catch { return undefined }
}

/** 把 Fetch `Response` 原样写回 node `ServerResponse`（保留 multipart 附件投影）。 */
async function writeFetchResponse(res: ServerResponse, response: Response, protocolHeader: string): Promise<void> {
  res.statusCode = response.status
  response.headers.forEach((value, key) => {
    // `content-length` 由 node 依据实际 body 重新计算，避免与压缩/分块冲突。
    if (key.toLowerCase() !== 'content-length') res.setHeader(key, value)
  })
  res.setHeader(HUB_PROTOCOL_HEADER, protocolHeader)
  const body = Buffer.from(await response.arrayBuffer())
  res.setHeader('content-length', String(body.length))
  res.end(body)
}

function sendJson(res: ServerResponse, status: number, value: unknown, protocolHeader: string): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', String(body.length))
  res.setHeader(HUB_PROTOCOL_HEADER, protocolHeader)
  res.end(body)
}

/** 兑换端限流：按来源 socket 地址，1 分钟窗口内最多 N 次。 */
class RedeemLimiter {
  private readonly hits = new Map<string, number[]>()

  constructor(private readonly limit: number, private readonly now: () => number = () => Date.now()) {}

  /** @returns true 表示允许，false 表示应 429。 */
  allow(key: string): boolean {
    const at = this.now()
    const recent = (this.hits.get(key) ?? []).filter(time => at - time < 60_000)
    if (recent.length >= this.limit) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(at)
    this.hits.set(key, recent)
    return true
  }
}

/**
 * 启动守卫。
 *
 * 端口被占（EADDRINUSE）时 **抛错**，插件加载失败；**不静默换端口**
 * （换端口会让隧道配置悬空）。
 * @param deps - 依赖。
 * @returns `GuardHandle`。
 */
export async function startGuard(deps: GuardDeps): Promise<GuardHandle> {
  const config = deps.config
  assertLoopbackLiteral(config.guardHost)
  const protocolHeader = String(PROTOCOL_VERSION)
  // 进程内随机，只注入本机 index 页。隧道拿不到它，所以即便隧道在本机终止、
  // socket 地址恒为回环、且伪造了 Host 头，也过不了签发端（§9.3 第 1 条的补强）。
  const pairIssueToken = deps.pairIssueToken ?? randomBytes(32).toString('base64url')
  const limiter = new RedeemLimiter(LIMITS.pairRedeemPerMinute)
  const protocol = 'http:' as const
  const sockets = new Set<import('node:net').Socket>()

  const toFenceRequest = (req: IncomingMessage): FenceRequest => ({
    headers: req.headers as Record<string, string | string[] | undefined>,
  })

  const audit = (event: string, fields: Record<string, unknown>): void => {
    deps.audit?.(event, fields)
  }

  /** 守卫层统一拒绝（仍是官方 server-response 形状，便于客户端只解析一种信封）。 */
  const reject = (res: ServerResponse, rpcId: string, error: GuardError): void => {
    sendJson(res, error.status, JSON.parse(rpcFailureBody(rpcId, error)) as unknown, protocolHeader)
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `${protocol}//${config.guardHost}:${config.guardPort}`)
      const path = url.pathname
      const method = (req.method ?? 'GET').toUpperCase()
      const rpcId = typeof req.headers['x-rpc-id'] === 'string' ? req.headers['x-rpc-id'] : 'guard'

      // ① 路由白名单：不在表里一律 404（含 /api/*、/remote/stream/*）。
      const known = new Set<string>(Object.values(GUARD_ROUTES))
      if (!known.has(path)) {
        reject(res, rpcId, failure(ERROR_CODES.notFound, 404, 'not found'))
        return
      }

      // ② 自有面版本头：不符即 400，不降级、不猜测。
      const version = req.headers[HUB_PROTOCOL_HEADER]
      if (version !== protocolHeader) {
        reject(res, rpcId, failure(ERROR_CODES.protocolVersionMismatch, 400, 'protocol version mismatch'))
        return
      }

      // ③ 三段来源围栏（对所有路由生效，包括 health 与签发端）。
      const fence = checkSource(toFenceRequest(req), {
        publicAuthorities: config.publicAuthorities,
        protocol,
      })
      if (!fence.ok) {
        audit('source-rejected', { path, reason: fence.reason })
        reject(res, rpcId, failure(ERROR_CODES.forbidden, 403, 'source not allowed'))
        return
      }

      // ── health ───────────────────────────────────────────────────────────
      if (path === GUARD_ROUTES.health) {
        if (method !== 'GET' && method !== 'HEAD') {
          reject(res, rpcId, failure(ERROR_CODES.notFound, 404, 'not found'))
          return
        }
        sendJson(res, 200, { ok: true, protocolVersion: PROTOCOL_VERSION }, protocolHeader)
        return
      }

      // ── 签发端（双条件回环 + 进程内令牌）────────────────────────────────
      if (path === GUARD_ROUTES.pairTicket || path === GUARD_ROUTES.pairCode) {
        if (method !== 'POST' && method !== 'GET') {
          reject(res, rpcId, failure(ERROR_CODES.notFound, 404, 'not found'))
          return
        }
        const loop = checkLoopback(req)
        if (!loop.ok) {
          audit('pair-issue-rejected', { path, reason: loop.reason })
          reject(res, rpcId, failure(ERROR_CODES.forbidden, 403, 'pairing issue is loopback-only'))
          return
        }
        const presented = req.headers[PAIR_ISSUE_HEADER]
        if (presented !== pairIssueToken) {
          audit('pair-issue-rejected', { path, reason: 'missing pairIssueToken' })
          reject(res, rpcId, failure(ERROR_CODES.forbidden, 403, 'pairing issue is loopback-only'))
          return
        }
        const body = await readBody(req, 64 * 1024)
        const parsed = body === null ? undefined : parseJson(body.toString('utf8'))
        let role = config.defaultRole
        if (isPlainObject(parsed) && parsed.role !== undefined) {
          if (!isRoleName(parsed.role)) {
            reject(res, rpcId, failure(ERROR_CODES.badRequest, 400, 'invalid role'))
            return
          }
          role = parsed.role
        }
        const issued = path === GUARD_ROUTES.pairTicket
          ? deps.pairing.issueTicket(role)
          : deps.pairing.issueCode(role)
        // 票据/短码只在这次响应里出现一次；不写日志、不回显进错误体。
        sendJson(res, 200, {
          ...(path === GUARD_ROUTES.pairTicket ? { ticket: issued.secret } : { code: issued.secret }),
          expiresAt: issued.expiresAt,
          role: issued.role,
        }, protocolHeader)
        return
      }

      // ── 兑换端（**不**加回环门控：远程设备在隧道外）─────────────────────
      if (path === GUARD_ROUTES.pair) {
        if (method !== 'POST') {
          reject(res, rpcId, failure(ERROR_CODES.notFound, 404, 'not found'))
          return
        }
        const source = req.socket.remoteAddress ?? 'unknown'
        if (!limiter.allow(source)) {
          reject(res, rpcId, failure(ERROR_CODES.rateLimited, 429, 'too many pairing attempts'))
          return
        }
        const body = await readBody(req, 64 * 1024)
        if (body === null) {
          reject(res, rpcId, failure(ERROR_CODES.badRequest, 400, 'body too large'))
          return
        }
        const parsed = parseJson(body.toString('utf8'))
        if (!isPlainObject(parsed)) {
          reject(res, rpcId, failure(ERROR_CODES.badRequest, 400, 'invalid body'))
          return
        }
        const clientLabel = typeof parsed.clientLabel === 'string' ? parsed.clientLabel.slice(0, 120) : 'remote device'
        const ticket = typeof parsed.ticket === 'string' ? parsed.ticket : undefined
        const code = typeof parsed.code === 'string' ? parsed.code : undefined
        if ((ticket === undefined) === (code === undefined)) {
          reject(res, rpcId, failure(ERROR_CODES.badRequest, 400, 'provide exactly one of ticket or code'))
          return
        }
        const result = ticket !== undefined
          ? await deps.pairing.redeemTicket(ticket, clientLabel)
          : await deps.pairing.redeemCode(code as string, clientLabel)
        if (!result.ok) {
          // 错误体只有码，**不含**票据/短码，也不区分「不存在/过期/预算耗尽」之外的细节。
          const status = result.code === ERROR_CODES.rateLimited ? 429 : 403
          reject(res, rpcId, failure(result.code, status, 'pairing credential rejected'))
          return
        }
        audit('pair-redeemed', { deviceId: result.issued.deviceId, role: result.issued.role, path: ticket !== undefined ? 'qr' : 'code' })
        sendJson(res, 200, result.issued, protocolHeader)
        return
      }

      // ── rpc：Bearer → 设备→Peer → 官方信封 → sharedFetch ────────────────
      if (path === GUARD_ROUTES.rpc) {
        if (method !== 'POST') {
          reject(res, rpcId, failure(ERROR_CODES.notFound, 404, 'not found'))
          return
        }
        const authorization = req.headers[AUTH_HEADER]
        const bearer = typeof authorization === 'string' ? authorization : undefined
        if (bearer === undefined || !bearer.startsWith(`${BEARER_SCHEME} `)) {
          reject(res, rpcId, failure(ERROR_CODES.unauthorized, 401, 'missing bearer token'))
          return
        }
        const token = bearer.slice(BEARER_SCHEME.length + 1)
        const identity = await deps.tokens.verify(token)
        if (identity === null) {
          reject(res, rpcId, failure(ERROR_CODES.unauthorized, 401, 'invalid or revoked token'))
          return
        }
        const body = await readBody(req, LIMITS.maxRequestBodyBytes)
        if (body === null) {
          reject(res, rpcId, failure(ERROR_CODES.badRequest, 400, 'body too large'))
          return
        }
        const envelope = parseJson(body.toString('utf8'))
        if (!isPlainObject(envelope)
          || envelope.type !== 'client-request'
          || typeof envelope.rpcId !== 'string'
          || typeof envelope.method !== 'string'
          || !isPlainObject(envelope.payload)
          || !Object.hasOwn(envelope.payload, 'args')
          || Object.keys(envelope.payload).length !== 1) {
          reject(res, rpcId, failure(ERROR_CODES.badRequest, 400, 'invalid client-request envelope'))
          return
        }
        const endpoint = envelope.method
        const responseRpcId = envelope.rpcId
        const peer = deps.dispatcher.peerFor(identity.deviceId, identity.role)
        // **转发完整信封**（含 type/rpcId/method/payload）：Gateway 的 zod 会再
        // 校验一次外层字段，只传 payload 会得到 `invalid client-request message`。
        const response = await deps.dispatcher.fetch(endpoint, envelope, peer)
        // 越权尝试是**最有价值**的审计信号；只读 status，不读 body（body 可能含业务数据）。
        if (response.status === 403) {
          audit('access-denied', { deviceId: identity.deviceId, action: endpoint })
        }
        await writeFetchResponse(res, response, protocolHeader)
        return
      }

      reject(res, rpcId, failure(ERROR_CODES.notFound, 404, 'not found'))
    })().catch(error => {
      if (res.headersSent) {
        res.end()
        return
      }
      reject(res, 'guard', failure(ERROR_CODES.internal, 500, error instanceof Error ? error.message : String(error)))
    })
  })

  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => { sockets.delete(socket) })
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(config.guardPort, config.guardHost)
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : config.guardPort

  return {
    origin: `${protocol}//${config.guardHost}:${port}`,
    port,
    pairIssueToken,
    async dispose() {
      // 顺序：先关监听（不再接新连接），再断在途 socket，最后等 server 关闭。
      // 反过来会让进行中的调用拿到 `gateway/peer-disposed` 而不是干净的连接关闭。
      await new Promise<void>(resolve => {
        server.close(() => resolve())
        for (const socket of sockets) socket.destroy()
        server.closeAllConnections?.()
      })
    },
  }
}

/** 守卫侧的默认读超时（HTTP 层兜底，供调用方配置 socket timeout）。 */
export const GUARD_READ_TIMEOUT_MS = STREAM_BUDGET.readTimeoutMs
