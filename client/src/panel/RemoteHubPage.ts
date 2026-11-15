/**
 * 云端设备页（`main` keyed 槽位 `key='remote-hub'`）—— 路线 A 的控制台。
 *
 * **两个身份必须分开呈现**（2026-11-11 反馈）：
 *  - 「本机（被控端）」：守卫状态、已配对设备、生成二维码/短码、**清除配对**；
 *  - 「连接其他设备（主控端）」：当前指向哪台设备、连接/断开。
 *
 * 单控策略（`singleController`）：同一时刻只允许一台设备控制本机；新设备配对
 * 成功时服务端自动吊销旧设备，页面把这条语义显式写出来。
 *
 * 渲染器（纯函数）与组件（hooks）分离：纯函数供测试直接断言 DOM 门控，
 * 组件只在插件装配时创建一次（保证 hooks 身份稳定）。
 *
 * @module dsh-remote-hub/client/panel/RemoteHubPage
 */
import React from 'react'

import { MODE_KEY, readCarrierMode, writeCarrierMode, type CarrierMode } from '@core/carrier-contract.js'
import {
  Button,
  CodeBox,
  Collapse,
  EmptyState,
  Field,
  Input,
  KeyValue,
  Notice,
  PasswordInput,
  Pill,
  Section,
  Segmented,
  Select,
  ThemeStyle,
  cx,
  formatRole,
} from '../rhui/index.js'
import { RH_CSS } from '../rhui/tokens.js'
import { encodeQr } from './qr.js'
import { DeviceDeleteDialog } from './DeviceDeleteDialog.js'

/** 一条已配对设备（守卫 `/remote/devices` 返回行）。 */
export interface CloudDeviceRow {
  deviceId: string
  label?: string
  role?: string
  createdAt?: string
  lastSeenAt?: string | null
  revokedAt?: string | null
  /** 被单控策略挤下线的时间（仍保留配对，可再次连接）。 */
  displacedAt?: string | null
  /** 归属账号（plan-optimization §9.3）：与设置页同一字段。 */
  accountId?: string | null
  username?: string | null
}

/** 主控端本地保存的已配对出站目标（令牌仅保存在本地主控档案，不渲染到 DOM）。 */
export interface OutboundTarget {
  id?: string
  origin: string
  token?: string
  deviceLabel?: string
  deviceId?: string
  role?: string
  pairedAt?: number
  lastConnectedAt?: number
}

/** 连接目标本地档案键。 */
export const OUTBOUND_TARGETS_KEY = 'remote-hub.outbound-targets'

/** 读取本地主控已配对目标（损坏数据 fail-closed）。 */
export function readOutboundTargets(storage?: Storage): readonly OutboundTarget[] {
  try {
    const raw = (storage ?? globalThis.localStorage)?.getItem(OUTBOUND_TARGETS_KEY)
    if (raw === null || raw === undefined) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap(item => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
      const row = item as Record<string, unknown>
      const origin = typeof row.origin === 'string' ? normalizeOrigin(row.origin) : undefined
      const token = typeof row.token === 'string' ? row.token : undefined
      const id = typeof row.id === 'string' && /^[0-9a-f]{64}$/u.test(row.id) ? row.id : undefined
      if (origin === undefined || (id === undefined && (token === undefined || !/^[A-Za-z0-9_-]{16,}$/.test(token)))) return []
      if (row.deviceId !== undefined && typeof row.deviceId !== 'string') return []
      if (row.deviceLabel !== undefined && typeof row.deviceLabel !== 'string') return []
      if (row.role !== undefined && typeof row.role !== 'string') return []
      if (row.lastConnectedAt !== undefined && typeof row.lastConnectedAt !== 'number') return []
      return [{
        ...(id === undefined ? {} : { id }),
        origin,
        ...(token === undefined ? {} : { token }),
        ...(row.deviceId === undefined ? {} : { deviceId: row.deviceId }),
        ...(row.deviceLabel === undefined ? {} : { deviceLabel: row.deviceLabel }),
        ...(row.role === undefined ? {} : { role: row.role }),
        ...(row.lastConnectedAt === undefined ? {} : { lastConnectedAt: row.lastConnectedAt }),
      }]
    }).slice(0, 20)
  } catch {
    return []
  }
}

/** 保存目标档案；失败返回 false，调用方不得继续 reload。 */
export function writeOutboundTargets(targets: readonly OutboundTarget[], storage?: Storage): boolean {
  try {
    ;(storage ?? globalThis.localStorage)?.setItem(OUTBOUND_TARGETS_KEY, JSON.stringify(targets.slice(0, 20)))
    return true
  } catch {
    return false
  }
}

/** Stable non-bearer identity for React keys and same-origin pairing comparisons. */
export function outboundTargetIdentity(target: Pick<OutboundTarget, 'id' | 'origin' | 'token'>): string {
  if (target.id) return target.id
  const origin = normalizeOrigin(target.origin) ?? target.origin
  const input = `${origin}\u0000${target.token ?? ''}`
  let hash = 0xcbf29ce484222325n
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `${origin}#${hash.toString(16).padStart(16, '0')}`
}

/** Persist the local escape before reload; archive failure does not block disconnect. */
export function outboundTargetLabel(target: OutboundTarget, targets: readonly OutboundTarget[]): string {
  const origin = normalizeOrigin(target.origin) ?? target.origin
  const peers = targets.filter(item => (normalizeOrigin(item.origin) ?? item.origin) === origin)
  const label = target.deviceLabel ?? origin
  if (peers.length < 2) return label
  const fingerprint = outboundTargetIdentity(target).slice(-6)
  return `${label} · ${fingerprint}`
}

/**
 * 卡片标题：一行就能放下的短标识。
 *
 * 优先用设备名（人类可读），但长度超过 40 字符的「名字」实际是旧版写入的地址串
 * （如 `http://127.0.0.1:8850 · controller 127.0.0.1:3091`），窄卡片里会被逐字折行，
 * 这种情况退回显示 origin。
 * @param target - 对端目标。
 * @returns 标题文本。
 */
export function outboundTargetTitle(target: OutboundTarget): string {
  const origin = normalizeOrigin(target.origin) ?? target.origin
  const label = target.deviceLabel
  if (label === undefined || label === null || label === '') return origin
  if (label.length > 40 || label.includes(' · ')) return origin
  return label
}

/**
 * 卡片副标题：同源目标的区分信息（设备名 / 指纹）。
 *
 * 标题行固定显示 `origin`（一行放得下），区分信息放副标题，避免长标签把卡片标题撑成
 * 多行（窄列下会被逐字折行）。只有一个目标且没有设备名时不显示多余文字。
 * @param target - 对端目标。
 * @param targets - 全部已保存目标（用于判断同源重复）。
 * @returns 副标题文本（可能为空串）。
 */
export function outboundTargetMeta(target: OutboundTarget, targets: readonly OutboundTarget[]): string {
  const origin = normalizeOrigin(target.origin) ?? target.origin
  const peers = targets.filter(item => (normalizeOrigin(item.origin) ?? item.origin) === origin)
  const fingerprint = outboundTargetIdentity(target).slice(-6)
  const device = target.deviceLabel === undefined || target.deviceLabel === null
    || target.deviceLabel === '' || target.deviceLabel === origin
    ? ''
    : target.deviceLabel
  if (peers.length >= 2) return `${device === '' ? '' : `${device} · `}${fingerprint}`
  return device
}

/** Persist the local escape before reloading; archive failure does not block disconnect. */
export async function runDetachPersistence(input: {
  saveTargets(): boolean
  writeLocalMode(): Promise<number>
  warnTargetsNotSaved?(): void
  reload(): void
}): Promise<{ disconnected: boolean; targetsSaved: boolean }> {
  const targetsSaved = input.saveTargets()
  try {
    await input.writeLocalMode()
  } catch {
    return { disconnected: false, targetsSaved }
  }
  if (!targetsSaved) input.warnTargetsNotSaved?.()
  input.reload()
  return { disconnected: true, targetsSaved }
}

/** Save redeemed credentials to the local Host archive, then activate only by opaque id. */
export async function persistNewPairing(input: {
  saveTarget(): Promise<OutboundTarget>
  writeCloudMode(target: OutboundTarget): Promise<number>
  setCloudMode(target: OutboundTarget): void
}): Promise<{ target?: OutboundTarget; archiveSaved: boolean; carrierSaved: boolean }> {
  let target: OutboundTarget
  try {
    target = await input.saveTarget()
  } catch {
    return { archiveSaved: false, carrierSaved: false }
  }
  try {
    await input.writeCloudMode(target)
  } catch {
    return { target, archiveSaved: true, carrierSaved: false }
  }
  input.setCloudMode(target)
  return { target, archiveSaved: true, carrierSaved: true }
}


/** 按 origin+token 去重并更新一个出站目标。 */
export function upsertOutboundTarget(
  targets: readonly OutboundTarget[],
  target: OutboundTarget,
): OutboundTarget[] {
  const normalized = normalizeOrigin(target.origin) ?? target.origin
  const next = targets.filter(item => {
    const sameOrigin = (normalizeOrigin(item.origin) ?? item.origin) === normalized
    if (!sameOrigin) return true
    if (target.id !== undefined) return item.id !== target.id
    return target.token === undefined || item.token !== target.token
  })
  next.unshift({ ...target, origin: normalized })
  return next.slice(0, 20)
}

/** 本机守卫状态（`/remote/devices` 的 guard 段 + 协议信息）。 */
export interface GuardStatus {
  host: string
  port: number
  /** 对外可用地址（LAN 模式为 LAN IP）。 */
  origin: string
  /** 本机页面签发/管理用的回环地址（可选）。 */
  loopbackOrigin?: string
  /** 信任域。 */
  network?: 'loopback' | 'lan'
  protocolVersion: number
  singleController: boolean
}

/** 角色（与 core/roles.ts 同名）。 */
export type RoleName = 'read-only' | 'control' | 'full'

/** 守卫运行指标（/remote/stats；缺字段时页面按 '—' 降级）。 */
export interface HubMetrics {
  startedAt: string
  pairIssued: number
  pairRedeemed: number
  pairRejected: number
  authAccepted: number
  authDenied: number
  activeStreams: number
  streamsOpened: number
  hourly: readonly number[]
  daily: readonly number[]
}

/** 配置快照（可展示子集；写入走白名单）。 */
export type ConfigSnapshot = Record<string, unknown>

/** 页面状态。 */
export interface RemoteHubPageState {
  /** 主控端：本地保留的已配对出站目标（断开后仍可重连）。 */
  outboundTargets: readonly OutboundTarget[]
  /** 主控端：当前指向哪台目标。 */
  mode: CarrierMode
  /** 被控端：守卫状态（null = 未检测到/未运行）。 */
  guard: GuardStatus | null
  /** 被控端：状态读取失败的原因。 */
  guardError: string | null
  /** 被控端：已配对设备（含已吊销行，UI 灰显）。 */
  devices: readonly CloudDeviceRow[]
  /** 被控端：状态读取中。 */
  loading: boolean
  /** 同源管理通道是否可用（宿主注入了管理 transport）。 */
  adminAvailable?: boolean
  /** 本机局域网候选地址（`http://<ip>:<port>`，供其他设备填写）。 */
  lanCandidates?: readonly string[]
  /** 推荐地址（告诉对方填哪个地址）。 */
  listenAddress?: string
  /** 主控端：连接表单（目标地址）。 */
  originDraft: string
  /** 对端账号登录草稿（账号认证模式，跨源）。 */
  accountDraft: { username: string; password: string; code: string; role: RoleName }
  /** ② 设备筛选。 */
  deviceFilter: 'all' | 'inbound'
  /** ③ 守卫运行指标（null = 宿主不支持/未加载）。 */
  stats: HubMetrics | null
  /** ③ 指标不可用的原因（宿主旧版本等）。 */
  statsError: string | null
  /** ④ 配置快照（null = 宿主不支持/未加载）。 */
  config: ConfigSnapshot | null
  /** ④ 配置编辑副本（未保存）。 */
  configDraft: ConfigSnapshot | null
  /** ④ 配置保存中。 */
  configSaving: boolean
  /** ④ 最近一次保存结果（ok / error 文案）。 */
  configSavedAt: number | null
  /** 进行中的异步操作。 */
  busy: null | 'connect' | 'account' | 'revoke' | 'delete' | 'refresh' | 'detach'
  /** 错误信息。 */
  error: string | null
  /** 注入状态（诊断区展示；不含凭据本身）。 */
  injection?: InjectionDiagnostic
  /** 最近一次管理请求诊断（诊断区展示）。 */
  diagnostic?: AdminDiagnostic | null
  /** 用户可见日志时间线。 */
  logs?: readonly HubLogEntry[]
  /** 守卫读取失败后的自动重试状态。 */
  retry?: { attempts: number; nextRetryAt: number | null }
  /** 注入时钟（倒计时）。 */
  now: number
}

