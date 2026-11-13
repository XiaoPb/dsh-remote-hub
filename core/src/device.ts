/**
 * 设备身份与令牌类型。
 *
 * SECURITY CONTRACT: `tokenHash` 是**唯一**可以落盘的令牌派生值。明文令牌在内存
 * 中存在且仅存在一次（签发那一刻），随后交给刚兑换成功的设备。
 *
 * @module @core/device
 */
import type { RoleName } from './roles.js'

/** 落盘的设备记录。不含任何可用凭据（只有哈希）。 */
export interface DeviceRecord {
  deviceId: string
  /** 本机设备清单里显示的名字。 */
  label: string
  role: RoleName
  /** hex(sha256(token))；校验时按常量时间与它比较。 */
  tokenHash: string
  createdAt: string
  lastSeenAt: string | null
  /**
   * `revoke()` 设置；已吊销记录在**路由之前**被拒。
   *
   * **语义边界（2026-11-12 修订）**：只有「用户明确删除配对」才设它。
   * 单控模式下被新设备挤下线**不**吊销 —— 那只是断开连接，
   * 令牌仍然有效，device 仍是「已配对」状态。
   */
  revokedAt: string | null
  /**
   * 被单控策略挤下线的时间（**仍保留配对**）。
   *
   * 与 `revokedAt` 的区别：
   * - `displacedAt`：连接被踢，令牌有效，可以重新连上（状态「已配对」）
   * - `revokedAt`：配对被删，令牌失效（状态「配对失效」）
   *
   * 缺省（旧记录）视为 `null`。
   */
  displacedAt?: string | null
}

/** 落盘的设备表。文件的机密性只是纵深防御的一层。 */
export interface DeviceTable {
  version: typeof import('./protocol.js').DEVICE_TABLE_VERSION
  devices: DeviceRecord[]
}

/** 客户端在配对成功时收到一次的东西。**绝不写日志**。 */
export interface IssuedDeviceToken {
  deviceId: string
  token: string
  role: RoleName
  /** 单控模式下被本次配对踢下线的设备（只断连接，配对仍保留）。 */
  displacedDevices?: { deviceId: string; label: string }[]
}

/**
 * 守卫侧的身份视图。
 *
 * ⚠️ 这是 **core 内部**的视图，不是 `PeerScope.principal`。真正进 Peer 的
 * principal 是 `host/src/principal.ts` 合并进 `PrincipalMap` 的
 * `{ kind: 'remote-device', deviceId, role }` —— 只放身份，不放凭据（D-12）。
 */
export interface GuardPrincipal {
  deviceId: string
  role: RoleName
}

/** 配对路径（审计用；两条路径共享签发端门控与角色绑定）。 */
export type PairingPath = 'qr' | 'code'

/** 一次成功兑换的审计行（结构化日志）。 */
export interface PairingAuditRow {
  deviceId: string
  label: string
  role: RoleName
  path: PairingPath
  at: string
  /** `Host` 头（只作日志，**不作为身份**）。 */
  sourceAuthority: string | null
}

/** 吊销/角色变更时守卫要做的三件事（顺序固定）。 */
export interface DeviceLifecycleHooks {
  /** 设备表落盘后的回调：丢 Peer、断流、让快照重算。 */
  onRevoked(deviceId: string): void
  onRoleChanged(deviceId: string, role: RoleName): void
}
