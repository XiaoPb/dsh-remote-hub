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
  /**
   * 局域网信任域：为 true 时额外放行**私有地址** authority（RFC1918 / 链路本地 /
   * IPv6 ULA）。公网地址**永不**因为这一项被放行 —— 公网访问只能经隧道
   * （`publicAuthorities` 显式声明）或 VPN（届时来源是私网地址）。
   */
  allowPrivate?: boolean
  /**
   * 允许「回环主机、不同端口」的 Origin（仅用于本机管理端点）。
   *
   * 本机页面由 DSH web 在 `127.0.0.1:<webPort>` 提供，守卫在
   * `127.0.0.1:<guardPort>` —— 同主机不同端口在浏览器眼里是**跨源**，
   * 因此真实请求的 `Origin` authority 永远不等于 `Host` authority。
   * 这些端点另有「socket 回环 + 进程内 pairIssueToken」双条件，Origin 只作为
   * 额外的 CSRF 防护，所以对回环 origin 放宽端口是安全的；**非回环 origin 不放宽**。
   */
  allowLoopbackCrossPortOrigin?: boolean
  /**
   * 额外放行的**完整 origin**（`scheme://authority`，例如
   * `http://127.0.0.1:3091`）。
   *
   * ## 为什么需要它（2026-11-12 两机实测）
   *
   * 跨机接管时，主控端页面跑在自己的机器上（例如沙箱的
   * `http://127.0.0.1:3091`），而守卫在**另一台**机器的
   * `http://192.168.0.17:8443`。浏览器发的 `Origin` 是主控端页面的 origin，
   * 与守卫的 `Host` authority 天然不等 —— 即使 `network: 'lan'` 放行了私有
   * 地址 authority，`Origin` 与 `Host` 的**同源判定**仍会失败，于是所有 RPC
   * 都得到 `403 source not allowed`（实测：会话创建 / 模型列表 / 权限目录 /
   * 目录选择器全部 403）。
   *
   * 这是**显式**放行：只有被管理员写进配置的 origin 才通过，默认仍是空数组
   * （fail-closed）。真正的身份校验仍由设备令牌承担，围栏只防 CSRF 与
   * 跨站页面盗用。
   */
  allowedOrigins?: readonly string[]
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
 * 私有地址判定（与 `config.isPrivateAddress` 同判据；本文件保持零依赖，
 * 因为它要被测试单独注入）。
 * @param address - 裸 IP 字面量（可带方括号）。
 * @returns RFC1918 / 链路本地 / IPv6 ULA 时为 true。
 */
export function isPrivateHostname(address: string): boolean {
  const value = address.trim().toLowerCase().replace(/^\[|\]$/gu, '')
  if (value === '::1' || value === 'localhost') return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(value)
  if (v4 !== null) {
    const parts = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])]
    if (parts.some(part => part > 255)) return false
    const [a, b] = [parts[0]!, parts[1]!]
    if (a === 127 || a === 10) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 169 && b === 254) return true
    return false
  }
  if (/^f[cd][0-9a-f]{2}:/u.test(value)) return true // ULA fc00::/7
  if (/^fe[89ab][0-9a-f]:/u.test(value)) return true // 链路本地 fe80::/10
  return false
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
  // 局域网模式：私有地址 authority 放行（公网地址仍必须显式声明 publicAuthorities）。
  const privateAllowed = options.allowPrivate === true && isPrivateHostname(hostname)
  if (!loopback && !privateAllowed && !declared) return { ok: false, reason: 'Host is not allowed' }

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
    const sameAuthority = originHost !== undefined && originHost === host
    // 本机管理端点：允许「同回环主机、不同端口」（web 页面 ↔ 守卫）。
    const loopbackCrossPort = options.allowLoopbackCrossPortOrigin === true
      && isLoopbackHostname(originUrl.hostname)
      && isLoopbackHostname(hostname)
    // 显式白名单：跨机接管时主控端页面的 origin（见 SourceOptions.allowedOrigins）。
    // 按 canonical `scheme://authority` 精确比较，不做前缀/通配匹配。
    const explicitlyAllowed = (options.allowedOrigins ?? []).some((entry) => {
      const canonicalEntry = canonicalOrigin(entry)
      const canonicalOriginValue = canonicalOrigin(origin)
      return canonicalEntry !== undefined && canonicalEntry === canonicalOriginValue
    })
    if (!sameAuthority && !loopbackCrossPort && !explicitlyAllowed) {
      return { ok: false, reason: 'Origin does not match Host authority' }
    }
  }
  return { ok: true }
}

/**
 * 把 `scheme://host[:port]` 规范化成可精确比较的形式。
 *
 * 只用 `http:` / `https:`；其余 scheme 返回 undefined（**不**放行）。
 * 端口会被规范成显式形式（`https:` 的 443、`http:` 的 80 视为默认端口）。
 * @param value - 原始 origin 字符串。
 * @returns 规范化后的 `scheme://authority`，或 undefined。
 */
export function canonicalOrigin(value: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return undefined
  }
  const scheme = parsed.protocol
  if (scheme !== 'http:' && scheme !== 'https:') return undefined
  if (parsed.username !== '' || parsed.password !== '') return undefined
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') return undefined
  const host = parsed.hostname.toLowerCase()
  const port = parsed.port === '' ? (scheme === 'https:' ? '443' : '80') : parsed.port
  return `${scheme}//${host}:${port}`
}

/**
 * 局域网模式的对端判定：socket peer 必须是回环或**私有**地址。
 *
 * 这是「公网必须走隧道/VPN」的最后一道防线：即使有人把本机端口直接映射到
 * 公网（家宽端口转发），来自公网的对端地址也不在私网段，请求会被 403 拒绝。
 * @param remoteAddress - `req.socket.remoteAddress`（可能是 `::ffff:a.b.c.d`）。
 * @returns 通过或带原因的拒绝（原因只进日志）。
 */
export function checkPrivatePeer(remoteAddress: string | undefined): { ok: true } | { ok: false; reason: string } {
  if (typeof remoteAddress !== 'string' || remoteAddress === '') {
    return { ok: false, reason: 'socket peer is unknown' }
  }
  const normalized = remoteAddress.replace(/^::ffff:/u, '')
  if (!isPrivateHostname(normalized)) return { ok: false, reason: 'socket peer is not private' }
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
