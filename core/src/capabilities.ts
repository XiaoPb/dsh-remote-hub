/**
 * 能力矩阵：三档角色 × 官方 endpoint 的 allow-list，**按资源种类分层**。
 *
 * 这是「哪个角色能调哪个 endpoint」的**唯一真源**：host 的
 * `remoteAccess.registerPolicy('remote-device', …)` 与 client/Android 的 UI 门控
 * 读同一份表，所以 UI 永远不会显示一个后端一定会拒绝的入口。
 *
 * 三条硬约束（改这个文件前先读）：
 *
 * 1. **单位是官方 endpoint**（`<namespace>/<method>`），不是本插件自造的方法名。
 *    每个条目都能在 {@link ENDPOINT_TABLE} 里查到；那张表来自对 DSH 0.2.2-rc.1
 *    源码的 `@Remote` 全量扫描（`docs/verification/01-harness-facts.md` §5 的方法清单 +
 *    本次开工时对 `packages/**\/src` 的复查）。`scripts/contract-check.mjs` 会断言
 *    「矩阵里的每个动作都可在表里追溯」，所以新增一个动作必须同时补表。
 * 2. **资源种类决定 binding 的挂法**（D-11）。官方 `decide()` 拿到的
 *    `resources` 由方法参数的 lookup 解析而来：`sessionId` → `session`，
 *    `workspaceFileScopeId` → `session`（实测：`workspace-files` 注册的
 *    `workspaceFileScope` lookup 声明的 `resource` 就是 `'session'`），
 *    `agentId` → `session`。**没有任何参数指明资源时是 `global`。**
 *    只在 `global` 上授权（v0.1 的做法）会让每一个会话级方法在实机上全拒。
 * 3. **红线不进本表**：`capabilities-redlines.ts` 的前缀与方法集合与本表的交集
 *    必须为空，`assertNoRedlineDelegated()` 在模块加载期就断言。
 *
 * 角色语义（DESIGN §8.6.1）：
 * - `read-only`：只能看。列表、历史、状态、文件读、任务面板。
 * - `control`：能驱动会话。read-only + prompt/cancel/create/fork/rename/queue + 审批/提问。
 * - `full`：还能传文件、开终端。control + `fileUploads/upload` + `workspaceFiles/*` + `terminal/*` + `job/kill`。
 *
 * @module @core/capabilities
 */
import { SHARED_READ_ENDPOINTS, FULL_ADMIN_ENDPOINTS, NEVER_DELEGATED_ENDPOINTS, isNeverDelegated } from './capabilities-redlines.js'
import { ROLE_CONTROL, ROLE_FULL, ROLE_READ_ONLY, ROLE_NAMES, roleAtMost, type RoleName } from './roles.js'

/** 官方资源种类：`global` 无 id，其余需要具体身份。 */
export type ResourceKind = 'global' | 'session' | 'workspace'

/** 一个官方 endpoint 的静态事实。 */
export interface EndpointFact {
  /** 没有参数指明资源时是 `global`；否则是解析出的资源种类。 */
  readonly kind: ResourceKind
  /** `@Remote({ mode: 'stream' })`；只能经 `hub/stream.*` 消费。 */
  readonly stream?: true
  /** 是否在 DSH 的同一 namespace 下由官方端点提供（false 表示这是我们自己的 `hub/*`）。 */
  readonly hub?: true
}

/**
 * 已核对的官方 endpoint 表（namespace → method）。
 *
 * 每一项都对应 DSH 源码里一个 `@Remote`（或被 `hub/*` 包住的官方 stream 方法）。
 * `kind` 的判据见文件头第 2 条：由该方法的 lookup 参数决定，不是猜的。
 */
