/**
 * 本插件**自己**的 Remote 面（namespace `hub`）。
 *
 * ⚠️ v0.2 / D-1：这里**不再镜像**官方 endpoint（那十个业务方法的翻译层已删除）。
 * 官方 endpoint 由守卫直接转发到 `createSharedFetchHandler('/api')`；这里只剩下
 * 官方**不给非 owner Peer** 的三件事：设备管理、流（长轮询）、审批应答。
 *
 * 每个类都是 `TypertRemoteService` 子类，用 `@Remote` 装饰器导出方法 —— 所以
 * 它们和官方 endpoint 走**完全相同**的裁决路径：Gateway 的参数校验 →
 * `remoteAccess.decide()` → 业务调用（红线 R9：不存在绕过守卫的简化端点）。
 *
 * ## 参数形状为什么这么写
 *
 * Gateway 的 SRC 描述符用 `Function.prototype.toString()` 读方法的**参数名**，
 * 并把它们当作 wire 字段名（`methodParameterNames()` in gateway/src/index.ts）。
 * 所以下面每个方法的参数名就是客户端 `payload.args` 里必须出现的字段名，
 * 一个不多一个不少（`assertExactArguments` 会拒掉多余字段）。这是**故意**的：
 * 它让「参数校验只有一份实现」成为现实（D-1 的直接收益）。
 *
 * 对应关系（客户端 `hub/stream.*` 契约与此逐字一致）：
 * - `hub/stream.open(endpoint, args)`      → `{ endpoint, args }`
 * - `hub/stream.next(streamId, cursor, holdMs)` → `{ streamId, cursor, holdMs }`
 * - `hub/stream.cancel(streamId)`          → `{ streamId }`
 * - `hub/devices()`                        → `{}`
 * - `hub/revoke(deviceId)`                 → `{ deviceId }`
 * - `hub/answerApproval(requestId, outcome)` → `{ requestId, outcome }`
 *
 * @module dsh-remote-hub/host/services
 */
import type { Context } from '@deepseek-ai/cordis'
import { readFile, rename, stat, writeFile, mkdir } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import {
  Remote,
  TypertRemoteService,
  principalOf,
} from '@deepseek-ai/dsh-typert-protocol'

import { ERROR_CODES, GUARD_ROUTES, HUB_NAMESPACE, HUB_SERVICE_KEYS } from '@core/index.js'
import { allActionsFor } from '@core/capabilities.js'
import { isRoleName } from '@core/roles.js'
import type { RoleName } from '@core/index.js'

import type { AccessPolicyHandles } from '../policy.js'
import type { StreamEngine } from '../streams.js'
import type { ApprovalBridge } from '../approval-bridge.js'
import { dshHome } from '../devices.js'
import type { DeviceStore } from '../devices.js'
import type { PairingService } from '../pairing.js'
import type { TokenService } from '../token.js'
import { remoteDeviceOf } from '../principal.js'
import { createOutboundTargetStore, outboundTargetView } from '../outbound-targets.js'

/** 所有 `hub/*` 服务共享的依赖。 */
export interface HubServicesDeps {
  streams: StreamEngine
  approvals: ApprovalBridge
  devices: DeviceStore
  tokens: TokenService
  policy: AccessPolicyHandles
  /** 配对签发（管理面 `admin.issue` 与守卫签发共用同一出口）。 */
  pairing: PairingService
  /** 把吊销事件传播到流引擎（由 plugin.ts 接线）。 */
  onRevoked: (deviceId: string) => void
  /** 本机管理面（owner 页面同源调用；`/remote/*` 守卫端点之外的第二条通道）。 */
  metrics?: import('./index.js').AdminDeps['metrics']
  configStore?: AdminDeps['configStore']
  guard?: () => AdminDeps['guard']
}

/** `carrier-mode.json` 的位置（与其它持久化文件同目录，遵循 `DSH_HOME`）。 */
function carrierPath(): string {
  return join(dshHome(), 'remote-hub', 'carrier-mode.json')
}