/** 页面动作。 */
export interface RemoteHubPageActions {
  onRefresh(): void
  onForgetDevice?(deviceId: string): void
  onForgetOutbound?(target: OutboundTarget): void
  onRevoke(deviceId: string): void
  onRevokeAll(): void
  onOriginChange(value: string): void
  onConnect(): void
  /** 修改对端账号草稿字段。 */
  onAccountChange(field: 'username' | 'password' | 'code' | 'role', value: string): void
  /** 用对端账号登录并信任本浏览器（跨源）。 */
  onAccountConnect(): void
  onReconnect(target: OutboundTarget): void
  onDetach(): void
  onCopy(text: string): void
  /** ② 切换设备筛选。 */
  onFilterChange(filter: 'all' | 'inbound'): void
  /** ④ 修改配置草稿（未保存）。 */
  onConfigChange(key: string, value: unknown): void
  /** ④ 保存配置草稿。 */
  onConfigSave(): void
}

// ── 样式 ─────────────────────────────────────────────────────────────────────
// 页面尺寸与滚动交给 .rh-root 的响应式样式。

/** 页面内文案表（集中管理，便于后续接入宿主 i18n；布局不依赖文字长度）。 */
const STRINGS = {
  title: '云端设备',
  modeLocal: '本机',
  modeCloud: '云端',
  hostTitle: '本机 · 被控端',
  hostSub: '让其他设备连接并控制这台机器。单控模式下同一时刻只有一台设备能控制本机。',
  guardUp: '守卫运行中',
  guardDown: '守卫未运行',
  refreshing: '正在读取守卫状态…',
  noGuard: '未检测到守卫（本机可能未启用被控端）',
  refresh: '刷新状态',
  refreshingBtn: '刷新中…',
  singleCtrl: '单控策略：',
  singleOn: '已启用（新客户端连接会挤掉旧客户端）',
  singleOff: '已关闭（允许多设备同时控制）',
  paired: '已信任',
  devicesTitle: '可信客户端',
  devicesEmptyLoading: '正在读取…',
  devicesEmpty: '还没有可信客户端。在设置页「登录与账号」信任本浏览器，或从其他设备用账号登录后登记公钥。',
  revoked: ' · 已撤销',
  never: ' · 从未连接',
  recent: ' · 最近 ',
  revoke: '撤销客户端',
  revokeAll: '撤销全部客户端',
  lead: '让其他设备连接并控制这台机器，或把整机切换到其它设备。',
  guardOrigin: '守卫地址',
  guardProtocol: '协议版本',
  guardNetwork: '网络模式',
  netLan: '局域网（同网段可直连）',
  netLoopback: '仅本机',
  singleOnShort: '单控已启用',
  singleOffShort: '单控已关闭',
  revokedShort: '已撤销',
  neverShort: '从未连接',
  notConnectedShort: '未连接',
  devicesEmptyTitle: '暂无可信客户端',
  // ② 设备区
  devicesZoneTitle: '已连接设备',
  filterAll: '全部',
  filterInbound: '连接本机',
  filterOutbound: '本机连接',
  groupInbound: '可信客户端（在线 / 离线）',
  groupInboundHint: '已信任的客户端。权限上限与撤销在「设置 → 登录与账号」管理',
  manageInSettings: '权限与撤销：设置 → 登录与账号',
  groupOutbound: '本机连接的设备',
  groupOutboundHint: '本机作为主控端主动连接',
  statusOnline: '在线',
  statusIdle: '空闲',
  statusOffline: '离线',
  // 三态（2026-11-12）：已连接 / 已配对 / 配对失效
  statusConnected: '已连接',
  statusPaired: '已信任（离线）',
  statusInvalid: '已撤销',
  devAccount: '归属账号',
  devCreatedAt: '信任于',
  devRole: '角色',
  devLastSeen: '最近活跃',
  // ③ 统计区
  statsTitle: '本机状态 · 统计',
  statsScope: '本次运行',
  statUptime: '运行时长',
  statActive: '活跃设备',
  statPaired: '累计邀请兑换',
  statRejected: '拒绝尝试',
  statActiveStreams: '活跃连接',
  chartActivity: '连接活动（24h）',
  chartActivitySub: '每小时认证通过数',
  chartPairing: '邀请兑换（7d）',
  chartPairingSub: '每日兑换成功数',
  chartHeat: '活跃度热力',
  chartHeatSub: '颜色越深表示该时段连接越密集',
  statsUnsupported: '当前宿主版本不支持运行统计，升级后可用。',
  // ④ 配置区
  configTitle: '本机配置',
  configSaved: '已保存',
  configUnsaved: '有未保存修改',
  configSavingLbl: '保存中…',
  configSave: '保存修改',
  configUnsupported: '当前宿主版本不支持在线配置，升级后可用。',
  cfgSingle: '单控策略',
  cfgSingleDesc: '同一时刻只允许一台设备控制本机',
  cfgBridge: '审批桥接',
  cfgBridgeDesc: '远程操作审批走桌面原生卡片',
  cfgRole: '默认授权角色',
  cfgRoleDesc: '新客户端首次信任时建议授予的上限；不会改变已信任客户端的权限（那些在设置页管理）',
  cfgAttempts: '登录尝试次数上限',
  cfgAttemptsDesc: '同一来源在窗口内的失败次数上限（1–100）',
  cfgColdNote: '以下参数可修改，保存后写入本机配置；需重启 dsh web，重启后生效',
  cfgRestartPending: '有修改待重启生效',
  cfgPort: '监听端口',
  cfgPortDesc: '守卫绑定端口（1–65535）。被占用时启动会自动顺延 +1，并在诊断里标注实际端口',
  cfgNetworkDesc: 'loopback 仅本机可连；lan 允许同网段直连（公网仍需隧道）',
  cfgTtl: '票据有效期',
  cfgTunnel: '隧道类型',
  // 连接其他设备（主控端）
  clientTitle: '连接其他设备 · 主控端',
  clientSub: '连接成功后整机切换到该设备：侧栏工作区、会话、插件全部显示那台机器的数据。',
  connected: '已连接',
  detach: '断开并切回本机',
  notConnected: '当前指向本机，未连接其他设备。',
  originPlaceholder: '目标设备地址，例如 http://192.168.1.10:8443',
  connect: '连接',
  connecting: '连接中…',
  originInvalid: '地址格式不正确：需要形如 http://主机:端口，且不带路径。',
  advanced: '连接参数（高级）',
  // 守卫诊断
  diagTitle: '守卫诊断',
  diagInjection: '注入握手',
  diagPin: '管理凭据',
  diagPinYes: '已注入',
  diagPinNo: '未注入',
  diagInstance: '实例',
  diagPid: 'host pid',
  diagInjectedAt: '注入时间',
  diagAge: '注入距今',
  diagLastRequest: '最近管理请求',
  diagNoRequest: '尚未发起',
  diagPageOrigin: '页面 origin',
  diagTakeover: '整机接管',
  diagTakeoverOn: '已生效',
  diagTakeoverOff: '未生效（transport 未注入）',
  diagTakeoverLocal: '本机模式',
  diagStreamBase: 'WS 目标',
  diagTargetOrigin: '守卫 origin',
  diagStatus: 'HTTP 状态',
  diagRetry: '自动重试',
  diagRetryIdle: '已停止（守卫可用）',
  diagApiHint: '注意：直接访问 /remote/* 是受保护 API，浏览器地址栏打开必然 400，请以本页状态为准。',
  // 日志卡片
  logTitle: '运行日志',
  logEmpty: '暂无日志记录。',
  logLevelInfo: '成功',
  logLevelWarn: '警告',
  logLevelError: '失败',
  logLevel: '级别',
  logTime: '时间',
  logClear: '清空',
  // 监听地址
  listenLabel: '本机监听地址',
  listenHint: '其他设备连接时填这些地址（局域网 IPv4）',
  listenUnavailable: '未获取到监听地址',
  copyAddress: '复制',
} as const

const ROLES: readonly RoleName[] = ['read-only', 'control', 'full']
export function configuredDefaultRole(value: unknown): RoleName {
  return ROLES.includes(value as RoleName) ? value as RoleName : 'control'
}
const ROLE_LABEL: Record<RoleName, string> = { 'read-only': '只读', control: '可操作', full: '完全控制' }

/**
 * 把守卫读取失败翻译成可操作的文案。
 *
 * 浏览器只给 "Failed to fetch"，页面必须自己区分：注入缺失 / 预检或网络失败 /
 * CORS 不可读 / HTTP 拒绝。错误对象由 transport 的 RemoteHubError 携带 `kind`。
 * @param cause - 捕获到的异常。
 * @returns 面向用户的错误文案。
 */
export function describeGuardFailure(cause: unknown): string {
  const detail = cause as { kind?: string; status?: number; message?: string; path?: string } | null
  const message = detail?.message ?? (cause instanceof Error ? cause.message : String(cause))
  const path = detail?.path === undefined ? '' : `（${detail.path}）`
  switch (detail?.kind) {
    case 'missing-injection':
      return `本机未注入守卫凭据${path}：宿主插件未装配或页面来自旧实例，请重启宿主并刷新页面。`
    case 'preflight-failed':
      return `守卫连接失败${path}：跨源预检或网络被拒。守卫可能未启动，或守卫版本不支持 OPTIONS 预检。`
    case 'network-unreachable':
      return `网络不可达${path}：无法连接到守卫，请确认宿主已启动且 8443 未被占用。`
    case 'cors-blocked':
      return `响应不可读${path}：守卫未宣告 Access-Control-Allow-Origin，请确认守卫为当前版本。`
    case 'http-400':
      return `守卫拒绝请求${path}（HTTP 400）：请求头或协议版本不符。`
    case 'http-401':
      return `凭据无效${path}（HTTP 401）：设备令牌已吊销或不匹配。`
    case 'http-403':
      return `守卫拒绝来源${path}（HTTP 403）：回环凭据或来源围栏判定失败。`
    case 'http-404':
      return `端点不存在${path}（HTTP 404）：宿主版本过旧，缺少该管理端点。`
    case 'http-5xx':
      return `守卫内部错误${path}（HTTP ${detail.status ?? 500}）：请查看宿主日志。`
    default:
      return `读取守卫状态失败：${message}`
  }
}

/** 剩余秒数（向上取整，不为负）。 */
export function remainingSeconds(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000))
}

/** 校验并规范化 guard 地址；非法返回 undefined。 */
export function normalizeOrigin(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    if (url.username !== '' || url.password !== '') return undefined
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined
    return url.origin
  } catch {
    return undefined
  }
}

// ── 轻量节点助手（参数自动分类：字符串→className、普通对象→props、其余→children）─
const isReactNode = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && (value as { $$typeof?: unknown }).$$typeof !== undefined

const el = (tag: string, ...args: unknown[]): React.ReactNode => {
  let className: string | undefined
  let props: Record<string, unknown> | undefined
  const children: React.ReactNode[] = []
  for (const arg of args) {
    if (arg === null || arg === undefined || arg === false || arg === true || arg === '') continue
    if (typeof arg === 'string' || typeof arg === 'number') {
      if (className === undefined && props === undefined && children.length === 0) { className = String(arg); continue }
      children.push(arg); continue
    }
    if (Array.isArray(arg)) { children.push(...(arg as React.ReactNode[])); continue }
    if (typeof arg === 'object' && !isReactNode(arg) && props === undefined) { props = arg as Record<string, unknown>; continue }
    children.push(arg as React.ReactNode)
  }
  return React.createElement(tag, { ...(props ?? {}), ...(className ? { className } : {}) }, ...children)}

/**
 * 云端设备页的纯渲染（区块 1–5，plan-devices §2/§3）。
 *
 * 阶段 A 只重排**结构与样式**：所有 `data-testid` 与交互回调原样保留，
 * 视觉进入 `--rh-*` 设计系统（`client/src/rhui`）。阶段 B 才会删掉邀请区、
 * 把「连接其他设备」换成账号登录多步流。
 *
 * 区块顺序（design-system §9）：页头 → 被控端（本机·接入设备）→ 主控端
 * （连接其他设备）→ 守卫状态 & 配置 → 统计 & 诊断。
 *
 * @param state - 页面状态。
 * @param actions - 页面动作。
 * @returns React 节点。
 */
