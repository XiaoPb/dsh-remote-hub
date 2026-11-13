/**
 * 敏感 endpoint 的**逐次审批**（0.2.6 / D-16）。
 *
 * ## 为什么放在 dispatch 而不是 `decide()`
 *
 * 官方 `RemoteAccessPolicy.bindings()` 是**同步、不得做 I/O** 的纯函数（每次
 * `decide()` 都调用它），因此不可能在那里等一次人工审批。正确位置是
 * `Dispatcher.fetch()`：它在构造官方信封、调用 `sharedFetch` **之前**，
 * 天然可以 `await`，而且是所有 HTTP RPC 的必经之路。
 *
 * ## 语义
 *
 * 1. 只有 {@link APPROVAL_REQUIRED_ENDPOINTS} 里的 endpoint 进入本模块；
 *    role 门控仍由 `decide()` 负责（本模块只管「谁能调之后还要不要点头」）。
 * 2. 载荷一律经 `redactSecrets()` 后再投递：**审批卡里永远没有明文密钥**。
 * 3. 无人应答（超时）/ 桥接被关闭 ⇒ **拒绝**（fail-closed），
 *    绝不因为「没人理」而放行。
 * 4. 同一设备 + endpoint + 载荷指纹在 {@link APPROVAL_CACHE_MS} 内重复提交时复用
 *    上一次的批准结果，避免官方设置页的一次保存触发多轮审批。
 *    **拒绝从不缓存** —— 被拒之后必须重新请求。
 *
 * @module dsh-remote-hub/host/sensitive-approval
 */
import { createHash } from 'node:crypto'

import { APPROVAL_REQUIRED_ENDPOINTS, redactSecrets } from '@core/index.js'
import type { RoleName } from '@core/index.js'

import type { ApprovalFrame, RemoteApprovalOutcome } from './approval-bridge.js'
import type { StreamEngine } from './streams.js'

/** 一次审批请求的输入。 */
export interface SensitiveApprovalRequest {
  deviceId: string
  role: RoleName
  endpoint: string
  /** 原始信封载荷（可能含明文密钥）。 */
  payload: unknown
}

/** 审批结果。 */
export type SensitiveApprovalDecision =
  | { allowed: true, reason: 'not-required' | 'approved' | 'cached' }
  | { allowed: false, reason: 'rejected' | 'cancelled' | 'timeout' | 'bridge-disabled' }

/** 审批缓存有效期（ms）；同一个保存动作的多轮 RPC 不重复打扰 owner。 */
export const APPROVAL_CACHE_MS = 60_000

export interface SensitiveApprovalDeps {
  /** 投递审批帧到 owner 的轮询流。 */
  streams: StreamEngine
  config: {
    approvalBridgeTimeoutMs: number
    /** 安全评审否决时整体关掉接管（与工具审批桥同一开关）。 */
    bridgeApprovals: boolean
  }
  /** 审计回调（**不得**含明文密钥）。 */
  onAudit?: (row: {
    deviceId: string
    endpoint: string
    decision: string
    at: string
  }) => void
  now?: () => Date
}

export interface SensitiveApprovalGate {
  /**
   * 判断一次调用是否需要、且已获得审批。
   * @param request - 设备、endpoint 与原始载荷。
   * @returns 审批决定。
   */
  check(request: SensitiveApprovalRequest): Promise<SensitiveApprovalDecision>
  /**
   * 处理一次远端 `hub/answerApproval`（与工具审批共用回复方法）。
   * @param input - 设备、请求 id 与三值之一。
   * @returns 是否命中一张本模块的待答审批。
   */
  answer(input: { deviceId: string, requestId: string, outcome: string }): boolean
  /** 待答审批数量（诊断）。 */
  readonly pending: number
  dispose(): void
}

/** 帧形状允许远端返回的三值。 */
const OUTCOMES: readonly RemoteApprovalOutcome[] = ['allowed-once', 'rejected', 'cancelled']

/** 一次调用是否需要 owner 审批。 */
export function requiresApproval(endpoint: string): boolean {
  return APPROVAL_REQUIRED_ENDPOINTS.includes(endpoint)
}

/**
 * 载荷指纹：只用于**去重**，不记录内容。
 * @param endpoint - endpoint。
 * @param payload - 掩码后的载荷。
 * @returns 短哈希。
 */
function fingerprint(endpoint: string, payload: unknown): string {
  return createHash('sha256')
    .update(`${endpoint}\u0000${JSON.stringify(payload ?? null)}`, 'utf8')
    .digest('hex')
    .slice(0, 16)
}

/**
 * 从掩码后的载荷里挑出可读的「操作摘要」给 owner 看：
 * 引用名、provider、bundle 名等。值一律截断，密钥已在此前被掩码。
 *
 * @param payload - 掩码后的载荷。
 * @returns 单行摘要（可能为空串）。
 */
