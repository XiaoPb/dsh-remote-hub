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
import { appendFileSync } from 'node:fs'
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
  // **必须走 reflect 读实例**：reflect.props[name] 只是声明元数据（{type:'service'}），
  // 不是服务对象——用它调 registerPolicy 会得到 `not a function`（2026-11-11 实机
  // 卡死根因）。reflect.get(name, false) 宽松读实例：提供方 fiber 尚未激活时返回
  // undefined 而不抛错；而这里的调用点在 ctx.inject 回调里（服务已就绪），正常
  // 情况必然拿到实例。
  const remoteAccess = (ctx as unknown as {
    reflect?: { get?: (name: string, strict?: boolean) => unknown }
  }).reflect?.get?.('remoteAccess', false) as {
    registerPolicy(kind: string, policy: RemoteAccessPolicy<never>): () => void
    invalidate(principal?: unknown): void
    allows(resource: unknown): boolean
  } | undefined
  if (remoteAccess === undefined || typeof remoteAccess.registerPolicy !== 'function') {
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

    const ids: { session?: readonly string[]; workspace?: readonly string[] } = (() => {
      try { return visible() } catch { return {} }
    })()
    const actions = allActionsFor(role) as readonly RemoteAccessAction[]
    const bindings: RemoteAccessBinding[] = [
      {
        role: { name: `remote-hub:${role}:global`, resource: 'global', actions },
        resource: { kind: 'global' },
      } as RemoteAccessBinding,
    ]
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

  // 每个 Host composition 只能注册一份 remote-device 策略。重复装配可能绑定到
  // 不同 DeviceStore/可见资源源，不能复用未知依赖；直接失败，让宿主修正重复 roster。
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
 * 由 `ctx.sessions` / `ctx.workspaceRegistry` 同步读出**当前 live** 的可见资源 id。
 *
 * ⚠️ **不要单独拿它当可见集合**：官方 `session/list` 的过滤依据是**持久化全集**
 * （`ApiSessionList` → 磁盘上所有会话），而 `ctx.sessions.list()` 只含**已 live**
 * 的会话。二者不一致时，磁盘上有会话、接管端却看到空列表——实测复现过。
 * 生产路径请用 {@link createVisibleResourceTracker}，它把两者合并并缓存。
 *
 * @param ctx - Host Context。
 * @returns live 资源 id 集合。
 */
export function visibleResourceIdsFromContext(ctx: Context): { session: readonly string[]; workspace: readonly string[] } {
  // ⚠️ 用官方同款 `ctx.get(name)` 取服务：直接属性访问在 cordis 的某些组合下
  // 会抛错（实测：`ctx.sessions` 触发异常被外层 try 吞掉 → 永久的空集合
  // → 官方 session/list 被过滤成空列表）。读不到就当作该服务缺席。
  const getService = (name: string): unknown => {
    try {
      const get = (ctx as unknown as { get?: (key: string) => unknown }).get
      if (typeof get === 'function') return get.call(ctx, name)
    } catch { /* 缺席 */ }
    try {
      return (ctx as unknown as Record<string, unknown>)[name]
    } catch { /* 缺席 */ }
    return undefined
  }

  const sessions = getService('sessions') as { list?: () => readonly { id?: unknown }[] } | undefined
  const workspaces = (getService('workspaceRegistry') ?? getService('workspace')) as
    | { list?: () => readonly { id?: unknown }[] }
    | undefined

  const idsOf = (rows: readonly { id?: unknown }[] | undefined): string[] => {
    if (!Array.isArray(rows)) return []
    return rows
      .map(row => row?.id)
      .filter((id): id is string => typeof id === 'string' && id !== '')
  }

  let session: string[] = []
  let workspace: string[] = []
  try { session = idsOf(sessions?.list?.()) } catch (error) { deps_ignore('session', error); session = [] }
  try { workspace = idsOf(workspaces?.list?.()) } catch (error) { deps_ignore('workspace', error); workspace = [] }
  return { session, workspace }
}

/**
 * 读取失败时的诊断点（默认静默，`DSH_REMOTE_HUB_DEBUG` 打开时写文件）。
 * @param what - 读取目标。
 * @param error - 异常。
 */
function deps_ignore(what: string, error: unknown): void {
  if (process.env.DSH_REMOTE_HUB_DEBUG === undefined) return
  try {
    appendFileSync('/tmp/remote-hub-visible.log',
      `${new Date().toISOString()} read-failed:${what}:${String(error)}\n`)
  } catch { /* 忽略 */ }
}

/**
 * 可见资源的**生产真源**：持久化全集 ∪ live 集合，带同步缓存。
 *
 * ## 为什么需要它
 *
 * `RemoteAccessPolicy.bindings()` 是**同步**接口，而持久化会话只能异步列出
 * （`ctx.sessionQuery.listSessions()`）。所以这里维护一份缓存：
 *
 * - `refresh()` 异步拉取持久化全集 + 读 live 集合，合并后替换缓存；
 * - `resourceIds()` 同步返回最近一次成功刷新的结果（`bindings()` 用它）；
 * - 事件驱动刷新：会话新增/归档/写入、以及显式 `invalidate()`。
 *
 * ## 失败语义
 *
 * 刷新失败**保留上一份缓存**（不把设备踢成"什么都看不见"），但首次尚未成功时
 * 返回 live 集合（fail-closed 的可用子集）。
 */
export interface VisibleResourceTracker {
  /** 同步读缓存（`bindings()` 用）。 */
  resourceIds(): { session: readonly string[]; workspace: readonly string[] }
  /** 异步刷新缓存；并发调用合并为一次在途刷新。 */
  refresh(): Promise<void>
  /** 丢弃缓存并在下一轮刷新时重建。 */
  invalidate(): void
  /** 停止事件订阅与定时刷新。 */
  dispose(): void
}

/** `createVisibleResourceTracker` 依赖。 */
export interface VisibleResourceTrackerDeps {
  /** Host Context（从中读 `sessions` / `sessionQuery` / `workspaceRegistry`）。 */
  ctx: Context
  /** 刷新失败时的记录器（不得包含凭据）。 */
  onError?: (message: string, error: unknown) => void
  /** 兜底定时刷新间隔（毫秒）；0 表示不定时。默认 1s，避免新建 workspace 后首次 session/create 命中旧缓存。 */
  refreshIntervalMs?: number
}

/**
 * 构造可见资源跟踪器。
 * @param deps - 依赖。
 * @returns 跟踪器。
 */
export function createVisibleResourceTracker(deps: VisibleResourceTrackerDeps): VisibleResourceTracker {
  const ctx = deps.ctx
  const intervalMs = deps.refreshIntervalMs ?? 1_000
  /** 持久化全集（最近一次成功结果）。 */
  let persisted: string[] | null = null
  /** 最近一次成功合并的结果。 */
  let cached: { session: readonly string[]; workspace: readonly string[] } | null = null
  let inflight: Promise<void> | null = null
  let disposed = false

  /** 读持久化会话全集；服务缺席时返回 null（表示"未知"，不覆盖现有缓存）。 */
  const readPersisted = async (): Promise<string[] | null> => {
    // 官方同款取法：`this.ctx.get("sessionQuery")`
    // （`dsh-api-session-controller/lib/index.js:2806`）。直接属性访问在
    // 某些 cordis 组合下拿不到服务，这里两种都试，优先 `get()`。
    let query: { listSessions?: (signal?: AbortSignal) => Promise<readonly { sessionId?: unknown }[]> } | undefined
    try {
      const get = (ctx as unknown as { get?: (name: string) => unknown }).get
      if (typeof get === 'function') {
        query = get.call(ctx, 'sessionQuery') as typeof query
      }
    } catch { /* 忽略 */ }
    if (query === undefined) {
      query = (ctx as unknown as {
        sessionQuery?: { listSessions?: (signal?: AbortSignal) => Promise<readonly { sessionId?: unknown }[]> }
      }).sessionQuery
    }
    if (typeof query?.listSessions !== 'function') {
      deps.onError?.('visible: sessionQuery unavailable', undefined)
      return null
    }
    try {
      const rows = await query.listSessions()
      if (!Array.isArray(rows)) return null
      // 返回形状是 `SessionRecord`：会话 id 在 **`row.header.id`**（不是 `row.sessionId`）。
      // 写错字段会让"持久化全集"恒为空 → 官方 session/list 被过滤成空列表（实测踩过）。
      return rows
        .map(row => {
          const record = row as { header?: { id?: unknown }; sessionId?: unknown; id?: unknown }
          return record?.header?.id ?? record?.sessionId ?? record?.id
        })
        .filter((id): id is string => typeof id === 'string' && id !== '')
    } catch (error) {
      deps.onError?.('visible: listSessions failed', error)
      return null
    }
  }

  /** 执行一次刷新。 */
  const doRefresh = async (): Promise<void> => {
    const live = visibleResourceIdsFromContext(ctx)
    const fromDisk = await readPersisted()
    if (disposed) return
    if (fromDisk !== null) persisted = fromDisk
    const merged = new Set<string>()
    // 持久化全集是官方 list 的过滤依据，必须包含；live 集合覆盖"刚创建还没落盘"的窗口。
    for (const id of persisted ?? []) merged.add(id)
    for (const id of live.session) merged.add(id)
    cached = { session: [...merged], workspace: live.workspace }
  }

  /** 合并并发刷新。 */
  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (inflight !== null) return inflight
    inflight = doRefresh()
      .catch(error => { deps.onError?.('visible: refresh failed', error) })
      .finally(() => { inflight = null })
    return inflight
  }

  // 事件驱动：会话生命周期变化时刷新（官方在 added 事件里给出新会话）。
  const offs: (() => void)[] = []
  try {
    const on = (ctx as unknown as {
      on?: (event: string, listener: () => void) => (() => void) | void
    }).on
    if (typeof on === 'function') {
      for (const event of ['api-session/added', 'api-session/archived', 'api-session/updated', 'session/disposed']) {
        const off = on.call(ctx, event, () => { void refresh() })
        if (typeof off === 'function') offs.push(off)
      }
    }
  } catch (error) {
    deps.onError?.('visible: event subscription failed', error)
  }

  // 定时兜底：事件名若随版本变化，仍能收敛。
  const timer = intervalMs > 0
    ? setInterval(() => { void refresh() }, intervalMs)
    : undefined
  timer?.unref?.()

  // 立刻预热一次，避免首个请求看到空集合。
  void refresh()

  return {
    resourceIds() {
      if (cached !== null) return cached
      // 尚未成功刷新：退回 live 集合（可用但可能不全），不阻塞、不报错。
      return visibleResourceIdsFromContext(ctx)
    },
    refresh,
    invalidate() {
      cached = null
      persisted = null
      void refresh()
    },
    dispose() {
      disposed = true
      if (timer !== undefined) clearInterval(timer)
      for (const off of offs) {
        try { off() } catch { /* 已解除 */ }
      }
    },
  }
}