export function renderRemoteHubPage(state: RemoteHubPageState, actions: RemoteHubPageActions): React.ReactNode {
  const isCloud = state.mode.mode === 'cloud'
  const guardUp = state.guard !== null
  const activeDevices = state.devices.filter(device => device.revokedAt == null)

  // ── 区块 1：页头（守卫状态 pill + 快捷入口）──────────────────────────────
  const pageHead = React.createElement('header', { className: 'rh-page-head' },
    React.createElement('h1', { className: 'rh-page-title rh-h1', 'data-testid': 'page-title' }, STRINGS.title,
      React.createElement(Pill, {
        'data-testid': 'mode-badge',
        tone: isCloud ? 'online' : 'offline',
        dot: true,
        children: isCloud
          ? `☁ ${state.mode.deviceLabel ?? state.mode.origin ?? STRINGS.modeCloud}`
          : STRINGS.modeLocal,
      })),
    React.createElement('p', { className: 'rh-lead' }, STRINGS.lead))

  // ── 区块 2：被控端（本机 · 接入设备）──────────────────────────────────────
  const hostCard = React.createElement(Section, {
    'data-testid': 'host-section',
    title: React.createElement(React.Fragment, null,
      STRINGS.hostTitle,
      React.createElement(Pill, {
        'data-testid': 'guard-state',
        tone: guardUp ? 'online' : 'error',
        dot: true,
        children: guardUp ? STRINGS.guardUp : STRINGS.guardDown,
      })),
    desc: STRINGS.hostSub,
    actions: React.createElement(React.Fragment, null,
      React.createElement(Button, {
        'data-testid': 'refresh',
        size: 'small',
        loading: state.loading,
        disabled: state.busy !== null,
        children: state.loading ? STRINGS.refreshingBtn : STRINGS.refresh,
        onClick: () => actions.onRefresh(),
      })),
    children: React.createElement(React.Fragment, null,
      // 状态行：地址 / 协议 / 网络 / 单控（KeyValue 网格）
      guardUp
        ? el('div', 'rh-kv', { 'data-testid': 'guard-status' },
          el('div', undefined,
            el('div', 'rh-k', undefined, STRINGS.listenLabel),
            el('div', 'rh-v', { 'data-testid': 'listen-address' },
              state.listenAddress !== undefined && state.listenAddress !== ''
                ? state.listenAddress
                : (state.guard?.origin ?? '—'))),
          el('div', undefined,
            el('div', 'rh-k', undefined, STRINGS.guardProtocol),
            el('div', 'rh-v', undefined, `v${state.guard?.protocolVersion ?? 1}`)),
          el('div', undefined,
            el('div', 'rh-k', undefined, STRINGS.guardNetwork),
            el('div', 'rh-v', undefined, state.guard?.network === 'lan' ? STRINGS.netLan : STRINGS.netLoopback)),
          el('div', undefined,
            el('div', 'rh-k', undefined, STRINGS.singleCtrl),
            el('div', 'rh-v', { 'data-testid': 'single-controller' },
              state.guard?.singleController ? STRINGS.singleOnShort : STRINGS.singleOffShort)),
          el('div', undefined,
            el('div', 'rh-k', undefined, STRINGS.paired),
            el('div', 'rh-v', undefined, `${activeDevices.length} 台`)))
        : React.createElement(Notice, { 'data-testid': 'guard-error' },
          state.loading ? STRINGS.refreshing : (state.guardError ?? STRINGS.noGuard)),

      // 局域网地址列表（供其他设备填写；每个地址都可一键复制）
      state.lanCandidates !== undefined && state.lanCandidates.length > 0
        ? React.createElement('div', { className: 'rh-row', 'data-testid': 'lan-addresses', style: { marginTop: 12 } },
          React.createElement('span', { className: 'rh-k' }, `${STRINGS.listenHint}：`),
          ...state.lanCandidates.map(address => React.createElement(Pill, { key: address, tone: 'neutral' },
            React.createElement('code', { className: 'rh-mono' }, address),
            React.createElement(Button, {
              'data-testid': 'copy-address',
              'data-address': address,
              variant: 'ghost',
              size: 'small',
              title: STRINGS.copyAddress,
              children: STRINGS.copyAddress,
              onClick: () => actions.onCopy(address),
            }))))
        : null,

    ),
  })

  // ── 区块 3：设备区（筛选 + 入站分组 + 出站指向卡）────────────────────────
  const devicesCard = React.createElement(Section, {
    'data-testid': 'devices-section',
    title: React.createElement(React.Fragment, null,
      STRINGS.devicesZoneTitle,
      React.createElement(Pill, { tone: 'neutral', children: `${activeDevices.length} 台` })),
    actions: React.createElement(Segmented, {
      'data-testid': 'device-filter',
      ariaLabel: '设备筛选',
      value: state.deviceFilter,
      options: [
        { value: 'all', label: STRINGS.filterAll, testId: 'filter' },
        { value: 'inbound', label: STRINGS.filterInbound, testId: 'filter' },
      ],
      onChange: value => actions.onFilterChange(value as 'all' | 'inbound'),
    }),
    children: React.createElement(React.Fragment, null,
      state.deviceFilter === 'all' || state.deviceFilter === 'inbound'
        ? React.createElement('div', { className: 'rh-section' },
          React.createElement('div', { className: 'rh-section-head' },
            React.createElement('span', { className: 'rh-cfg-title' }, STRINGS.groupInbound),
            React.createElement('span', { className: 'rh-cfg-desc' }, STRINGS.groupInboundHint)),
          state.devices.length === 0
            ? React.createElement(EmptyState, {
              'data-testid': 'devices-empty',
              icon: '📭',
              title: state.loading ? STRINGS.devicesEmptyLoading : STRINGS.devicesEmptyTitle,
              desc: STRINGS.devicesEmpty,
            })
            : React.createElement('div', { className: 'rh-devgrid', 'data-testid': 'remote-hub-devices' },
              state.devices.map(device => renderDeviceCard(state, actions, device))))
        : null,
      state.deviceFilter === 'all'
        ? React.createElement('div', { className: 'rh-section' },
          React.createElement('div', { className: 'rh-section-head' },
            React.createElement('span', { className: 'rh-cfg-title' }, STRINGS.groupOutbound),
            React.createElement('span', { className: 'rh-cfg-desc' }, STRINGS.groupOutboundHint),
            React.createElement(Button, {
              'data-testid': 'connect-entry',
              variant: 'primary',
              size: 'small',
              style: { marginLeft: 'auto' },
              children: `+ ${STRINGS.filterOutbound}`,
              onClick: () => {
                const target = document?.querySelector('[data-testid="client-section"]')
                target?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
              },
            })),
          (state.outboundTargets ?? []).length === 0
            ? React.createElement('div', { className: 'rh-dev', 'data-testid': 'outbound-none' },
              React.createElement('div', { className: 'rh-dev-top' },
                React.createElement('div', { className: 'rh-dev-ico' }, '🔗'),
                React.createElement('div', { className: 'rh-dev-meta' },
                  React.createElement('div', { className: 'rh-dev-nm' }, STRINGS.notConnected),
                  React.createElement('div', { className: 'rh-dev-sub' }, STRINGS.clientSub))))
            : React.createElement('p', { className: 'rh-cfg-desc' },
              `已保存 ${(state.outboundTargets ?? []).length} 个目标，在「${STRINGS.clientTitle}」里选择连接。`))
        : null),
  })

  // ── 区块 4：统计区 ────────────────────────────────────────────────────────
  const statsCard = React.createElement(Section, {
    'data-testid': 'stats-section',
    title: STRINGS.statsTitle,
    actions: React.createElement(Pill, { tone: 'neutral', children: STRINGS.statsScope }),
    children: state.stats == null
      ? React.createElement('div', { 'data-testid': 'stats-unsupported', className: 'rh-empty' },
        state.statsError ?? STRINGS.statsUnsupported)
      : renderStatsBody(state),
  })

  // ── 区块 5：配置区 ────────────────────────────────────────────────────────
  const configCard = React.createElement(Section, {
    'data-testid': 'config-section',
    title: STRINGS.configTitle,
    actions: renderConfigSavedPill(state),
    children: state.config == null
      ? React.createElement('div', { 'data-testid': 'config-unsupported', className: 'rh-empty' }, STRINGS.configUnsupported)
      : renderConfigBody(state, actions),
  })

  // 账号草稿：旧版调用方可能没有该字段，这里给一个安全的空草稿。
  const accountDraft = state.accountDraft ?? { username: '', password: '', code: '', role: 'control' as RoleName }

  // 主控端卡片（区块 3 的「连接其他设备」；阶段 B 换成账号登录多步流）
  // 标题只放名称 + 状态 pill：IP / 已保存目标等**数据**一律进正文，避免挤占标题行。
  const clientCard = React.createElement(Section, {
    'data-testid': 'client-section',
    title: React.createElement(React.Fragment, null,
      STRINGS.clientTitle,
      React.createElement(Pill, {
        tone: isCloud ? 'online' : 'offline',
        dot: true,
        children: isCloud ? STRINGS.connected : STRINGS.notConnectedShort,
      })),
    desc: STRINGS.clientSub,
    children: React.createElement(React.Fragment, null,
      // ── 当前指向（地址/来源进正文，标题行保持干净）─────────────────────────
      React.createElement('div', {
        className: 'rh-fact',
        'data-testid': 'client-target',
      },
      React.createElement('span', { className: 'rh-fact-key' }, isCloud ? '已连接' : '当前指向'),
      React.createElement('span', { className: 'rh-fact-value' },
        isCloud
          ? `${state.mode.deviceLabel ?? state.mode.origin ?? STRINGS.modeCloud}`
          : ''),
      (state.mode.origin ?? '') === '' || !isCloud
        ? null
        : React.createElement('code', { className: 'rh-inline-code' }, state.mode.origin)),

      // ── 已连接时的说明与断开（3D）────────────────────────────────────────
      isCloud
        ? React.createElement('div', { className: 'rh-row', 'data-testid': 'connected-to' },
          React.createElement('span', { className: 'rh-k' },
            '当前数据面已切换到该设备：侧栏、会话、插件都读取那台机器的数据。'),
          React.createElement(Button, {
            'data-testid': 'detach',
            size: 'small',
            variant: 'danger',
            children: STRINGS.detach,
            onClick: () => actions.onDetach(),
          }))
        : React.createElement('p', { className: 'rh-k', 'data-testid': 'not-connected', style: { margin: 0 } }, STRINGS.notConnected),

      // ── 3A 未连接：目标地址 + 连接（已保存目标走 3C 卡片）──────────────────
      React.createElement(Field, {
        label: '目标地址',
        hint: '填写对端 DSH 守卫地址（IP:端口），例如 http://192.168.1.10:8443',
        children: React.createElement('div', { className: 'rh-row' },
          React.createElement(Input, {
            'data-testid': 'origin-input',
            ariaLabel: '目标设备地址',
            type: 'url',
            inputMode: 'url',
            autoComplete: 'url',
            placeholder: STRINGS.originPlaceholder,
            value: state.originDraft,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => actions.onOriginChange(event.currentTarget.value),
          }),
          React.createElement(Button, {
            'data-testid': 'connect',
            variant: 'primary',
            disabled: state.busy !== null,
            loading: state.busy === 'connect',
            children: state.busy === 'connect' ? STRINGS.connecting : STRINGS.connect,
            onClick: () => actions.onConnect(),
          })),
      }),
      state.originDraft.trim() !== '' && normalizeOrigin(state.originDraft) === undefined
        ? React.createElement(Notice, { 'data-testid': 'origin-invalid', tone: 'error' }, STRINGS.originInvalid)
        : null,

      // ── 已保存目标（3C）：用 keyring 里的绑定直连，无需再输口令 ────────────
      (state.outboundTargets ?? []).length > 0
        ? React.createElement('div', { style: { marginTop: 12 } },
          React.createElement('div', { className: 'rh-k' }, `已保存的目标（${state.outboundTargets.length}）`),
          renderOutboundCard(state, actions))
        : null,

      // ── 3B 首次连接：账号登录（MFA 在同一表单内切换，不跳页）───────────────
      React.createElement('hr', { className: 'rh-divider' }),
      React.createElement('div', { className: 'rh-row', 'data-testid': 'account-login-hint' },
        React.createElement('span', { className: 'rh-cfg-title' }, '用目标设备的账号登录'),
        React.createElement('span', { className: 'rh-k' }, '登录成功后本机公钥会被自动登记，之后重连不再需要 2FA')),
      React.createElement('div', { className: 'rh-row' },
        React.createElement(Field, {
          label: '用户名',
          children: React.createElement(Input, {
            'data-testid': 'account-user',
            ariaLabel: '对端账号',
            autoComplete: 'username',
            placeholder: '对端账号',
            value: accountDraft.username,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => actions.onAccountChange('username', event.currentTarget.value),
          }),
        }),
        React.createElement(Field, {
          label: '口令',
          children: React.createElement(PasswordInput, {
            'data-testid': 'account-password',
            ariaLabel: '对端口令',
            autoComplete: 'current-password',
            placeholder: '对端口令',
            value: accountDraft.password,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => actions.onAccountChange('password', event.currentTarget.value),
          }),
        })),
      React.createElement('div', { className: 'rh-row' },
        React.createElement(Field, {
          label: '动态码（目标要求 2FA 时填写）',
          children: React.createElement(Input, {
            'data-testid': 'account-code',
            ariaLabel: '两步验证码',
            inputMode: 'numeric',
            autoComplete: 'one-time-code',
            placeholder: '6 位验证码（可选）',
            value: accountDraft.code,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => actions.onAccountChange('code', event.currentTarget.value),
          }),
        }),
        React.createElement(Field, {
          label: '申请的角色',
          children: React.createElement(Select, {
            'data-testid': 'account-role',
            ariaLabel: '申请的角色',
            value: accountDraft.role,
            options: ROLES.map(role => ({ value: role, label: ROLE_LABEL[role] })),
            onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
              actions.onAccountChange('role', event.currentTarget.value),
          }),
        })),
      React.createElement('div', { className: 'rh-row' },
        React.createElement(Button, {
          'data-testid': 'account-connect',
          variant: 'primary',
          disabled: state.busy !== null
            || normalizeOrigin(state.originDraft) === undefined
            || accountDraft.username.trim() === ''
            || accountDraft.password === '',
          loading: state.busy === 'account',
          children: state.busy === 'account' ? '登录中…' : '登录并信任本机',
          onClick: () => actions.onAccountConnect(),
        })),
    ),
  })

  return React.createElement(
    'div',
    { className: 'rh-root rh-scroll', 'data-testid': 'remote-hub-page', 'data-mode': state.mode.mode, 'data-rh-scope': '' },
    // 设计系统样式表（token + 组件类 + 响应式）：幂等注入；外部可预先覆盖 --rh-*。
    ThemeStyle(RH_CSS),

    // 内容壳：限宽居中（背景由 .rh-root 全幅铺满）
    React.createElement('div', { className: 'rh-shell' },
      pageHead,
      hostCard,
      devicesCard,
      clientCard,
      statsCard,
      configCard,

      // 错误条
      state.error === null
        ? null
        : React.createElement(Notice, { 'data-testid': 'page-error', role: 'alert', tone: 'error' },
          `⚠️ ${state.error}`),

      // 守卫诊断（故障时默认展开：用户不必打开开发者工具）
      renderDiagnosticCard(state),

      // 运行日志（最近 30 条时间线；有错误时默认展开）
      renderLogCard(state),

      // 高级（折叠收纳）
      React.createElement(Collapse, { summary: STRINGS.advanced },
        React.createElement('ul', null,
          React.createElement('li', null, `存储键：${MODE_KEY}`),
          React.createElement('li', null, `守卫地址：${state.guard?.origin ?? '（未检测到）'}`),
          React.createElement('li', null, `协议版本：${state.guard?.protocolVersion ?? 1}（X-Hub-Protocol）`)))),
  )
}

