/**
 * Host configuration (schemastery `Config`, so it can be registered under the
 * `settings` service and persisted per profile like every other DSH plugin).
 *
 * 两条加载期硬校验（fail loud，**不**留到运行期才发现）：
 * 1. `guardHost` **必须**是回环字面量（`127.0.0.0/8`、`::1`、`localhost` 不算字面量）。
 *    判据与 DSH 自己的 `WebServer` 一致：绑通配地址是安全事故，不是配置项。
 * 2. `publicAuthorities` 的每一项必须是 **裸 authority**（`host` 或 `host:port`），
 *    且经 WHATWG 解析后原样不变。带路径、账号、百分号编码、非括号 IPv6、
 *    前导零端口一律在加载期抛错 —— 它们是「本以为是精确授权，实际放宽到所有端口」
 *    这类事故的来源。
 *
 * @module dsh-remote-hub/host/config
 */
import { isIP } from 'node:net'

import z from '@deepseek-ai/schemastery'

import { LIMITS, PAIRING, STREAM_BUDGET } from '@core/protocol.js'
import { ROLE_CONTROL, ROLE_FULL, ROLE_READ_ONLY, isRoleName, type RoleName } from '@core/roles.js'

/** 隧道配置。默认 `kind: 'none'` = 只有回环可达（零暴露）。 */
export interface TunnelConfig {
  kind: 'none' | 'cloudflared'
  /** 可执行文件名或路径；裸名字走 PATH。 */
  command?: string
  /** 透传给隧道二进制的额外 argv（**不含** `--url`，那个由我们生成并断言）。 */
  args?: string[]
  /** 崩溃后的重启策略。 */
  restart: 'never' | 'on-failure'
}

export interface Config {
  /** **必须**是回环字面量。绑 `0.0.0.0` 是安全事故。 */
  guardHost: string
  /** 守卫端口。被占用时抛错，**不**静默换端口（换端口会让隧道配置悬空）。 */
  guardPort: number
  /**
   * 隧道公开 authority 白名单（`host[:port]`，canonical 校验）。
   *
   * 空数组 = 只接受回环 `Host`；此时经隧道来的请求会被来源围栏拒 —— 这是正确的
   * fail-closed 默认值，也是接上隧道前必须先填这一项的原因（D-9）。
   */
  publicAuthorities: string[]
  /**
   * DSH 自己的 origin。**只用于静态资源透传（如有），不参与 API 派发。**
   * 一元调用不是「代理到 upstream」，而是守卫用 `peer` 身份在进程内走
   * `connection.createSharedFetchHandler('/api').fetch(request, peer)`。
   */
  upstreamUrl: string
  /** 操作者未指定时绑给新设备的角色。 */
  defaultRole: RoleName
  /** 设备表路径。只存 `sha256(token)`。 */
  deviceTablePath: string
  /** QR 票据 TTL（D-14：2 分钟）。 */
  pairQrTtlMs: number
  /** 短码 TTL（D-14：10 分钟）。 */
  pairCodeTtlMs: number
  /** 错误尝试预算；达预算即烧码/烧票据（成功同样 burn）。 */
  maxPairAttempts: number
  /** 长轮询单次持有上限（D-4）。 */
  streamHoldMs: number
  /** 单批最大帧数。 */
  streamBatchMax: number
  /** 批量聚合窗口。 */
  streamBatchWindowMs: number
  /** 客户端判超时的余量。 */
  streamPollSlackMs: number
  /** 服务端读超时兜底。 */
  streamReadTimeoutMs: number
  /** 无人轮询的流回收时长。 */
  streamIdleTtlMs: number
  /** 每设备并发流数。 */
  maxStreamsPerDevice: number
  /** 审批桥接等待远端应答的上限；超时按 `cancelled` 处理（不是 `unavailable`）。 */
  approvalBridgeTimeoutMs: number
  /** 是否把审批请求投给远端设备（安全评审否决时可整体关掉，见 ROADMAP M2 的 Plan B）。 */
  bridgeApprovals: boolean
  /** 隧道。 */
  tunnel: TunnelConfig
}

