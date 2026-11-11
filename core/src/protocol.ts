/**
 * Wire-level constants shared by every peer: the host half, the browser client
 * half, and (via the exported contract snapshot) the Android app.
 *
 * v0.2 口径（D-1）：本文件**只**持有四样东西 ——
 *   1. `GUARD_ROUTES`：守卫自己的 HTTP 路由（health / 配对签发×2 / 兑换 / 一元入口）；
 *   2. `HUB_METHODS`：本插件**自己**注册在 Typert Remote 上的 `hub/*` 方法名
 *      （设备管理 + 三条长轮询方法 + 审批应答）。它们走官方 `/api` 信封与官方
 *      `decide()`，不是自造的信封或自造的路由；
 *   3. `STREAM_BUDGET` / `LIMITS`：长轮询预算与资源上限（D-4 / §9.8）；
 *   4. `ERROR_CODES`：本插件自有错误码。**官方错误码原样透传，不包装**。
 *
 * 能力矩阵（哪个角色能调哪个官方 endpoint）不在本文件：它在
 * `core/src/capabilities.ts`，因为那张表是 host 的策略注册与 client/Android 的
 * UI 门控共同读取的**唯一真源**，体量与变更频率都与本文件不同。
 *
 * RULE: host 与 client 必须 import 这里的常量，禁止在本地重新声明一个路由、
 * 一个方法名或一个错误码。漂移的副本正是「桌面能跑、手机 403」这类事故的来源。
 *
 * @module @core/protocol
 */

/**
 * Bumped only on breaking wire changes.
 *
 * 消费者恰好两个：守卫自有面的 `X-Hub-Protocol` 头（三条 stream 方法 + 配对端点），
 * 以及本仓库导出的契约快照（`out/contract.json`，Android/Kotlin 镜像读它）。
 * 它**不是** DSH 版本 —— DSH 兼容性由 `package.json` 的 `engines.dsh` 约束；
 * 也**不是**设备表的磁盘版本（`DeviceTable.version` 独立演进）。
 */
export const PROTOCOL_VERSION = 1

/** 请求与响应都带的自有面版本头。不一致即 `protocol-version-mismatch`（400）。 */
export const HUB_PROTOCOL_HEADER = 'x-hub-protocol'

/** 设备令牌的承载头：只此一种，没有 `?token=` 回退（D-3：不再有 WS）。 */
export const AUTH_HEADER = 'authorization'

/** `Authorization` 方案前缀（大小写不敏感比较）。 */
export const BEARER_SCHEME = 'Bearer'

/**
 * 守卫自己的 HTTP 路由。**其余一律 404** —— 包括 `/api/*`：那不是守卫的路由，
 * 而是守卫以 `peer` 身份交给 DSH 自己的
 * `ctx.connection.createSharedFetchHandler('/api')` 的 RPC 面。
 *
 * 五条路由，一条不多：
 * - 流**不占路由**：三条 stream 方法是 `hub/*` Remote 方法，走 `rpc` 入口，
 *   因此同样过官方 `decide()`。给它们单开 HTTP 路由等于绕开 Gateway 的参数校验
 *   与访问判定（红线 R9）。
 */
export const GUARD_ROUTES = {
  /** 无鉴权的最小事实：`{ ok, protocolVersion }`。不回显设备数，不暴露其它配置。 */
  health: '/remote/health',
  /** 签发 QR 票据（32 字节随机，TTL 120s，单次）。**双条件回环门控**。 */
  pairTicket: '/remote/pair/ticket',
  /** 签发 8 位 Crockford 短码（40 bit，TTL 600s，5 次预算即烧）。**双条件回环门控**。 */
  pairCode: '/remote/pair/code',
  /** 兑换票据/短码。**故意不作回环门控**（远程设备在隧道外）。 */
  pair: '/remote/pair',
  /** 一元入口：Bearer 令牌 + 来源围栏 + 设备 → Peer → official `/api` 派发。 */
  rpc: '/remote/rpc',
} as const

export type GuardRouteName = keyof typeof GUARD_ROUTES
export type GuardRoutePath = (typeof GUARD_ROUTES)[GuardRouteName]

/**
 * 本插件自己的 Remote 方法名（namespace 固定 `hub`）。
 *
 * endpoint 形如 `hub/stream.next`；`ENDPOINT_SEGMENT_PATTERN` 允许段内 `.`，
 * 所以 `stream.next` 是一个合法的方法段。
 */
export const HUB_NAMESPACE = 'hub'

export const HUB_METHODS = {
  /** 设备清单（只读；给本机 UI 与 `full` 角色）。 */
  devices: 'devices',
  /** 吊销一台设备（写；仅 `full`）。 */
  revoke: 'revoke',
  /** 打开一条长轮询流：`{ endpoint, args }` → `{ streamId, cursor }`。 */
  streamOpen: 'stream.open',
  /** 拉取下一批：`{ streamId, cursor, holdMs }` → `{ items, nextCursor, done?, terminal? }`。 */
  streamNext: 'stream.next',
  /** 取消：`{ streamId }` → `{ ok }`。 */
  streamCancel: 'stream.cancel',
  /** 回答一次审批：`{ requestId, outcome }` → `{ ok }`（三值，见能力矩阵）。 */
  answerApproval: 'answerApproval',
} as const

export type HubMethod = (typeof HUB_METHODS)[keyof typeof HUB_METHODS]

/**
 * 一个 `hub/*` endpoint 的完整写法，例如 `hub/stream.next`。
 * 服务键是 `hubStreams` / `hubDevices`（Cordis service key 必须互不相同），
 * 但它们共用 wire namespace `hub`。
 */
