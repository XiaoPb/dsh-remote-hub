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
import { encodeQr } from './qr.js'
import { QrScanner } from './QrScanner.js'
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

/** 一次签发结果。 */
export interface IssuedPairing {
  kind: 'ticket' | 'code'
  /** 票据原文或 8 位短码。 */
  value: string
  role: string
  expiresAt: number
}

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
  /** 被控端：本机签发凭据；缺省时隐藏签发区。 */
  pairIssueToken?: string
  /** 签发时选定的角色。 */
  role: RoleName
  /** 最近一次签发（票据→二维码 / 短码→文本）。 */
  /** 最近一次签发的票据（二维码 + 链接来源）。 */
  issued: IssuedPairing | null
  /** 最近一次签发的短码（独立于票据）。 */
  issuedCode: IssuedPairing | null
  /** ① 票据/短码过期后自动重签（默认开）。 */
  autoReissue: boolean
  /** 同源管理通道是否可用（桌面端签发/管理唯一路径）。 */
  adminAvailable?: boolean
  /** 本机局域网候选地址（`http://<ip>:<port>`，供其他设备填写）。 */
  lanCandidates?: readonly string[]
  /** 推荐地址（二维码 / 链接使用；无候选时回退 origin）。 */
  listenAddress?: string
  /** 主控端：连接表单。 */
  originDraft: string
  secretDraft: string
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
  busy: null | 'connect' | 'issue' | 'revoke' | 'delete' | 'refresh' | 'detach'
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
  onRoleChange(role: RoleName): void
  onIssue(kind: 'ticket' | 'code'): void
  onForgetDevice?(deviceId: string): void
  onForgetOutbound?(target: OutboundTarget): void
  onRevoke(deviceId: string): void
  onRevokeAll(): void
  onOriginChange(value: string): void
  onSecretChange(value: string): void
  onScan(): void
  onConnect(): void
  onReconnect(target: OutboundTarget): void
  onDetach(): void
  onCopy(text: string): void
  /** ① 切换自动重签。 */
  onAutoReissueChange(enabled: boolean): void
  /** ② 切换设备筛选。 */
  onFilterChange(filter: 'all' | 'inbound'): void
  /** ④ 修改配置草稿（未保存）。 */  onConfigChange(key: string, value: unknown): void
  /** ④ 保存配置草稿。 */
  onConfigSave(): void
}

// ── 样式 ─────────────────────────────────────────────────────────────────────
// 组件样式集中在 THEME_CSS 的 .rh-* 类中（参考文档组件体系），此处仅保留
// 少量动态内联样式（按状态切换的类名与行内布局）。

const S = {
  root: { width: '100%', height: '100vh', boxSizing: 'border-box', padding: '28px 32px 56px', overflowY: 'auto', overflowX: 'hidden', fontSize: 14, lineHeight: 1.6 },
  badge: { 'data-testid': 'mode-badge' },
} as const

