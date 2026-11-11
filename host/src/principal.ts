/**
 * `remote-device` principal —— 合并进官方 `PrincipalMap` 的自定义身份种类。
 *
 * 这是**官方明示支持**的扩展点，不是私有 hack：`packages/typert/protocol/src/types.ts`
 * 的 `PrincipalMap` 注释写着 "Each driver declares its own entry / Merge-extensible"，
 * Gateway 与 remote-access 里有四处 `oxlint-disable` 注释原文写着
 * "other packages merge non-owner kinds into PrincipalMap"。LiveShare 的
 * `share-viewer` 就是同一个形状。
 *
 * **只放身份，不放凭据（D-12）**：`PeerScope.principal` 会被写进 Session 日志的
 * `source.principal`，所以它绝不能带 `tokenHash` / `label` / 时间戳，更不能带明文
 * 令牌。三个字段一个不多：`kind` / `deviceId` / `role`。
 *
 * @module dsh-remote-hub/host/principal
 */
import type { RoleName } from '@core/index.js'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    'remote-device': RemoteDevicePrincipal
  }
}

/** 一台已配对设备的身份。序列化后进 Session 日志，所以字段刻意最少。 */
export interface RemoteDevicePrincipal {
  readonly kind: 'remote-device'
  readonly deviceId: string
  readonly role: RoleName
}

/**
 * 逐字段构造 principal —— 不 spread 整个 `DeviceRecord`，避免将来有人给设备记录
 * 加字段时把凭据顺手带进 Session 日志。
 * @param device - 只取 `deviceId` 与 `role`。
 * @returns 深层等于 `{ kind, deviceId, role }` 的对象。
 */
export function remoteDevicePrincipal(device: { deviceId: string; role: RoleName }): RemoteDevicePrincipal {
  return {
    kind: 'remote-device',
    deviceId: device.deviceId,
    role: device.role,
  }
}

/**
 * 从任意 principal 里读出 `remote-device`，不是这个种类时返回 undefined。
 * @param principal - 任意 principal 形状。
 * @returns 收窄后的身份，或 undefined。
 */
export function remoteDeviceOf(principal: unknown): RemoteDevicePrincipal | undefined {
  if (typeof principal !== 'object' || principal === null) return undefined
  const value = principal as Record<string, unknown>
  if (value.kind !== 'remote-device') return undefined
  if (typeof value.deviceId !== 'string' || typeof value.role !== 'string') return undefined
  return value as unknown as RemoteDevicePrincipal
}
