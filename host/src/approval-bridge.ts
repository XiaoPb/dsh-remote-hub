/**
 * 审批 waterfall 桥接（D-5）—— 形状被源码推翻后重写的那一版。
 *
 * 已验证事实（`docs/verification/01-harness-facts.md` F16 / A12）：
 * - 审批**不是** Remote 方法。`ApprovalService`（ctx key `approval`）以
 *   `'approval/request'` **scoped waterfall** 派发（`scopeTarget(req.agent, req.agent)`）。
 * - 非 owner Peer **永远拿不到可作答的 waterfall**（Gateway 里
 *   `answers = principal.kind === 'owner'`），`$events/result` 只认 owner。
 * - 服务的 `request()` 要求 turn 已打开，且会自己 append `approval/asked` +
 *   `approval/decided`；重复调用把审计对写两遍。所以**绝不调用服务的 request 方法**
 *   （静态断言 `approval-request-call-sites: 0` 会 grep 这条调用形状）。
 * - 官方 SDK server 的桥接就是 `ctx.on('approval/request', async (req, next) => …)`。
 *
 * 因此正确形状是：注册一个 **root-scope waterfall 监听器**，
 * **不接管就 `next()`**（把决定权还给本机 owner UI），接管时把请求投给轮询流，
 * 等设备回答，返回三值之一。
 *
 * 三值与 `unavailable` 的归属（红线 R13 / D-5）：
 * - 远端只能返回 `allowed-once` | `rejected` | `cancelled`。
 * - `'unavailable'` **只能由「没人应答」产生**（超时 / 吊销），桥接**不得主动返回**
 *   它来表达「我不想答」—— 那种情况的正确做法是 `next()`。
 *
 * ⚠️ 接管条件是**显式判定**：「该 agent 的 session 在本设备可见集合内」。
 * 代码里不存在「总是接管」的分支；任何一个无法判定的请求都 `next()`。
 *
 * @module dsh-remote-hub/host/approval-bridge
 */
import type { Context } from '@deepseek-ai/cordis'

import { HUB_METHODS, hubEndpoint } from '@core/index.js'
import type { RoleName } from '@core/index.js'
import { ROLE_CONTROL, roleAtMost } from '@core/roles.js'

import type { StreamEngine } from './streams.js'

/** 远端允许返回的三个值（**不含** `unavailable`）。 */
export type RemoteApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled'

export const REMOTE_OUTCOMES: readonly RemoteApprovalOutcome[] = ['allowed-once', 'rejected', 'cancelled']

/** 一条投递给轮询流的审批帧。 */
export interface ApprovalFrame {
  kind: 'approval'
  requestId: string
  callId: string | null
  toolName: string
  reason: string | null
  /** **完整原始参数**，不摘要、不截断（红线：审批卡片必须显示完整原始参数）。 */
  args: unknown
  /** 到期时间（epoch ms）；到期后卡片自动变「已过期」。 */
  expiresAt: number
  outcomeOptions: readonly RemoteApprovalOutcome[]
}

/** 一次远端应答的审计行。 */
export interface ApprovalAuditRow {
  deviceId: string
  callId: string | null
  outcome: RemoteApprovalOutcome | 'next'
  at: string
}

export interface ApprovalBridgeDeps {
  streams: StreamEngine
  config: {
    approvalBridgeTimeoutMs: number
    /** 安全评审否决时整体关掉接管（ROADMAP M2 的 Plan B）。 */
    bridgeApprovals: boolean
  }
  /**
   * 接管判定的**唯一**注入源：返回当前可见的 `{deviceId, role}` 设备列表，
   * 以及该 agent 的 session 是否对这些设备可见。生产实现由 `plugin.ts` 从
   * 设备表 + `ctx.sessions` 构造；测试注入固定答案。
   */
  resolveTargets: (request: { agent: unknown; sessionId?: string }) => readonly {
    deviceId: string
    role: RoleName
  }[]
  /** 注入时钟。 */
  now?: () => Date
  /** 审计回调。 */
  onAudit?: (row: ApprovalAuditRow) => void
  /** 投递帧到轮询流（默认走 `deps.streams.enqueue`）。 */
  enqueue?: (deviceId: string, frame: ApprovalFrame) => void
}

/** `hub/answerApproval` 的返回。 */
export interface AnswerApprovalResult {
  ok: boolean
  error?: string
}

export interface ApprovalBridge {
  /**
   * 处理一次 `hub/answerApproval` 调用。
   *
   * 只接受三值；`unavailable` 一律拒绝（那不是远端的答案）。
   * 一个 `requestId` 只能答一次，第二个设备/第二次调用都得 `already-answered`。
   */
  answer(input: {
    deviceId: string
    role: RoleName
    requestId: string
    outcome: string
  }): AnswerApprovalResult
  /** 撤销监听器（随 fiber 自动，但显式 dispose 便于测试）。 */
  dispose(): void
  /** 当前待应答请求数（诊断）。 */
  readonly pending: number
}

interface PendingApproval {
  requestId: string
  callId: string | null
  deviceIds: string[]
  resolve(outcome: RemoteApprovalOutcome | null): void
  timer: ReturnType<typeof setTimeout>
}

/**
 * 创建审批桥接并注册 root-scope waterfall 监听器。
 *
 * @param ctx - Host Context（`ctx.on` 注册 waterfall）。
 * @param deps - 流引擎、配置、接管判定源。
 * @returns `ApprovalBridge`。
 */