// ── 守卫诊断卡 ────────────────────────────────────────────────────────────────

/**
 * 守卫诊断卡：把「页面连的是哪个守卫实例、注入是否新鲜、最近请求失败在哪一层」
 * 一次性摊开，避免用户只能看到 `Failed to fetch`。
 *
 * 安全：只展示 pin 是否存在（布尔），绝不渲染凭据内容。
 * @param state - 页面状态。
 * @returns React 节点。
 */
/**
 * 整机接管状态行（诊断卡内）。
 *
 * 直接读取页面全局 `__DSH_TRANSPORT__`，回答「carrier 到底生效了没有」——
 * 这是排障时最常被问、也最难从页面看出来的事实。
 * @param state - 页面状态。
 * @returns 一组 div（无接管信息时返回空数组）。
 */
function renderTakeoverRow(state: RemoteHubPageState): React.ReactNode[] {
  const transport = (globalThis as unknown as {
    __DSH_TRANSPORT__?: {
      fetch?: unknown
      createWebSocket?: unknown
      streamBaseUrl?: string
      ownsHost?: boolean
      openStream?: unknown
    }
  }).__DSH_TRANSPORT__
  const installed = typeof transport?.fetch === 'function'
    && typeof transport?.createWebSocket === 'function'
  const cloud = state.mode.mode === 'cloud'
  return [
    el('div', undefined,
      el('div', 'rh-k', undefined, STRINGS.diagTakeover),
      el('div', 'rh-v', { 'data-testid': 'diag-takeover' },
        !cloud
          ? STRINGS.diagTakeoverLocal
          : installed
            ? STRINGS.diagTakeoverOn
            : STRINGS.diagTakeoverOff)),
    el('div', undefined,
      el('div', 'rh-k', undefined, STRINGS.diagStreamBase),
      el('div', 'rh-v', { 'data-testid': 'diag-stream-base' }, transport?.streamBaseUrl ?? '—')),
  ]
}

function renderDiagnosticCard(state: RemoteHubPageState): React.ReactNode {
  const injection = state.injection
  const diagnostic = state.diagnostic ?? null
  const pageOrigin = (globalThis.location as { origin?: string } | undefined)?.origin ?? '（非浏览器）'
  const healthy = state.guard !== null
  return React.createElement('details', {
    className: 'rh-collapse',
    'data-testid': 'guard-diagnostic',
    ...(healthy ? {} : { open: true }),
  },
  React.createElement('summary', undefined, STRINGS.diagTitle),
  el('div', 'rh-kv rh-diagnostic-grid', { 'data-testid': 'diagnostic-grid', style: { padding: '0 16px', marginTop: 8 } },
    el('div', undefined,
      el('div', 'rh-k', undefined, STRINGS.diagPageOrigin),
      el('div', 'rh-v', undefined, pageOrigin)),
    el('div', undefined,
      el('div', 'rh-k', undefined, STRINGS.diagTargetOrigin),
      el('div', 'rh-v', { 'data-testid': 'diag-target-origin' }, diagnostic?.origin ?? injection?.loopbackOrigin ?? '—')),
    el('div', undefined,
      el('div', 'rh-k', undefined, STRINGS.diagPin),
      el('div', 'rh-v', { 'data-testid': 'diag-pin' },
        injection?.hasPin === true ? STRINGS.diagPinYes : STRINGS.diagPinNo)),
    el('div', undefined,
      el('div', 'rh-k', undefined, STRINGS.diagInstance),
      el('div', 'rh-v', undefined, injection?.instanceId === '' ? '—' : (injection?.instanceId ?? '—'))),
    el('div', undefined,
      el('div', 'rh-k', undefined, STRINGS.diagPid),
      el('div', 'rh-v', undefined, injection?.pid === null || injection?.pid === undefined ? '—' : String(injection.pid))),
    el('div', undefined,
      el('div', 'rh-k', undefined, STRINGS.diagInjectedAt),
      el('div', 'rh-v', undefined, injection?.injectedAt === '' ? '—' : (injection?.injectedAt ?? '—'))),
    el('div', undefined,
      el('div', 'rh-k', undefined, STRINGS.diagAge),
      el('div', 'rh-v', undefined,
        injection?.ageSeconds === null || injection?.ageSeconds === undefined
          ? '—'
          : `${injection.ageSeconds}s`))),
  // 整机接管状态：carrier 是否已把 transport 指向远端。
  el('div', 'rh-diag', { 'data-testid': 'diagnostic-transport-grid', style: { padding: '0 16px' } }, ...renderTakeoverRow(state)),
  el('div', 'rh-kv rh-diagnostic-grid', { 'data-testid': 'diagnostic-request-grid', style: { padding: '0 16px' } },
    el('div', undefined,
      el('div', 'rh-k', undefined, STRINGS.diagLastRequest),
      el('div', 'rh-v', { 'data-testid': 'diag-last-request' }, diagnostic === null
        ? STRINGS.diagNoRequest
        : `${diagnostic.method} ${diagnostic.path}`)),
    el('div', undefined,
      el('div', 'rh-k', undefined, STRINGS.diagStatus),
      el('div', 'rh-v', { 'data-testid': 'diag-status' }, diagnostic === null
        ? '—'
        : `${diagnostic.status} · ${diagnostic.kind}`)),
    el('div', undefined,
      el('div', 'rh-k', undefined, STRINGS.diagRetry),
      el('div', 'rh-v', { 'data-testid': 'diag-retry' }, state.retry === undefined || state.retry.nextRetryAt === null
        ? STRINGS.diagRetryIdle
        : `第 ${state.retry.attempts} 次 · 下次 ${Math.max(0, Math.ceil((state.retry.nextRetryAt - state.now) / 1000))}s`))),
  diagnostic?.code === undefined
    ? null
    : el('p', 'rh-cold', { style: { padding: '0 16px', margin: '4px 0 0' }, 'data-testid': 'diag-code' },
      `${diagnostic.code}${diagnostic.message === undefined ? '' : `：${diagnostic.message}`}`),
  el('p', 'rh-cold', { style: { padding: '0 16px', margin: '6px 0 12px' } }, STRINGS.diagApiHint))
}

/** 出站状态轮询间隔：2 秒（足够快感知 CLI 配对，几乎无开销）。 */
export const CARRIER_POLL_MS = 2_000

/**
 * 把磁盘上的出站状态收敛成 `CarrierMode`（非法形状一律回落到本机）。
 * @param raw - 磁盘 JSON 解析结果。
 * @returns 合法状态。
 */
export function normalizeCarrier(raw: Record<string, unknown> | null | undefined): CarrierMode {
  if (raw === null || raw === undefined || raw.mode !== 'cloud') return { mode: 'local' }
  if (typeof raw.origin !== 'string' || raw.origin === '') return { mode: 'local' }
  return {
    mode: 'cloud',
    origin: raw.origin,
    ...(typeof raw.targetId === 'string' && raw.targetId !== '' ? { targetId: raw.targetId } : {}),
    ...(typeof raw.token === 'string' && raw.token !== '' ? { token: raw.token } : {}),
    ...(typeof raw.deviceLabel === 'string' && raw.deviceLabel !== '' ? { deviceLabel: raw.deviceLabel } : {}),
  }
}

/**
 * 两个出站状态是否等价（用于避免无意义的重写与重渲染）。
 * @param a - 状态 A。
 * @param b - 状态 B。
 * @returns 等价时为 true。
 */
export function carrierEquals(a: CarrierMode, b: CarrierMode): boolean {
  if (a.mode !== b.mode) return false
  if (a.mode === 'local') return true
  if (a.origin !== b.origin) return false
  if (a.targetId !== undefined || b.targetId !== undefined) return a.targetId === b.targetId
  if (a.token === undefined || b.token === undefined) return true
  return a.token === b.token && (a.deviceLabel ?? '') === (b.deviceLabel ?? '')
}

// ── 运行日志卡 ────────────────────────────────────────────────────────────────

/**
 * 运行日志卡：把页面侧发生的事（请求成功/失败/签发/配置保存）按时间线摊开。
 *
 * 为什么需要：`Failed to fetch` 之外的失败（签发被拒、配置保存 400、注入缺失）
 * 以前只体现在某个局部区域，用户无法拼出因果链。这里是**唯一**的排障时间线。
 * 安全：日志由 transport 与页面在写入时就已脱敏，不含 pin/ticket/token。
 * @param state - 页面状态。
 * @returns React 节点。
 */
function renderLogCard(state: RemoteHubPageState): React.ReactNode {
  const logs = [...(state.logs ?? [])].reverse().slice(0, 30)
  const count = state.logs?.length ?? 0
  return React.createElement('details', {
    className: 'rh-collapse',
    'data-testid': 'run-log',
    ...(count > 0 && logs.some(entry => entry.level === 'error') ? { open: true } : {}),
  },
  React.createElement('summary', undefined, `${STRINGS.logTitle}${count > 0 ? `（${count}）` : ''}`),
  logs.length === 0
    ? el('p', 'rh-cold', { style: { padding: '0 16px 14px', margin: 0 } }, STRINGS.logEmpty)
    : el('div', 'rh-loglist', { 'data-testid': 'run-log-list', style: { padding: '0 16px 14px' } },
      logs.map((entry, index) => el('div', `rh-logrow rh-log-${entry.level}`, {
        key: `${entry.at}-${index}`,
        'data-level': entry.level,
      },
      el('span', 'rh-logtime', undefined, new Date(entry.at).toLocaleTimeString()),
      el('span', 'rh-loglevel', undefined,
        entry.level === 'error' ? STRINGS.logLevelError
          : entry.level === 'warn' ? STRINGS.logLevelWarn : STRINGS.logLevelInfo),
      el('span', 'rh-logtitle', undefined, entry.title),
      entry.path === undefined ? null : el('span', 'rh-logpath', undefined, entry.path),
      entry.detail === undefined ? null : el('span', 'rh-logdetail', undefined, entry.detail)))))
}