export function hubEndpoint(method: HubMethod): `${typeof HUB_NAMESPACE}/${HubMethod}` {
  return `${HUB_NAMESPACE}/${method}`
}

/**
 * 长轮询预算（D-4）。数值与官方 viewer 的量级一致，但持有时间更短，
 * 以便把「吊销可见延迟」压到 5s 以内。**顺序不可倒置**：
 * `holdMs < pollSlackMs + holdMs < readTimeoutMs`，否则正常的一轮读会被上层判成超时。
 */
export const STREAM_BUDGET = {
  /** 单次 `stream.next` 的持有上限。 */
  holdMs: 4_000,
  /** 单批最大帧数（同官方 `STREAM_BATCH_MAX`）。 */
  batchMax: 64,
  /** 批量聚合窗口：只在已有一帧之后才等（同官方 `STREAM_BATCH_WINDOW_MS`）。 */
  batchWindowMs: 4,
  /** 客户端判超时的余量：`holdMs + pollSlackMs` 之后才认定这一轮丢了。 */
  pollSlackMs: 2_000,
  /** 服务端读超时兜底（同官方 `VIEWER_READ_TIMEOUT_MS`）。 */
  readTimeoutMs: 25_000,
  /** 无人轮询的流在此时长后回收。 */
  idleTtlMs: 120_000,
} as const

/**
 * 资源上限（§9.8）。守卫入口比 DSH 自己的 `/api` 更窄：DSH 默认 300 MiB 是给
 * 图片留的，而我们的入口只承载 JSON 信封与 base64 上传。
 */
export const LIMITS = {
  /** `/remote/rpc` 请求体上限（8 MiB）。 */
  maxRequestBodyBytes: 8 * 1024 * 1024,
  /** 单批响应体上限；超限截断该批并置 `truncated: true`（4 MiB）。 */
  maxResponseBodyBytes: 4 * 1024 * 1024,
  /** 每设备并发长轮询流数。 */
  maxStreamsPerDevice: 4,
  /** 每设备并发 `/remote/rpc` 请求数。 */
  maxInflightRequestsPerDevice: 8,
  /** 设备表文件大小上限。 */
  maxDeviceTableBytes: 4 * 1024 * 1024,
  /** 兑换端按来源限流：1 分钟内最多 10 次。 */
  pairRedeemPerMinute: 10,
} as const

/** 配对原语的固定参数（D-14）。 */
export const PAIRING = {
  /** QR 票据：32 字节随机 → base64url 43 字符。 */
  ticketBytes: 32,
  ticketChars: 43,
  /** QR 票据 TTL。 */
  ticketTtlMs: 120_000,
  /** 短码：8 位 Crockford Base32 = 40 bit。 */
  codeLength: 8,
  codeTtlMs: 600_000,
  /** 错误尝试预算；达预算即烧码/烧票据（成功同样 burn）。 */
  maxAttempts: 5,
} as const

/**
 * Crockford Base32 字母表：去掉 `I` `L` `O` `U`（易与 1/0/V 混读）。
 * 32 个字符 → 每位 5 bit；8 位 = 40 bit。
 */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 错误码。 */
export const ERROR_CODES = {
  /** 信封或守卫层结构非法。 */
  badRequest: 'bad-request',
  /** 无令牌 / 令牌未知。 */
  unauthorized: 'unauthorized',
  /** 来源围栏拒绝（Host/Origin/Sec-Fetch-Site 不在允许集合内）。 */
  forbidden: 'forbidden',
  /** 设备已吊销：清空本地令牌并停止重连。 */
  deviceRevoked: 'device-revoked',
  /** 票据/短码不匹配。 */
  pairInvalid: 'pair-invalid',
  /** 票据/短码过期。 */
  pairExpired: 'pair-expired',
  /** 超出预算或限流。 */
  rateLimited: 'rate-limited',
  /** `X-Hub-Protocol` 不符；不要重试。 */
  protocolVersionMismatch: 'protocol-version-mismatch',
  /** 流目标不被允许（不区分「不存在」「角色不足」「不是 stream 方法」）。 */
  streamOpenDenied: 'stream-open-denied',
  /** 游标回退或超越已发放游标。 */
  cursorInvalid: 'cursor-invalid',
  /** 未知 streamId（流已回收 / 守卫重启）。 */
  streamNotFound: 'stream-not-found',
  /** 流被调用方取消。 */
  streamCancelled: 'stream-cancelled',
  /** 路由不存在。 */
  notFound: 'not-found',
  /** 守卫未预期错误。 */
  internal: 'internal',
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

/**
 * **官方**错误码（原样透传，不包装成 hub 码）。
 *
 * - `remote-access/denied`：`decide()` 拒绝，`details = { action, reason }`，
 *   reason ∈ `resource-invalid` / `no-allow` / `policy-failed` / 条件原因。
 *   UI 必须渲染成「本来就不该显示的入口」，而不是网络失败。
 * - `hub/*` 里我们自己的拒绝用上面的 `ERROR_CODES`，但**透传**官方码时不做映射。
 */
export const OFFICIAL_ERROR_CODES = {
  remoteAccessDenied: 'remote-access/denied',
  sessionNotFound: 'session/not-found',
  workspaceFileNotText: 'workspace-file/not-text',
} as const

/** 本插件的 `hub/*` 服务键（Cordis service key；namespace 都是 `hub`）。 */
export const HUB_SERVICE_KEYS = {
  streams: 'hubStreams',
  devices: 'hubDevices',
} as const

/** 设备表磁盘格式版本（与 `PROTOCOL_VERSION` 独立演进）。 */
export const DEVICE_TABLE_VERSION = 1