/**
 * 读取出站连接状态快照。
 *
 * 文件缺失/损坏/形状不合法时一律返回 `{ mode: 'local' }`（宁可回到本机，
 * 也不让页面拿到一个半残的 cloud 状态）。
 *
 * **`exists`（2026-11-12）**：区分「用户显式断开」与「从未配对」。
 * 页面点「断开并切回本机」会写 `{ mode: 'local' }` 到磁盘；只有 `mode` 字段时
 * carrier 无法判断是否该否决接管，会被 localStorage 的旧 cloud 状态翻盘。
 *
 * @returns `{ mode, at, exists }`；`at` 是文件 mtime（缺失时为 0）。
 */
export async function readCarrierFile(): Promise<{
  mode: Record<string, unknown>
  at: number
  exists: boolean
}> {
  const file = carrierPath()
  let at = 0
  try {
    at = (await stat(file)).mtimeMs
  } catch {
    return { mode: { mode: 'local' }, at: 0, exists: false }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return { mode: { mode: 'local' }, at, exists: true }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { mode: { mode: 'local' }, at, exists: true }
  }
  const value = parsed as Record<string, unknown>
  if (value.mode !== 'cloud') return { mode: { mode: 'local' }, at, exists: true }
  if (typeof value.origin !== 'string' || value.origin === '') return { mode: { mode: 'local' }, at, exists: true }
  if (typeof value.targetId === 'string' && value.targetId !== '') {
    const target = await createOutboundTargetStore(dshHome()).get(value.targetId)
    if (target === undefined || target.origin !== value.origin) return { mode: { mode: 'local' }, at, exists: true }
    let resolvedAt = at
    if (typeof value.token === 'string') {
      resolvedAt = await writeCarrierFile({
        mode: 'cloud',
        origin: target.origin,
        targetId: target.id,
        ...(target.deviceLabel === undefined ? {} : { deviceLabel: target.deviceLabel }),
      })
    }
    return {
      mode: {
        mode: 'cloud', origin: target.origin, token: target.token, targetId: target.id,
        ...(target.deviceLabel === undefined ? {} : { deviceLabel: target.deviceLabel }),
      },
      at: resolvedAt,
      exists: true,
    }
  }
  // Read legacy files written by earlier releases and migrate them on the next host save.
  if (typeof value.token !== 'string' || value.token === '') return { mode: { mode: 'local' }, at, exists: true }
  return {
    mode: {
      mode: 'cloud', origin: value.origin, token: value.token,
      ...(typeof value.deviceLabel === 'string' && value.deviceLabel !== '' ? { deviceLabel: value.deviceLabel } : {}),
    },
    at,
    exists: true,
  }
}

/**
 * 写入出站连接状态快照（0600，原子替换）。
 * @param mode - 待写入状态；`{ mode: 'local' }` 会清空 cloud 字段。
 * @returns 写入后的 mtime。
 */
export async function writeCarrierFile(mode: Record<string, unknown>): Promise<number> {
  const file = carrierPath()
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const payload = mode.mode === 'cloud'
    ? {
      mode: 'cloud',
      origin: String(mode.origin ?? ''),
      ...(typeof mode.targetId === 'string' && mode.targetId !== '' ? { targetId: mode.targetId } : {}),
      ...(typeof mode.targetId !== 'string' && typeof mode.token === 'string' ? { token: mode.token } : {}),
      ...(typeof mode.deviceLabel === 'string' && mode.deviceLabel !== ''
        ? { deviceLabel: mode.deviceLabel }
        : {}),
    }
    : { mode: 'local' }
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, file)
  return (await stat(file)).mtimeMs
}

/** 本机管理面依赖（与守卫解耦，便于测试注入）。 */
export interface AdminDeps {
  tokens?: Pick<TokenService, 'revoke'>
  metrics: import('../metrics.js').MetricsCollector
  configStore: {
    get(): Promise<Record<string, unknown>>
    patch(input: Record<string, unknown>): Promise<Record<string, unknown>>
  }
  /** 设备表（`admin.devices` 只读清单）。 */
  devices: DeviceStore
  /** 配对签发服务（`admin.issue`；与守卫直连签发同一出口）。 */
  pairing: PairingService
  /** 枚举本机局域网 IPv4（可注入，便于测试）。 */
  lanAddresses?: () => readonly string[]
  guard: {
    origin: string
    loopbackOrigin: string
    port: number
    protocolVersion: number
    singleController: boolean
    network: 'loopback' | 'lan'
  }
}