// ── ② 设备区子渲染 ────────────────────────────────────────────────────────────

/**
 * 设备三态（2026-11-12 修订）。
 *
 * 用户要求区分三种状态，语义边界如下：
 *
 * | 状态 | 判据 | 含义 |
 * | --- | --- | --- |
 * | `invalid` | `revokedAt` 非空 | **配对失效** —— 用户删除了配对，须重新扫码 |
 * | `connected` | 未失效且 60s 内有心跳 | **已连接** —— 正在控制/被控制 |
 * | `paired` | 未失效且无近期心跳 | **已配对** —— 配对仍在，但当前离线 |
 *
 * 关键：被单控策略挤下线的设备**仍是 `paired`**（不是 `invalid`），
 * 因为它的令牌没有被吊销（见 host/guard.ts 的 displaceOthers）。
 *
 * @param device - 设备行。
 * @param now - 当前时间（毫秒）。
 * @returns 三态之一，外加 `idle`（10 分钟内的空闲态，UI 显示为已连接）。
 */
export function deviceStatus(
  device: CloudDeviceRow,
  now: number,
): 'connected' | 'idle' | 'paired' | 'invalid' {
  if (device.revokedAt != null) return 'invalid'
  if (device.lastSeenAt == null) return 'paired'
  const delta = now - Date.parse(device.lastSeenAt)
  if (Number.isNaN(delta)) return 'paired'
  // 60s 内 = 已连接；10 分钟内 = 空闲（仍算在线）；其余视为已配对但离线。
  if (delta < 60_000) return 'connected'
  if (delta < 600_000) return 'idle'
  return 'paired'
}

/** 设备是否处于在线状态（connected 或 idle）。 */
export function isDeviceOnline(device: CloudDeviceRow, now: number): boolean {
  const status = deviceStatus(device, now)
  return status === 'connected' || status === 'idle'
}

/** 单张设备卡（入站）。 */
function renderDeviceCard(
  state: RemoteHubPageState,
  actions: RemoteHubPageActions,
  device: CloudDeviceRow,
): React.ReactNode {
  const status = deviceStatus(device, state.now)
  const invalid = status === 'invalid'
  // 三态：已连接 / 已配对 / 配对失效（2026-11-12）。
  const connected = status === 'connected' || status === 'idle'
  const statusLabel = status === 'invalid' ? STRINGS.statusInvalid
    : connected ? STRINGS.statusConnected
      : STRINGS.statusPaired
  const pillCls = invalid ? 'off' : connected ? 'on' : 'off'
  return el('div', `rh-dev${invalid ? ' revoked' : ''}${connected ? '' : ' offline'}`, {
    key: device.deviceId,
    'data-device-id': device.deviceId,
    'data-role': device.role ?? '',
    'data-revoked': invalid ? 'true' : 'false',
    'data-status': status,
    'data-online': connected ? 'true' : 'false',
  },
  el('div', 'rh-dev-top', undefined,
    el('div', 'rh-dev-ico', undefined, invalid ? '🚫' : connected ? '🖥️' : '💤'),
    el('div', 'rh-dev-meta', undefined,
      el('div', 'rh-dev-nm', undefined, device.label ?? device.deviceId),
      el('div', 'rh-dev-sub', undefined, device.deviceId)),
    el('span', `rh-pill ${pillCls}`, {
      'data-testid': 'device-status',
      'data-status': status,
    }, el('span', 'rh-dot'), statusLabel)),
  el('div', 'rh-kv', { style: { margin: '2px 0' } },
    device.username === undefined || device.username === null
      ? null
      : el('div', undefined,
        el('div', 'rh-k', undefined, STRINGS.devAccount),
        el('div', 'rh-v', { 'data-testid': 'device-account' }, `账号 ${device.username}`)),
    device.role
      ? el('div', undefined,
        el('div', 'rh-k', undefined, STRINGS.devRole),
        el('div', 'rh-v', undefined, ROLE_LABEL[device.role as RoleName] ?? device.role))
      : null,
    device.lastSeenAt
      ? el('div', undefined,
        el('div', 'rh-k', undefined, STRINGS.devLastSeen),
        el('div', 'rh-v', undefined, formatTime(device.lastSeenAt)))
      : null,
    device.createdAt
      ? el('div', undefined,
        el('div', 'rh-k', undefined, STRINGS.devCreatedAt),
        el('div', 'rh-v', undefined, new Date(device.createdAt).toLocaleDateString()))
      : null),
  // 状态由右上角三态标签表达，不再额外堆叠文字说明。
  // 权限上限与撤销属于**身份管理**：统一在「设置 → 登录与账号」里做，
  // 运行页只保留状态与连接事实，避免两处都能改权限而语义漂移。
  el('div', 'rh-dev-foot', undefined,
    el('span', {
      'data-testid': 'manage-in-settings',
      style: { fontSize: 'var(--rh-fs-label)', color: 'var(--rh-text-2)' },
    }, STRINGS.manageInSettings)))
}

/** Display only recorded trust facts; legacy missing metadata remains unknown. */
function renderOutboundFacts(target?: OutboundTarget): React.ReactNode {
  const time = (value?: number): string => value === undefined ? '未知（旧记录未保存）' : new Date(value).toLocaleString()
  return el('div', 'rh-kv', { 'data-testid': 'outbound-facts' },
    React.createElement('div', null, '授权角色：', target?.role ? (ROLE_LABEL[target.role as RoleName] ?? target.role) : '未知（需重新信任确认）'),
    React.createElement('div', null, '信任时间：', time(target?.pairedAt)),
    React.createElement('div', null, '最近连接：', time(target?.lastConnectedAt)),
    React.createElement('div', null, '客户端标识：', target?.deviceId ?? target?.id?.slice(0, 12) ?? '未知'))
}

/** 出站分组内容卡（本机指向；不伪造设备列表）。 */
function renderOutboundCard(state: RemoteHubPageState, actions: RemoteHubPageActions): React.ReactNode {
  const isCloud = state.mode.mode === 'cloud'
  if (isCloud) {
    const currentTarget = state.mode.targetId
      ?? (state.mode.origin && state.mode.token
        ? outboundTargetIdentity({ origin: state.mode.origin, token: state.mode.token })
        : undefined)
    const otherTargets = (state.outboundTargets ?? []).filter(target => outboundTargetIdentity(target) !== currentTarget)
    const currentCard = el('div', 'rh-dev', { 'data-testid': 'outbound-current' },
      el('div', 'rh-dev-top', undefined,
        el('div', 'rh-dev-ico', undefined, '☁️'),
        el('div', 'rh-dev-meta', undefined,
          el('div', 'rh-dev-nm', undefined, state.mode.deviceLabel ?? STRINGS.modeCloud),
          el('div', 'rh-dev-sub', undefined, state.mode.origin ?? '')),
        el('span', 'rh-pill is-online', undefined, el('span', 'rh-dot'), STRINGS.connected)),
      renderOutboundFacts((state.outboundTargets ?? []).find(target => outboundTargetIdentity(target) === currentTarget)),
      el('div', 'rh-dev-foot', undefined,
        el('button', 'rh-btn is-small is-danger', {
          type: 'button', 'data-testid': 'detach-inline',
          onClick: () => actions.onDetach(),
        }, STRINGS.detach)))
    const otherCards = otherTargets.map(target => el('div', 'rh-dev is-offline', {
      key: outboundTargetIdentity(target),
      'data-testid': 'outbound-paired',
      'data-origin': target.origin,
      'data-status': 'paired',
    },
      el('div', 'rh-dev-top', undefined,
        el('div', 'rh-dev-ico', undefined, '💤'),
        el('div', 'rh-dev-meta', undefined,
          el('div', 'rh-dev-nm', undefined, outboundTargetTitle(target)),
          el('div', 'rh-dev-sub', undefined, outboundTargetMeta(target, state.outboundTargets))),
        el('span', 'rh-pill is-offline', undefined, el('span', 'rh-dot'), STRINGS.statusPaired)),
      renderOutboundFacts(target),
      actions.onForgetOutbound ? el('button', 'rh-btn is-small is-danger', {
        type: 'button', 'data-testid': 'outbound-delete', disabled: state.busy !== null,
        onClick: () => actions.onForgetOutbound?.(target),
      }, '删除配对 / Delete') : null,
      el('div', 'rh-dev-foot', undefined,
        el('button', 'rh-btn is-small is-primary', {
          type: 'button', 'data-testid': 'reconnect',
          disabled: state.busy !== null,
          onClick: () => actions.onReconnect(target),
        }, STRINGS.connect))))
    return React.createElement(React.Fragment, null, currentCard, ...otherCards)
  }

  const paired = state.outboundTargets ?? []
  return el('div', 'rh-devgrid', { 'data-testid': 'outbound-paired-list' },
    paired.map(target => el('div', 'rh-dev is-offline', {
        key: outboundTargetIdentity(target),
        'data-testid': 'outbound-paired',
        'data-origin': target.origin,
        'data-status': 'paired',
      },
        el('div', 'rh-dev-top', undefined,
          el('div', 'rh-dev-ico', undefined, '💤'),
          el('div', 'rh-dev-meta', undefined,
            el('div', 'rh-dev-nm', undefined, outboundTargetTitle(target)),
            el('div', 'rh-dev-sub', undefined, outboundTargetMeta(target, state.outboundTargets))),
          el('span', 'rh-pill is-offline', undefined, el('span', 'rh-dot'), STRINGS.statusPaired)),
        renderOutboundFacts(target),
        el('div', 'rh-dev-foot', undefined,
          el('button', 'rh-btn is-small is-primary', {
            type: 'button', 'data-testid': 'reconnect',
            disabled: state.busy !== null,
            onClick: () => actions.onReconnect(target),
          }, STRINGS.connect),
          actions.onForgetOutbound ? el('button', 'rh-btn is-small is-danger', {
            type: 'button', 'data-testid': 'outbound-delete', disabled: state.busy !== null,
            onClick: () => actions.onForgetOutbound?.(target),
          }, '删除配对 / Delete') : null))))
}

// ── ③ 统计区子渲染 ────────────────────────────────────────────────────────────