export const ENDPOINT_TABLE: Readonly<Record<string, EndpointFact>> = {
  ...Object.fromEntries([...SHARED_READ_ENDPOINTS, ...FULL_ADMIN_ENDPOINTS].map(endpoint => [endpoint, {
    kind: 'global' as const,
    ...(['account/watch', 'account/watchExpiry', 'remoteAccess/follow'].includes(endpoint) ? { stream: true as const } : {}),
  }])),
  ...Object.fromEntries(['pluginManager/listBundles', 'pluginManager/listPlugins', 'pluginManager/listVersionExemptions', 'pluginManager/registries', 'pluginManager/inspect', 'pluginMarket/listIndexes', 'pluginMarket/search'].map(endpoint => [endpoint, { kind: 'global' as const }])),
  'directoryPicker/pick': { kind: 'global' },
  // ── session（`sessionController`，namespace `session`）──────────────────────
  'session/list': { kind: 'global' },
  'session/search': { kind: 'global' },
  'session/create': { kind: 'global' },
  'session/modelCatalog': { kind: 'global' },
  'session/selectModel': { kind: 'session' },
  'session/openWorkspacePath': { kind: 'global' },
  'session/workspacePathApplications': { kind: 'global' },
  'session/rename': { kind: 'session' },
  'session/fork': { kind: 'session' },
  'session/prompt': { kind: 'session' },
  'session/attachment': { kind: 'session' },
  'session/updateQueue': { kind: 'session' },
  'session/cancel': { kind: 'session' },
  'session/page': { kind: 'session' },
  'session/events': { kind: 'session' },
  'session/state': { kind: 'session' },
  'session/wait': { kind: 'session' },
  'session/projections': { kind: 'session' },
  'session/observeEvent': { kind: 'session', stream: true },
  'session/observeProjections': { kind: 'session', stream: true },
  'session/observeState': { kind: 'session', stream: true },
  'session/follow': { kind: 'session', stream: true },
  'session/control': { kind: 'global', stream: true },

  // ── workspaceFiles（服务键 `workspaceFiles`，namespace 同名）────────────────
  // `workspaceFileScope` lookup 声明的 resource 是 `session`，所以这些方法落在
  // `session` 资源上 —— 与 DESIGN §8.6.2 的「workspace」标注不同，以源码为准。
  'workspaceFiles/list': { kind: 'session' },
  'workspaceFiles/stat': { kind: 'session' },
  'workspaceFiles/read': { kind: 'session' },
  'workspaceFiles/readBytes': { kind: 'session' },
  'workspaceFiles/changes': { kind: 'session', stream: true },

  // ── workspace（`workspaceController`，namespace `workspace`）───────────────
  'workspace/follow': { kind: 'global', stream: true },
  'workspace/create': { kind: 'global' },
  'workspace/initializeDefault': { kind: 'global' },
  'workspace/rename': { kind: 'global' },
  'workspace/delete': { kind: 'global' },
  'workspace/insertBefore': { kind: 'global' },
  'workspace/insertSessionBefore': { kind: 'global' },
  'workspace/archiveSession': { kind: 'global' },
  'workspace/unarchiveSession': { kind: 'global' },
  'workspace/pinSession': { kind: 'global' },
  'workspace/unpinSession': { kind: 'global' },

  // ── terminal（`terminalController`，namespace `terminal`）─────────────────
  'terminal/list': { kind: 'session' },
  'terminal/create': { kind: 'session' },
  'terminal/close': { kind: 'session' },
  'terminal/rename': { kind: 'session' },
  'terminal/shells': { kind: 'session' },
  'terminal/environment': { kind: 'session' },
  'terminal/retain': { kind: 'session', stream: true },
  'terminal/attach': { kind: 'session', stream: true },

  // ── job（`jobController`，namespace `job`）────────────────────────────────
  'job/list': { kind: 'global', stream: true },
  'job/follow': { kind: 'global', stream: true },
  'job/kill': { kind: 'global' },

  // ── goals（服务键 `goals`，无 namespace 覆盖）──────────────────────────────
  'goals/get': { kind: 'global' },
  'goals/create': { kind: 'global' },
  'goals/edit': { kind: 'global' },
  'goals/pause': { kind: 'global' },
  'goals/resume': { kind: 'global' },
  'goals/complete': { kind: 'global' },
  'goals/clear': { kind: 'global' },

  // ── fileUploads（`fileUploads`）──────────────────────────────────────────
  'fileUploads/upload': { kind: 'session' },

  // ── userQuestions（`userQuestions`）──────────────────────────────────────
  'userQuestions/answer': { kind: 'session' },
  'userQuestions/attachWait': { kind: 'session', stream: true },

  // ── settings（只读的 describe；写方法在红线里）────────────────────────────
  'settings/describe': { kind: 'global' },

  // ── UI 必需只读目录（2026-11-13 页面 CDP 实测补齐）──────────────────────
  // 这些方法只枚举被控 Host 已配置的选择项，无写入/执行副作用；缺失会导致
  // 新会话 composer、设置中的 Agent preset/命令/技能选择器报 remote-access/denied。
  // Credentials / plugin inventory / dynamicCordisRunner 不在这里：它们分别涉及
  // 凭据元数据、宿主插件攻击面、动态插件执行，必须走单独的窄化管理设计。
  /** 模型设置配置目录（只返回 provider/config metadata）。 */
  'llm/listConfigurableProviders': { kind: 'global' },
  'llm/listProviders': { kind: 'global' },
  'permissionPresets/catalog': { kind: 'global' },
  'agentPresets/list': { kind: 'global' },
  // Composer discovery is read-only and session-scoped; include every source
  // consulted by @ candidate rendering, not only the candidate RPC itself.
  'fileReferences/list': { kind: 'session' },
  'messageFeedback/list': { kind: 'session' },
  'sessionReferenceResolver/candidates': { kind: 'session' },
  'commands/list': { kind: 'session' },
  /** request.sessionId 由 Gateway default sessionId resource field 提取。 */
  'skills/list': { kind: 'session' },

  // ── 本插件自己的 hub/* 方法（同过 decide()，与官方 endpoint 等权）──────────
  'hub/devices': { kind: 'global', hub: true },
  'hub/revoke': { kind: 'global', hub: true },
  'hub/stream.open': { kind: 'global', hub: true },
  'hub/stream.next': { kind: 'global', hub: true },
  'hub/stream.cancel': { kind: 'global', hub: true },
  'hub/answerApproval': { kind: 'global', hub: true },
}

