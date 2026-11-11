/**
 * 守卫自己的来源围栏（D-9）与签发端双条件回环门控（D-15）。
 *
 * ⚠️ **这是同语义的独立实现，不是引用官方函数**：`isTrustedApiRequest` 只在
 * `packages/client/connection/src/api-request-trust.ts` 内部导出，**没有从包根
 * re-export**，而发布产物里不含 `./src/*`。所以本文件照它的判据重写一遍。
 * **升级 DSH 时必须重核这里**（写进 ROADMAP §6.3 的升级检查清单）。
 *
 * 三段（与 `api-request-trust.ts:121-151` 逐条对齐）：
 * 1. `Host` ∈ {回环字面量} ∪ `publicAuthorities`（显式声明、canonical 校验）
 * 2. `Sec-Fetch-Site: cross-site` 一律拒
 * 3. 有 `Origin` 时必须与 `Host` 同 authority；`Origin: null` 拒
 *
 * **绝不采信任何转发头**：`x-forwarded-for` / `true-client-ip` /
 * `cf-connecting-ip` 只能进日志与限流辅助，绝不参与身份或来源判定。DSH 自己全仓
 * 不读 `x-forwarded-*`，Cloudflare 也官方承认 `True-Client-IP` 可伪造。
 * 本文件连读都不读它们 —— 加了这些头不改变任何判定（验收脚本逐条断言）。
 *
 * 另外：守卫**不能**复用 `ctx.connection.requestRejection()` / `admit()` 来省事，
 * 因为它们用的是 DSH 自己的 `trustedHosts` 与 `webServer` 绑定地址，不是我们的
 * `publicAuthorities`。
 *
 * @module dsh-remote-hub/host/fence
 */
import type { IncomingMessage } from 'node:http'

/** 与 `Config.publicAuthorities` 对齐的选项。 */
export interface SourceOptions {
  /** 隧道公开 authority 白名单（`host[:port]`，canonical）。 */
  publicAuthorities: readonly string[]
  /** 监听器协议；决定默认端口如何规范化。默认 `'http:'`。 */
  protocol?: 'http:' | 'https:'
}

export type SourceVerdict =
  | { ok: true }
  | {
    ok: false
    /** 仅进日志，绝不回显给调用方（避免成为探测器）。 */
    reason: string
  }

/** 同为 200/403 判定的最小化请求形状（便于单测注入，不依赖真实 socket）。 */
export interface FenceRequest {
  headers: Record<string, string | string[] | undefined>
  /** 仅 `checkLoopback` 使用：socket 数值地址。 */
  remoteAddress?: string
}

function header(req: FenceRequest, name: string): string | undefined {
  const value = req.headers[name]
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value[0]
  return undefined
}

/** 回环 hostname：官方 helper 的判据（`localhost` / `[::1]` / `127/8`）。 */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}

/**
 * 一个裸 authority 的 canonical 形式（`hostname` 或 `hostname:port`）。
 * 与官方 `assertTrustedAuthority` 同语义：必须能在 http/https 两个 special scheme
 * 下原样解析，拒绝路径、账号、百分号编码、非括号 IPv6、前导零端口、悬空冒号。
 * @returns canonical 文本，或 `undefined`（不合格）。
 */
export function canonicalAuthority(entry: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(`http://${entry}`)
  } catch {
    return undefined
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/' || parsed.search !== '') {
    return undefined
  }
  const port = parsed.port !== '' ? parsed.port : new URL(`https://${entry}`).port
  const canonical = port === '' ? parsed.hostname : `${parsed.hostname}:${port}`
  return canonical === entry.toLowerCase() ? canonical : undefined
}

/** 从 Host 头解析出 canonical authority。 */
function authorityOf(host: string, protocol: 'http:' | 'https:'): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(`${protocol}//${host}`)
  } catch {
    return undefined
  }
  // 与官方一致的端口判据：在两个 scheme 下都看一次，显式 :80 / :443 都算显式。
  const other = protocol === 'http:' ? 'https:' : 'http:'
  const otherPort = (() => {
    try { return new URL(`${other}//${host}`).port } catch { return '' }
  })()
  const port = parsed.port !== '' ? parsed.port : otherPort
  return port === '' ? parsed.hostname : `${parsed.hostname}:${port}`
}