/** 运行时长文案（如 2h 14m）。 */
function formatUptime(startedAt: string, now: number): string {
  const at = Date.parse(startedAt)
  if (Number.isNaN(at)) return '—'
  let seconds = Math.max(0, Math.floor((now - at) / 1000))
  const days = Math.floor(seconds / 86_400)
  seconds -= days * 86_400
  const hours = Math.floor(seconds / 3_600)
  seconds -= hours * 3_600
  const minutes = Math.floor(seconds / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/** SVG 折线（近 N 桶；颜色经 token）。 */
function renderLineChart(values: readonly number[], width = 320, height = 96): React.ReactNode {
  const max = Math.max(1, ...values)
  const step = values.length > 1 ? width / (values.length - 1) : width
  const points = values.map((value, index) =>
    `${index * step},${height - 8 - (value / max) * (height - 16)}`).join(' ')
  return React.createElement('svg', {
    viewBox: `0 0 ${width} ${height}`, style: { width: '100%', height: 'auto', display: 'block' },
    role: 'img', 'data-testid': 'chart-line',
  },
  [0.25, 0.5, 0.75].map(ratio => React.createElement('line', {
    key: ratio, x1: 0, x2: width, y1: height * ratio, y2: height * ratio,
    stroke: 'var(--rh-border)', strokeWidth: 1,
  })),
  React.createElement('polyline', {
    points, fill: 'none', stroke: 'var(--rh-primary)', strokeWidth: 2.5,
    strokeLinejoin: 'round', strokeLinecap: 'round',
  }))
}

/** SVG 柱状（7 日）。 */
function renderBarChart(values: readonly number[], width = 200, height = 96): React.ReactNode {
  const max = Math.max(1, ...values)
  const gap = 8
  const barWidth = (width - gap * (values.length - 1)) / values.length
  return React.createElement('svg', {
    viewBox: `0 0 ${width} ${height}`, style: { width: '100%', height: 'auto', display: 'block' },
    role: 'img', 'data-testid': 'chart-bar',
  },
  values.map((value, index) => {
    const h = (value / max) * (height - 12)
    return React.createElement('rect', {
      key: index, x: index * (barWidth + gap), y: height - h, width: barWidth, height: h,
      rx: 3, fill: 'var(--rh-primary)', opacity: value === Math.max(...values) ? 1 : 0.55,
    })
  }))
}

/** 统计区主体：4 卡 + 折线/柱状 + 热力。 */
function renderStatsBody(state: RemoteHubPageState): React.ReactNode {
  const stats = state.stats as HubMetrics
  const activeDevices = state.devices.filter(device =>
    device.revokedAt == null && isDeviceOnline(device, state.now)).length
  const maxHour = Math.max(1, ...stats.hourly)
  return el('div', undefined, { 'data-testid': 'stats-body' },
    el('div', 'rh-statgrid', undefined,
      el('div', 'rh-stat', { 'data-testid': 'stat-uptime' },
        el('div', 'rh-slbl', undefined, STRINGS.statUptime),
        el('div', 'rh-snum', undefined, formatUptime(stats.startedAt, state.now)),
        el('div', 'rh-scap', undefined, new Date(stats.startedAt).toLocaleTimeString())),
      el('div', 'rh-stat', { 'data-testid': 'stat-active' },
        el('div', 'rh-slbl', undefined, STRINGS.statActive),
        el('div', 'rh-snum', undefined, String(activeDevices)),
        el('div', 'rh-scap', undefined, `${state.devices.filter(d => d.revokedAt == null).length} ${STRINGS.paired}`)),
      el('div', 'rh-stat', undefined,
        el('div', 'rh-slbl', undefined, STRINGS.statPaired),
        el('div', 'rh-snum', undefined, String(stats.pairRedeemed)),
        el('div', 'rh-scap', undefined, `${STRINGS.statActiveStreams}: ${stats.activeStreams}`)),
      el('div', 'rh-stat', undefined,
        el('div', 'rh-slbl', undefined, STRINGS.statRejected),
        el('div', 'rh-snum', undefined, String(stats.pairRejected)),
        el('div', 'rh-scap', undefined, `auth: ${stats.authAccepted} / denied: ${stats.authDenied}`))),
    el('div', 'rh-chartgrid', undefined,
      el('div', 'rh-chartbox', undefined,
        el('div', 'rh-ct', undefined, STRINGS.chartActivity),
        el('div', 'rh-cs', undefined, STRINGS.chartActivitySub),
        renderLineChart(stats.hourly)),
      el('div', 'rh-chartbox', undefined,
        el('div', 'rh-ct', undefined, STRINGS.chartPairing),
        el('div', 'rh-cs', undefined, STRINGS.chartPairingSub),
        renderBarChart(stats.daily))),
    el('div', 'rh-chartbox', { style: { marginTop: 'var(--rh-gap)' } },
      el('div', 'rh-ct', undefined, STRINGS.chartHeat),
      el('div', 'rh-cs', undefined, STRINGS.chartHeatSub),
      el('div', 'rh-heat', { 'data-testid': 'chart-heat' },
        stats.hourly.map((value, index) => React.createElement('i', {
          key: index,
          ...(value > 0
            ? { style: { background: 'var(--rh-primary)', opacity: String(0.25 + 0.75 * (value / maxHour)) } }
            : {}),
        })))))
}

// ── ④ 配置区子渲染 ────────────────────────────────────────────────────────────

/** 保存状态胶囊。 */
function renderConfigSavedPill(state: RemoteHubPageState): React.ReactNode {
  if (state.configSaving) return el('span', 'rh-pill', undefined, STRINGS.configSavingLbl)
  const dirty = state.configDraft !== null
    && JSON.stringify(state.configDraft) !== JSON.stringify(state.config)
  if (dirty) {
    return el('span', 'rh-pill is-error', { 'data-testid': 'config-dirty' }, STRINGS.configUnsaved)
  }
  return state.configSavedAt !== null
    ? el('span', 'rh-pill is-online', { 'data-testid': 'config-saved' }, STRINGS.configSaved)
    : null
}

/** 行式配置主体（开关 / 下拉 / 数字输入 + 冷项展示）。 */
function renderConfigBody(state: RemoteHubPageState, actions: RemoteHubPageActions): React.ReactNode {
  const draft = state.configDraft ?? {}
  const value = (key: string): unknown => draft[key]
  const boolRow = (key: 'singleController' | 'bridgeApprovals', title: string, desc: string, testid: string) =>
    el('div', 'rh-cfg-row', undefined,
      el('div', 'rh-cfg-label', undefined,
        el('div', 'rh-cfg-title', undefined, title),
        el('div', 'rh-cfg-desc', undefined, desc)),
      el('div', 'rh-cfg-control', undefined,
        el('button', `rh-switch ${value(key) === true ? 'on' : ''}`, {
          type: 'button', role: 'switch', 'aria-checked': value(key) === true ? 'true' : 'false',
          'data-testid': testid,
          onClick: () => actions.onConfigChange(key, !(value(key) === true)),
        }, el('i'))))
  return el('div', undefined, { 'data-testid': 'config-body' },
    el('div', 'rh-cfg', undefined,
      boolRow('singleController', STRINGS.cfgSingle, STRINGS.cfgSingleDesc, 'cfg-single'),
      boolRow('bridgeApprovals', STRINGS.cfgBridge, STRINGS.cfgBridgeDesc, 'cfg-bridge'),
      el('div', 'rh-cfg-row', undefined,
        el('div', 'rh-cfg-label', undefined,
          el('div', 'rh-cfg-title', undefined, STRINGS.cfgRole),
          el('div', 'rh-cfg-desc', undefined, STRINGS.cfgRoleDesc)),
        el('div', 'rh-cfg-control', undefined,
          el('select', 'rh-select', {
            'data-testid': 'cfg-role', value: String(value('defaultRole') ?? 'control'),
            onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
              actions.onConfigChange('defaultRole', event.currentTarget.value),
          },
          ROLES.map(role => el('option', { key: role, value: role }, ROLE_LABEL[role]))))),
      el('div', 'rh-cfg-row', undefined,
        el('div', 'rh-cfg-label', undefined,
          el('div', 'rh-cfg-title', undefined, STRINGS.cfgAttempts),
          el('div', 'rh-cfg-desc', undefined, STRINGS.cfgAttemptsDesc)),
        el('div', 'rh-cfg-control', undefined,
          el('input', 'rh-input', {
            type: 'number', min: 1, max: 100, 'data-testid': 'cfg-attempts',
            value: String(value('maxPairAttempts') ?? 5),
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
              const parsed = Number.parseInt(event.currentTarget.value, 10)
              if (!Number.isNaN(parsed)) actions.onConfigChange('maxPairAttempts', parsed)
            },
          })))),
    // 冷项（可改，但需重启 dsh web 生效）
    el('div', 'rh-cold', undefined,
      // 注意：`el` 的第二个参数是 className；纯文本节点必须带一个类名，
      // 否则文本会被当成 className（2026-11-15 实测）。
      el('span', 'rh-muted', STRINGS.cfgColdNote),
      value('restartPending') === true
        ? el('span', 'rh-pill is-error', { 'data-testid': 'restart-pending' }, STRINGS.cfgRestartPending)
        : null),
    // 与热项同样的卡片 + 行样式（`rh-cfg` 提供内边距/分隔线/字号继承）。
    el('div', 'rh-cfg', undefined,
      el('div', 'rh-cfg-row', undefined,
        el('div', 'rh-cfg-label', undefined,
          el('div', 'rh-cfg-title', undefined, '网络模式'),
          el('div', 'rh-cfg-desc', undefined, STRINGS.cfgNetworkDesc)),
        el('div', 'rh-cfg-control', undefined,
          el('select', 'rh-select', {
            'data-testid': 'cfg-network',
            value: String(value('network') ?? 'loopback'),
            onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
              actions.onConfigChange('network', event.currentTarget.value),
          },
          el('option', { value: 'loopback' }, STRINGS.netLoopback),
          el('option', { value: 'lan' }, STRINGS.netLan)))),
      el('div', 'rh-cfg-row', undefined,
        el('div', 'rh-cfg-label', undefined,
          el('div', 'rh-cfg-title', undefined, STRINGS.cfgPort),
          el('div', 'rh-cfg-desc', undefined, STRINGS.cfgPortDesc)),
        el('div', 'rh-cfg-control', undefined,
          el('input', 'rh-input', {
            type: 'number', min: 1, max: 65_535, 'data-testid': 'cfg-port',
            value: String(value('guardPort') ?? ''),
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
              const parsed = Number.parseInt(event.currentTarget.value, 10)
              if (!Number.isNaN(parsed)) actions.onConfigChange('guardPort', parsed)
            },
          })))),
    el('div', 'rh-kv', { style: { marginTop: 12 } },
      el('div', undefined,
        el('div', 'rh-k', undefined, STRINGS.cfgTtl),
        el('div', 'rh-v', undefined, `${Math.round(Number(value('pairQrTtlMs') ?? 0) / 1000)}s`)),
      el('div', undefined,
        el('div', 'rh-k', undefined, '票据轮换'),
        el('div', 'rh-v', undefined, `${Math.round(Number(value('pairCodeTtlMs') ?? 0) / 1000)}s`)),
      el('div', undefined,
        el('div', 'rh-k', undefined, STRINGS.cfgTunnel),
        el('div', 'rh-v', undefined, String(value('tunnelKind') ?? '—')))),
    el('div', 'rh-row', undefined,
      el('button', 'rh-btn is-primary', {
        type: 'button', 'data-testid': 'config-save',
        disabled: state.configSaving,
        onClick: () => actions.onConfigSave(),
      }, state.configSaving ? STRINGS.configSavingLbl : STRINGS.configSave)))
}

/**
 * 签发结果块：同时展示**二维码 + 短码 + 链接**（三者等价，任选其一）。
 *
 * 历史问题（2026-11-12 实机）：
 * - 只签发了一种凭据时，另一种无处显示，用户不知道还有别的选择；
 * - 票据为 null 链接时落到短码分支，把 43 字符票据当「配对短码」渲染，
 *   且等宽 24px 字距拉不开 → 横向溢出。
 *
 * 现在：一个块内并列展示二维码、短码（就绪或占位）、链接（就绪或占位），
 * 所有等宽文本 `word-break: break-all` + `max-width: 100%`，窄屏自动换行。
 *
 * @param state - 页面状态。
 * @param actions - 页面动作。
 * @param link - 票据对应的配对链接（无票据时为 null）。
 * @returns React 节点。
 */

/** 倒计时用的「最近一次签发」（票据优先，其次短码）。 */
/** 签发倒计时进度（0–1，按签发类型的有效期归一）。 */
/** 倒计时文案（含角色）。 */
/** 时间显示：相对最近。 */
function formatTime(iso: string): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return '未知'
  const delta = Date.now() - at
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
  return new Date(at).toLocaleDateString()
}

// ── 组件 ─────────────────────────────────────────────────────────────────────

/** index 页注入的全局（host `webserver/index-inject` 写入）。 */
export interface HubInjected {
  pairIssueToken?: string
  /** 对外可用地址（LAN 模式是 LAN IP）。 */
  guardOrigin?: string
  /** 本机签发/设备管理用的回环地址。 */
  loopbackOrigin?: string
  /** 守卫实例标识（host 注入；用于确认页面连的是当前实例）。 */
  instanceId?: string
  /** host 进程 pid。 */
  pid?: number
  /** 注入时间（ISO）。 */
  injectedAt?: string
  /** 协议版本。 */
  protocolVersion?: number
  devices?: readonly CloudDeviceRow[]
}

/** 注入握手诊断（页面展示；pin 只显示「已注入/未注入」）。 */
export interface InjectionDiagnostic {
  /** 是否拿到 pairIssueToken。 */
  hasPin: boolean
  guardOrigin: string
  loopbackOrigin: string
  instanceId: string
  pid: number | null
  injectedAt: string
  protocolVersion: number | null
  /** 注入时间与页面加载时间差（秒）；过大说明页面拿到的是旧注入。 */
  ageSeconds: number | null
}

/** 管理请求诊断（页面展示；与 transport 的 AdminRequestDiagnostic 同形）。 */
export interface AdminDiagnostic {
  path: string
  method: string
  origin: string
  pageOrigin: string
  status: number
  kind: string
  code?: string
  message?: string
  at: number
}

/** 一条页面日志（与 transport 的 HubLogEntry 同形）。 */
export interface HubLogEntry {
  at: number
  level: 'info' | 'warn' | 'error'
  title: string
  detail?: string
  path?: string
}