/** 某角色在某个资源种类上可用的动作集合。 */
export type RoleMatrix = Readonly<Record<ResourceKind, readonly string[]>>

/**
 * `read-only`：无副作用的一切。
 *
 * 只读设备必须能看流（监控场景），所以 `session/follow` / `observe*` /
 * `workspaceFiles/changes` / `job/follow` / `terminal/retain` 都在这里 ——
 * 它们本身不改状态。
 */
const READ_ONLY: RoleMatrix = {
  global: [
    'session/list',
    'session/search',
    'session/modelCatalog',
    'session/workspacePathApplications',
    'workspace/follow',
    'job/list',
    'job/follow',
    'goals/get',
    'settings/describe',
    ...SHARED_READ_ENDPOINTS,
    'llm/listConfigurableProviders', 'llm/listProviders', 'permissionPresets/catalog', 'agentPresets/list',
    // ── Remote Hub 自有只读状态流 ──────────────────────────────────────────
    'hub/stream.open',
    'hub/stream.next',
    'hub/stream.cancel',
  ],
  session: [
    'session/events',
    // `session/page` 已 @deprecated（接任者是 `session/events`），**不进矩阵**。
    // 它仍留在 ENDPOINT_TABLE 里以便对账，但任何角色都不会被授予它。
    'session/state',
    'session/projections',
    'session/wait',
    'session/observeEvent',
    'session/observeProjections',
    'session/observeState',
    'session/follow',
    'session/control',
    'workspaceFiles/list',
    'workspaceFiles/stat',
    'workspaceFiles/read',
    'workspaceFiles/readBytes',
    'workspaceFiles/changes',
    'job/list',
    'job/follow',
    'goals/get',
    'terminal/list',
    'terminal/shells',
    'terminal/environment',
    'terminal/retain',
    // commands/list 使用 agentId lookup（官方 resource=session）；skills/list
    // 需要 request.sessionId。两者是只读目录，按当前 session 可见性过滤。
    'commands/list',
    'fileReferences/list',
    'messageFeedback/list',
    'sessionReferenceResolver/candidates',
    'skills/list',
  ],
  workspace: [],
}

/**
 * `control`：在只读之上能驱动会话。
 *
 * 注意 `hub/answerApproval` 与 `userQuestions/answer` 都在这里：它们**替 owner
 * 做决定**，风险等级与审批相同，所以只给 control 及以上，且必须审计（D-5）。
 */
const CONTROL: RoleMatrix = {
  global: [
    ...READ_ONLY.global,
    'session/create',
    'workspace/create',
    'workspace/initializeDefault',
    'workspace/rename',
    'workspace/insertBefore',
    'workspace/insertSessionBefore',
    'workspace/archiveSession',
    'workspace/unarchiveSession',
    'workspace/pinSession',
    'workspace/unpinSession',
    'goals/create',
    'goals/edit',
    'goals/pause',
    'goals/resume',
    'goals/complete',
    'hub/devices',
    'hub/answerApproval',
  ],
  session: [
    ...READ_ONLY.session,
    'session/prompt',
    'session/cancel',
    'session/rename',
    'session/fork',
    'session/updateQueue',
    'session/selectModel',
    'userQuestions/answer',
    'userQuestions/attachWait',
  ],
  workspace: ['session/create'],
}

