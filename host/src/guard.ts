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
import type { Duplex } from 'node:stream'
import { networkInterfaces } from 'node:os'

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
import { assertBindableHost, isPrivateAddress } from './config.js'
import type { DeviceStore } from './devices.js'
import { createGuardWsRoute } from './guard-ws.js'
import type { Dispatcher } from './dispatch.js'
import { checkLoopback, checkPrivatePeer, checkSource, isLoopbackHostname, type FenceRequest } from './fence.js'
import type { HubMetrics, MetricsCollector } from './metrics.js'
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
  /**
   * 对外可用的 origin：局域网模式是 **LAN IP**（例如 `http://192.168.1.10:8443`），
   * 回环模式是 `http://127.0.0.1:8443`。配对二维码/链接用它。
   */
  origin: string
  /**
   * 仅供本机页面做**签发与设备管理**：`http://127.0.0.1:<port>`。
   * 签发端要求 socket 对端是回环，所以这些调用必须走这个地址（即便在 LAN 模式，
   * 从本机连 LAN IP 时源地址也是 LAN IP，会被回环门控拒绝）。
   */
  loopbackOrigin: string
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
  /** 设备表（设备管理路由要列/吊销；不经过 Peer 与 decide()）。 */
  devices: DeviceStore
  /** 运行指标收集器（stats 路由数据源 + 认证/签发埋点）。 */
  metrics?: MetricsCollector
  /** 配置读写（config 路由；缺省时路由 404，页面走降级）。 */
  configStore?: ConfigStore
  /** 结构化审计（越权尝试、配对、流越界）。日志**不得**含令牌/票据/短码/Authorization。 */
  audit?: (event: string, fields: Record<string, unknown>) => void
  /** 注入 `pairIssueToken`（测试用；缺省随机生成）。 */
  pairIssueToken?: string
  /**
   * 设备被单控策略挤下线时的回调。
   *
   * **只断连接，不动令牌**（2026-11-12）：调用方应丢弃 Peer、断开流，
   * 但**不得**调用 `tokens.revoke()`。
   */
  onSessionDisplaced?: (deviceId: string) => void
  /**
   * 把 `/remote/ws` 交给 Host 的 WebSocket 基础设施（A3 形态）。
   *
   * 由 `plugin.ts` 注入：守卫只做「令牌校验 + 认领」，mux 由
   * `guard-mux.ts`（承载 `typertGateway.wireStream`）实现。
   * 缺省时 WS 端点不挂载（保持纯 HTTP 行为）。
   */
  ws?: {
    /** 由 `guard-mux.ts` 创建；`accept` 完成认领后的接入。 */
    mux: {
      /** `deviceId` 用于建立连接索引，让位/吊销时可定向关闭。 */
      accept(request: IncomingMessage, socket: Duplex, head: Buffer, peer: unknown, deviceId?: string): void
      close(): Promise<void>
      closeDevice?(deviceId: string): number
      connectionsOf?(deviceId: string): number
    }
    /** 为已认证设备创建进程内 Peer（官方 `connection.createPeer`）。 */
    admit: (request: IncomingMessage, device: { deviceId: string; role: string }) =>
      { peer: unknown; release: () => Promise<void> } | { rejection: unknown }
  }
}

/**
 * 配置存取（config 路由依赖；由 plugin.ts 提供，测试可注入桩）。
 * 可写白名单由实现负责约束——guard 只做信封与鉴权。
 */