/**
 * 回环字面量判定。
 *
 * `localhost` **不算**：它是名字，解析结果取决于 `hosts` 文件与 DNS，绑它不是绑一个字面量。
 * @param host - 待判定的绑定地址。
 * @returns 是否为回环 IP 字面量。
 */
export function isLoopbackLiteral(host: string): boolean {
  if (host === '::1') return true
  if (isIP(host) !== 4) return false
  return host.startsWith('127.')
}

/**
 * 加载期断言：绑定地址必须是回环字面量。
 * @param host - 配置里的 `guardHost`。
 * @throws 当它不是回环 IP 字面量时，错误文本含 `loopback`。
 */
export function assertLoopbackLiteral(host: string): void {
  if (!isLoopbackLiteral(host)) {
    throw new Error(
      `dsh-remote-hub: guardHost ${JSON.stringify(host)} must be a loopback IP literal (127.0.0.0/8 or ::1); `
      + 'binding any other address exposes this machine without the device-token gate',
    )
  }
}

/**
 * 一个裸 authority 的 canonical 形式：`hostname`（无端口）或 `hostname:port`。
 *
 * 判据与 DSH 自己的 `assertTrustedAuthority` 同语义：必须能在 `http:` / `https:`
 * 两个 special scheme 下原样解析，且规范化后与原文（忽略大小写）相等。
 */
function canonicalAuthority(entry: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(`http://${entry}`)
  } catch {
    return undefined
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/' || parsed.search !== '') return undefined
  // 端口：`http:` 与 `https:` 的默认端口不同，所以在两个 scheme 下都看一次，
  // `:80` 与 `:443` 都算显式端口（与官方 helper 的判据一致）。
  const port = parsed.port !== ''
    ? parsed.port
    : new URL(`https://${entry}`).port
  const canonical = port === '' ? parsed.hostname : `${parsed.hostname}:${port}`
  return canonical === entry.toLowerCase() ? canonical : undefined
}

/**
 * 加载期断言：每个 `publicAuthorities` 项都是裸 authority。
 * @param entries - 配置里的数组。
 * @throws 指名第一个不合格的项。
 */
export function assertPublicAuthorities(entries: readonly string[]): void {
  for (const entry of entries) {
    if (canonicalAuthority(entry) === undefined) {
      throw new Error(
        `dsh-remote-hub: publicAuthorities entry ${JSON.stringify(entry)} is not a bare host[:port] authority `
        + '(no scheme, path, userinfo, percent-encoding, unbracketed IPv6 or zero-padded port)',
      )
    }
  }
}

/** 一条 authority（`host[:port]`）是否在我们的允许集合内（回环恒允许）。 */
export function isAllowedAuthority(authority: string, config: Pick<Config, 'publicAuthorities'>): boolean {
  const canonical = canonicalAuthority(authority)
  if (canonical === undefined) return false
  const hostname = canonical.split(':')[0] ?? ''
  if (isLoopbackLiteral(hostname) || hostname === '[::1]') return true
  return config.publicAuthorities.some(entry => canonicalAuthority(entry) === canonical)
}

export const Config: z<Config> = z.object({
  guardHost: z.string().default('127.0.0.1'),
  guardPort: z.number().min(1).max(65_535).default(8443),
  publicAuthorities: z.array(z.string()).default([]),
  upstreamUrl: z.string().default('http://127.0.0.1:3080'),
  defaultRole: z.union([z.const(ROLE_READ_ONLY), z.const(ROLE_CONTROL), z.const(ROLE_FULL)]).default(ROLE_CONTROL),
  deviceTablePath: z.string().default('~/.dsh/remote-hub/devices.json'),
  pairQrTtlMs: z.number().min(1_000).default(PAIRING.ticketTtlMs),
  pairCodeTtlMs: z.number().min(1_000).default(PAIRING.codeTtlMs),
  maxPairAttempts: z.number().min(1).max(100).default(PAIRING.maxAttempts),
  streamHoldMs: z.number().min(100).max(STREAM_BUDGET.readTimeoutMs).default(STREAM_BUDGET.holdMs),
  streamBatchMax: z.number().min(1).max(1_024).default(STREAM_BUDGET.batchMax),
  streamBatchWindowMs: z.number().min(0).max(1_000).default(STREAM_BUDGET.batchWindowMs),
  streamPollSlackMs: z.number().min(0).max(60_000).default(STREAM_BUDGET.pollSlackMs),
  streamReadTimeoutMs: z.number().min(1_000).default(STREAM_BUDGET.readTimeoutMs),
  streamIdleTtlMs: z.number().min(1_000).default(STREAM_BUDGET.idleTtlMs),
  maxStreamsPerDevice: z.number().min(1).max(64).default(LIMITS.maxStreamsPerDevice),
  approvalBridgeTimeoutMs: z.number().min(1_000).default(STREAM_BUDGET.readTimeoutMs),
  bridgeApprovals: z.boolean().default(true),
  tunnel: z.object({
    kind: z.union([z.const('none'), z.const('cloudflared')]).default('none'),
    command: z.string(),
    args: z.array(z.string()),
    restart: z.union([z.const('never'), z.const('on-failure')]).default('on-failure'),
  }),
})

