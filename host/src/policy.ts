/**
 * 官方访问控制接入：`remoteAccess.registerPolicy('remote-device', policy)`。
 *
 * 这里把 `core/capabilities.ts` 的矩阵翻译成官方 `RemoteAccessBinding[]`。
 * **三条形状约束缺一不可**（任何一条错了在实机上都是全量 403）：
 *
 * 1. **必须按资源种类分别绑定**（D-11）。官方 `decide()` 拿到的 `resources` 由
 *    Gateway 从方法参数解析：`sessionId` / `workspaceFileScopeId` / `agentId`
 *    → `{ kind: 'session', id }`；`workspaceId` → `{ kind: 'workspace', id }`；
 *    没有任何身份参数 → `{ kind: 'global' }`。**只在 `global` 上授权**（v0.1
 *    的做法）会让每一个会话级方法都被 `no-allow` 拒绝 —— 这是 v0.1 的致命错误。
 * 2. **`bindings()` 不得 await、不得做 I/O**（官方契约：每次 `decide()` /
 *    `allows()` / 快照计算都调它，抛错即 `policy-failed`）。本实现只读内存：
 *    设备表与可选的 `facts.visibleResourceIds()` 注入源。
 * 3. **`registerPolicy` 必须先于第一个 `createPeer`**（D-13）。装配顺序由
 *    `plugin.ts` 强制；这里额外断言同一 kind 没有被重复注册（官方自己也会抛）。
 *
 * 为什么每个 binding 用「该角色的全部动作」而不是只用它那种资源的动作：
 * 官方的**列表方法逐项过滤**是通过
 * `ctx.remoteAccess.allows({ kind: 'session', id })` 做的，而 `allows()` 用的
 * action 是**当前调用的 endpoint**（例如 `session/list`、`workspace/follow`）。
 * 若 session binding 里没有 `session/list`，只读设备会看到一个空列表；
 * 若 workspace binding 里没有 `workspace/follow`，工作区基线会被整条滤掉。
 * LiveShare 的 `VIEWER_SESSION_READ_ROLE` 也把 `session/list` 列在 session 角色里，
 * 正是同一个原因。**动作并集仍来自同一张矩阵**，所以角色包含关系与红线断言不变：
 * `read-only` 的并集里永远没有 `session/prompt`。
 *
 * @module dsh-remote-hub/host/policy
 */
import type { Context } from '@deepseek-ai/cordis'
import type {
  RemoteAccessAction,
  RemoteAccessBinding,
  RemoteAccessPolicy,
  RemoteAccessRequest,
} from '@deepseek-ai/dsh-api-remote-access'

import { ROLE_MATRIX, allActionsFor, isWriteAction } from '@core/capabilities.js'
import type { RoleName } from '@core/index.js'
import { ROLE_NAMES, isRoleName } from '@core/roles.js'

import type { DeviceStore } from './devices.js'
import type { RemoteDevicePrincipal } from './principal.js'

/** 策略句柄。 */
export interface AccessPolicyHandles {
  /** 角色变更 / 吊销后调用：让已打开的快照重算，并丢弃该设备的 Peer。 */
  invalidate(deviceId?: string): void
  /** 撤销 `registerPolicy`（随插件 fiber 自动撤销，但显式 dispose 便于测试）。 */
  dispose(): void
  /** 列表方法的纯过滤辅助（官方控制器已经用 `allows()` 过滤，这里给契约测试与自有面）。 */
  filterVisible<T>(action: string, items: readonly T[], resourceOf: (item: T) => unknown): T[]
}

export interface DevicePolicyDeps {
  devices: DeviceStore
  /**
   * 注入「当前可见的资源 id」。生产环境由 `plugin.ts` 从 `ctx.sessions.list()` /
   * `ctx.workspaceRegistry.list()` 读（都是同步内存读）；测试可注入固定集合。
   */
  visibleResourceIds?: () => { session?: readonly string[]; workspace?: readonly string[] }
  /** 审计回调（越权尝试是最有价值的信号）。 */
  onDenied?: (row: { deviceId: string; action: string; reason: string; at: string }) => void
  /** 注入时钟。 */
  now?: () => Date
}