export interface ConfigStore {
  /** 只读快照（供页面展示的可展示子集）。 */
  get(): Promise<Record<string, unknown>>
  /** 白名单子集写入；越界字段抛错（→ 400）。 */
  patch(input: Record<string, unknown>): Promise<Record<string, unknown>>
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

/**
 * 单控策略：把除 `keepDeviceId` 之外的设备**踢下线**（断开连接）。
 *
 * **不吊销配对**（2026-11-12 修订）。旧实现调用 `tokens.revoke()`，会把
 * `revokedAt` 写进设备表 —— 被挤掉的设备从此失效，须重新扫码配对。
 * 用户要求的是「踢连接不删配对」：
 *
 * - 令牌保留 → 被挤设备仍是「已配对」，可以再次连上；
 * - 只标记 `displacedAt` → UI 能显示「已配对（离线）」而不是「配对失效」；
 * - 立即丢弃 Peer 与在途流 → 连接确实断开了。
 *
 * @param deps - 守卫依赖（设备表 + 令牌服务 + 断连回调）。
 * @param keepDeviceId - 保留（新配对）的设备。
 * @returns 被挤下线的 deviceId 列表（审计用）。
 */
async function displaceOthers(deps: GuardDeps, keepDeviceId: string): Promise<string[]> {
  const displaced: string[] = []
  for (const device of deps.devices.list()) {
    if (device.deviceId === keepDeviceId) continue
    if (device.revokedAt !== null) continue
    // 只标记「被挤下线」，不动令牌。
    try {
      await deps.devices.update(device.deviceId, { displacedAt: new Date().toISOString() })
    } catch (error) {
      // 更新失败不阻断连接断开，但必须留痕（否则「已踢下线」无从判断）。
      deps.audit?.('displace-mark-failed', {
        deviceId: device.deviceId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    displaced.push(device.deviceId)
  }
  return displaced
}

/** 构造官方 `server-response` 失败信封。 */function rpcFailureBody(rpcId: string, error: GuardError): string {
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
 * 每设备并发信号量（路线 A：官方 GUI 峰值 12+ 并发，超限 429 + Retry-After）。
 * 计数不释放即泄漏，所以 acquire/release 必须成对（rpc 分支 finally）。
 */
class DeviceSemaphore {
  private readonly counts = new Map<string, number>()

  constructor(private readonly limit: number) {}

  /** @returns true 表示允许，false 表示该设备已到并发上限。 */
  tryAcquire(deviceId: string): boolean {
    const current = this.counts.get(deviceId) ?? 0
    if (current >= this.limit) return false
    this.counts.set(deviceId, current + 1)
    return true
  }

  release(deviceId: string): void {
    const current = this.counts.get(deviceId) ?? 0
    if (current <= 1) this.counts.delete(deviceId)
    else this.counts.set(deviceId, current - 1)
  }
}

/**
 * 本机主用 LAN IPv4（私有段、非内部）。
 *
 * 只用于「对外公布哪个地址」——配对链接与页面提示。绑定地址本身仍由配置决定，
 * 这里不参与任何安全判定。
 * @returns 首选私有 IPv4，或 undefined（无可用网卡）。
 */
export function primaryLanAddress(): string | undefined {
  try {
    for (const infos of Object.values(networkInterfaces())) {
      for (const info of infos ?? []) {
        if (info.family !== 'IPv4' || info.internal) continue
        if (!isPrivateAddress(info.address)) continue
        return info.address
      }
    }
  } catch {
    // 读网卡失败不能影响守卫启动。
  }
  return undefined
}

/**
 * 启动守卫。
 *
 * 端口被占（EADDRINUSE）时抛错。**装配层已先做顺延探测**（`resolveGuardPort`）：
 * 首选端口不可用时自动 +1 找到空闲端口再传进来，所以这里正常不会因占用失败。
 * 若仍失败（探测与 bind 之间的竞态），抛错即插件加载失败——不在此静默换端口。
 * @param deps - 依赖。
 * @returns `GuardHandle`。
 */
export async function startGuard(deps: GuardDeps): Promise<GuardHandle> {
  const config = deps.config
  assertBindableHost(config.guardHost, config.network)
  const protocolHeader = String(PROTOCOL_VERSION)
  // 进程内随机，只注入本机 index 页。隧道拿不到它，所以即便隧道在本机终止、
  // socket 地址恒为回环、且伪造了 Host 头，也过不了签发端（§9.3 第 1 条的补强）。
  const pairIssueToken = deps.pairIssueToken ?? randomBytes(32).toString('base64url')
  const limiter = new RedeemLimiter(LIMITS.pairRedeemPerMinute)
  const rpcSlots = new DeviceSemaphore(LIMITS.maxInflightRequestsPerDevice)
  const protocol = 'http:' as const
  const sockets = new Set<import('node:net').Socket>()

  const toFenceRequest = (req: IncomingMessage): FenceRequest => ({
    headers: req.headers as Record<string, string | string[] | undefined>,
  })

  /**
   * 本机页面（回环 origin，任意端口）的 CORS 宣告。
   *
   * 为什么需要：页面在 `127.0.0.1:<webPort>`、守卫在 `127.0.0.1:<guardPort>`，
   * 端口不同即跨源；浏览器的 fetch 会先发 `OPTIONS` 预检，且真实响应必须带
   * `Access-Control-Allow-Origin` 才能被 JS 读取。**只对回环 origin 宣告**，
   * 其它 origin 不加任何 CORS 头（浏览器侧即被拒）。
   * @param req - 入站请求。
   * @param res - 响应。
   * @returns 是否为被认可的回环 origin。
   */
  const applyLoopbackCors = (req: IncomingMessage, res: ServerResponse): boolean => {
    const origin = req.headers.origin
    if (typeof origin !== 'string' || origin === '' || origin === 'null') return false
    let allowed = false
    try {
      const url = new URL(origin)
      allowed = (url.protocol === 'http:' || url.protocol === 'https:')
        && isLoopbackHostname(url.hostname)
    } catch {
      allowed = false
    }
    if (!allowed) return false
    res.setHeader('access-control-allow-origin', origin)
    res.setHeader('vary', 'Origin')
    return true
  }

  /**
   * 处理 CORS 预检（`OPTIONS`）。
   *
   * 预检**不携带**自定义头（`x-hub-protocol` / `x-pair-issue-token` / `Authorization`），
   * 所以它必须排在 ② 版本头检查之前，否则浏览器只会看到 400 而永远发不出真实请求
   * （2026-11-11 实机现象）。这里只对回环 origin 回应 CORS 宣告。
   * @returns `true` 表示已响应（调用方直接 return）。
   */
  const handlePreflight = (req: IncomingMessage, res: ServerResponse, rpcId: string): boolean => {
    if ((req.method ?? '').toUpperCase() !== 'OPTIONS') return false
    if (!applyLoopbackCors(req, res)) {
      reject(res, rpcId, failure(ERROR_CODES.notFound, 404, 'not found'))
      return true
    }
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, OPTIONS')
    const requested = req.headers['access-control-request-headers']
    // 回显浏览器请求的头列表（仅对已认可的回环 origin，无信息泄露面）。
    res.setHeader(
      'access-control-allow-headers',
      typeof requested === 'string' && requested.trim() !== ''
        ? requested
        : `${AUTH_HEADER}, ${HUB_PROTOCOL_HEADER}, ${PAIR_ISSUE_HEADER}, content-type`,
    )
    res.setHeader('access-control-max-age', '600')
    res.writeHead(204)
    res.end()
    return true
  }

  /** 管理端点（回环 + pairIssueToken 双条件）：允许回环跨端口 Origin。 */
  const ADMIN_ROUTE_SET: ReadonlySet<string> = new Set([
    GUARD_ROUTES.devices,
    GUARD_ROUTES.devicesRevoke,
    GUARD_ROUTES.stats,
    GUARD_ROUTES.config,
    GUARD_ROUTES.pairTicket,
    GUARD_ROUTES.pairCode,
  ])

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

      // ①.5 CORS 预检（必须在版本头检查之前：预检不携带自定义头）。
      if (handlePreflight(req, res, rpcId)) return

      // 其它真实请求：回环 origin 需要 CORS 宣告，浏览器才能读取响应。
      applyLoopbackCors(req, res)

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
        allowPrivate: config.network === 'lan',
        // 本机管理端点：web 页面与守卫同主机不同端口，Origin authority 天然不等。
        allowLoopbackCrossPortOrigin: ADMIN_ROUTE_SET.has(path),
        // 跨机接管：主控端页面的 origin 必须被显式放行（默认空 = fail-closed）。
        allowedOrigins: config.allowedOrigins,
        // lan 模式：自动放行来自私有地址的 Origin（主控端页面在对端机器上，
        // origin 是对端的 DSH web 地址，不可能预先枚举）。
        allowPrivateOrigin: config.network === 'lan',
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
        deps.metrics?.countPairIssued()
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
          deps.metrics?.countPairRejected()
          reject(res, rpcId, failure(result.code, status, 'pairing credential rejected'))
          return
        }
        deps.metrics?.countPairRedeemed()
        audit('pair-redeemed', { deviceId: result.issued.deviceId, role: result.issued.role, path: ticket !== undefined ? 'qr' : 'code' })
        // 单控策略：新设备接管时把**其它设备踢下线**（断开连接），但保留它们的配对。
        // 令牌不失效 → 被挤设备仍是「已配对」，可再次连接（2026-11-12 修订）。
        let displacedForNotice: { deviceId: string; label: string }[] = []
        if (config.singleController) {
          const displaced = await displaceOthers(deps, result.issued.deviceId)
          if (displaced.length > 0) {
            audit('single-controller-displaced', { keep: result.issued.deviceId, displaced })
            // 记下名字供 UI 弹窗；同时立即断开它们的连接（Peer 与在途流）。
            const byId = new Map(deps.devices.list().map(device => [device.deviceId, device.label]))
            displacedForNotice = displaced.map(deviceId => ({
              deviceId,
              label: byId.get(deviceId) ?? deviceId,
            }))
            for (const deviceId of displaced) {
              try { deps.onSessionDisplaced?.(deviceId) } catch { /* 忽略 */ }
            }
          }
        }
        sendJson(res, 200, {
          ...result.issued,
          ...(displacedForNotice.length > 0 ? { displacedDevices: displacedForNotice } : {}),
        }, protocolHeader)
        return
      }

      // ── 设备管理（只作用于本机页面：回环 + 进程内令牌，双条件）──────────
      if (path === GUARD_ROUTES.devices || path === GUARD_ROUTES.devicesRevoke) {
        const loop = checkLoopback(req)
        if (!loop.ok) {
          audit('device-admin-rejected', { path, reason: loop.reason })
          reject(res, rpcId, failure(ERROR_CODES.forbidden, 403, 'device admin is loopback-only'))
          return
        }
        if (req.headers[PAIR_ISSUE_HEADER] !== pairIssueToken) {
          audit('device-admin-rejected', { path, reason: 'missing pairIssueToken' })
          reject(res, rpcId, failure(ERROR_CODES.forbidden, 403, 'device admin is loopback-only'))
          return
        }

        if (path === GUARD_ROUTES.devices) {
          if (method !== 'GET') {
            reject(res, rpcId, failure(ERROR_CODES.notFound, 404, 'not found'))
            return
          }
          const rows = deps.devices.list().map(device => ({
            deviceId: device.deviceId,
            label: device.label,
            role: device.role,
            createdAt: device.createdAt,
            lastSeenAt: device.lastSeenAt,
            revokedAt: device.revokedAt,
            // 被单控挤下线（仍保留配对）——UI 据此区分「已配对」与「配对失效」。
            displacedAt: device.displacedAt ?? null,
          }))
          sendJson(res, 200, {
            ok: true,
            protocolVersion: PROTOCOL_VERSION,
            guard: {
              host: config.guardHost,
              port,
              // 对外可用地址（LAN 模式是 LAN IP），页面用它生成配对二维码。
              origin: advertisedOrigin,
              // 本机页面做签发/设备管理必须用这个（签发端要求回环对端）。
              loopbackOrigin,
              network: config.network,
            },
            singleController: config.singleController,
            // 单控模式下「正在控制的那台」= 唯一未吊销设备。
            devices: rows,
          }, protocolHeader)
          return
        }

        // revoke：{ deviceId } 或 { all: true }
        if (method !== 'POST') {
          reject(res, rpcId, failure(ERROR_CODES.notFound, 404, 'not found'))
          return
        }
        const body = await readBody(req, 64 * 1024)
        const parsed = body === null ? undefined : parseJson(body.toString('utf8'))
        if (!isPlainObject(parsed)) {
          reject(res, rpcId, failure(ERROR_CODES.badRequest, 400, 'invalid body'))
          return
        }
        const all = parsed.all === true
        const deviceId = typeof parsed.deviceId === 'string' ? parsed.deviceId : undefined
        if (!all && (deviceId === undefined || deviceId === '')) {
          reject(res, rpcId, failure(ERROR_CODES.badRequest, 400, 'provide deviceId or all:true'))
          return
        }
        const targets = all
          ? deps.devices.list().filter(device => device.revokedAt === null).map(device => device.deviceId)
          : [deviceId as string]
        const revoked: string[] = []
        for (const target of targets) {
          const record = deps.devices.get(target)
          if (record === undefined || record.revokedAt !== null) continue
          await deps.tokens.revoke(target)
          revoked.push(target)
        }
        audit('device-admin-revoked', { revoked, mode: all ? 'all' : 'single' })
        sendJson(res, 200, { ok: true, revoked }, protocolHeader)
        return
      }

      // ── 运行指标 + 配置（与设备管理同防护：双条件回环）──────────────────
      if (path === GUARD_ROUTES.stats || path === GUARD_ROUTES.config) {
        const loop = checkLoopback(req)
        if (!loop.ok) {
          audit('device-admin-rejected', { path, reason: loop.reason })
          reject(res, rpcId, failure(ERROR_CODES.forbidden, 403, 'stats/config is loopback-only'))
          return
        }
        if (req.headers[PAIR_ISSUE_HEADER] !== pairIssueToken) {
          audit('device-admin-rejected', { path, reason: 'missing pairIssueToken' })
          reject(res, rpcId, failure(ERROR_CODES.forbidden, 403, 'stats/config is loopback-only'))
          return
        }

        if (path === GUARD_ROUTES.stats) {
          if (method !== 'GET') {
            reject(res, rpcId, failure(ERROR_CODES.notFound, 404, 'not found'))
            return
          }
          if (deps.metrics === undefined) {
            reject(res, rpcId, failure(ERROR_CODES.notFound, 404, 'metrics unavailable'))
            return
          }
          const snapshot: HubMetrics = deps.metrics.snapshot()
          sendJson(res, 200, { ok: true, ...snapshot }, protocolHeader)
          return
        }

        // config：GET 快照 / PUT 白名单子集
        if (deps.configStore === undefined) {
          reject(res, rpcId, failure(ERROR_CODES.notFound, 404, 'config store unavailable'))
          return
        }
        if (method === 'GET') {
          sendJson(res, 200, { ok: true, config: await deps.configStore.get() }, protocolHeader)
          return
        }
        if (method !== 'PUT') {
          reject(res, rpcId, failure(ERROR_CODES.notFound, 404, 'not found'))
          return
        }
        const body = await readBody(req, 64 * 1024)
        const parsed = body === null ? undefined : parseJson(body.toString('utf8'))
        if (!isPlainObject(parsed)) {
          reject(res, rpcId, failure(ERROR_CODES.badRequest, 400, 'invalid body'))
          return
        }
        try {
          const config = await deps.configStore.patch(parsed)
          audit('config-patched', { keys: Object.keys(parsed) })
          sendJson(res, 200, { ok: true, config }, protocolHeader)
        } catch (error) {
          reject(res, rpcId, failure(
            ERROR_CODES.badRequest,
            400,
            error instanceof Error ? error.message : 'config patch rejected',
          ))
        }
        return
      }

      // ── rpc：Bearer → 设备→Peer → 官方信封 → sharedFetch ────────────────
      if (path === GUARD_ROUTES.rpc) {
        if (method !== 'POST') {
          reject(res, rpcId, failure(ERROR_CODES.notFound, 404, 'not found'))
          return
        }
        // 局域网模式的对端判定：即使有人把端口直接映射到公网，非私网来源一律拒。
        // 隧道模式（network=loopback + publicAuthorities）不受影响。
        if (config.network === 'lan') {
          const peerCheck = checkPrivatePeer(req.socket.remoteAddress)
          if (!peerCheck.ok) {
            audit('peer-rejected', { path, reason: peerCheck.reason })
            reject(res, rpcId, failure(ERROR_CODES.forbidden, 403, 'source address is not on a private network'))
            return
          }
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
          deps.metrics?.countAuthDenied()
          reject(res, rpcId, failure(ERROR_CODES.unauthorized, 401, 'invalid or revoked token'))
          return
        }
        deps.metrics?.countAuthAccepted()
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
        // 并发预算（路线 A Task 7）：官方 GUI 峰值 12+，超限 429 + Retry-After
        // 让 client 的重试退避而不是打爆 sharedFetch。
        if (!rpcSlots.tryAcquire(identity.deviceId)) {
          reject(res, rpcId, failure(ERROR_CODES.rateLimited, 429, 'device concurrency budget exhausted'))
          res.setHeader('retry-after', '1')
          return
        }
        try {
          const peer = deps.dispatcher.peerFor(identity.deviceId, identity.role)
          // **转发完整信封**（含 type/rpcId/method/payload）：Gateway 的 zod 会再
          // 校验一次外层字段，只传 payload 会得到 `invalid client-request message`。
          const response = await deps.dispatcher.fetch(endpoint, envelope, peer)
          // 越权尝试是**最有价值**的审计信号；只读 status，不读 body（body 可能含业务数据）。
          if (response.status === 403) {
            audit('access-denied', { deviceId: identity.deviceId, action: endpoint })
          }
          await writeFetchResponse(res, response, protocolHeader)
        } finally {
          rpcSlots.release(identity.deviceId)
        }
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
  const loopbackOrigin = `${protocol}//127.0.0.1:${port}`
  // LAN 模式对外公布 LAN IP（绑定 0.0.0.0 时 127.0.0.1 对其他设备不可达）。
  const advertisedHost = config.network === 'lan'
    ? (primaryLanAddress() ?? '127.0.0.1')
    : '127.0.0.1'
  const advertisedOrigin = `${protocol}//${advertisedHost}:${port}`

  // 整机接管的 WebSocket 端点（架构说明 §10.9 / A3）：仅在调用方给出 ws 依赖时挂载。
  // 守卫只做「令牌校验 + admitConnection 认领」，mux 由 guard-mux.ts 承载
  // （其内部把帧翻译成 typertGateway.wireStream.open 调用）。
  let wsDispose: (() => void) | undefined
  if (deps.ws !== undefined) {
    const { route } = createGuardWsRoute({
      authenticate: async (token: string) => {
        try {
          const verdict = await deps.tokens.verify(token)
          return verdict === null ? null : { deviceId: verdict.deviceId, role: verdict.role }
        } catch {
          return null
        }
      },
      onEvent: event => {
        // 只记结局与设备，**不记令牌**。
        deps.audit?.('ws-tunnel', { ...event })
      },
      handoff: ({ request, socket, head, deviceId, role }) => {
        const admission = deps.ws!.admit(request, { deviceId, role })
        if ('rejection' in admission) {
          console.warn(
            `[dsh-remote-hub] ws: admit rejected (${JSON.stringify(admission.rejection)})`,
          )
          try { socket.destroy() } catch { /* 已关闭 */ }
          return
        }
        // release 在 socket 关闭后调用，释放 API socket 所有权。
        socket.once('close', () => { void admission.release() })
        socket.once('error', () => { void admission.release() })
        deps.audit?.('ws-admitted', { deviceId })
        deps.ws!.mux.accept(request, socket, head, admission.peer, deviceId)
      },
    })
    // 把 route 挂到守卫自己的 http server 上（守卫是独立监听）。
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      let pathname: string
      try {
        pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      } catch {
        return
      }
      if (pathname !== route.path) return
      route.handler(request, socket, head)
    })
    wsDispose = () => { void deps.ws!.mux.close() }
  }

  return {
    origin: advertisedOrigin,
    loopbackOrigin,
    port,
    pairIssueToken,
    async dispose() {
      wsDispose?.()
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