/**
 * 枚举本机可用的局域网 IPv4 地址。
 *
 * 只取 IPv4 非内部地址（排除 `127.0.0.1`、`169.254.*` 链路本地），并按
 * 「私有网段优先」排序：`192.168.*` > `10.*` > `172.16-31.*` > 其它。
 * 其他设备只能通过这些地址访问本机守卫。
 * @returns 地址列表（可能为空）。
 */
export function lanAddresses(): string[] {
  const result: { address: string; rank: number }[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4') continue
      if (entry.internal) continue
      const address = entry.address
      if (address.startsWith('169.254.')) continue
      const rank = address.startsWith('192.168.') ? 0
        : address.startsWith('10.') ? 1
          : /^172\.(1[6-9]|2\d|3[01])\./u.test(address) ? 2
            : 3
      result.push({ address, rank })
    }
  }
  return result.sort((a, b) => a.rank - b.rank).map(entry => entry.address)
}

/** 服务抛出的结构化错误（Gateway 会把它转成 `server-response` 的 ok:false）。 */
class HubFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'HubFailure'
  }
}

function deny(code: string, message: string): never {
  throw new HubFailure(code, message)
}

/**
 * 从当前调用里读出 `remote-device` principal。
 *
 * `principalOf(this.ctx.invocation)` 是官方导出的取法；用宽松形状调用以保持
 * 与 0.2.x 的类型兼容。
 */
function caller(ctx: Context): { deviceId: string; role: RoleName } {
  const invocation = (ctx as unknown as { invocation?: unknown }).invocation
  const principal = (principalOf as unknown as (value: unknown) => unknown)(invocation)
  const device = remoteDeviceOf(principal)
  if (device === undefined) {
    deny(ERROR_CODES.forbidden, 'hub/* requires a remote-device Peer')
  }
  return { deviceId: (device as { deviceId: string }).deviceId, role: (device as { role: RoleName }).role }
}

/**
 * 判定「本机 owner 页面」调用（管理面专用）。
 *
 * 本机 GUI 页面通过 Electron 的 `forwardWebRequest` 同源转发，Peer 是 **owner**
 * （`principal.kind === 'owner'`，或 principal 为 undefined 表示直接 owner 上下文）。
 * 远端配对设备是 `remote-device`，必须被拒——管理面绝不对外部设备开放。
 * @param ctx - 服务 ctx。
 * @returns 通过时返回 undefined；不通过时抛 denied。
 */
function assertOwnerCaller(ctx: Context, endpoint: string): void {
  const invocation = (ctx as unknown as { invocation?: unknown }).invocation
  const principal = (principalOf as unknown as (value: unknown) => unknown)(invocation) as
    { kind?: unknown } | undefined
  // owner：principal 为空（同进程直调）或 kind === 'owner'。remote-device 一律拒。
  if (principal === undefined || principal === null) return
  if (principal.kind === 'owner') return
  deny('remote-access/denied', `${endpoint} is available to the local owner page only`)
}

/**
 * 三条长轮询方法（D-3/D-4）。
 *
 * **不是** Typert stream 方法：它们是一元方法，返回普通值，因此不需要
 * `/api/remote.mux`（那条 socket 的 Peer 恒为 owner，非 owner 拿不到）。
 */
export class HubStreamsService extends TypertRemoteService {
  constructor(ctx: Context, private readonly engine: StreamEngine) {
    super(ctx, HUB_SERVICE_KEYS.streams, { namespace: HUB_NAMESPACE })
  }

  /**
   * 打开一条流。
   * @param endpoint - 官方 stream endpoint，必须在该角色的 `openableStreams()` 里。
   * @param args - 该官方方法的命名参数。
   * @returns `{ streamId, cursor }`。
   */
  @Remote('stream.open')
  async open(endpoint: string, args: Record<string, unknown>): Promise<{ streamId: string; cursor: number }> {
    const { deviceId, role } = caller(this.ctx)
    const result = await this.engine.open({
      deviceId,
      role,
      endpoint,
      args: args ?? {},
      peer: (this.ctx as unknown as { invocation?: { peer?: unknown } }).invocation?.peer,
    })
    if (result === null) {
      // 统一错误：**不区分**「不存在」「角色不足」「不是 stream 方法」「超并发」。
      deny(ERROR_CODES.streamOpenDenied, 'stream target is not available')
    }
    return result as { streamId: string; cursor: number }
  }