/** 默认配置（`Config` 的 `.default()` 已经给出同一组值；此处是给测试与文档用的显式副本）。 */
export const DEFAULT_CONFIG: Config = {
  guardHost: '127.0.0.1',
  guardPort: 8443,
  publicAuthorities: [],
  upstreamUrl: 'http://127.0.0.1:3080',
  defaultRole: ROLE_CONTROL,
  deviceTablePath: '~/.dsh/remote-hub/devices.json',
  pairQrTtlMs: PAIRING.ticketTtlMs,
  pairCodeTtlMs: PAIRING.codeTtlMs,
  maxPairAttempts: PAIRING.maxAttempts,
  streamHoldMs: STREAM_BUDGET.holdMs,
  streamBatchMax: STREAM_BUDGET.batchMax,
  streamBatchWindowMs: STREAM_BUDGET.batchWindowMs,
  streamPollSlackMs: STREAM_BUDGET.pollSlackMs,
  streamReadTimeoutMs: STREAM_BUDGET.readTimeoutMs,
  streamIdleTtlMs: STREAM_BUDGET.idleTtlMs,
  maxStreamsPerDevice: LIMITS.maxStreamsPerDevice,
  approvalBridgeTimeoutMs: STREAM_BUDGET.readTimeoutMs,
  bridgeApprovals: true,
  tunnel: { kind: 'none', restart: 'on-failure' },
}

/**
 * 加载期校验一次完整配置：两条断言 + 两个语义约束。
 *
 * `streamHoldMs` 的上界是 `streamReadTimeoutMs`（超过它每轮必超时）；
 * `defaultRole` 必须是已知角色。两者都在这里抛，而不是等到第一次请求。
 * @param config - 已按 schema 解析的配置。
 * @throws 当任一约束不成立。
 */
export function validateConfig(config: Config): void {
  assertLoopbackLiteral(config.guardHost)
  assertPublicAuthorities(config.publicAuthorities)
  if (!isRoleName(config.defaultRole)) {
    throw new Error(`dsh-remote-hub: defaultRole ${JSON.stringify(config.defaultRole)} is not a known role`)
  }
  if (config.streamHoldMs > config.streamReadTimeoutMs) {
    throw new Error(
      `dsh-remote-hub: streamHoldMs (${config.streamHoldMs}) must not exceed streamReadTimeoutMs `
      + `(${config.streamReadTimeoutMs}); every poll would time out`,
    )
  }
  if (config.streamPollSlackMs + config.streamHoldMs > config.streamReadTimeoutMs) {
    throw new Error(
      'dsh-remote-hub: streamHoldMs + streamPollSlackMs must stay below streamReadTimeoutMs; '
      + 'otherwise a healthy poll is indistinguishable from a dead one',
    )
  }
  if (config.tunnel.kind !== 'none' && config.publicAuthorities.length === 0) {
    throw new Error(
      'dsh-remote-hub: tunnel is enabled but publicAuthorities is empty; every tunnelled request would be '
      + 'refused by the source fence — declare the public authority (host[:port]) the tunnel serves',
    )
  }
}