/**
 * 三段来源围栏。
 *
 * @returns `{ ok: true }` 或 `{ ok: false, reason }`；守卫把后者映射成 403。
 */
export function checkSource(req: FenceRequest, options: SourceOptions): SourceVerdict {
  const protocol = options.protocol ?? 'http:'
  const rawHost = header(req, 'host')
  if (rawHost === undefined) return { ok: false, reason: 'missing Host' }

  const canonical = canonicalAuthority(rawHost)
  const host = authorityOf(rawHost, protocol)
  if (canonical === undefined || host === undefined) {
    return { ok: false, reason: 'Host is not a bare authority' }
  }
  const hostname = host.split(':')[0] ?? ''
  const loopback = isLoopbackHostname(hostname)
  const declared = options.publicAuthorities.some(entry => canonicalAuthority(entry) === canonical)
  if (!loopback && !declared) return { ok: false, reason: 'Host is not allowed' }

  // ② 跨站标记一律拒（无论 Origin 是否存在）。
  if (header(req, 'sec-fetch-site') === 'cross-site') {
    return { ok: false, reason: 'cross-site request' }
  }

  // ③ Origin 存在时必须与 Host 同 authority；`null` 是不透明 origin，拒。
  const origin = header(req, 'origin')
  if (origin !== undefined) {
    if (origin === 'null') return { ok: false, reason: 'opaque Origin' }
    let originUrl: URL
    try {
      originUrl = new URL(origin)
    } catch {
      return { ok: false, reason: 'unparsable Origin' }
    }
    const scheme = originUrl.protocol === 'https:' ? 'https:'
      : originUrl.protocol === 'http:' ? 'http:' : undefined
    if (scheme === undefined) return { ok: false, reason: 'Origin scheme is not http(s)' }
    const originHost = authorityOf(originUrl.host, scheme)
    if (originHost === undefined || originHost !== host) {
      return { ok: false, reason: 'Origin does not match Host authority' }
    }
  }
  return { ok: true }
}

/**
 * 签发端**双条件**回环门控（红线 R4）：
 * ① socket 数值地址是回环；② `Host` 头是回环字面量。
 *
 * 只施加在 `GUARD_ROUTES.pairTicket` / `pairCode` 两个**签发**端点。
 * **绝不**施加在 `GUARD_ROUTES.pair`（兑换）—— 远程设备在隧道外，加了就永远
 * 配不上（v0.1 的 C1 结论，D-15 保留）。
 *
 * 注意：隧道在本机终止时 `socket.remoteAddress` 恒为 `127.0.0.1`，所以单靠 ①
 * 可以被经隧道发来的 `Host: 127.0.0.1` 骗过。② 堵掉这一半；守卫另外还要求
 * 进程内 `pairIssueToken`（见 `guard.ts`），三重防线合起来才成立。
 *
 * @param req - `IncomingMessage`（或带 `remoteAddress` / `headers` 的最小形状）。
 * @returns 通过或带原因的拒绝（原因只进日志）。
 */
export function checkLoopback(req: IncomingMessage | FenceRequest): { ok: true } | { ok: false; reason: string } {
  const incoming = req as IncomingMessage
  const socketAddress = (req as FenceRequest).remoteAddress ?? incoming.socket?.remoteAddress
  const normalized = typeof socketAddress === 'string' ? socketAddress.replace(/^::ffff:/u, '') : undefined
  const numericLoopback = normalized !== undefined
    && (normalized === '::1' || isLoopbackHostname(normalized))
  if (!numericLoopback) return { ok: false, reason: 'socket peer is not loopback' }

  const rawHost = header(req as FenceRequest, 'host')
  if (rawHost === undefined) return { ok: false, reason: 'missing Host' }
  let hostname: string
  try {
    hostname = new URL(`http://${rawHost}`).hostname
  } catch {
    return { ok: false, reason: 'Host is not a bare authority' }
  }
  // 这里要求的是**回环字面量**，`localhost` 是名字不是字面量，不算。
  if (!/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(hostname) && hostname !== '[::1]') {
    return { ok: false, reason: 'Host header is not a loopback literal' }
  }
  return { ok: true }
}