  /**
   * 拉取下一批。
   * @param streamId - `open()` 返回的 id（绑定 deviceId，跨设备猜测无效）。
   * @param cursor - 上一次返回的 `nextCursor`；回退或超越 → `cursor-invalid`。
   * @param holdMs - 期望持有时间（被配置上限钳制）。
   * @returns 批次、下一游标、可选的终态。
   */
  @Remote('stream.next')
  async next(
    streamId: string,
    cursor: number,
    holdMs?: number,
  ): Promise<{
    items: unknown[]
    nextCursor: number
    done?: boolean
    terminal?: { code: string }
    truncated?: boolean
  }> {
    const { deviceId } = caller(this.ctx)
    const result = await this.engine.next({ deviceId, streamId, cursor, ...(holdMs === undefined ? {} : { holdMs }) })
    if (result === null) {
      deny(ERROR_CODES.streamNotFound, 'stream not found')
    }
    return result as { items: unknown[]; nextCursor: number }
  }

  /**
   * 取消一条流。
   * @param streamId - 流 id。
   * @returns `{ ok }`。
   */
  @Remote('stream.cancel')
  async cancel(streamId: string): Promise<{ ok: boolean }> {
    const { deviceId } = caller(this.ctx)
    return this.engine.cancel(deviceId, streamId)
  }
}

/** 设备管理与审批应答。 */
export class HubDevicesService extends TypertRemoteService {  constructor(ctx: Context, private readonly deps: HubServicesDeps) {
    super(ctx, HUB_SERVICE_KEYS.devices, { namespace: HUB_NAMESPACE })
  }

  /**
   * 列出设备（只给 `control` / `full`；`read-only` 由 `decide()` 拒掉）。
   * 返回的字段里**只有** `tokenHash`，没有明文令牌。
   * @returns 设备清单。
   */
  @Remote('devices')
  devices(): { items: readonly unknown[] } {
    const { role } = caller(this.ctx)
    if (!allActionsFor(role).includes('hub/devices')) {
      deny('remote-access/denied', 'hub/devices is not granted to this role')
    }
    return {
      items: this.deps.devices.list().map(device => ({
        deviceId: device.deviceId,
        label: device.label,
        role: device.role,
        createdAt: device.createdAt,
        lastSeenAt: device.lastSeenAt,
        revokedAt: device.revokedAt,
        // tokenHash 故意不返回：设备清单不是凭据分发面。
      })),
    }
  }

  /**
   * 吊销一台设备（只给 `full`）。吊销后 ≤ `streamHoldMs` 内该设备的下一次
   * `hub/stream.next` 得到终态 `device-revoked`。
   * @param deviceId - 目标设备。
   * @returns `{ ok }`。
   */
  @Remote('revoke')
  async revoke(deviceId: string): Promise<{ ok: boolean }> {
    const { role } = caller(this.ctx)
    if (!allActionsFor(role).includes('hub/revoke')) {
      deny('remote-access/denied', 'hub/revoke is not granted to this role')
    }
    await this.deps.tokens.revoke(deviceId)
    this.deps.streams.markRevoked(deviceId)
    this.deps.onRevoked(deviceId)
    this.deps.policy.invalidate(deviceId)
    return { ok: true }
  }

  /**
   * 回答一次审批。**只接受三值**（`unavailable` 会被拒）。
   * @param requestId - 审批帧里的 id。
   * @param outcome - `allowed-once` | `rejected` | `cancelled`。
   * @returns `{ ok }` 或 `{ ok: false, error }`。
   */
  @Remote('answerApproval')
  answerApproval(requestId: string, outcome: string): { ok: boolean; error?: string } {
    const { deviceId, role } = caller(this.ctx)
    if (!allActionsFor(role).includes('hub/answerApproval')) {
      deny('remote-access/denied', 'hub/answerApproval is not granted to this role')
    }
    return this.deps.approvals.answer({ deviceId, role, requestId, outcome })
  }
}