/** 组件依赖（可注入，便于测试）。 */
export interface RemoteHubPageDeps {
  injected: () => HubInjected
  /** 读本机被控端状态（守卫 /remote/devices）。 */
  listDevices: () => Promise<{
    guard: { host: string; port: number; origin: string }
    protocolVersion: number
    singleController: boolean
    devices: readonly CloudDeviceRow[]
  }>
  /** 清除配对。 */
  revokeDevices: (input: { deviceId?: string; all?: boolean }) => Promise<{ revoked: string[] }>
  /** 出站连接状态读写（`carrier-mode.json`；磁盘为真源，CLI 连接也能被页面感知）。 */
  carrier?: () => Promise<{ mode: Record<string, unknown>; at: number }>
  carrierWrite?: (mode: Record<string, unknown>) => Promise<number>
  listOutboundTargets?: () => Promise<readonly OutboundTarget[]>
  /**
   * 用**对端账号**登录并信任本浏览器（账号认证模式）。
   *
   * 内部完成：跨源 `/remote-auth/*`（头会话）→ 登录/二次验证 → 登记客户端公钥
   * → 保存按 origin 的绑定 → 写入出站档案（account 目标）。页面只负责切 carrier。
   */
  connectWithAccount?: (input: {
    origin: string
    username: string
    password: string
    code: string
    role: RoleName
  }) => Promise<{ clientId: string; deviceLabel?: string; role?: string; targetId?: string }>
  saveOutboundTarget?: (target: Omit<OutboundTarget, 'id'> & {
    token?: string
    account?: boolean
    accountId?: string
  }) => Promise<OutboundTarget>
  activateOutboundTarget?: (targetId: string) => Promise<number>
  forgetDevice?: (deviceId: string) => Promise<boolean>
  forgetOutboundTarget?: (targetId: string) => Promise<boolean>
  /** 本机对外监听信息（局域网 IPv4 + 端口；供其他设备填写）。 */
  endpoints?: () => Promise<{
    port: number
    network: 'loopback' | 'lan'
    origin: string
    candidates: readonly string[]
    preferred: string
  }>
  /** ③ 守卫运行指标（宿主旧版本 reject → 降级卡）。 */
  stats?: () => Promise<HubMetrics>
  /** ④ 配置读写（宿主旧版本 reject → 降级卡）。 */
  getConfig?: () => Promise<ConfigSnapshot>
  patchConfig?: (input: Record<string, unknown>) => Promise<ConfigSnapshot>
  /** 最近一次管理请求诊断（transport 通过 onAdminDiagnostic 写回）。 */
  diagnostic?: () => AdminDiagnostic | null
  /** 用户可见日志时间线（最近 N 条，已脱敏）。 */
  logs?: () => readonly HubLogEntry[]
  /** 页面侧主动记录一条日志。 */
  log?: (level: 'info' | 'warn' | 'error', title: string, detail?: string, path?: string) => void
  storage?: Storage
  reload?: () => void
  clock?: () => number
}

/**
 * 创建页面组件（装配时调用一次，保证 hooks 身份稳定）。
 * @param deps - 注入依赖。
 * @returns 无 props 的函数组件。
 */
