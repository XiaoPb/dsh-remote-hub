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
 * 本机签发/设备管理的进程内凭据头。
 *
 * 值由 host 在启动时随机生成并注入本机 index 页（`__DSH_REMOTE_HUB__`），
 * **绝不经隧道、绝不写日志**；签发端与设备管理端都要求「回环 + 该头」双条件。
 */
export const PAIR_ISSUE_HEADER = 'x-pair-issue-token'

/**
 * 守卫自己的 HTTP 路由。**其余一律 404** —— 包括 `/api/*`：那不是守卫的路由，
 * 而是守卫以 `peer` 身份交给 DSH 自己的
 * `ctx.connection.createSharedFetchHandler('/api')` 的 RPC 面。
 *
 * 七条路由，一条不多：
 * - 流**不占路由**：三条 stream 方法是 `hub/*` Remote 方法，走 `rpc` 入口，
 *   因此同样过官方 `decide()`。给它们单开 HTTP 路由等于绕开 Gateway 的参数校验
 *   与访问判定（红线 R9）。
 * - 两条**设备管理**路由（`devices` / `devicesRevoke`）只作用于本机页面：与
 *   签发端同样施加「回环 + `x-pair-issue-token`」双条件，不对外暴露。
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
  /** 设备管理（只读）：本机页面列出已配对设备。**双条件回环门控**。 */
  devices: '/remote/devices',
  /** 设备管理（写）：清除单台 / 全部配对。**双条件回环门控**。 */
  devicesRevoke: '/remote/devices/revoke',
  /** 运行指标（只读快照）：本机页面统计区数据源。**双条件回环门控**。 */
  stats: '/remote/stats',
  /** 配置快照（只读）与白名单子集写入。**双条件回环门控**。 */
  config: '/remote/config',
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
  /**
   * 本机管理面（仅 owner 页面可调；走同源 `/api` 通道，无需 CORS）。
   *
   * 桌面端页面 origin 是 `dsh-app://app`（不透明来源），无法直接 fetch
   * `http://127.0.0.1:8443`。这些方法与已有的 `hub/*` 一样注册在 Typert Remote 上，
   * 页面经同源 `POST /api/<endpoint>` 调用，由 Electron 的 `forwardWebRequest`
   * 转发到本机 Host —— 全程同源，零预检。
   */
  adminDevices: 'admin.devices',
  adminDeviceForget: 'admin.deviceForget',
  adminStats: 'admin.stats',
  adminConfig: 'admin.config',
  adminConfigPatch: 'admin.configPatch',
  adminHealth: 'admin.health',
  /** 签发配对凭据（owner 页面同源调用；仍需进程内 pin 作为第二因子）。 */
  adminIssue: 'admin.issue',
  /** 本机连接信息：局域网 IPv4 + 端口（供其他设备填写 / 生成二维码链接）。 */
  adminEndpoints: 'admin.endpoints',
  /**
   * 出站连接状态（`carrier-mode.json` 的读写）。
   *
   * 页面「主控端」卡片的状态原本只存在浏览器 localStorage，CLI 配对后页面
   * 无从得知。这条端点让磁盘上的 `carrier-mode.json` 成为可轮询的真源：
   * 页面定时调用 `adminCarrier`，发现有更新即导入到 localStorage。
   */
  adminCarrier: 'admin.carrier',
  /** 把页面的出站状态写回磁盘（页面切换/断开时调用）。 */
  adminCarrierWrite: 'admin.carrierWrite',
  /** 枚举当前 DSH_HOME/profile 中已配对的目标，仅返回 opaque ID 与标签。 */
  adminOutboundTargets: 'admin.outboundTargets',
  /** 保存新兑换的 bearer 到本地受限档案，不回传 bearer 到浏览器 storage。 */
  adminOutboundSave: 'admin.outboundSave',
  /** 按 opaque targetId 激活由 Host 保存的配对目标。 */
  adminOutboundActivate: 'admin.outboundActivate',
  /** 删除当前本地主控 profile 下的配对目标。 */
  adminOutboundForget: 'admin.outboundForget',
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
 *
 * 路线 A（carrier 接管）实测口径：官方 GUI 的并发请求峰值可到 12+（会话流 +
 * 列表 + 投影），`maxInflightRequestsPerDevice` 已调到 16；`/remote/rpc` 的
 * 响应**不截断**——官方 client 期待完整 multipart 附件投影
 * （client.browser.js parseBinaryResponse），截断会产生畸形附件。
 */
export const LIMITS = {
  /** `/remote/rpc` 请求体上限（16 MiB；官方附件上传实测可达 10 MiB+）。 */
  maxRequestBodyBytes: 16 * 1024 * 1024,
  /**
   * 单批响应体上限；仅对 `hub/stream.next` 的**批聚合**生效（streams.ts 自有
   * 判据）。`/remote/rpc` 透传官方响应，不做截断（见上）。
   */
  maxResponseBodyBytes: 4 * 1024 * 1024,
  /** 每设备并发长轮询流数。 */
  maxStreamsPerDevice: 4,
  /** 每设备并发 `/remote/rpc` 请求数（官方 GUI 峰值 12+，留余量）。 */
  maxInflightRequestsPerDevice: 16,
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
  /**
   * 配对凭据 TTL：**15 秒轮换**。
   *
   * 设计：票据与短码都只在 15 秒窗口内有效，页面每 15 秒自动换新。
   * 配对一旦成功，服务端立即签发**长期设备令牌**（`DeviceRecord.tokenHash`
   * 持久化到设备表），此后该设备凭令牌长期访问，不再需要配对凭据。
   * 短窗口 + 成功后持久化 = 凭据泄露面极小，且设备不会因凭据过期掉线。
   */
  ticketTtlMs: 15_000,
  /** 短码：8 位 Crockford Base32 = 40 bit。 */
  codeLength: 8,
  /** 短码 TTL：与票据一致（15 秒轮换）。 */
  codeTtlMs: 15_000,
  /** 轮换周期（页面自动刷新间隔）。 */
  rotateMs: 15_000,
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
  /** 本机管理面（owner 页面专用；同源通道）。 */
  admin: 'hubAdmin',
} as const

/** 设备表磁盘格式版本（与 `PROTOCOL_VERSION` 独立演进）。 */
export const DEVICE_TABLE_VERSION = 1