/**
 * 本机管理面（owner 页面专用，经同源 `/api` 通道到达）。
 *
 * 为什么存在：桌面端页面 origin 是 `dsh-app://app`（不透明来源），浏览器禁止它
 * 直接 fetch `http://127.0.0.1:8443` —— 预检发不出去、真实请求被拦在 fetch 层
 * （2026-11-11 实机：诊断卡显示「最近管理请求：尚未发起」）。
 * Electron 的 `forwardWebRequest` 会把 `dsh-app://app/*` 同源转发到本机 Host，
 * 所以把管理面做成 `hub/admin.*` Remote 方法后，页面走 `POST /api/hub/admin.*`
 * 即可，全程同源、零 CORS、零预检。
 *
 * 安全：只接受 **owner** 调用（本机 GUI），远端配对设备（`remote-device`）一律
 * 拒绝；凭据（pin/token）不经过这里，也不需要经过这里。
 */
export class HubAdminService extends TypertRemoteService {
  constructor(ctx: Context, private readonly deps: AdminDeps) {
    super(ctx, HUB_SERVICE_KEYS.admin, { namespace: HUB_NAMESPACE })
  }

  /** 守卫健康与实例信息（页面诊断卡 + ①区状态）。 */
  @Remote('admin.health')
  health(): {
    ok: true
    protocolVersion: number
    guard: { origin: string; loopbackOrigin: string; port: number }
    singleController: boolean
  } {
    assertOwnerCaller(this.ctx, 'hub/admin.health')
    return {
      ok: true,
      protocolVersion: this.deps.guard.protocolVersion,
      guard: {
        origin: this.deps.guard.origin,
        loopbackOrigin: this.deps.guard.loopbackOrigin,
        port: this.deps.guard.port,
      },
      singleController: this.deps.guard.singleController,
    }
  }

  /**
   * 已配对设备清单（② 区数据源）。
   *
   * 与 `hub/devices` 的区别：这是**本机 owner 页面**视角，返回完整守卫快照形状
   * （含 `guard` / `protocolVersion` / `singleController`），并且不经过角色矩阵
   * —— owner 本来就拥有全部权限。明文令牌永远不会出现在这里。
   */
  @Remote('admin.devices')
  devices(): {
    ok: true
    protocolVersion: number
    guard: { host: string; port: number; origin: string }
    singleController: boolean
    devices: readonly Record<string, unknown>[]
  } {
    assertOwnerCaller(this.ctx, 'hub/admin.devices')
    return {
      ok: true,
      protocolVersion: this.deps.guard.protocolVersion,
      guard: {
        host: '127.0.0.1',
        port: this.deps.guard.port,
        origin: this.deps.guard.origin,
      },
      singleController: this.deps.guard.singleController,
      devices: this.deps.devices.list().map(device => ({
        deviceId: device.deviceId,
        label: device.label,
        role: device.role,
        createdAt: device.createdAt,
        lastSeenAt: device.lastSeenAt,
        revokedAt: device.revokedAt,
        // 被单控挤下线（仍保留配对）——UI 据此区分「已配对」与「已连接」。
        displacedAt: device.displacedAt ?? null,
        // tokenHash 故意不返回：设备清单不是凭据分发面。
      })),
    }
  }

  @Remote('admin.deviceForget')
  async deviceForget(deviceId: string): Promise<{ ok: true; removed: boolean }> {
    assertOwnerCaller(this.ctx, 'hub/admin.deviceForget')
    if (!deviceId || typeof deviceId !== 'string') throw new Error('deviceId is required')
    if (!this.deps.tokens) throw new Error('Device revocation is unavailable')
    await this.deps.tokens.revoke(deviceId)
    if (!this.deps.devices.removeRevoked) throw new Error('Device deletion is unavailable')
    return { ok: true, removed: await this.deps.devices.removeRevoked(deviceId) }
  }

  /** 运行指标（③ 区数据源）。 */
  @Remote('admin.stats')
  stats(): { ok: true } & Record<string, unknown> {
    assertOwnerCaller(this.ctx, 'hub/admin.stats')
    return { ok: true, ...this.deps.metrics.snapshot() }
  }