export function createRemoteHubPageComponent(deps: RemoteHubPageDeps): () => React.ReactNode {
  const storage = deps.storage ?? (() => {
    try { return globalThis.localStorage } catch { return undefined }
  })()
  const reload = deps.reload ?? (() => globalThis.location?.reload())
  const clock = deps.clock ?? (() => Date.now())

  return function RemoteHubPage(): React.ReactNode {
    const [mode] = React.useState<CarrierMode>(() => readCarrierMode(storage))
    const [outboundTargets, setOutboundTargets] = React.useState<readonly OutboundTarget[]>([])
    const [guard, setGuard] = React.useState<GuardStatus | null>(null)
    const [guardError, setGuardError] = React.useState<string | null>(null)
    const [devices, setDevices] = React.useState<readonly CloudDeviceRow[]>([])
    const [loading, setLoading] = React.useState(true)
    const [deletePrompt, setDeletePrompt] = React.useState<{ message: string; run(): void } | null>(null)
    const [originDraft, setOriginDraft] = React.useState<string>(
      () => (mode.mode === 'cloud' ? (mode.origin ?? '') : ''),
    )
    const [accountDraft, setAccountDraft] = React.useState<{ username: string; password: string; code: string; role: RoleName }>(
      () => ({ username: 'admin', password: '', code: '', role: 'control' }),
    )
    const [busy, setBusy] = React.useState<null | 'connect' | 'account' | 'revoke' | 'delete' | 'refresh' | 'detach'>(null)
    const [error, setError] = React.useState<string | null>(null)
    const [now, setNow] = React.useState<number>(() => clock())
    // 四区扩展状态
    const [deviceFilter, setDeviceFilter] = React.useState<'all' | 'inbound'>('all')
    const [stats, setStats] = React.useState<HubMetrics | null>(null)
    const [statsError, setStatsError] = React.useState<string | null>(null)
    const [config, setConfig] = React.useState<ConfigSnapshot | null>(null)
    const [configDraft, setConfigDraft] = React.useState<ConfigSnapshot | null>(null)
    const [configSaving, setConfigSaving] = React.useState(false)
    const [configSavedAt, setConfigSavedAt] = React.useState<number | null>(null)
    /** 本机局域网候选地址与推荐地址（供其他设备填写 / 二维码）。 */
    const [lanCandidates, setLanCandidates] = React.useState<readonly string[]>([])
    const [listenAddress, setListenAddress] = React.useState<string>('')
    /** 出站状态轮询：记住上次采纳的文件 mtime，避免重复导入覆盖页面操作。 */
    const lastCarrierAtRef = React.useRef(-1)

    React.useEffect(() => {
      if (deps.listOutboundTargets === undefined) {
        const legacy = readOutboundTargets(storage)
        writeOutboundTargets([], storage)
        setOutboundTargets(legacy.map(({ token: _token, ...target }) => target))
        if (legacy.length > 0) setError('旧版浏览器凭据已清除；此宿主不支持安全设备档案，请重新配对后切换。')
        return undefined
      }
      let disposed = false
      void (async () => {
        try {
          const targets = [...await deps.listOutboundTargets!()]
          const active = deps.carrier === undefined ? null : normalizeCarrier((await deps.carrier()).mode)
          if (active?.mode === 'cloud' && active.origin && active.token && deps.saveOutboundTarget !== undefined) {
            const exists = active.targetId !== undefined && targets.some(target => target.id === active.targetId)
            if (!exists) await deps.saveOutboundTarget({
              origin: active.origin,
              token: active.token,
              ...(active.deviceLabel === undefined ? {} : { deviceLabel: active.deviceLabel }),
              lastConnectedAt: clock(),
            })
          }
          if (disposed) return
          const profileTargets = await deps.listOutboundTargets!()
          setOutboundTargets(profileTargets)
          if (readOutboundTargets(storage).length > 0) {
            writeOutboundTargets([], storage)
            setError('旧版浏览器 bearer archive 已清除；仅迁移当前活动目标，其它旧目标需重新配对。')
          }
        } catch (cause) {
          if (!disposed) setError(`读取本机配对档案失败：${cause instanceof Error ? cause.message : String(cause)}`)
        }
      })()
      return () => { disposed = true }
    }, [deps.listOutboundTargets, deps.saveOutboundTarget, deps.carrier])

    /**
     * 从磁盘同步出站状态（`carrier-mode.json`）。
     *
     * 磁盘是**唯一真源**：CLI 配对、另一个窗口的操作都会写这个文件。页面每
     * `CARRIER_POLL_MS` 轮询一次，只有文件的 mtime 变化时才采纳，避免把用户的
     * 手动操作反复覆盖回去。
     *
     * 采纳后调用 `deps.reload()` 让 carrier 重新装配（与首次加载一致），
     * 而不是只改 React 状态——出站切换必须重置整条 RPC 通道。
     */
    const syncCarrier = React.useCallback((): void => {
      if (deps.carrier === undefined) return
      void deps.carrier()
        .then(async snapshot => {
          // 首次轮询记一条：确认通道真的通（排障时不至于只有「没反应」）。
          const first = lastCarrierAtRef.current === -1
          if (snapshot.at === lastCarrierAtRef.current) return
          lastCarrierAtRef.current = snapshot.at
          const next = normalizeCarrier(snapshot.mode)
          const current = readCarrierMode(storage)
          if (first) {
            deps.log?.('info', '出站状态已读取',
              `文件=${snapshot.at === 0 ? '不存在' : new Date(snapshot.at).toLocaleTimeString()} `
              + `磁盘=${next.mode === 'cloud' ? next.origin : '本机'} `
              + `页面=${current.mode === 'cloud' ? current.origin : '本机'}`)
          }
          if (carrierEquals(current, next)) return
          if (next.mode === 'cloud' && next.origin && next.token) {
            let targetId = next.targetId
            if (deps.saveOutboundTarget !== undefined) {
              const saved = await deps.saveOutboundTarget({
                origin: next.origin,
                token: next.token,
                ...(next.deviceLabel === undefined ? {} : { deviceLabel: next.deviceLabel }),
                  lastConnectedAt: clock(),
              })
              targetId = saved.id
              if (deps.listOutboundTargets !== undefined) setOutboundTargets(await deps.listOutboundTargets())
            }
            if (targetId !== next.targetId && deps.carrierWrite !== undefined) {
              await deps.carrierWrite({ ...next, targetId })
            }
            const hint: CarrierMode = {
              mode: 'cloud', origin: next.origin,
              ...(targetId === undefined ? {} : { targetId }),
              ...(next.deviceLabel === undefined ? {} : { deviceLabel: next.deviceLabel }),
            }
            if (!carrierEquals(current, hint)) {
              writeCarrierMode(hint, storage)
              deps.log?.('info', '已从磁盘同步连接状态', `→ ${hint.origin}`)
              deps.reload?.()
            }
            return
          }
          if (carrierEquals(current, next)) return
          writeCarrierMode(next, storage)
          deps.log?.('info', '已从磁盘同步连接状态', '→ 本机')
          deps.reload?.()
        })
        .catch((cause: unknown) => {
          // 失败不再静默：诊断卡与日志都要能看到原因。
          // 不写 lastCarrierAtRef：下次轮询仍会重试（吞掉失败会让问题永远不可见）。
          deps.log?.('error', '出站状态读取失败', describeGuardFailure(cause), 'hub/admin.carrier')
        })
    }, [])

    // 出站状态定时轮询（含首次）。
    React.useEffect(() => {
      if (deps.carrier === undefined) return undefined
      syncCarrier()
      const timer = setInterval(syncCarrier, CARRIER_POLL_MS)
      return () => { clearInterval(timer) }
    }, [syncCarrier])

    const [retry, setRetry] = React.useState<{ attempts: number; nextRetryAt: number | null }>({
      attempts: 0,
      nextRetryAt: null,
    })

    /** 注入握手快照（每次渲染求值：host 可能在页面加载后重新注入）。 */
    const injection: InjectionDiagnostic = (() => {
      const injected = deps.injected()
      const injectedAt = injected.injectedAt ?? ''
      const at = injectedAt === '' ? Number.NaN : Date.parse(injectedAt)
      return {
        hasPin: typeof injected.pairIssueToken === 'string' && injected.pairIssueToken !== '',
        guardOrigin: injected.guardOrigin ?? '',
        loopbackOrigin: injected.loopbackOrigin ?? '',
        instanceId: injected.instanceId ?? '',
        pid: typeof injected.pid === 'number' ? injected.pid : null,
        injectedAt,
        protocolVersion: typeof injected.protocolVersion === 'number' ? injected.protocolVersion : null,
        ageSeconds: Number.isNaN(at) ? null : Math.max(0, Math.round((clock() - at) / 1000)),
      }
    })()

    /** ③ 指标刷新（可选依赖；失败 = 宿主不支持）。 */
    const refreshStats = React.useCallback((): void => {
      if (deps.stats === undefined) {
        setStatsError(STRINGS.statsUnsupported)
        return
      }
      deps.stats()
        .then(snapshot => { setStats(snapshot); setStatsError(null) })
        .catch((cause: unknown) => {
          setStats(null)
          setStatsError(cause instanceof Error ? cause.message : STRINGS.statsUnsupported)
        })
    }, [])

    /** ④ 配置读取（可选依赖；失败 = 宿主不支持）。 */
    const refreshConfig = React.useCallback((): void => {
      if (deps.getConfig === undefined) return
      deps.getConfig()
        .then(snapshot => {
          setConfig(snapshot); setConfigDraft(snapshot)
        })
        .catch(() => { setConfig(null); setConfigDraft(null) })
    }, [])

    const refresh = React.useCallback((): void => {
      setLoading(true)
      deps.listDevices()
        .then(snapshot => {
          setGuard({
            ...snapshot.guard,
            protocolVersion: snapshot.protocolVersion,
            singleController: snapshot.singleController,
          })
          setDevices(snapshot.devices)
          setGuardError(null)
        })
        .catch((cause: unknown) => {
          setGuard(null)
          setDevices([])
          setGuardError(describeGuardFailure(cause))
        })
        .finally(() => { setLoading(false) })
      refreshStats()
      refreshConfig()
      // 局域网地址（供其他设备填写 / 生成二维码链接）。
      if (deps.endpoints !== undefined) {
        void deps.endpoints()
          .then(info => {
            setLanCandidates(info.candidates)
            setListenAddress(info.preferred)
          })
          .catch(() => { /* 地址探测失败不影响主流程 */ })
      }
    }, [refreshStats, refreshConfig])

    React.useEffect(() => { refresh() }, [refresh])

    // 守卫读取失败后的自动重试：守卫晚于页面装配启动（宿主插件装配顺序）是常态，
    // 一次网络失败不该让用户看到永久的「Failed to fetch」——指数退避到 30s 封顶，
    // 成功后停止（guard 非 null）。
    React.useEffect(() => {
      if (guard !== null) {
        setRetry(previous => (previous.attempts === 0 && previous.nextRetryAt === null
          ? previous
          : { attempts: 0, nextRetryAt: null }))
        return undefined
      }
      let delay = 2_000
      let cancelled = false
      let attempts = 0
      const tick = (): void => {
        if (cancelled) return
        attempts += 1
        setRetry({ attempts, nextRetryAt: clock() + delay })
        refresh()
        delay = Math.min(delay * 2, 30_000)
        timer = setTimeout(tick, delay)
      }
      let timer = setTimeout(tick, delay)
      return () => { cancelled = true; clearTimeout(timer) }
    }, [guard !== null, refresh])


    // ③ 指标轮询（60s；守卫不可用时节流不重试）。
    React.useEffect(() => {
      if (deps.stats === undefined || guard === null) return undefined
      const timer = setInterval(() => { refreshStats() }, 60_000)
      return () => { clearInterval(timer) }
    }, [deps.stats, guard === null, refreshStats])



    const actions: RemoteHubPageActions = {
      onRefresh() { refresh() },
      onCopy(text) {
        const clipboard = (globalThis as {
          navigator?: { clipboard?: { writeText?: (value: string) => Promise<void> } }
        }).navigator?.clipboard
        void clipboard?.writeText?.(text)
      },
      onForgetDevice(deviceId) {
        const remove = deps.forgetDevice
        if (!remove) return
        setDeletePrompt({ message: `删除设备 ${devices.find(device => device.deviceId === deviceId)?.label ?? deviceId} 并撤销其访问？之后需要重新配对。\nDelete this device and revoke its access? Pairing will be required again.`, run: () => {
          setBusy('delete'); setError(null)
          void remove(deviceId).then(() => refresh())
            .catch((cause: unknown) => setError(`删除失败 / Delete failed: ${cause instanceof Error ? cause.message : String(cause)}`))
            .finally(() => setBusy(null))
        } })
      },
      onForgetOutbound(target) {
        const remove = deps.forgetOutboundTarget
        const id = target.id
        if (!id || !remove) return
        if (mode.mode === 'cloud' && mode.targetId === id) { setError('请先断开连接再删除配对。 / Disconnect before deleting this pairing.'); return }
        setDeletePrompt({ message: `删除本机保存的配对 ${target.deviceLabel ?? target.origin}？不会撤销目标主机上的设备授权；以后需重新配对。\nDelete this saved pairing? This does not revoke access on the target host.`, run: () => {
          setBusy('delete'); setError(null)
          void remove(id).then(() => setOutboundTargets(previous => previous.filter(item => item.id !== id)))
            .catch((cause: unknown) => setError(`删除失败 / Delete failed: ${cause instanceof Error ? cause.message : String(cause)}`))
            .finally(() => setBusy(null))
        } })
      },
      onRevoke(deviceId) {
        setBusy('revoke')
        setError(null)
        void deps.revokeDevices({ deviceId })
          .then(() => { refresh() })
          .catch((cause: unknown) => {
            setError(`清除失败：${cause instanceof Error ? cause.message : String(cause)}`)
          })
          .finally(() => { setBusy(null) })
      },
      onRevokeAll() {
        if (!globalThis.confirm?.('清除全部配对？所有已连接设备都会被断开。') ) return
        setBusy('revoke')
        setError(null)
        void deps.revokeDevices({ all: true })
          .then(() => { refresh() })
          .catch((cause: unknown) => {
            setError(`清除失败：${cause instanceof Error ? cause.message : String(cause)}`)
          })
          .finally(() => { setBusy(null) })
      },
      onOriginChange(value) {
        setOriginDraft(value)
        if (error !== null) setError(null)
      },
      onDetach() {
        const current = readCarrierMode(storage)
        if (deps.carrierWrite === undefined) {
          setError('当前宿主不支持安全断开，未更改连接状态。')
          return
        }
        setBusy('detach')
        setError(null)
        void (async () => {
          let archiveSaved = true
          if (current.mode === 'cloud' && current.origin && current.token && deps.saveOutboundTarget !== undefined) {
            try {
              const saved = await deps.saveOutboundTarget({
                origin: current.origin,
                token: current.token,
                ...(current.deviceLabel === undefined ? {} : { deviceLabel: current.deviceLabel }),
                ...(current.targetId === undefined ? {} : { id: current.targetId }),
                lastConnectedAt: clock(),
              })
              setOutboundTargets(previous => upsertOutboundTarget(previous, saved))
            } catch {
              archiveSaved = false
            }
          }
          return runDetachPersistence({
            saveTargets: () => archiveSaved,
            writeLocalMode: () => deps.carrierWrite!({ mode: 'local' }),
            warnTargetsNotSaved: () => {
              try { globalThis.alert?.('已切回本机，但无法安全保存重连凭据；请在恢复存储前勿关闭配对页面。') } catch { /* 页面即将切换 */ }
            },
            reload,
          })
        })().then(result => {
          if (!result.disconnected) {
            setBusy(null)
            setError('断开失败，未能保存本机模式。当前连接保持不变。')
            return
          }
          lastCarrierAtRef.current = -1
          setBusy(null)
        }).catch((cause: unknown) => {
          setBusy(null)
          setError(`断开失败：${cause instanceof Error ? cause.message : String(cause)}`)
        })
      },
      onReconnect(target) {
        if (busy !== null) return
        if (!target.id || deps.activateOutboundTarget === undefined) {
          setError('此配对尚未迁移到本机受限档案，请重新配对后再连接。')
          return
        }
        setBusy('connect')
        setError(null)
        deps.log?.('info', '正在重连已配对设备', outboundTargetLabel(target, outboundTargets))
        void deps.activateOutboundTarget(target.id).then(at => {
          lastCarrierAtRef.current = at
          setBusy(null)
          reload()
        }).catch((cause: unknown) => {
          setBusy(null)
          setError(`重连失败，连接状态未更改：${cause instanceof Error ? cause.message : String(cause)}`)
        })
      },
      onFilterChange(filter) { setDeviceFilter(filter) },
      onConfigChange(key, value) {
        setConfigDraft(previous => ({ ...(previous ?? {}), [key]: value }))
        setConfigSavedAt(null)
      },
      onConfigSave() {
        if (deps.patchConfig === undefined || configDraft === null) return
        const patch: Record<string, unknown> = {}
        // 热项 + 冷项（端口/网络）：冷项也需要提交，否则页面能改却永远存不进去。
        for (const key of ['singleController', 'bridgeApprovals', 'defaultRole', 'maxPairAttempts', 'guardPort', 'network']) {
          if (Object.hasOwn(configDraft, key)) patch[key] = configDraft[key]
        }
        setConfigSaving(true)
        setError(null)
        void deps.patchConfig(patch)
          .then(result => {
            setConfig(result)
            setConfigDraft(result)
            setConfigSavedAt(clock())
            deps.log?.('info', '配置已保存', Object.keys(patch).join(', '), 'hub/admin.configPatch')
          })
          .catch((cause: unknown) => {
            const reason = describeGuardFailure(cause)
            setError(`保存配置失败：${reason}`)
            deps.log?.('error', '配置保存失败', reason, 'hub/admin.configPatch')
          })
          .finally(() => { setConfigSaving(false) })
      },
      onConnect() {
        // 「连接」= 用已保存的 keyring 绑定直连目标；没有已保存目标时等同「登录并信任」。
        const target = normalizeOrigin(originDraft)
        if (target === undefined) {
          setError(STRINGS.originInvalid)
          return
        }
        const saved = (outboundTargets ?? []).find(item => (normalizeOrigin(item.origin) ?? item.origin) === target)
        if (saved?.id !== undefined && deps.activateOutboundTarget !== undefined) {
          actions.onReconnect(saved)
          return
        }
        actions.onAccountConnect()
      },
      onAccountChange(field, value) {
        setAccountDraft(current => ({
          ...current,
          ...(field === 'role'
            ? { role: (configuredDefaultRole(value)) }
            : { [field]: value }),
        }))
      },
      onAccountConnect() {
        const target = normalizeOrigin(originDraft)
        if (target === undefined) {
          setError('目标地址格式不正确。')
          return
        }
        if (deps.connectWithAccount === undefined) {
          setError('当前宿主不支持跨机账号登录；请升级插件。')
          return
        }
        const { username, password, code, role: accountRole } = accountDraft
        if (username.trim() === '' || password === '') {
          setError('请填写对端账号与口令。')
          return
        }
        setBusy('account')
        setError(null)
        void deps.connectWithAccount({
          origin: target,
          username: username.trim(),
          password,
          code: code.trim(),
          role: accountRole,
        })
          .then(async result => {
            if (deps.carrierWrite === undefined) {
              setError('宿主不支持安全保存连接状态；账号已信任，但未切换。')
              return
            }
            const label = result.deviceLabel ?? result.clientId
            // 带上 targetId：磁盘 carrier 状态靠它关联出站档案，重启才能续上。
            const carrierState = {
              mode: 'cloud' as const,
              origin: target,
              account: true,
              ...(result.targetId === undefined ? {} : { targetId: result.targetId }),
              ...(label === undefined ? {} : { deviceLabel: label }),
            }
            const at = await deps.carrierWrite(carrierState)
            writeCarrierMode(carrierState, storage)
            lastCarrierAtRef.current = at
            setAccountDraft(current => ({ ...current, password: '', code: '' }))
            reload()
          })
          .catch((cause: unknown) => {
            setError(`登录失败：${cause instanceof Error ? cause.message : String(cause)}`)
          })
          .finally(() => { setBusy(null) })
      },
    }

    const page = renderRemoteHubPage({
      mode,
      outboundTargets,
      guard,
      guardError,
      devices,
      loading,
      originDraft,
      accountDraft,
      deviceFilter,
      stats,
      statsError,
      config,
      configDraft,
      configSaving,
      configSavedAt,
      busy,
      error,
      injection,
      adminAvailable: deps.diagnostic !== undefined,
      listenAddress,
      lanCandidates,
      diagnostic: deps.diagnostic?.() ?? null,
      logs: deps.logs?.() ?? [],
      retry,
      now,
    }, actions)

    if (deletePrompt) return React.createElement(React.Fragment, null, page,
      React.createElement(DeviceDeleteDialog, {
        message: deletePrompt.message,
        onCancel: () => setDeletePrompt(null),
        onConfirm: () => { const run = deletePrompt.run; setDeletePrompt(null); run() },
      }))
    return page
  }
}

/**
 * 兼容旧调用点的薄封装：申请/断开整机指向（供测试与外部工具复用）。
 * @param deps - storage/reload 注入。
 */
export function createSettingsActions(deps: { storage?: Storage; reload?: () => void }): {
  attach: (args: { origin: string; token: string; deviceLabel?: string }) => void
  detach: () => void
} {
  const storage = deps.storage
  const reload = deps.reload ?? (() => globalThis.location?.reload())
  return {
    attach(args) {
      if (typeof args?.origin !== 'string' || args.origin === '') return
      if (typeof args.token !== 'string' || args.token === '') return
      writeCarrierMode({
        mode: 'cloud',
        origin: args.origin,
        token: args.token,
        ...(args.deviceLabel === undefined ? {} : { deviceLabel: args.deviceLabel }),
      }, storage)
      reload()
    },
    detach() {
      writeCarrierMode({ mode: 'local' }, storage)
      reload()
    },
  }
}