// ── 主题 token（语义化 CSS 变量；不写死任何示意参数，方便外部整体换肤）───────
//
// 亮色为默认；暗色走两条路径：
//  1. `@media (prefers-color-scheme: dark)` 自动跟随系统；
//  2. 根容器 `data-theme="dark" | "light"` 供宿主/外部主题强制指定。
// 外部主题只需在任意祖先元素覆盖 `--rh-*` 变量即可整体换肤，组件样式零硬编码色值。
const THEME_CSS = `
.rh-root{
  /* 表面 */
  --rh-bg: #f6f7f9;
  --rh-card: #ffffff;
  --rh-border: rgba(127,127,127,.22);
  --rh-border-strong: rgba(127,127,127,.40);
  /* 文字 */
  --rh-text: #1a1d21;
  --rh-text-2: rgba(27,32,38,.66);
  --rh-text-3: rgba(27,32,38,.45);
  /* 强调（选中态/主按钮） */
  --rh-accent: #1a1d21;
  --rh-accent-contrast: #ffffff;
  --rh-primary: #3b82f6;
  --rh-primary-contrast: #ffffff;
  /* 语义色 + 弱背景 */
  --rh-green: #17945c;
  --rh-green-bg: rgba(23,148,92,.14);
  --rh-red: #d64545;
  --rh-red-bg: rgba(214,69,69,.10);
  /* 形状 / 间距 / 字体 */
  --rh-radius: 14px;
  --rh-radius-sm: 9px;
  --rh-gap: 16px;
  --rh-shadow: 0 1px 2px rgba(17,20,24,.04), 0 4px 16px rgba(17,20,24,.05);
  --rh-font: system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  --rh-mono: ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;

  background: var(--rh-bg);
  color: var(--rh-text);
  font-family: var(--rh-font);
}
.rh-root[data-theme="dark"]{
  --rh-bg: #17191d;
  --rh-card: #1f2228;
  --rh-border: rgba(255,255,255,.14);
  --rh-border-strong: rgba(255,255,255,.26);
  --rh-text: #eceef1;
  --rh-text-2: rgba(236,238,241,.70);
  --rh-text-3: rgba(236,238,241,.45);
  --rh-accent: #eceef1;
  --rh-accent-contrast: #17191d;
  --rh-green: #3ecf8e;
  --rh-green-bg: rgba(62,207,142,.16);
  --rh-red: #f27d7d;
  --rh-red-bg: rgba(242,125,125,.12);
  --rh-shadow: 0 1px 2px rgba(0,0,0,.3), 0 4px 16px rgba(0,0,0,.25);
}
@media (prefers-color-scheme: dark){
  .rh-root:not([data-theme="light"]){
    --rh-bg: #17191d;
    --rh-card: #1f2228;
    --rh-border: rgba(255,255,255,.14);
    --rh-border-strong: rgba(255,255,255,.26);
    --rh-text: #eceef1;
    --rh-text-2: rgba(236,238,241,.70);
    --rh-text-3: rgba(236,238,241,.45);
    --rh-accent: #eceef1;
    --rh-accent-contrast: #17191d;
    --rh-green: #3ecf8e;
    --rh-green-bg: rgba(62,207,142,.16);
    --rh-red: #f27d7d;
    --rh-red-bg: rgba(242,125,125,.12);
    --rh-shadow: 0 1px 2px rgba(0,0,0,.3), 0 4px 16px rgba(0,0,0,.25);
  }
}
/* ===== 参考《云端设备布局设计参考》组件体系（全部经 --rh-* token）===== */
/* 页面外壳：背景铺满 + 可滚动。
 * 宿主 main 槽位的容器高度/overflow 不可控，所以 .rh-root 自己成为滚动容器：
 * height:100vh（视口高）+ overflow-y:auto，内容超出即内部滚动，背景始终铺满。
 * 若宿主容器比视口矮，height:100% 的回退规则兜底。 */
.rh-root{
  width: 100%;
  height: 100vh;
  box-sizing: border-box;
  padding: 28px 32px 56px;
  overflow-y: auto;
  overflow-x: hidden;
}
.rh-root .rh-shell{ max-width: 1080px; margin: 0 auto; }
.rh-root h1{ margin: 0 0 4px; font-size: 24px; font-weight: 700; letter-spacing: -.3px;
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.rh-root .rh-lead{ margin: 0 0 6px; font-size: 14px; color: var(--rh-text-2); }
/* 区块头（标题 + 右侧操作胶囊） */
.rh-root .rh-section-head{ display: flex; align-items: center; justify-content: space-between;
  gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.rh-root .rh-section-head .rh-title{ font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.rh-root .rh-section-head .rh-right{ display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
/* 卡片分区 */
.rh-root .rh-card{
  margin: 18px 0; padding: 20px 22px;
  background: var(--rh-card);
  border: 1px solid var(--rh-border);
  border-radius: var(--rh-radius);
  box-shadow: var(--rh-shadow);
}
.rh-root .rh-card-title{ margin: 0 0 4px; font-size: 15px; font-weight: 600; }
.rh-root .rh-sub{ margin: 0 0 10px; font-size: 12.5px; color: var(--rh-text-2); }
/* 胶囊 / 圆点 */
.rh-root .rh-pill{
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 12px; border-radius: 999px; font-size: 12.5px;
  background: var(--rh-card); border: 1px solid var(--rh-border-strong);
  color: var(--rh-text); white-space: nowrap;
}
.rh-root .rh-pill.small{ padding: 2px 9px; font-size: 11.5px; }
.rh-root .rh-pill.solid{ background: var(--rh-accent); color: var(--rh-accent-contrast); border-color: var(--rh-accent); }
.rh-root .rh-pill.on{
  background: var(--rh-green-bg); border-color: var(--rh-green); color: var(--rh-green);
}
.rh-root .rh-pill.off{ color: var(--rh-text-2); }
.rh-root .rh-pill.danger{ background: var(--rh-red-bg); border-color: var(--rh-red); color: var(--rh-red); }
.rh-root .rh-dot{ width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: none; }
/* 行 / 栅格 */
.rh-root .rh-row{ display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; align-items: center; }
.rh-root .rh-qrwrap{ display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap; margin-top: 14px; }
.rh-root .rh-tokinfo{ flex: 1 1 240px; min-width: 0; }
/* 令牌信息（参考 .tokinfo / .minirow / .countdown） */
.rh-root .rh-lbl{ font-size: 12px; color: var(--rh-text-3); }
.rh-root .rh-val{ font-family: var(--rh-mono); font-size: 16px; font-weight: 600; margin: 4px 0 12px; word-break: break-all; }
.rh-root .rh-minirow{ display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 12px; }
.rh-root .rh-minirow .rh-k{ font-size: 11px; color: var(--rh-text-3); }
.rh-root .rh-minirow .rh-v{ font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.rh-root .rh-diagnostic-grid{ display: grid; grid-template-columns: repeat(auto-fit,minmax(min(210px,100%),1fr)); gap: 12px; box-sizing: border-box; }
.rh-root .rh-diagnostic-grid > div{ min-width: 0; padding: 12px; background: var(--rh-bg); border: 1px solid var(--rh-border); border-radius: var(--rh-radius-sm); }
.rh-root .rh-diagnostic-grid .rh-v{ font-size: 12px; line-height: 1.6; margin-top: 4px; font-family: var(--rh-mono); font-weight: 400; overflow-wrap: anywhere; word-break: break-word; min-width: 0; }
.rh-root .rh-dev-meta{ min-width: 0; }
.rh-root .rh-dev-nm,.rh-root .rh-dev-sub{ overflow-wrap: anywhere; }
.rh-root [data-testid="outbound-facts"]{ display: grid; grid-template-columns: repeat(auto-fit,minmax(min(160px,100%),1fr)); gap: 8px 16px; font-size: 12px; color: var(--rh-text-2); }
.rh-root .rh-dev-foot{ flex-wrap: wrap; }
.rh-root .rh-cfg .rh-crow{ gap: 16px; flex-wrap: wrap; }
.rh-root .rh-cfg .rh-cl{ min-width: 0; flex: 1 1 200px; }
.rh-root .rh-cfg select,.rh-root .rh-cfg input{ max-width: 100%; box-sizing: border-box; }
.rh-root .rh-countdown{ height: 6px; border-radius: 4px; background: var(--rh-border); overflow: hidden; margin-top: 6px; flex: 1 1 120px; min-width: 100px; }
.rh-root .rh-countdown > i{ display: block; height: 100%; border-radius: 4px; background: var(--rh-accent); transition: width .4s ease; }
/* 设备卡（参考 .devgrid / .dev） */
.rh-root .rh-devgrid{ display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: var(--rh-gap); margin-top: 10px; }
.rh-root .rh-dev{
  background: var(--rh-card); border: 1px solid var(--rh-border); border-radius: var(--rh-radius);
  padding: 14px 16px; box-shadow: var(--rh-shadow);
  display: flex; flex-direction: column; gap: 8px; min-width: 0;
}
.rh-root .rh-dev .rh-dev-top{ display: flex; align-items: center; gap: 10px; }
.rh-root .rh-dev .rh-dev-ico{ width: 36px; height: 36px; border-radius: 10px; background: var(--rh-bg);
  display: flex; align-items: center; justify-content: center; font-size: 17px; flex: none; }
.rh-root .rh-dev .rh-dev-nm{ font-weight: 700; font-size: 14px; word-break: break-all; }
.rh-root .rh-dev .rh-dev-sub{ font-size: 12px; color: var(--rh-text-3); font-family: var(--rh-mono); word-break: break-all; }
.rh-root .rh-dev .rh-dev-meta{ flex: 1; min-width: 0; }
.rh-root .rh-dev .rh-dev-foot{ display: flex; align-items: center; gap: 8px; margin-top: auto; flex-wrap: wrap; }
.rh-root .rh-dev.revoked{ opacity: .45; }
/* 已配对但离线：置灰（2026-11-12：用户要求「不在线就变灰」） */
.rh-root .rh-dev.offline{ opacity: .6; }
.rh-root .rh-dev.offline .rh-dev-ico{ filter: grayscale(1); }
.rh-root .rh-dev.offline .rh-dev-nm{ color: var(--rh-text-2); }
/* 设备分组（参考 .group-head） */
.rh-root .rh-group{ margin-top: 16px; }
.rh-root .rh-group:first-of-type{ margin-top: 6px; }
.rh-root .rh-group-head{ display: flex; align-items: center; gap: 10px; margin-bottom: 4px; flex-wrap: wrap; }
.rh-root .rh-group-head .rh-gtitle{ font-size: 14px; font-weight: 700; }
.rh-root .rh-group-head .rh-ghint{ font-size: 12px; color: var(--rh-text-3); }
/* 空状态（参考 .empty） */
.rh-root .rh-empty{ text-align: center; padding: 40px 20px; color: var(--rh-text-3); font-size: 13px; }
.rh-root .rh-empty .rh-ic{ font-size: 36px; margin-bottom: 8px; }
.rh-root .rh-empty .rh-empty-title{ font-weight: 600; color: var(--rh-text); margin-bottom: 4px; }
/* 表单控件（参考 .input / .select / .switch） */
.rh-root input.rh-input{
  flex: 1 1 260px; min-width: 200px; height: 34px; padding: 0 12px; font-size: 13px;
  border-radius: var(--rh-radius-sm); border: 1px solid var(--rh-border-strong);
  background: var(--rh-card); color: var(--rh-text); font-family: inherit;
}
.rh-root input.rh-input::placeholder{ color: var(--rh-text-3); }
.rh-root button.rh-btn{
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 34px; padding: 0 16px; font-size: 13px; font-weight: 600;
  border-radius: var(--rh-radius-sm); border: 1px solid var(--rh-border-strong);
  background: var(--rh-card); color: var(--rh-text); cursor: pointer; font-family: inherit;
  transition: opacity .15s ease;
}
.rh-root button.rh-btn:hover{ opacity: .85; }
.rh-root button.rh-btn.primary{ background: var(--rh-primary); border-color: var(--rh-primary); color: var(--rh-primary-contrast); }
.rh-root button.rh-btn.danger{ background: transparent; border-color: var(--rh-red); color: var(--rh-red); }
.rh-root button.rh-btn.danger:hover{ background: var(--rh-red-bg); opacity: 1; }
.rh-root button.rh-btn:disabled{ opacity: .5; cursor: not-allowed; }
.rh-root button.rh-btn.small{ height: 28px; padding: 0 12px; font-size: 12.5px; font-weight: 500; }
/* 令牌结果块：二维码 + 信息列（自适应换行，窄屏堆叠） */
.rh-root .rh-tokenbody{
  display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 20px;
  align-items: start; margin-top: 14px;
}
.rh-root .rh-tokcol{ min-width: 0; }
.rh-root .rh-tokcol-qr{ flex: none; }
.rh-root .rh-codevalue{
  display: block; width: 100%; box-sizing: border-box;
  font-family: var(--rh-mono); font-size: 20px; font-weight: 600; letter-spacing: 3px;
  padding: 10px 14px; border-radius: var(--rh-radius-sm);
  background: var(--rh-bg); border: 1px solid var(--rh-border-strong); color: var(--rh-text);
  word-break: break-all; overflow-wrap: anywhere; max-width: 100%;
}
.rh-root .rh-codevalue-empty{
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  font-family: inherit; font-size: 13px; font-weight: 400; letter-spacing: 0;
  color: var(--rh-text-3); border-style: dashed;
}
.rh-root .rh-linkvalue{
  display: block; width: 100%; box-sizing: border-box;
  font-family: var(--rh-mono); font-size: 12px; line-height: 1.6;
  padding: 8px 12px; border-radius: var(--rh-radius-sm);
  background: var(--rh-bg); border: 1px solid var(--rh-border);
  color: var(--rh-text-2); word-break: break-all; overflow-wrap: anywhere; max-width: 100%;
}
.rh-root .rh-qr-placeholder{
  width: 216px; height: 216px; box-sizing: border-box;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  border: 1px dashed var(--rh-border-strong); border-radius: var(--rh-radius);
  background: var(--rh-bg); color: var(--rh-text-3); font-size: 12px; text-align: center; padding: 12px;
}
.rh-root .rh-qr-placeholder .rh-ic{ font-size: 32px; line-height: 1; }
/* 窄屏：二维码在上、信息在下 */
@media (max-width: 899px){
  .rh-root .rh-tokenbody{ grid-template-columns: minmax(0, 1fr); }
  .rh-root .rh-qr-placeholder{ width: 180px; height: 180px; margin: 0 auto; }
  .rh-root .rh-tokcol-qr{ display: flex; justify-content: center; }
}
.rh-root button.rh-linkbtn{
  border: 0; background: transparent; color: var(--rh-primary); cursor: pointer;
  font-size: 12px; font-family: inherit; padding: 0 2px 0 6px; text-decoration: underline;
}
/* 错误条（参考 .err） */
.rh-root .rh-error{
  display: flex; gap: 10px; align-items: flex-start;
  background: var(--rh-red-bg); border: 1px solid var(--rh-red); color: var(--rh-red);
  padding: 12px 14px; border-radius: var(--rh-radius-sm); font-size: 13px; margin: 14px 0 0;
}
/* 折叠高级区（参考 .collapse） */
.rh-root .rh-collapse{ margin-top: 16px; border: 1px dashed var(--rh-border-strong); border-radius: var(--rh-radius-sm); background: var(--rh-bg); }
.rh-root .rh-collapse summary{ padding: 12px 16px; font-size: 13px; font-weight: 600; cursor: pointer; color: var(--rh-text-2); }
.rh-root .rh-collapse ul{ list-style: none; margin: 0; padding: 0 16px 14px; font-size: 12px; color: var(--rh-text-2); font-family: var(--rh-mono); }
.rh-root .rh-collapse li{ padding: 2px 0; word-break: break-all; }
/* 统计卡（参考 .statgrid / .stat） */
.rh-root .rh-statgrid{ display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--rh-gap); margin-top: 6px; }
.rh-root .rh-stat{
  background: var(--rh-card); border: 1px solid var(--rh-border); border-radius: var(--rh-radius);
  padding: 16px 18px; box-shadow: var(--rh-shadow); min-width: 0;
}
.rh-root .rh-stat .rh-slbl{ font-size: 12px; color: var(--rh-text-3); margin-bottom: 8px; }
.rh-root .rh-stat .rh-snum{ font-size: 28px; font-weight: 700; letter-spacing: -.5px; line-height: 1; font-family: var(--rh-mono); }
.rh-root .rh-stat .rh-scap{ font-size: 12px; color: var(--rh-text-2); margin-top: 8px; }
/* 图表 */
.rh-root .rh-chartgrid{ display: grid; grid-template-columns: 1.4fr 1fr; gap: var(--rh-gap); margin-top: var(--rh-gap); }
.rh-root .rh-chartbox{
  background: var(--rh-card); border: 1px solid var(--rh-border); border-radius: var(--rh-radius);
  padding: 16px 18px; box-shadow: var(--rh-shadow); min-width: 0;
}
.rh-root .rh-chartbox .rh-ct{ font-size: 13px; font-weight: 700; }
.rh-root .rh-chartbox .rh-cs{ font-size: 12px; color: var(--rh-text-3); margin: 2px 0 12px; }
.rh-root .rh-heat{ display: grid; grid-template-columns: repeat(24, 1fr); gap: 3px; margin-top: 10px; }
.rh-root .rh-heat i{ aspect-ratio: 1; border-radius: 2px; background: var(--rh-border); }
/* 配置行（参考 .cfg） */
.rh-root .rh-cfg{
  background: var(--rh-card); border: 1px solid var(--rh-border); border-radius: var(--rh-radius);
  box-shadow: var(--rh-shadow); overflow: hidden; margin-top: 8px;
}
.rh-root .rh-cfg .rh-crow{ display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px; border-bottom: 1px solid var(--rh-border); gap: 16px; flex-wrap: wrap; }
.rh-root .rh-cfg .rh-crow:last-child{ border-bottom: 0; }
.rh-root .rh-cfg .rh-cl .rh-ct1{ font-weight: 600; font-size: 14px; }
.rh-root .rh-cfg .rh-cl .rh-cd{ font-size: 12px; color: var(--rh-text-3); margin-top: 2px; }
.rh-root .rh-cfg .rh-cc{ display: flex; align-items: center; gap: 10px; }
.rh-root .rh-switch{ width: 42px; height: 24px; border-radius: 999px; background: var(--rh-border-strong);
  position: relative; flex: none; cursor: pointer; border: 0; padding: 0; transition: background .2s ease; }
.rh-root .rh-switch.on{ background: var(--rh-green); }
.rh-root .rh-switch i{ position: absolute; top: 2px; left: 2px; width: 20px; height: 20px;
  border-radius: 50%; background: var(--rh-card); transition: left .2s ease; }
.rh-root .rh-switch.on i{ left: 20px; }
.rh-root select.rh-select, .rh-root input.rh-num{
  height: 34px; border: 1px solid var(--rh-border-strong); border-radius: var(--rh-radius-sm);
  padding: 0 12px; font-size: 13px; background: var(--rh-card); color: var(--rh-text);
  min-width: 120px; font-family: inherit;
}
.rh-root .rh-cold{ font-size: 12px; color: var(--rh-text-3); margin-top: 10px; }
/* 运行日志 */
.rh-root .rh-loglist{ display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
.rh-root .rh-logrow{
  display: grid; grid-template-columns: 68px 44px auto 1fr; gap: 8px;
  align-items: baseline; padding: 4px 0; border-top: 1px dashed var(--rh-border);
  color: var(--rh-text-2); min-width: 0;
}
.rh-root .rh-logrow:first-child{ border-top: 0; }
.rh-root .rh-logtime{ font-family: var(--rh-mono); color: var(--rh-text-3); }
.rh-root .rh-loglevel{ font-weight: 600; }
.rh-root .rh-log-error .rh-loglevel{ color: var(--rh-red); }
.rh-root .rh-log-warn .rh-loglevel{ color: var(--rh-text); }
.rh-root .rh-log-info .rh-loglevel{ color: var(--rh-green); }
.rh-root .rh-logtitle{ color: var(--rh-text); font-weight: 500; }
.rh-root .rh-logpath{ font-family: var(--rh-mono); font-size: 11px; color: var(--rh-text-3); word-break: break-all; }
.rh-root .rh-logdetail{ grid-column: 3 / -1; color: var(--rh-text-3); word-break: break-word; }
/* 降级卡（宿主不支持 ③④） */
.rh-root .rh-unsup{ text-align: center; padding: 28px 20px; color: var(--rh-text-3); font-size: 13px; }

/* ===== 响应式（同一 DOM，纯栅格：桌面 → 平板 → 手机）===== */
@media (max-width: 1023px){
  .rh-root .rh-statgrid{ grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 639px){
  .rh-root{ padding: 16px 14px 48px; }
  .rh-root h1{ font-size: 20px; }
  .rh-root .rh-shell{ max-width: none; }
  .rh-root .rh-card{ padding: 14px; }
  .rh-root .rh-qrwrap{ flex-direction: column; align-items: stretch; }
  .rh-root .rh-qrwrap svg[data-testid="pair-qr"]{ margin: 0 auto; }
  .rh-root .rh-devgrid{ grid-template-columns: 1fr; }
  .rh-root .rh-statgrid{ grid-template-columns: repeat(2, 1fr); }
  .rh-root .rh-chartgrid{ grid-template-columns: 1fr; }
  .rh-root .rh-heat{ grid-template-columns: repeat(18, 1fr); }
  .rh-root button.rh-btn{ min-height: 40px; }
  .rh-root button.rh-btn.small{ min-height: 36px; }
  .rh-root input.rh-input{ min-height: 40px; }
  .rh-root select.rh-select, .rh-root input.rh-num{ min-height: 40px; flex: 1 1 auto; }
  .rh-root .rh-cfg .rh-cc{ width: 100%; justify-content: flex-end; }
  .rh-root .rh-minirow{ gap: 14px; }
}
`

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
  singleOn: '已启用（新设备配对会挤掉旧设备）',
  singleOff: '已关闭（允许多设备同时控制）',
  paired: '已配对',
  role: '授权角色：',
  issueTicket: '生成二维码',
  issuing: '生成中…',
  issueCode: '生成短码',
  ticketHint: '每 15 秒自动轮换 · 配对成功即下发长期设备令牌',
  pairUnavailable: '未检测到本机签发凭据：本机未启用被控端，或页面不是从本机 127.0.0.1 打开。',
  devicesTitle: '已配对设备',
  devicesEmptyLoading: '正在读取…',
  devicesEmpty: '还没有设备配对到本机。上方生成二维码，用另一台设备连接即可。',
  revoked: ' · 已清除',
  never: ' · 从未连接',
  recent: ' · 最近 ',
  revoke: '清除配对',
  revokeAll: '清除全部配对',
  lead: '让其他设备连接并控制这台机器，或把整机切换到其它设备。',
  guardOrigin: '守卫地址',
  guardProtocol: '协议版本',
  guardNetwork: '网络模式',
  netLan: '局域网（同网段可直连）',
  netLoopback: '仅本机',
  singleOnShort: '单控已启用',
  singleOffShort: '单控已关闭',
  issueTitle: '连接令牌',
  issuedKind: '凭据类型',
  issuedRole: '授权角色',
  issuedTicket: '二维码票据',
  issuedCodeLabel: '配对短码',
  issuedLinkLabel: '配对链接',
  issuedNone: '尚未签发',
  qrPending: '尚未生成二维码',
  codePending: '点击右侧生成短码',
  linkPending: '点击右侧生成二维码以获取链接',
  countdownLabel: '有效期倒计时',
  scanHint: '用另一台设备扫码，或在下方主控端粘贴链接。',
  revokedShort: '已清除',
  neverShort: '从未连接',
  notConnectedShort: '未连接',
  devicesEmptyTitle: '暂无设备配对到本机',
  // ② 设备区
  devicesZoneTitle: '已连接设备',
  filterAll: '全部',
  filterInbound: '连接本机',
  filterOutbound: '本机连接',
  groupInbound: '连接本机的设备',
  groupInboundHint: '其它设备正在控制本机（被控端入站）',
  groupOutbound: '本机连接的设备',
  groupOutboundHint: '本机作为主控端主动连接',
  statusOnline: '在线',
  statusIdle: '空闲',
  statusOffline: '离线',
  // 三态（2026-11-12）：已连接 / 已配对 / 配对失效
  statusConnected: '已连接',
  statusPaired: '已配对',
  statusInvalid: '配对失效',
  devCreatedAt: '配对于',
  devRole: '角色',
  devLastSeen: '最近活跃',
  // ③ 统计区
  statsTitle: '本机状态 · 统计',
  statsScope: '本次运行',
  statUptime: '运行时长',
  statActive: '活跃设备',
  statPaired: '累计配对',
  statRejected: '拒绝尝试',
  statActiveStreams: '活跃连接',
  chartActivity: '连接活动（24h）',
  chartActivitySub: '每小时认证通过数',
  chartPairing: '配对成功（7d）',
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
  cfgRoleDesc: '保存后同步顶部配对权限，并重新生成二维码与短码；不会改变已配对设备的权限',
  cfgAttempts: '短码最大尝试次数',
  cfgAttemptsDesc: '超过次数短码立即作废（1–100）',
  cfgColdNote: '以下参数需重启后生效',
  cfgNetwork: '网络模式',
  cfgPort: '监听端口',
  cfgQrTtl: '票据有效期',
  cfgCodeTtl: '短码有效期',
  cfgTunnel: '隧道类型',
  // ① 令牌区
  autoReissue: '过期自动重签',
  qrFreshHint: '过期后自动生成新凭据并刷新二维码',
  clientTitle: '连接其他设备 · 主控端',
  clientSub: '连接成功后整机切换到该设备：侧栏工作区、会话、插件全部显示那台机器的数据。',
  connected: '已连接',
  detach: '断开并切回本机',
  notConnected: '当前指向本机，未连接其他设备。',
  originPlaceholder: '目标设备地址，例如 http://192.168.1.10:8443',
  secretPlaceholder: '短码（8 位）／票据／完整二维码链接 #dshrh=… 均可',
  scan: '📷 扫码',
  connect: '连接',
  connecting: '连接中…',
  secretInvalid: '无法识别：短码为 8 位（不含 I/L/O/U），或粘贴完整二维码链接。',
  originInvalid: '地址格式不正确：需要形如 http://主机:端口，且不带路径。',
  advanced: '连接参数（高级）',
  qrTitle: '配对二维码',
  qrTooLong: '二维码内容过长，请改用短码。',
  copyLink: '复制链接',
  copyCode: '复制短码',
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
  issueEquivalent: '二维码、短码、链接三者等价，任选其一交给对方即可',
  secretHint: '粘贴对方给的短码（8 位）、票据或完整二维码链接',
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