  /** 配置快照（④ 区数据源）。 */
  @Remote('admin.config')
  async config(): Promise<{ ok: true; config: Record<string, unknown> }> {
    assertOwnerCaller(this.ctx, 'hub/admin.config')
    return { ok: true, config: await this.deps.configStore.get() }
  }

  /**
   * 配置白名单写入。
   * @param patch - 要改的字段（越界字段由 configStore 拒绝）。
   * @returns 写入后的完整快照。
   */
  @Remote('admin.configPatch')
  async configPatch(patch: Record<string, unknown>): Promise<{ ok: true; config: Record<string, unknown> }> {
    assertOwnerCaller(this.ctx, 'hub/admin.configPatch')
    return { ok: true, config: await this.deps.configStore.patch(patch) }
  }

  /**
   * 本机连接信息（供其他设备填写的地址 + 对外可用 origin）。
   *
   * 为什么必须有：守卫在 loopback 模式下 `origin` 是 `127.0.0.1:8443`，
   * **对其他设备无意义**。配对二维码 / 链接必须带局域网地址，否则扫码方
   * 拿到的 URL 指向它自己的回环。这里返回本机局域网 IPv4 + 端口。
   *
   * @returns 地址列表（含推荐地址）、端口、网络模式与当前 origin。
   */
  @Remote('admin.endpoints')
  endpoints(): {
    ok: true
    port: number
    network: 'loopback' | 'lan'
    /** 当前守卫公告的 origin（LAN 模式是 LAN IP）。 */
    origin: string
    /** 可用于其他设备填写的地址（`http://<lan-ip>:<port>`）。 */
    candidates: readonly string[]
    /** 推荐地址（第一个可用候选；无候选时为 origin）。 */
    preferred: string
  } {
    assertOwnerCaller(this.ctx, 'hub/admin.endpoints')
    const port = this.deps.guard.port
    const candidates = lanAddresses().map(address => `http://${address}:${port}`)
    return {
      ok: true,
      port,
      network: this.deps.guard.network,
      origin: this.deps.guard.origin,
      candidates,
      preferred: candidates[0] ?? this.deps.guard.origin,
    }
  }

  /**
   * 出站连接状态（`carrier-mode.json`）。
   *
   * 页面「主控端」卡片的真源。CLI 配对（`scripts/pair-outbound.mjs`）写入这个
   * 文件后，页面靠轮询这里拿到变更并导入 localStorage —— 磁盘是唯一真源。
   *
   * @returns 当前快照（无文件时 `mode: 'local'`）。
   */
  @Remote('admin.carrier')
  async carrier(): Promise<{ ok: true; mode: Record<string, unknown>; at: number; exists: boolean }> {
    assertOwnerCaller(this.ctx, 'hub/admin.carrier')
    const snapshot = await readCarrierFile()
    return { ok: true, mode: snapshot.mode, at: snapshot.at, exists: snapshot.exists }
  }

  /**
   * 把页面的出站状态写回磁盘。
   *
   * 页面在接管/断开时调用，确保下一次打开（或另一台窗口）能读到同一状态。
   * @param mode - `{ mode: 'local' }` 或 `{ mode: 'cloud', origin, token, deviceLabel }`。
   */
  @Remote('admin.carrierWrite')
  async carrierWrite(mode: Record<string, unknown>): Promise<{ ok: true; at: number }> {
    assertOwnerCaller(this.ctx, 'hub/admin.carrierWrite')
    const at = await writeCarrierFile(mode)
    return { ok: true, at }
  }

  /** List opaque pairing views from this local DSH_HOME; bearer values never leave Host. */
  @Remote('admin.outboundTargets')
  async outboundTargets(): Promise<{ ok: true; targets: readonly unknown[] }> {
    assertOwnerCaller(this.ctx, 'hub/admin.outboundTargets')
    const targets = await createOutboundTargetStore(dshHome()).list()
    return { ok: true, targets }
  }

  /** Save a redeemed bearer to the local profile-protected archive. */
  @Remote('admin.outboundSave')
  async outboundSave(target: Record<string, unknown>): Promise<{ ok: true; target: unknown }> {
    assertOwnerCaller(this.ctx, 'hub/admin.outboundSave')
    const saved = await createOutboundTargetStore(dshHome()).save(target)
    return { ok: true, target: saved }
  }