/**
 * `full`：在 control 之上能碰文件系统与终端。
 *
 * `session/attachment` 与 `fileUploads/upload` 只给 full；`terminal/*` 的写方法
 * （`create`/`attach`/`close`/`rename`）也只给 full，因为 `attach` 是一个双向
 * stream —— 给出去等于把 shell 交出去。
 */
const FULL: RoleMatrix = {
  global: [
    ...CONTROL.global,
    ...SHARED_READ_ENDPOINTS,
    ...FULL_ADMIN_ENDPOINTS,
    'job/kill',
    'goals/clear',
    'hub/revoke',
  ],
  session: [
    ...CONTROL.session,
    'fileUploads/upload',
    'session/attachment',
    'workspaceFiles/list',
    'workspaceFiles/stat',
    'workspaceFiles/read',
    'workspaceFiles/readBytes',
    'workspaceFiles/changes',
    'terminal/create',
    'terminal/attach',
    'terminal/close',
    'terminal/rename',
  ],
  workspace: ['session/create'],
}

/** 三档角色 → 三资源种类的矩阵。 */
export const ROLE_MATRIX: Readonly<Record<RoleName, RoleMatrix>> = {
  [ROLE_READ_ONLY]: READ_ONLY,
  [ROLE_CONTROL]: CONTROL,
  [ROLE_FULL]: FULL,
}

/** 某角色在某个资源种类上的动作集合（去重、稳定顺序）。 */
export function actionsFor(role: RoleName, kind: ResourceKind): readonly string[] {
  return ROLE_MATRIX[role][kind]
}

/** 某角色的全部动作（三个种类合并，用于审计与契约快照）。 */
export function allActionsFor(role: RoleName): readonly string[] {
  const seen = new Set<string>()
  for (const kind of ['global', 'session', 'workspace'] as const) {
    for (const action of ROLE_MATRIX[role][kind]) seen.add(action)
  }
  return [...seen].sort()
}

/**
 * 某角色**可以**作为 `hub/stream.open` 的 `endpoint` 参数的官方 stream 方法。
 *
 * 判据是三条同时成立：在矩阵里（该角色可调用）、在 {@link ENDPOINT_TABLE} 里、
 * 且标了 `stream: true`。任何一条不满足 → `stream-open-denied`（不区分原因，
 * 否则这条会成为 endpoint 探测器）。
 */
export function openableStreams(role: RoleName): readonly string[] {
  const allowed = new Set(allActionsFor(role))
  return Object.entries(ENDPOINT_TABLE)
    .filter(([endpoint, fact]) => fact.stream === true && allowed.has(endpoint))
    .map(([endpoint]) => endpoint)
    .sort()
}

/**
 * 断言一：三档角色逐项包含（`read-only ⊆ control ⊆ full`，按资源种类分别成立）。
 * @throws 当包含关系被破坏时，错误信息指名缺失的条目。
 */
export function assertRoleContainment(): void {
  for (const kind of ['global', 'session', 'workspace'] as const) {
    const chain: readonly RoleName[] = [ROLE_READ_ONLY, ROLE_CONTROL, ROLE_FULL]
    for (let index = 0; index < chain.length - 1; index += 1) {
      const weaker = chain[index] as RoleName
      const stronger = chain[index + 1] as RoleName
      const strong = new Set(ROLE_MATRIX[stronger][kind])
      const missing = ROLE_MATRIX[weaker][kind].filter(action => !strong.has(action))
      if (missing.length > 0) {
        throw new Error(
          `capabilities: ${weaker}/${kind} is not contained in ${stronger}/${kind}; missing ${missing.join(', ')}`,
        )
      }
    }
  }
}

/**
 * 断言二：allow-list 与红线交集为空（红线 R11）。
 * @throws 当某个红线 endpoint 出现在任一角色的矩阵里。
 */