export function summarizeForApproval(payload: unknown): string {
  if (payload === null || typeof payload !== 'object') return ''
  const flat: string[] = []
  const walk = (node: unknown, depth: number): void => {
    if (flat.length >= 6 || depth > 3 || node === null || typeof node !== 'object') return
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      if (item === null || item === undefined) continue
      if (typeof item === 'string') {
        flat.push(`${key}=${item.length > 60 ? `${item.slice(0, 57)}...` : item}`)
      } else if (typeof item === 'number' || typeof item === 'boolean') {
        flat.push(`${key}=${String(item)}`)
      } else {
        walk(item, depth + 1)
      }
    }
  }
  walk(payload, 0)
  return flat.slice(0, 6).join(' · ')
}

interface Waiter {
  deviceId: string
  settle(outcome: RemoteApprovalOutcome | null): void
}

/**
 * 创建审批网关。
 *
 * @param deps - 流引擎、配置与审计。
 * @returns 审批网关。
 */
export function createSensitiveApprovalGate(deps: SensitiveApprovalDeps): SensitiveApprovalGate {
  const now = deps.now ?? (() => new Date())
  /** key = deviceId + endpoint + fingerprint → 到期时间。只缓存**批准**。 */
  const approved = new Map<string, number>()
  /** requestId → 等待者。实例级（不是模块级），避免多实例串扰。 */
  const waiters = new Map<string, Waiter>()

  const audit = (deviceId: string, endpoint: string, decision: string): void => {
    deps.onAudit?.({ deviceId, endpoint, decision, at: now().toISOString() })
  }

  /** 清理过期缓存。 */
  const sweep = (): void => {
    const current = now().getTime()
    for (const [key, expires] of approved) if (expires <= current) approved.delete(key)
  }

  return {
    get pending() { return waiters.size },
    async check(request) {
      if (!requiresApproval(request.endpoint)) return { allowed: true, reason: 'not-required' }
      if (deps.config.bridgeApprovals === false) {
        audit(request.deviceId, request.endpoint, 'deny:bridge-disabled')
        return { allowed: false, reason: 'bridge-disabled' }
      }

      // ① 先掩码：之后所有分支都只接触掩码后的载荷。
      const safePayload = redactSecrets(request.payload)
      const key = `${request.deviceId}\u0000${request.endpoint}\u0000${fingerprint(request.endpoint, safePayload)}`
      sweep()
      const expires = approved.get(key)
      if (expires !== undefined && expires > now().getTime()) {
        audit(request.deviceId, request.endpoint, 'allow:cached')
        return { allowed: true, reason: 'cached' }
      }

      // ② 一张审批卡，等 owner 回答或超时。
      const requestId = `sen_${now().getTime().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
      const timeoutMs = deps.config.approvalBridgeTimeoutMs
      const frame: ApprovalFrame = {
        kind: 'approval',
        requestId,
        callId: null,
        toolName: `remote-hub:${request.endpoint}`,
        reason: summarizeForApproval(safePayload) || null,
        args: safePayload,
        expiresAt: now().getTime() + timeoutMs,
        outcomeOptions: OUTCOMES,
      }

      const outcome = await new Promise<RemoteApprovalOutcome | null>(resolve => {
        // 超时 == 没人应答 → 拒绝（fail-closed）：敏感写入不接受「静默放行」。
        //
        // ⚠️ 这里**不能** `unref()`：审批等待期间事件循环里可能没有别的句柄，
        // unref 的定时器不保持进程存活 → 超时分支永不触发，请求会被静默挂死。
        const timer = setTimeout(() => {
          waiters.delete(requestId)
          resolve(null)
        }, timeoutMs)
        waiters.set(requestId, {
          deviceId: request.deviceId,
          settle: value => {
            clearTimeout(timer)
            waiters.delete(requestId)
            resolve(value)
          },
        })
        deps.streams.enqueue(request.deviceId, frame)
      })

      if (outcome === 'allowed-once') {
        approved.set(key, now().getTime() + APPROVAL_CACHE_MS)
        audit(request.deviceId, request.endpoint, 'allow:approved')
        return { allowed: true, reason: 'approved' }
      }
      if (outcome === 'rejected') {
        audit(request.deviceId, request.endpoint, 'deny:rejected')
        return { allowed: false, reason: 'rejected' }
      }
      if (outcome === 'cancelled') {
        audit(request.deviceId, request.endpoint, 'deny:cancelled')
        return { allowed: false, reason: 'cancelled' }
      }
      audit(request.deviceId, request.endpoint, 'deny:timeout')
      return { allowed: false, reason: 'timeout' }
    },
    answer(input) {
      if (!OUTCOMES.includes(input.outcome as RemoteApprovalOutcome)) return false
      const waiter = waiters.get(input.requestId)
      if (waiter === undefined || waiter.deviceId !== input.deviceId) return false
      waiter.settle(input.outcome as RemoteApprovalOutcome)
      return true
    },
    dispose() {
      for (const waiter of waiters.values()) waiter.settle(null)
      waiters.clear()
      approved.clear()
    },
  }
}