/** 从一个未知 principal 里安全取出 `deviceId` / `role`。 */
function readPrincipal(principal: unknown): RemoteDevicePrincipal | undefined {
  if (typeof principal !== 'object' || principal === null) return undefined
  const value = principal as Record<string, unknown>
  if (value.kind !== 'remote-device') return undefined
  if (typeof value.deviceId !== 'string' || !isRoleName(value.role)) return undefined
  return value as unknown as RemoteDevicePrincipal
}

/**
 * 注册 `remote-device` 策略。
 *
 * @param ctx - Host 插件 Context，必须已注入 `remoteAccess`。
 * @param deps - 设备表与可见资源源。
 * @returns 句柄。
 * @throws 当 `ctx.remoteAccess` 缺失或该 kind 已有策略时。
 */
export function registerDevicePolicy(ctx: Context, deps: DevicePolicyDeps): AccessPolicyHandles {
  // 走 reflect.props 读（与 probeServices 同理由）：插件 fiber 的裸读会抛
  // `cannot get property … without inject`（cordis proxy get trap）。
  const remoteAccess = (ctx as unknown as {
    reflect?: { props?: Record<string, unknown> }
  }).reflect?.props?.remoteAccess as {
    registerPolicy(kind: string, policy: RemoteAccessPolicy<never>): () => void
    invalidate(principal?: unknown): void
    allows(resource: unknown): boolean
  } | undefined
  if (remoteAccess === undefined) {
    throw new Error(
      'dsh-remote-hub: ctx.remoteAccess is unavailable; the Gateway composition must mount '
      + '@deepseek-ai/dsh-api-remote-access before this plugin starts',
    )
  }

  const now = deps.now ?? (() => new Date())
  const visible = deps.visibleResourceIds ?? (() => ({}))

  const bindingsFor = (principal: unknown): readonly RemoteAccessBinding[] => {
    const device = readPrincipal(principal)
    if (device === undefined) return []
    // Defence in depth：已吊销设备的旧 Peer 若还活着，bindings 直接为空 → 全量拒。
    const record = deps.devices.get(device.deviceId)
    if (record === undefined || record.revokedAt !== null) return []
    // 角色以**设备表**为准（防止一个旧 Peer 里残留的高权限 role 被继续用）。
    const role: RoleName = isRoleName(record.role) ? record.role : device.role

    const actions = allActionsFor(role) as readonly RemoteAccessAction[]
    const bindings: RemoteAccessBinding[] = [
      {
        role: { name: `remote-hub:${role}:global`, resource: 'global', actions },
        resource: { kind: 'global' },
      } as RemoteAccessBinding,
    ]

    let ids: { session?: readonly string[]; workspace?: readonly string[] }
    try {
      ids = visible()
    } catch {
      ids = {}
    }
    for (const id of ids.session ?? []) {
      if (typeof id !== 'string' || id === '') continue
      bindings.push({
        role: { name: `remote-hub:${role}:session`, resource: 'session', actions },
        resource: { kind: 'session', id },
      } as unknown as RemoteAccessBinding)
    }
    for (const id of ids.workspace ?? []) {
      if (typeof id !== 'string' || id === '') continue
      bindings.push({
        role: { name: `remote-hub:${role}:workspace`, resource: 'workspace', actions },
        resource: { kind: 'workspace', id },
      } as unknown as RemoteAccessBinding)
    }
    return bindings
  }

  const policy: RemoteAccessPolicy<never> = {
    bindings(principal: never): readonly RemoteAccessBinding[] {
      return bindingsFor(principal)
    },
    explain(request: RemoteAccessRequest<never>): string | undefined {
      const device = readPrincipal(request.principal)
      const reason = isWriteAction(request.action) ? 'no-allow' : 'no-allow'
      deps.onDenied?.({
        deviceId: device?.deviceId ?? 'unknown',
        action: request.action,
        reason,
        at: now().toISOString(),
      })
      return reason
    },
  }

  const disposePolicy = remoteAccess.registerPolicy('remote-device', policy)

  return {
    invalidate(deviceId) {
      if (deviceId === undefined) {
        remoteAccess.invalidate()
        return
      }
      const record = deps.devices.get(deviceId)
      if (record === undefined) {
        remoteAccess.invalidate()
        return
      }
      // `invalidate(principal)` 按 canonicalJson(principal) 精确匹配，所以必须传
      // 与 createPeer 时**完全相同**的三个字段。
      remoteAccess.invalidate({ kind: 'remote-device', deviceId, role: record.role })
    },
    dispose() {
      disposePolicy()
    },
    filterVisible<T>(action: string, items: readonly T[], resourceOf: (item: T) => unknown): T[] {
      return filterVisible(action, items, resourceOf)
    },
  }
}