  /** Activate an archived target without returning its bearer to the renderer. */
  @Remote('admin.outboundActivate')
  async outboundActivate(targetId: string): Promise<{ ok: true; at: number; target: unknown }> {
    assertOwnerCaller(this.ctx, 'hub/admin.outboundActivate')
    const store = createOutboundTargetStore(dshHome())
    const target = await store.get(targetId)
    if (target === undefined) deny(ERROR_CODES.notFound, 'paired outbound target not found')
    const at = await writeCarrierFile({
      mode: 'cloud',
      origin: target.origin,
      targetId: target.id,
      ...(target.deviceLabel === undefined ? {} : { deviceLabel: target.deviceLabel }),
    })
    return { ok: true, at, target: outboundTargetView(target) }
  }

  /** Forget a saved pairing without revoking its token on the remote Host. */
  @Remote('admin.outboundForget')
  async outboundForget(targetId: string): Promise<{ ok: true; removed: boolean }> {
    assertOwnerCaller(this.ctx, 'hub/admin.outboundForget')
    return { ok: true, removed: await createOutboundTargetStore(dshHome()).forget(targetId) }
  }

  /**
   * 签发配对凭据（二维码票据 / 短码）。
   *
   * 为什么必须走同源通道：签发端原本只能从本机页面直连守卫
   * `http://127.0.0.1:8443`，而桌面页面 origin 是 `dsh-app://app`，跨协议 fetch
   * 会被浏览器拦在 fetch 层 —— 「点击生成二维码」永远失败且没有可见原因。
   *
   * 安全：`assertOwnerCaller` 只放行本机 owner 页面；票据/短码只返回给这一条
   * 同源响应，不落日志、不进 URL。
   * @param kind - `'ticket'`（二维码）或 `'code'`（短码）。
   * @param role - 授予远端设备的角色。
   * @returns 凭据原文、过期时间与角色。
   */
  @Remote('admin.issue')
  async issue(
    kind: string,
    role: string,
  ): Promise<{ ok: true; kind: 'ticket' | 'code'; value: string; expiresAt: number; role: string }> {
    assertOwnerCaller(this.ctx, 'hub/admin.issue')
    if (kind !== 'ticket' && kind !== 'code') deny(ERROR_CODES.badRequest, 'kind must be ticket or code')
    if (!isRoleName(role)) deny(ERROR_CODES.badRequest, 'role is not a known role')
    const issued = kind === 'ticket'
      ? this.deps.pairing.issueTicket(role)
      : this.deps.pairing.issueCode(role)
    this.deps.metrics.countPairIssued()
    return { ok: true, kind, value: issued.secret, expiresAt: issued.expiresAt, role: issued.role }
  }
}

/** 注册全部 `hub/*` 服务。返回 disposer。 */
export interface RemoteServicesHandle {
  dispose(): Promise<void>
}
/**
 * 注册 `hubStreams` 与 `hubDevices` 两个 Cordis 服务。
 *
 * 两个类共用 wire namespace `hub`，但 service key 不同 —— Gateway 的
 * `resolveSrcDescriptor` 按 namespace + method 找唯一候选，只要方法名不重复
 * 就不会 `ambiguous-endpoint`。
 * @param ctx - Host Context。
 * @param deps - 共享依赖。
 * @returns 句柄。
 */
export function registerRemoteServices(ctx: Context, deps: HubServicesDeps): RemoteServicesHandle {
  const streams = new HubStreamsService(ctx, deps.streams)
  const devices = new HubDevicesService(ctx, deps)
  const admin = deps.metrics !== undefined && deps.configStore !== undefined && deps.guard !== undefined
    ? new HubAdminService(ctx, {
      metrics: deps.metrics,
      tokens: deps.tokens,
      configStore: deps.configStore,
      devices: deps.devices,
      pairing: deps.pairing,
      guard: deps.guard(),
    })
    : undefined

  return {
    async dispose() {
      void streams
      void devices
      void admin
      // Cordis service registrations are owned by the plugin fiber and disposed on unload.
    },
  }
}

/** 守卫的路由表（供 guard.ts 与契约快照共用；这里 re-export 避免两份真相）。 */
export { GUARD_ROUTES }