export function assertNoRedlineDelegated(): void {
  for (const role of ROLE_NAMES) {
    for (const action of allActionsFor(role)) {
      if (isNeverDelegated(action)) {
        throw new Error(`capabilities: ${role} must not be granted redline endpoint ${action}`)
      }
      if (FULL_ADMIN_ENDPOINTS.includes(action) && role !== ROLE_FULL) {
        throw new Error(`capabilities: ${role} must not be granted full administration endpoint ${action}`)
      }
      if (NEVER_DELEGATED_ENDPOINTS.includes(action) && !FULL_ADMIN_ENDPOINTS.includes(action)) {
        throw new Error(`capabilities: ${role} must not be granted redline endpoint ${action}`)
      }
    }
  }
}

/**
 * 断言三：矩阵里的每个动作都能在 {@link ENDPOINT_TABLE} 里追溯。
 * @returns 无法追溯的动作（空数组 = 表与矩阵一致）。CI 用它输出 `untraceable-actions: N`。
 */
export function untraceableActions(): readonly string[] {
  const untraceable = new Set<string>()
  for (const role of ROLE_NAMES) {
    for (const action of allActionsFor(role)) {
      if (ENDPOINT_TABLE[action] === undefined) untraceable.add(action)
    }
  }
  return [...untraceable].sort()
}

/**
 * 断言四：矩阵里**不含**任何已废弃的官方 endpoint。
 *
 * `session/page` 已被 `session/events` 接任（`@deprecated Use events`）。它仍留在
 * `ENDPOINT_TABLE` 里以便与 Typert 注册表对账，但**不进任何角色的矩阵**：
 * 非 owner 设备一律用 `session/events`，不依赖废弃方法（ROADMAP T2.1 / A2-3）。
 * @returns 矩阵里出现的废弃 endpoint（合规实现恒为空数组）。
 */
export function deprecatedActionsInMatrix(): readonly string[] {
  const deprecated: readonly string[] = ['session/page']
  return [...new Set(ROLE_NAMES.flatMap(role => allActionsFor(role)))]
    .filter(action => deprecated.includes(action))
    .sort()
}

/**
 * 模块加载期自检：**任何一条不成立就抛错**，让能力矩阵的错误在插件加载时暴露，
 * 而不是等到某台设备在实机上 403。
 */
export function assertMatrixIntegrity(): void {
  assertRoleContainment()
  assertNoRedlineDelegated()
  const untraceable = untraceableActions()
  if (untraceable.length > 0) {
    throw new Error(`capabilities: matrix names endpoints missing from the table: ${untraceable.join(', ')}`)
  }
  for (const [endpoint, fact] of Object.entries(ENDPOINT_TABLE)) {
    if (!/^[A-Za-z0-9_$.-]+\/[A-Za-z0-9_$.-]+$/u.test(endpoint)) {
      throw new Error(`capabilities: endpoint ${JSON.stringify(endpoint)} is not <namespace>/<method>`)
    }
    if (fact.hub === true && !endpoint.startsWith('hub/')) {
      throw new Error(`capabilities: ${endpoint} is marked hub but is not in the hub namespace`)
    }
  }
  for (const role of ROLE_NAMES) {
    // 只读档必须真的只读：不许出现任何写动词（判据是动作名，不是资源）。
    if (role === ROLE_READ_ONLY) {
      const writes = allActionsFor(role).filter(isWriteAction)
      if (writes.length > 0) {
        throw new Error(`capabilities: read-only must not hold write actions: ${writes.join(', ')}`)
      }
    }
  }
  if (!roleAtMost(ROLE_READ_ONLY, ROLE_FULL)) {
    throw new Error('capabilities: role order is broken')
  }
}

/** 写动作的判据：方法名在写动词集合里。用于只读档的反向断言。 */
const WRITE_VERBS: readonly string[] = [
  'prompt',
  'cancel',
  'create',
  'fork',
  'rename',
  'delete',
  'updateQueue',
  'selectModel',
  'attachment',
  'upload',
  'kill',
  'edit',
  'pause',
  'resume',
  'complete',
  'clear',
  'insertBefore',
  'insertSessionBefore',
  'archiveSession',
  'unarchiveSession',
  'pinSession',
  'unpinSession',
  'initializeDefault',
  'answer',
  'close',
  'revoke',
  'answerApproval',
  'openWorkspacePath',
]

/**
 * 一个 endpoint 是否是写动作（方法名命中写动词）。
 * @param endpoint - `<namespace>/<method>`。
 * @returns 方法段属于写动词集合时为 true。
 */
export function isWriteAction(endpoint: string): boolean {
  const method = endpoint.slice(endpoint.lastIndexOf('/') + 1)
  return WRITE_VERBS.includes(method)
}

assertMatrixIntegrity()