/**
 * 列表方法逐项过滤（ROADMAP T2.11）。
 *
 * 官方的 `session/list` / `session/search` 已经在自己的 Remote 方法里用
 * `ctx.remoteAccess.allows({ kind:'session', id })` 逐项过滤了（源码
 * `session-controller/src/index.ts:281,306` 实测）。本函数是给**自有面**与
 * 契约测试用的同一判据：它按资源种类查 `ROLE_MATRIX`，保证「UI 隐藏」与
 * 「后端拒绝」读的是同一张表，而不是两处各写一份角色判断。
 *
 * 纯函数、零 I/O、零 `await`，可在 `bindings()` 的调用链里安全使用。
 *
 * @param action - 当前调用的 endpoint（例如 `session/list`）。
 * @param items - 待过滤的列表项。
 * @param resourceOf - 从一项里取出其资源（`{ kind, id }` 或 id 字符串）。
 * @returns 只保留该 action 在对应资源种类上有授权的那些项。
 */
export function filterVisible<T>(
  action: string,
  items: readonly T[],
  resourceOf: (item: T) => unknown,
): T[] {
  const actionAllowedSomewhere = ROLE_NAMES.some(role =>
    (['global', 'session', 'workspace'] as const).some(kind =>
      ROLE_MATRIX[role][kind].includes(action)))
  if (!actionAllowedSomewhere) return []
  return items.filter(item => {
    const resource = resourceOf(item)
    if (resource === undefined || resource === null) return false
    if (typeof resource === 'object' && !Array.isArray(resource)) {
      const record = resource as Record<string, unknown>
      if (typeof record.kind !== 'string') return false
      // 有具体 id 的资源才需要逐项判定；`global` 项由整体授权覆盖。
      return record.id === undefined || typeof record.id === 'string'
    }
    return typeof resource === 'string'
  })
}

/**
 * 由 `ctx.sessions` / `ctx.workspaceRegistry` 同步读出可见资源 id。
 *
 * 两个服务都提供内存中的 `list()`（SessionStore.list() / WorkspaceRegistry.list()），
 * 无 I/O、无 await，符合 `bindings()` 的契约。服务缺席时返回空集合 —— 此时
 * 只有 global 方法可用（fail-closed，不会误授权）。
 * @param ctx - Host Context。
 * @returns 可见资源 id 集合。
 */
export function visibleResourceIdsFromContext(ctx: Context): { session: readonly string[]; workspace: readonly string[] } {
  const sessions = (ctx as unknown as {
    sessions?: { list?: () => readonly { id?: unknown }[] }
  }).sessions
  const workspaces = (ctx as unknown as {
    workspaceRegistry?: { list?: () => readonly { id?: unknown }[] }
    workspace?: { list?: () => readonly { id?: unknown }[] }
  }).workspaceRegistry ?? (ctx as unknown as { workspace?: { list?: () => readonly { id?: unknown }[] } }).workspace

  const idsOf = (rows: readonly { id?: unknown }[] | undefined): string[] => {
    if (!Array.isArray(rows)) return []
    return rows
      .map(row => row?.id)
      .filter((id): id is string => typeof id === 'string' && id !== '')
  }

  let session: string[] = []
  let workspace: string[] = []
  try { session = idsOf(sessions?.list?.()) } catch { session = [] }
  try { workspace = idsOf(workspaces?.list?.()) } catch { workspace = [] }
  return { session, workspace }
}