export function createApprovalBridge(ctx: Context, deps: ApprovalBridgeDeps): ApprovalBridge {
  const now = deps.now ?? (() => new Date())
  const pending = new Map<string, PendingApproval>()
  const answerableRoles: readonly RoleName[] = [ROLE_CONTROL, 'full']

  const enqueue = deps.enqueue ?? ((deviceId, frame) => deps.streams.enqueue(deviceId, frame))
  const audit = (row: ApprovalAuditRow): void => { deps.onAudit?.(row) }

  /** 把一次 waterfall 请求接管的主体。返回 null 表示「不接管」（调用方 next()）。 */
  const takeOver = async (req: {
    toolName?: unknown
    callId?: unknown
    reason?: unknown
    args?: unknown
    agent?: unknown
  }): Promise<RemoteApprovalOutcome | null> => {
    if (deps.config.bridgeApprovals === false) return null
    const targets = deps.resolveTargets({ agent: req.agent })
    const eligible = targets.filter(device => answerableRoles.some(role => roleAtMost(role, device.role)))
    if (eligible.length === 0) return null

    const requestId = `apr_${now().getTime().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
    const callId = typeof req.callId === 'string' ? req.callId : null
    const expiresAt = now().getTime() + deps.config.approvalBridgeTimeoutMs
    const frame: ApprovalFrame = {
      kind: 'approval',
      requestId,
      callId,
      toolName: typeof req.toolName === 'string' ? req.toolName : 'tool',
      reason: typeof req.reason === 'string' ? req.reason : null,
      args: req.args ?? null,
      expiresAt,
      outcomeOptions: REMOTE_OUTCOMES,
    }

    const outcome = await new Promise<RemoteApprovalOutcome | null>(resolve => {
      const timer = setTimeout(() => {
        // 超时 == 没人应答 → 交回 `next()`，让本机 owner UI 或 fail-closed 处理。
        // **不主动返回 'unavailable'**。
        pending.delete(requestId)
        resolve(null)
      }, deps.config.approvalBridgeTimeoutMs)
      pending.set(requestId, {
        requestId,
        callId,
        deviceIds: eligible.map(device => device.deviceId),
        resolve: value => {
          clearTimeout(timer)
          pending.delete(requestId)
          resolve(value)
        },
        timer,
      })
      for (const device of eligible) enqueue(device.deviceId, frame)
    })
    return outcome
  }

  // Root-scope waterfall 监听器。`ctx.on` 的类型签名针对已知事件，这里用一个
  // 宽松形状注册（事件名是字符串常量），保持运行时语义与官方 SDK server 一致。
  const off = (ctx as unknown as {
    on(name: string, listener: (req: unknown, next: () => Promise<string>) => Promise<string>): () => void
  }).on('approval/request', async (rawReq, next) => {
    const req = rawReq as Parameters<typeof takeOver>[0]
    const outcome = await takeOver(req)
    if (outcome === null) {
      // 不接管：把决定权还给本机 owner UI（反向断言：owner 的审批照常到达）。
      return next()
    }
    return outcome
  })

  return {
    get pending() { return pending.size },
    answer(input) {
      if (!REMOTE_OUTCOMES.includes(input.outcome as RemoteApprovalOutcome)) {
        return { ok: false, error: 'outcome must be one of allowed-once, rejected, cancelled' }
      }
      if (!answerableRoles.some(role => roleAtMost(role, input.role))) {
        return { ok: false, error: 'device role may not answer approvals' }
      }
      const entry = pending.get(input.requestId)
      if (entry === undefined) return { ok: false, error: 'unknown or expired requestId' }
      if (!entry.deviceIds.includes(input.deviceId)) {
        return { ok: false, error: 'approval request is not visible to this device' }
      }
      const outcome = input.outcome as RemoteApprovalOutcome
      audit({
        deviceId: input.deviceId,
        callId: entry.callId,
        outcome,
        at: now().toISOString(),
      })
      entry.resolve(outcome)
      return { ok: true }
    },
    dispose() {
      off()
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        entry.resolve(null)
      }
      pending.clear()
    },
  }
}

/**
 * 生产环境的接管判定：从设备表 + session 可见集合构造。
 *
 * 显式判据：`sessionId` 必须在 `visibleSessionIds()` 里；否则返回空数组 →
 * `next()`。这就是「不接管就 next()」那条反向断言的落点，代码里不存在
 * 「总是接管」的分支。
 * @param deps - 设备表与可见会话源。
 * @returns `resolveTargets` 函数。
 */
export function deviceTargetsResolver(deps: {
  devices: () => readonly { deviceId: string; role: RoleName; revokedAt: string | null }[]
  visibleSessionIds: () => readonly string[]
  sessionIdOfAgent?: (agent: unknown) => string | undefined
}): (request: { agent: unknown; sessionId?: string }) => readonly { deviceId: string; role: RoleName }[] {
  return request => {
    const sessionId = request.sessionId
      ?? deps.sessionIdOfAgent?.(request.agent)
      ?? (request.agent as { session?: { id?: unknown } } | undefined)?.session?.id
    if (typeof sessionId !== 'string' || sessionId === '') return []
    let visible: readonly string[]
    try { visible = deps.visibleSessionIds() } catch { return [] }
    if (!visible.includes(sessionId)) return []
    return deps.devices()
      .filter(device => device.revokedAt === null)
      .map(device => ({ deviceId: device.deviceId, role: device.role }))
  }
}

/** `hub/answerApproval` 的 endpoint（供服务注册与审计共用）。 */
export const ANSWER_APPROVAL_ENDPOINT = hubEndpoint(HUB_METHODS.answerApproval)