/** 密钥分类：8 位 Crockford 短码 / base64url 票据 / 非法。 */
export function classifyPairSecret(secret: string): 'code' | 'ticket' | null {
  const value = secret.trim()
  if (/^[0-9A-HJKMNP-TV-Z]{8}$/u.test(value)) return 'code'
  if (/^[A-Za-z0-9_-]{40,120}$/u.test(value)) return 'ticket'
  return null
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

/**
 * 配对链接的片段标记（二维码内容）。
 *
 * 形如 `http://127.0.0.1:8443#dshrh=<ticket>`：比自定义 scheme 短 ~40 字节
 * （QR 版本 5-L 只有 106 字节容量），且对扫码软件仍然是一个可读 URL。
 */
export const PAIR_LINK_MARKER = '#dshrh='

/** 构造配对链接（二维码内容）。 */
export function buildPairLink(origin: string, ticket: string): string {
  return `${origin.replace(/\/+$/u, '')}${PAIR_LINK_MARKER}${ticket}`
}

/** 解析配对链接；不是链接时返回 null。 */
export function parsePairLink(text: string): { origin: string; secret: string } | null {
  const value = text.trim()
  const at = value.indexOf(PAIR_LINK_MARKER)
  if (at <= 0) return null
  const origin = value.slice(0, at)
  const secret = value.slice(at + PAIR_LINK_MARKER.length)
  if (normalizeOrigin(origin) === undefined || classifyPairSecret(secret) === null) return null
  return { origin, secret }
}

/** 渲染 QR（白底 + 黑色模块；需显式白底，深色主题下也能扫——唯一允许的硬编码色）。 */
function renderQr(link: string): React.ReactNode {
  let matrix: ReturnType<typeof encodeQr>
  try {
    matrix = encodeQr(link)
  } catch {
    return React.createElement('p', { className: 'rh-lbl' }, STRINGS.qrTooLong)
  }
  const cells: React.ReactNode[] = []
  for (let y = 0; y < matrix.size; y++) {
    for (let x = 0; x < matrix.size; x++) {
      if (!matrix.modules[y]?.[x]) continue
      cells.push(React.createElement('rect', { key: `${x}-${y}`, x, y, width: 1, height: 1 }))
    }
  }
  return React.createElement(
    'svg',
    {
      'data-testid': 'pair-qr',
      viewBox: `-2 -2 ${matrix.size + 4} ${matrix.size + 4}`,
      width: 216,
      height: 216,
      role: 'img',
      'aria-label': STRINGS.qrTitle,
      style: { background: '#fff', borderRadius: 8, display: 'block', flex: 'none', border: '1px solid var(--rh-border)' },
    },
    React.createElement('rect', { x: -2, y: -2, width: matrix.size + 4, height: matrix.size + 4, fill: '#fff' }),
    React.createElement('g', { fill: '#000' }, ...cells),
  )
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
  return React.createElement(tag, { ...(props ?? {}), ...(className ? { className } : {}) }, ...children)
}

/**
 * 纯渲染。
 * 布局完全对照《云端设备布局设计参考》：四区卡片 + 区块头 + 胶囊 + 设备卡栅格。
 * @param state - 页面状态。
 * @param actions - 页面动作。
 * @returns React 节点。
 */
export function renderRemoteHubPage(state: RemoteHubPageState, actions: RemoteHubPageActions): React.ReactNode {
  const isCloud = state.mode.mode === 'cloud'
  const guardUp = state.guard !== null
  const activeDevices = state.devices.filter(device => device.revokedAt == null)
  // 签发可用性：有同源管理通道，或本机注入了 pin（回退路径）。
  const canIssue = state.adminAvailable === true
    || (state.pairIssueToken !== undefined && state.pairIssueToken !== '')
  // 二维码 / 链接的目标地址：**必须是其他设备可达的局域网地址**，
  // 守卫在 loopback 模式下公告的是 127.0.0.1，扫码方会被指向它自己的回环。
  const pairOrigin = (state.listenAddress !== undefined && state.listenAddress !== '')
    ? state.listenAddress
    : (state.guard?.origin ?? '')
  const link = state.issued !== null && state.issued.kind === 'ticket' && pairOrigin !== ''
    ? buildPairLink(pairOrigin, state.issued.value)
    : null

  // 签发结果块：三件套（二维码 / 短码 / 链接）始终渲染，未就绪时显示占位与引导，
  // 让用户一眼看到「还能生成另外两种」。
  const issuedBlock = canIssue
    ? el('div', 'rh-qrwrap', { 'data-testid': 'issued' }, renderIssuedBody(state, actions, link))
    : null

  // ① 顶部区：连接令牌（签发）+ 二维码 + 已配对设备卡栅格
  const hostCard = el('section', 'rh-card', { 'data-testid': 'host-section' },
    el('div', 'rh-section-head', undefined,
      el('div', 'rh-title', undefined,
        STRINGS.hostTitle,
        el('span', `rh-pill ${guardUp ? 'on' : 'danger'}`, { 'data-testid': 'guard-state' },
          el('span', 'rh-dot'), guardUp ? STRINGS.guardUp : STRINGS.guardDown)),
      el('div', 'rh-right', undefined,
        el('button', 'rh-btn small', {
          type: 'button', 'data-testid': 'refresh',
          disabled: state.busy !== null,
          onClick: () => actions.onRefresh(),
        }, state.loading ? STRINGS.refreshingBtn : STRINGS.refresh))),
    el('p', 'rh-sub', undefined, STRINGS.hostSub),

    // 状态行：地址 / 协议 / 网络 / 单控（参考 .minirow 参数组）
    guardUp
      ? el('div', 'rh-minirow', { 'data-testid': 'guard-status' },
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
      : el('div', undefined, undefined,
        el('p', 'rh-sub', { 'data-testid': 'guard-error' },
          state.loading ? STRINGS.refreshing : (state.guardError ?? STRINGS.noGuard))),

    // 局域网地址列表（供其他设备填写；每个地址都可一键复制）
    state.lanCandidates !== undefined && state.lanCandidates.length > 0
      ? el('div', 'rh-row', { 'data-testid': 'lan-addresses', style: { alignItems: 'center' } },
        el('span', 'rh-lbl', undefined, `${STRINGS.listenHint}：`),
        ...state.lanCandidates.map(address => el('span', {
          key: address, className: 'rh-pill small', style: { fontFamily: 'var(--rh-mono)' },
        },
        el('code', { style: { fontFamily: 'inherit' } }, address),
        el('button', 'rh-linkbtn', {
          type: 'button', 'data-testid': 'copy-address', 'data-address': address,
          title: STRINGS.copyAddress,
          onClick: () => actions.onCopy(address),
        }, STRINGS.copyAddress))))
      : null,

    // 签发区（角色胶囊组 + 生成按钮 + 签发结果）
    canIssue
      ? el('div', undefined, { 'data-testid': 'pair-issue' },
        el('div', 'rh-section-head', { style: { marginTop: 6 } },
          el('div', 'rh-title', undefined, STRINGS.issueTitle),
          el('div', 'rh-right', undefined,
            ROLES.map(role => el('button',
              `rh-btn small ${state.role === role ? 'primary' : ''}`, {
              key: role,
              type: 'button',
              'data-testid': 'role',
              'data-role': role,
              'data-selected': state.role === role ? 'true' : 'false',
              disabled: state.busy !== null,
              onClick: () => actions.onRoleChange(role),
            }, ROLE_LABEL[role])))),
        el('div', 'rh-row', undefined,
          el('button', 'rh-btn primary', {
            type: 'button', 'data-testid': 'issue-ticket',
            disabled: state.busy !== null,
            onClick: () => actions.onIssue('ticket'),
          }, state.busy === 'issue' ? STRINGS.issuing : STRINGS.issueTicket),
          el('button', 'rh-btn', {
            type: 'button', 'data-testid': 'issue-code',
            disabled: state.busy !== null,
            onClick: () => actions.onIssue('code'),
          }, STRINGS.issueCode),
          el('span', 'rh-lbl', undefined, STRINGS.ticketHint)),
        el('p', 'rh-lbl', { style: { margin: '2px 0 0' } }, STRINGS.issueEquivalent),

        // 签发结果块：三件套（二维码 / 短码 / 链接）始终可见，未就绪时显示占位与引导。
        issuedBlock,

        el('label', 'rh-row', { style: { gap: 6, cursor: 'pointer', fontSize: 12.5, color: 'var(--rh-text-2)' } },
          el('input', undefined, {
            type: 'checkbox', 'data-testid': 'auto-reissue', checked: state.autoReissue,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => actions.onAutoReissueChange(event.currentTarget.checked),
          }),
          `${STRINGS.autoReissue} · ${STRINGS.qrFreshHint}`))
      : el('p', 'rh-sub', { 'data-testid': 'pair-issue-unavailable' }, STRINGS.pairUnavailable),
  )

  // ② 设备区：筛选 + 入站分组（含清除全部）+ 出站指向卡
  const devicesCard = el('section', 'rh-card', { 'data-testid': 'devices-section' },
    el('div', 'rh-section-head', undefined,
      el('div', 'rh-title', undefined, STRINGS.devicesZoneTitle,
        el('span', 'rh-pill small', undefined, `${activeDevices.length} 台`)),
      el('div', 'rh-right', { 'data-testid': 'device-filter' },
        (['all', 'inbound'] as const).map(filter => el('button',
          `rh-btn small ${state.deviceFilter === filter ? 'primary' : ''}`, {
          key: filter,
          type: 'button', 'data-testid': 'filter',
          'data-filter': filter,
          onClick: () => actions.onFilterChange(filter),
        }, filter === 'all' ? STRINGS.filterAll : STRINGS.filterInbound)))),
    state.deviceFilter === 'all' || state.deviceFilter === 'inbound'
      ? el('div', 'rh-group', undefined,
        el('div', 'rh-group-head', undefined,
          el('span', 'rh-gtitle', undefined, STRINGS.groupInbound),
          el('span', 'rh-ghint', undefined, STRINGS.groupInboundHint),
          activeDevices.length > 0
            ? el('button', 'rh-btn small danger', {
              type: 'button', 'data-testid': 'revoke-all', style: { marginLeft: 'auto' },
              disabled: state.busy !== null,
              onClick: () => actions.onRevokeAll(),
            }, STRINGS.revokeAll)
            : null),
        state.devices.length === 0
          ? el('div', 'rh-empty', { 'data-testid': 'devices-empty', style: { border: '1px dashed var(--rh-border-strong)', borderRadius: 'var(--rh-radius-sm)' } },
            el('div', 'rh-ic', undefined, '📭'),
            el('div', 'rh-empty-title', undefined,
              state.loading ? STRINGS.devicesEmptyLoading : STRINGS.devicesEmptyTitle),
            el('div', undefined, STRINGS.devicesEmpty))
          : el('div', 'rh-devgrid', { 'data-testid': 'remote-hub-devices' },
            state.devices.map(device => renderDeviceCard(state, actions, device))))
      : null,
    state.deviceFilter === 'all'
      ? el('div', 'rh-group', undefined,
        el('div', 'rh-group-head', undefined,
          el('span', 'rh-gtitle', undefined, STRINGS.groupOutbound),
          el('span', 'rh-ghint', undefined, STRINGS.groupOutboundHint),
          el('button', 'rh-btn small primary', {
            type: 'button', 'data-testid': 'connect-entry', style: { marginLeft: 'auto' },
            onClick: () => {
              const target = document?.querySelector('[data-testid="client-section"]')
              target?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
            },
          }, `+ ${STRINGS.filterOutbound}`)),
        renderOutboundCard(state, actions))
      : null,
  )

  // ③ 统计区
  const statsCard = el('section', 'rh-card', { 'data-testid': 'stats-section' },
    el('div', 'rh-section-head', undefined,
      el('div', 'rh-title', undefined, STRINGS.statsTitle),
      el('div', 'rh-right', undefined, el('span', 'rh-pill small', undefined, STRINGS.statsScope))),
    state.stats == null
      ? el('div', 'rh-unsup', { 'data-testid': 'stats-unsupported' },
        state.statsError ?? STRINGS.statsUnsupported)
      : renderStatsBody(state))

  // ④ 配置区
  const configCard = el('section', 'rh-card', { 'data-testid': 'config-section' },
    el('div', 'rh-section-head', undefined,
      el('div', 'rh-title', undefined, STRINGS.configTitle),
      el('div', 'rh-right', undefined, renderConfigSavedPill(state))),
    state.config == null
      ? el('div', 'rh-unsup', { 'data-testid': 'config-unsupported' }, STRINGS.configUnsupported)
      : renderConfigBody(state, actions))

  // 出站分组内容：当前指向 / 连接表单（主控端）——独立卡片供 ② 区引用
  const clientCard = el('section', 'rh-card', { 'data-testid': 'client-section' },
    el('div', 'rh-section-head', undefined,
      el('div', 'rh-title', undefined, STRINGS.clientTitle,
        isCloud
          ? el('span', 'rh-pill on', undefined, el('span', 'rh-dot'), STRINGS.connected)
          : el('span', 'rh-pill off', undefined, el('span', 'rh-dot'), STRINGS.notConnectedShort))),
    el('p', 'rh-sub', undefined, STRINGS.clientSub),
    isCloud
      ? el('div', 'rh-row', { 'data-testid': 'connected-to' },
        el('span', 'rh-lbl', undefined,
          `${state.mode.deviceLabel ?? ''} ${state.mode.origin ?? ''}`.trim()),
        el('button', 'rh-btn small', {
          type: 'button', 'data-testid': 'detach',
          onClick: () => actions.onDetach(),
        }, STRINGS.detach))
      : el('p', 'rh-lbl', { 'data-testid': 'not-connected' }, STRINGS.notConnected),
    el('div', 'rh-row', undefined,
      el('input', 'rh-input', {
        'data-testid': 'origin-input', 'aria-label': '目标设备地址',
        placeholder: STRINGS.originPlaceholder,
        value: state.originDraft,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => actions.onOriginChange(event.currentTarget.value),
      })),
    el('div', 'rh-row', undefined,
      el('input', 'rh-input', {
        'data-testid': 'secret-input', 'aria-label': '配对短码、票据或链接',
        placeholder: STRINGS.secretPlaceholder,
        value: state.secretDraft,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => actions.onSecretChange(event.currentTarget.value),
      }),
      el('button', 'rh-btn', {
        type: 'button', 'data-testid': 'scan',
        'aria-label': '打开摄像头扫描二维码',
        disabled: state.busy !== null,
        onClick: () => actions.onScan(),
      }, STRINGS.scan),
      el('button', 'rh-btn primary', {
        type: 'button', 'data-testid': 'connect',
        disabled: state.busy !== null || normalizeOrigin(state.originDraft) === undefined
          || (classifyPairSecret(state.secretDraft) === null && parsePairLink(state.secretDraft) === null),
        onClick: () => actions.onConnect(),
      }, state.busy === 'connect' ? STRINGS.connecting : STRINGS.connect)),
    state.secretDraft.trim() !== ''
      && classifyPairSecret(state.secretDraft) === null
      && parsePairLink(state.secretDraft) === null
      ? el('p', 'rh-lbl', { 'data-testid': 'secret-invalid', style: { color: 'var(--rh-red)' } }, STRINGS.secretInvalid)
      : null,
    state.originDraft.trim() !== '' && normalizeOrigin(state.originDraft) === undefined
      ? el('p', 'rh-lbl', { 'data-testid': 'origin-invalid', style: { color: 'var(--rh-red)' } }, STRINGS.originInvalid)
      : null)

  return React.createElement(
    'div',
    { className: 'rh-root', style: S.root, 'data-testid': 'remote-hub-page', 'data-mode': state.mode.mode },
    // 主题样式：幂等注入（相同节点不会重复）；外部可预先覆盖 --rh-* 变量。
    React.createElement('style', { key: 'rh-theme', 'data-rh-theme': '' }, THEME_CSS),

    // 内容壳：限宽居中（背景由 .rh-root 全幅铺满）
    el('div', 'rh-shell', undefined,

    // 页头
    React.createElement('h1', { 'data-testid': 'page-title' }, STRINGS.title,
      React.createElement('span', {
        className: `rh-pill ${isCloud ? 'on' : ''}`,
        ...(isCloud ? {} : { style: { color: 'var(--rh-text-2)' } }),
        'data-testid': 'mode-badge',
      }, el('span', 'rh-dot'),
      isCloud ? `☁ ${state.mode.deviceLabel ?? state.mode.origin ?? STRINGS.modeCloud}` : STRINGS.modeLocal)),
    el('p', 'rh-lead', undefined, STRINGS.lead),

    // 四区（参考文档 ①→②→③→④；主控端连接表单收进 ② 出站分组下方）
    hostCard,
    devicesCard,
    clientCard,
    statsCard,
    configCard,

    // 错误条
    state.error !== null
      ? el('div', 'rh-error', { role: 'alert', 'data-testid': 'page-error' },
        React.createElement('span', undefined, '⚠️'), React.createElement('span', null, state.error))
      : null,

    // 守卫诊断（默认展开：故障时用户不必打开开发者工具）
    renderDiagnosticCard(state),

    // 运行日志（最近 30 条时间线；有错误时默认展开）
    renderLogCard(state),

    // 高级（折叠收纳，参考 .collapse）
    React.createElement('details', { className: 'rh-collapse' },
      React.createElement('summary', undefined, STRINGS.advanced),
      React.createElement('ul', undefined,
        React.createElement('li', undefined, `存储键：${MODE_KEY}`),
        React.createElement('li', undefined, `守卫地址：${state.guard?.origin ?? '（未检测到）'}`),
        React.createElement('li', undefined, `协议版本：${state.guard?.protocolVersion ?? 1}（X-Hub-Protocol）`))),
    ),
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
  el('div', 'rh-minirow rh-diagnostic-grid', { 'data-testid': 'diagnostic-grid', style: { padding: '0 16px', marginTop: 8 } },
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
  el('div', 'rh-diagnostic-grid', { 'data-testid': 'diagnostic-transport-grid' }, ...renderTakeoverRow(state)),
  el('div', 'rh-minirow rh-diagnostic-grid', { 'data-testid': 'diagnostic-request-grid', style: { padding: '0 16px' } },
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
    el('span', `rh-pill small ${pillCls}`, {
      'data-testid': 'device-status',
      'data-status': status,
    }, el('span', 'rh-dot'), statusLabel)),
  el('div', 'rh-minirow', { style: { margin: '2px 0' } },
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
  el('div', 'rh-dev-foot', undefined,
    !invalid ? el('button', 'rh-btn small danger', {
      type: 'button', 'data-testid': 'revoke', disabled: state.busy !== null,
      onClick: () => actions.onRevoke(device.deviceId),
    }, STRINGS.revoke) : null,
    actions.onForgetDevice ? el('button', 'rh-btn small danger', {
      type: 'button', 'data-testid': 'device-delete', disabled: state.busy !== null,
      onClick: () => actions.onForgetDevice?.(device.deviceId),
    }, '删除记录 / Delete') : null))
}

/** Display only recorded pairing facts; legacy missing metadata remains unknown. */
function renderOutboundFacts(target?: OutboundTarget): React.ReactNode {
  const time = (value?: number): string => value === undefined ? '未知（旧配对未记录）' : new Date(value).toLocaleString()
  return el('div', 'rh-minirow', { 'data-testid': 'outbound-facts' },
    React.createElement('div', null, '授权角色：', target?.role ? (ROLE_LABEL[target.role as RoleName] ?? target.role) : '未知（需重新配对确认）'),
    React.createElement('div', null, '配对时间：', time(target?.pairedAt)),
    React.createElement('div', null, '最近连接：', time(target?.lastConnectedAt)),
    React.createElement('div', null, '配对标识：', target?.deviceId ?? target?.id?.slice(0, 12) ?? '未知'))
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
        el('span', 'rh-pill small on', undefined, el('span', 'rh-dot'), STRINGS.connected)),
      renderOutboundFacts((state.outboundTargets ?? []).find(target => outboundTargetIdentity(target) === currentTarget)),
      el('div', 'rh-dev-foot', undefined,
        el('button', 'rh-btn small danger', {
          type: 'button', 'data-testid': 'detach-inline',
          onClick: () => actions.onDetach(),
        }, STRINGS.detach)))
    const otherCards = otherTargets.map(target => el('div', 'rh-dev offline', {
      key: outboundTargetIdentity(target),
      'data-testid': 'outbound-paired',
      'data-origin': target.origin,
      'data-status': 'paired',
    },
      el('div', 'rh-dev-top', undefined,
        el('div', 'rh-dev-ico', undefined, '💤'),
        el('div', 'rh-dev-meta', undefined,
          el('div', 'rh-dev-nm', undefined, outboundTargetLabel(target, state.outboundTargets)),
          el('div', 'rh-dev-sub', undefined, target.origin)),
        el('span', 'rh-pill small off', undefined, el('span', 'rh-dot'), STRINGS.statusPaired)),
      renderOutboundFacts(target),
      actions.onForgetOutbound ? el('button', 'rh-btn small danger', {
        type: 'button', 'data-testid': 'outbound-delete', disabled: state.busy !== null,
        onClick: () => actions.onForgetOutbound?.(target),
      }, '删除配对 / Delete') : null,
      el('div', 'rh-dev-foot', undefined,
        el('button', 'rh-btn small primary', {
          type: 'button', 'data-testid': 'reconnect',
          disabled: state.busy !== null,
          onClick: () => actions.onReconnect(target),
        }, STRINGS.connect))))
    return React.createElement(React.Fragment, null, currentCard, ...otherCards)
  }

  const paired = state.outboundTargets ?? []
  return el('div', 'rh-outbound-list', { 'data-testid': 'outbound-paired-list' },
    paired.length === 0
      ? el('div', 'rh-dev', { 'data-testid': 'outbound-none' },
        el('div', 'rh-dev-top', undefined,
          el('div', 'rh-dev-ico', undefined, '🔗'),
          el('div', 'rh-dev-meta', undefined,
            el('div', 'rh-dev-nm', undefined, STRINGS.notConnected),
            el('div', 'rh-dev-sub', undefined, STRINGS.clientSub))),
        el('div', 'rh-dev-foot', undefined,
          el('button', 'rh-btn small primary', {
            type: 'button', 'data-testid': 'connect-entry',
            onClick: () => {
              document?.querySelector('[data-testid="client-section"]')
                ?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
            },
          }, `+ ${STRINGS.connect}`)))
      : paired.map(target => el('div', 'rh-dev offline', {
        key: outboundTargetIdentity(target),
        'data-testid': 'outbound-paired',
        'data-origin': target.origin,
        'data-status': 'paired',
      },
        el('div', 'rh-dev-top', undefined,
          el('div', 'rh-dev-ico', undefined, '💤'),
          el('div', 'rh-dev-meta', undefined,
            el('div', 'rh-dev-nm', undefined, outboundTargetLabel(target, state.outboundTargets)),
            el('div', 'rh-dev-sub', undefined, target.origin)),
          el('span', 'rh-pill small off', undefined, el('span', 'rh-dot'), STRINGS.statusPaired)),
        renderOutboundFacts(target),
      actions.onForgetOutbound ? el('button', 'rh-btn small danger', {
        type: 'button', 'data-testid': 'outbound-delete', disabled: state.busy !== null,
        onClick: () => actions.onForgetOutbound?.(target),
      }, '删除配对 / Delete') : null,
        el('div', 'rh-dev-foot', undefined,
          el('button', 'rh-btn small primary', {
            type: 'button', 'data-testid': 'reconnect',
            disabled: state.busy !== null,
            onClick: () => actions.onReconnect(target),
          }, STRINGS.connect)))))
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
  if (state.configSaving) return el('span', 'rh-pill small', undefined, STRINGS.configSavingLbl)
  const dirty = state.configDraft !== null
    && JSON.stringify(state.configDraft) !== JSON.stringify(state.config)
  if (dirty) {
    return el('span', 'rh-pill small danger', { 'data-testid': 'config-dirty' }, STRINGS.configUnsaved)
  }
  return state.configSavedAt !== null
    ? el('span', 'rh-pill small on', { 'data-testid': 'config-saved' }, STRINGS.configSaved)
    : null
}

/** 行式配置主体（开关 / 下拉 / 数字输入 + 冷项展示）。 */
function renderConfigBody(state: RemoteHubPageState, actions: RemoteHubPageActions): React.ReactNode {
  const draft = state.configDraft ?? {}
  const value = (key: string): unknown => draft[key]
  const boolRow = (key: 'singleController' | 'bridgeApprovals', title: string, desc: string, testid: string) =>
    el('div', 'rh-crow', undefined,
      el('div', 'rh-cl', undefined,
        el('div', 'rh-ct1', undefined, title),
        el('div', 'rh-cd', undefined, desc)),
      el('div', 'rh-cc', undefined,
        el('button', `rh-switch ${value(key) === true ? 'on' : ''}`, {
          type: 'button', role: 'switch', 'aria-checked': value(key) === true ? 'true' : 'false',
          'data-testid': testid,
          onClick: () => actions.onConfigChange(key, !(value(key) === true)),
        }, el('i'))))
  return el('div', undefined, { 'data-testid': 'config-body' },
    el('div', 'rh-cfg', undefined,
      boolRow('singleController', STRINGS.cfgSingle, STRINGS.cfgSingleDesc, 'cfg-single'),
      boolRow('bridgeApprovals', STRINGS.cfgBridge, STRINGS.cfgBridgeDesc, 'cfg-bridge'),
      el('div', 'rh-crow', undefined,
        el('div', 'rh-cl', undefined,
          el('div', 'rh-ct1', undefined, STRINGS.cfgRole),
          el('div', 'rh-cd', undefined, STRINGS.cfgRoleDesc)),
        el('div', 'rh-cc', undefined,
          el('select', 'rh-select', {
            'data-testid': 'cfg-role', value: String(value('defaultRole') ?? 'control'),
            onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
              actions.onConfigChange('defaultRole', event.currentTarget.value),
          },
          ROLES.map(role => el('option', { key: role, value: role }, ROLE_LABEL[role]))))),
      el('div', 'rh-crow', undefined,
        el('div', 'rh-cl', undefined,
          el('div', 'rh-ct1', undefined, STRINGS.cfgAttempts),
          el('div', 'rh-cd', undefined, STRINGS.cfgAttemptsDesc)),
        el('div', 'rh-cc', undefined,
          el('input', 'rh-num', {
            type: 'number', min: 1, max: 100, 'data-testid': 'cfg-attempts',
            value: String(value('maxPairAttempts') ?? 5),
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
              const parsed = Number.parseInt(event.currentTarget.value, 10)
              if (!Number.isNaN(parsed)) actions.onConfigChange('maxPairAttempts', parsed)
            },
          })))),
    // 冷项（只读展示 + 需重启标注）
    el('div', 'rh-cold', undefined, STRINGS.cfgColdNote),
    el('div', 'rh-minirow', { style: { marginTop: 8 } },
      el('div', undefined,
        el('div', 'rh-k', undefined, STRINGS.cfgNetwork),
        el('div', 'rh-v', undefined, value('network') === 'lan' ? STRINGS.netLan : STRINGS.netLoopback)),
      el('div', undefined,
        el('div', 'rh-k', undefined, STRINGS.cfgPort),
        el('div', 'rh-v', undefined, String(value('guardPort') ?? '—'))),
      el('div', undefined,
        el('div', 'rh-k', undefined, STRINGS.cfgQrTtl),
        el('div', 'rh-v', undefined, `${Math.round(Number(value('pairQrTtlMs') ?? 0) / 1000)}s`)),
      el('div', undefined,
        el('div', 'rh-k', undefined, STRINGS.cfgCodeTtl),
        el('div', 'rh-v', undefined, `${Math.round(Number(value('pairCodeTtlMs') ?? 0) / 1000)}s`)),
      el('div', undefined,
        el('div', 'rh-k', undefined, STRINGS.cfgTunnel),
        el('div', 'rh-v', undefined, String(value('tunnelKind') ?? '—')))),
    el('div', 'rh-row', undefined,
      el('button', 'rh-btn primary', {
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
/** 签发有效期（毫秒）：票据与短码都是 15 秒轮换——用于倒计时进度条比例。 */
const ISSUE_TTL: Record<IssuedPairing['kind'], number> = { ticket: 15_000, code: 15_000 }

function renderIssuedBody(
  state: RemoteHubPageState,
  actions: RemoteHubPageActions,
  link: string | null,
): React.ReactNode {
  const ticket = state.issued !== null && state.issued.kind === 'ticket' ? state.issued : null
  const code = state.issuedCode !== null && state.issuedCode.kind === 'code' ? state.issuedCode : null
  // 二维码：票据存在时渲染；否则显示占位提示（引导点击「生成二维码」）。
  const qr = link !== null
    ? renderQr(link)
    : el('div', 'rh-qr-placeholder', { 'data-testid': 'qr-placeholder' },
      el('div', 'rh-ic', undefined, '▦'),
      el('div', undefined, STRINGS.qrPending))

  return el('div', 'rh-tokenbody', undefined,
    // ── 二维码 ────────────────────────────────────────────────────────────
    el('div', 'rh-tokcol rh-tokcol-qr', undefined, qr),

    // ── 凭据信息（短码 + 链接 + 倒计时）──────────────────────────────────
    el('div', 'rh-tokcol rh-tokcol-info', undefined,
      el('div', 'rh-minirow', { style: { marginBottom: 8 } },
        el('div', undefined,
          el('div', 'rh-k', undefined, STRINGS.issuedRole),
          el('div', 'rh-v', undefined,
            ROLE_LABEL[((ticket ?? code)?.role as RoleName) ?? state.role] ?? ((ticket ?? code)?.role ?? state.role))),
        el('div', undefined,
          el('div', 'rh-k', undefined, STRINGS.issuedKind),
          el('div', 'rh-v', { 'data-testid': 'issued-kind' },
            ticket !== null ? STRINGS.issuedTicket : code !== null ? STRINGS.issuedCodeLabel : STRINGS.issuedNone))),

      // 短码：就绪时显示真实短码，否则显示占位 + 引导
      el('div', 'rh-lbl', undefined, STRINGS.issuedCodeLabel),
      code !== null
        ? el('code', 'rh-codevalue', { 'data-testid': 'issued-code' }, code.value)
        : el('div', 'rh-codevalue rh-codevalue-empty', { 'data-testid': 'issued-code-empty' },
          el('span', undefined, STRINGS.codePending),
          el('button', 'rh-linkbtn', {
            type: 'button', 'data-testid': 'issue-code-inline',
            disabled: state.busy !== null,
            onClick: () => actions.onIssue('code'),
          }, STRINGS.issueCode)),

      // 链接：票据存在时显示可复制的完整链接
      el('div', 'rh-lbl', { style: { marginTop: 12 } }, STRINGS.issuedLinkLabel),
      link !== null
        ? el('code', 'rh-linkvalue', { 'data-testid': 'issued-link' }, link)
        : el('div', 'rh-linkvalue rh-codevalue-empty', { 'data-testid': 'issued-link-empty' },
          el('span', undefined, STRINGS.linkPending),
          el('button', 'rh-linkbtn', {
            type: 'button', 'data-testid': 'issue-ticket-inline',
            disabled: state.busy !== null,
            onClick: () => actions.onIssue('ticket'),
          }, STRINGS.issueTicket)),

      // 倒计时
      el('div', 'rh-lbl', { style: { marginTop: 12 } }, STRINGS.countdownLabel),
      el('div', 'rh-countdown', { 'data-testid': 'issued-countdown-bar', role: 'presentation' },
        React.createElement('i', { style: { width: `${Math.round(issuedRatio(state) * 100)}%` } })),
      el('div', 'rh-row', { style: { marginTop: 8 } },
        link !== null
          ? el('button', 'rh-btn small', {
            type: 'button', 'data-testid': 'copy-link',
            onClick: () => actions.onCopy(link),
          }, STRINGS.copyLink)
          : null,
        code !== null
          ? el('button', 'rh-btn small', {
            type: 'button', 'data-testid': 'copy-code',
            onClick: () => actions.onCopy(code.value),
          }, STRINGS.copyCode)
          : null,
        el('span', 'rh-lbl', { 'data-testid': 'issued-countdown' }, countdownText(state)))))
}

/** 倒计时用的「最近一次签发」（票据优先，其次短码）。 */
function latestIssue(state: RemoteHubPageState): IssuedPairing | null {
  if (state.issued !== null) return state.issued
  return state.issuedCode ?? null
}

/** 签发倒计时进度（0–1，按签发类型的有效期归一）。 */
function issuedRatio(state: RemoteHubPageState): number {
  const latest = latestIssue(state)
  if (latest === null) return 0
  const ttl = ISSUE_TTL[latest.kind] ?? 15_000
  const left = Math.max(0, latest.expiresAt - state.now)
  return Math.min(1, left / ttl)
}

/** 倒计时文案（含角色）。 */
function countdownText(state: RemoteHubPageState): string {
  const latest = latestIssue(state)
  if (latest === null) return ''
  const left = remainingSeconds(latest.expiresAt, state.now)
  const role = ROLE_LABEL[latest.role as RoleName] ?? latest.role
  return left > 0 ? `剩余 ${left}s · 角色 ${role}` : '已过期，请重新生成'
}

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
  issueTicket: (input: { origin: string; pairIssueToken: string; role: RoleName }) => Promise<{ ticket: string; expiresAt: number; role: string }>
  issueCode: (input: { origin: string; pairIssueToken: string; role: RoleName }) => Promise<{ code: string; expiresAt: number; role: string }>
  /**
   * 同源签发（桌面端唯一可用路径）。
   *
   * 桌面页面 origin 是 `dsh-app://app`，无法跨协议 fetch 守卫；签发必须走
   * `hub/admin.issue` 同源通道。缺省时回退到 `issueTicket` / `issueCode`。
   */
  adminIssue?: (input: { kind: 'ticket' | 'code'; role: RoleName }) => Promise<{
    kind: 'ticket' | 'code'
    value: string
    expiresAt: number
    role: string
  }>
  /** 出站连接状态读写（`carrier-mode.json`；磁盘为真源，CLI 配对也能被页面感知）。 */
  carrier?: () => Promise<{ mode: Record<string, unknown>; at: number }>
  carrierWrite?: (mode: Record<string, unknown>) => Promise<number>
  listOutboundTargets?: () => Promise<readonly OutboundTarget[]>
  saveOutboundTarget?: (target: Omit<OutboundTarget, 'id'> & { token: string }) => Promise<OutboundTarget>
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
  connect: (input: { origin: string; secret: string }) => Promise<{
    token: string
    role: string
    deviceId?: string
    label?: string
    /** 单控模式下被本次配对踢下线的设备（供 UI 提示）。 */
    displacedDevices?: { deviceId: string; label: string }[]
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
    const [role, setRole] = React.useState<RoleName>('control')
    const [deletePrompt, setDeletePrompt] = React.useState<{ message: string; run(): void } | null>(null)
    const selectedRoleRef = React.useRef(role)
    selectedRoleRef.current = role
  /** 同时持有一张票据与一个短码（两者独立有效期，一起展示）。 */
  const [ticket, setTicket] = React.useState<IssuedPairing | null>(null)
  const [code, setCode] = React.useState<IssuedPairing | null>(null)
    const [originDraft, setOriginDraft] = React.useState<string>(
      () => (mode.mode === 'cloud' ? (mode.origin ?? '') : ''),
    )
    const [secretDraft, setSecretDraft] = React.useState<string>('')
    const [busy, setBusy] = React.useState<null | 'connect' | 'issue' | 'revoke' | 'delete' | 'refresh' | 'detach'>(null)
    const [error, setError] = React.useState<string | null>(null)
    const [now, setNow] = React.useState<number>(() => clock())
    const [scannerOpen, setScannerOpen] = React.useState(false)
    // 四区扩展状态
    const [autoReissue, setAutoReissue] = React.useState<boolean>(() => {
      try { return storage?.getItem('remote-hub:auto-reissue') !== '0' } catch { return true }
    })
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
          setRole(configuredDefaultRole(snapshot.defaultRole))
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

    React.useEffect(() => {
      if (ticket === null && code === null) return undefined
      const timer = setInterval(() => { setNow(clock()) }, 1000)
      return () => { clearInterval(timer) }
    }, [ticket === null, code === null])

    // ③ 指标轮询（60s；守卫不可用时节流不重试）。
    React.useEffect(() => {
      if (deps.stats === undefined || guard === null) return undefined
      const timer = setInterval(() => { refreshStats() }, 60_000)
      return () => { clearInterval(timer) }
    }, [deps.stats, guard === null, refreshStats])

    /**
     * 15 秒轮换：票据与短码**各自独立**到期后立即换新。
     *
     * 为什么是 15 秒：配对凭据只在极短窗口内有效，配对成功那一刻服务端就下发
     * 长期设备令牌并持久化到设备表，设备此后凭令牌长期访问 —— 凭据过期不会
     * 让已配对设备掉线，只是页面上展示的码会不断更新。
     */
    React.useEffect(() => {
      if (!autoReissue || busy !== null) return
      const ticketExpired = ticket !== null && remainingSeconds(ticket.expiresAt, now) <= 0
      const codeExpired = code !== null && remainingSeconds(code.expiresAt, now) <= 0
      if (!ticketExpired && !codeExpired) return
      if (deps.adminIssue === undefined
        && (deps.injected().pairIssueToken ?? '') === '') return
      if (ticketExpired) void issueOne('ticket')
      if (codeExpired) void issueOne('code')
    }, [ticket, code, autoReissue, now, busy, guard])

    /**
     * 签发一枚凭据并写入对应状态槽（票据 → ticket，短码 → code）。
     * @param kind - 凭据类型。
     * @param roleOverride - 指定角色（缺省用页面当前选择）。
     */
    function issueOne(
      kind: 'ticket' | 'code',
      roleOverride?: RoleName,
    ): Promise<void> {
      const useRole = roleOverride ?? role
      // 守卫直连回退路径需要 pin + 地址；同源通道不需要。
      if (deps.adminIssue === undefined
        && (deps.injected().pairIssueToken ?? '') === '') {
        return Promise.reject(new Error('本机签发不可用：缺少签发凭据'))
      }
      const pairIssueToken = deps.injected().pairIssueToken
      const origin = guard?.loopbackOrigin
        ?? deps.injected().loopbackOrigin
        ?? guard?.origin
        ?? normalizeOrigin(deps.injected().guardOrigin ?? '')
      const run = deps.adminIssue !== undefined
        // 同源通道：桌面端 dsh-app 页面无法跨协议访问守卫。
        ? deps.adminIssue({ kind, role: useRole }).then(result => ({
          kind: result.kind, value: result.value, role: result.role, expiresAt: result.expiresAt,
        }))
        : kind === 'ticket'
          ? deps.issueTicket({ origin: origin as string, pairIssueToken: pairIssueToken as string, role: useRole }).then(result => ({
            kind: 'ticket' as const, value: result.ticket, role: result.role, expiresAt: result.expiresAt,
          }))
          : deps.issueCode({ origin: origin as string, pairIssueToken: pairIssueToken as string, role: useRole }).then(result => ({
            kind: 'code' as const, value: result.code, role: result.role, expiresAt: result.expiresAt,
          }))
      return run
        .then(result => {
          if (selectedRoleRef.current !== useRole) return
          if (result.kind === 'ticket') setTicket(result)
          else setCode(result)
          setNow(clock())
          deps.log?.('info', result.kind === 'ticket' ? '二维码已更新' : '短码已更新',
            `${Math.round((result.expiresAt - clock()) / 1000)}s 有效`, 'hub/admin.issue')
        })
        .catch((cause: unknown) => {
          deps.log?.('warn', kind === 'ticket' ? '二维码刷新失败' : '短码刷新失败', describeGuardFailure(cause))
        })
    }

    const actions: RemoteHubPageActions = {
      onRefresh() { refresh() },
      onRoleChange(next) { setRole(next) },
      onCopy(text) {
        const clipboard = (globalThis as {
          navigator?: { clipboard?: { writeText?: (value: string) => Promise<void> } }
        }).navigator?.clipboard
        void clipboard?.writeText?.(text)
      },
      onIssue(kind) {
        setBusy('issue')
        setError(null)
        deps.log?.('info', kind === 'ticket' ? '开始签发二维码' : '开始签发短码', `角色 ${ROLE_LABEL[role]}`)
        void issueOne(kind)
          .catch((cause: unknown) => {
            setError(`生成失败：${describeGuardFailure(cause)}`)
            deps.log?.('error', '签发失败', describeGuardFailure(cause), 'hub/admin.issue')
          })
          .finally(() => { setBusy(null) })
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
      onOriginChange(value) { setOriginDraft(value) },
      onSecretChange(value) {
        setSecretDraft(value)
        // 粘贴二维码链接时自动填充地址。
        const parsed = parsePairLink(value)
        if (parsed !== null) setOriginDraft(parsed.origin)
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
      onScan() { setScannerOpen(true) },
      onAutoReissueChange(enabled) {
        setAutoReissue(enabled)
        try { storage?.setItem('remote-hub:auto-reissue', enabled ? '1' : '0') } catch { /* 无存储时跳过 */ }
      },
      onFilterChange(filter) { setDeviceFilter(filter) },
      onConfigChange(key, value) {
        setConfigDraft(previous => ({ ...(previous ?? {}), [key]: value }))
        if (key === 'defaultRole') setRole(configuredDefaultRole(value))
        setConfigSavedAt(null)
      },
      onConfigSave() {
        if (deps.patchConfig === undefined || configDraft === null) return
        const patch: Record<string, unknown> = {}
        for (const key of ['singleController', 'bridgeApprovals', 'defaultRole', 'maxPairAttempts']) {
          if (Object.hasOwn(configDraft, key)) patch[key] = configDraft[key]
        }
        setConfigSaving(true)
        setError(null)
        void deps.patchConfig(patch)
          .then(result => {
            setConfig(result)
            setConfigDraft(result)
            setRole(configuredDefaultRole(result.defaultRole))
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
        const link = parsePairLink(secretDraft)
        connectWith(normalizeOrigin(link?.origin ?? originDraft), link?.secret ?? secretDraft.trim())
      },
    }

    /**
     * 进入页面自动签发**二维码 + 短码**（两者独立 15 秒轮换）。
     *
     * 用户不该需要手动点击才能看到可扫的码；三种凭据同时就绪，任选其一交给
     * 对方即可。之后由「过期自动重签」各自续期。失败静默（运行日志记录原因）。
     */
    const autoIssuedRef = React.useRef<RoleName | null>(null)
    React.useEffect(() => {
      if (autoIssuedRef.current === role) return
      if (guard === null) return
      // 同源管理通道或注入 pin 任一可用即可签发。
      if (deps.adminIssue === undefined && (deps.injected().pairIssueToken ?? '') === '') return
      autoIssuedRef.current = role
      setTicket(null); setCode(null)
      void issueOne('ticket')
      void issueOne('code')
    }, [guard, actions])

    /**
     * 用给定 origin/secret 建立连接（`onConnect` 与扫码共用）。
     * @param target - 已规范化的地址；undefined 表示非法。
     * @param secret - 短码或票据。
     */
    function connectWith(target: string | undefined, secret: string): void {
      if (target === undefined) {
        setError('目标地址格式不正确。')
        return
      }
      if (classifyPairSecret(secret) === null) {
        setError('配对凭据格式不正确。')
        return
      }
      setBusy('connect')
      setError(null)
      void deps.connect({ origin: target, secret })
        .then(async result => {
          const next: CarrierMode = {
            mode: 'cloud',
            origin: target,
            token: result.token,
            ...(result.label ?? result.deviceId !== undefined
              ? { deviceLabel: result.label ?? result.deviceId }
              : {}),
          }
          if (deps.saveOutboundTarget === undefined || deps.carrierWrite === undefined) {
            setError('宿主不支持安全保存配对凭据；配对可能已兑换，请在目标端检查并撤销孤立设备。')
            return
          }
          const paired = await persistNewPairing({
            saveTarget: () => deps.saveOutboundTarget!({
              origin: target,
              token: result.token,
              ...(next.deviceLabel === undefined ? {} : { deviceLabel: next.deviceLabel }),
              ...(result.deviceId === undefined ? {} : { deviceId: result.deviceId }),
              role: result.role,
              pairedAt: clock(),
              lastConnectedAt: clock(),
            }),
            writeCloudMode: saved => deps.carrierWrite!({
              mode: 'cloud',
              origin: saved.origin,
              targetId: saved.id,
              ...(saved.deviceLabel === undefined ? {} : { deviceLabel: saved.deviceLabel }),
            }),
            setCloudMode: saved => {
              writeCarrierMode({ ...next, targetId: saved.id }, storage)
              setOutboundTargets(previous => upsertOutboundTarget(previous, saved))
            },
          })
          if (!paired.archiveSaved) {
            setError('配对已在目标端兑换，但本机 profile 档案保存失败；未切换，请在目标端撤销孤立配对后重试。')
            return
          }
          if (!paired.carrierSaved) {
            setOutboundTargets(previous => upsertOutboundTarget(previous, paired.target!))
            setError('配对已保存到本机档案，但 carrier 切换失败；可从已配对卡重试。')
            return
          }
          lastCarrierAtRef.current = -1
          const displaced = result.displacedDevices ?? []
          if (displaced.length > 0) {
            deps.log?.('info', '单控已切换控制端', displaced.map(device => device.label).join('、'))
          }
          reload()
        })
        .catch((cause: unknown) => {
          setError(`连接失败：${cause instanceof Error ? cause.message : String(cause)}`)
        })
        .finally(() => { setBusy(null) })
    }

    /**
     * 扫码命中：解析链接 → 回填表单 → 直接连接。
     * @param text - 解码出的原始文本。
     */
    function applyScan(text: string): void {
      setScannerOpen(false)
      const link = parsePairLink(text)
      const secret = link?.secret ?? text.trim()
      const target = normalizeOrigin(link?.origin ?? originDraft)
      if (link !== null) setOriginDraft(link.origin)
      setSecretDraft(secret)
      if (target === undefined || classifyPairSecret(secret) === null) {
        setError('扫到的内容不是本插件的配对二维码（可改用短码手动输入）。')
        return
      }
      connectWith(target, secret)
    }

    const page = renderRemoteHubPage({
      mode,
      outboundTargets,
      guard,
      guardError,
      devices,
      loading,
      ...(deps.injected().pairIssueToken !== undefined
        ? { pairIssueToken: deps.injected().pairIssueToken }
        : {}),
      role,
      issued: ticket,
      issuedCode: code,
      autoReissue,
      originDraft,
      secretDraft,
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
      adminAvailable: deps.adminIssue !== undefined || deps.diagnostic !== undefined,
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
    return scannerOpen
      ? React.createElement(React.Fragment, null,
        page,
        React.createElement(QrScanner, {
          onResult: (text: string) => { applyScan(text) },
          onClose: () => { setScannerOpen(false) },
        }))
      : page
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
