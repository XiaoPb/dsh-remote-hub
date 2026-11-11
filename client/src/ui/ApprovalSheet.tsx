/**
 * 审批卡片（三值语义，D-5）。
 *
 * - 显示**完整原始参数**（`args` 原样），不摘要、不截断。
 * - 只提供「允许一次 / 拒绝」两个按钮；`cancelled` 由关闭 / 超时产生，**不设按钮**。
 * - 超时倒计时可见，到期后卡片自动变为「已过期」。
 *
 * @module dsh-remote-hub/client/ui/ApprovalSheet
 */
import React, { useEffect, useState } from 'react'

/** 一条审批请求（与 `host/src/approval-bridge.ts` 的 `ApprovalFrame` 同形）。 */
export interface ApprovalCardProps {
  requestId: string
  callId: string | null
  toolName: string
  reason: string | null
  /** **完整原始参数**。 */
  args: unknown
  expiresAt: number
  /** 只允许一次；`null` 表示卡片已关闭/超时（`cancelled`）。 */
  onAnswer: (outcome: 'allowed-once' | 'rejected' | 'cancelled') => void
  /** 注入时钟（测试用）。 */
  now?: () => number
}

/** 远端允许返回的三个值（`unavailable` 不是远端的答案）。 */
export const OUTCOME_OPTIONS: readonly ('allowed-once' | 'rejected')[] = ['allowed-once', 'rejected']

/**
 * 审批卡片。
 * @param props - 见 `ApprovalCardProps`。
 * @returns React 节点。
 */
export function ApprovalSheet(props: ApprovalCardProps): React.ReactNode {
  const now = props.now ?? (() => Date.now())
  const [remaining, setRemaining] = useState<number>(() => Math.max(0, props.expiresAt - now()))
  const [answered, setAnswered] = useState(false)

  useEffect(() => {
    if (answered) return
    const timer = setInterval(() => {
      const left = Math.max(0, props.expiresAt - now())
      setRemaining(left)
      if (left === 0) {
        clearInterval(timer)
        setAnswered(true)
        props.onAnswer('cancelled')
      }
    }, 250)
    return () => clearInterval(timer)
  }, [answered, props.expiresAt])

  const expired = remaining === 0

  return React.createElement(
    'section',
    { 'data-testid': 'approval-sheet', 'data-request-id': props.requestId },
    React.createElement('header', null,
      React.createElement('strong', null, props.toolName),
      props.callId !== null ? React.createElement('code', null, props.callId) : null,
    ),
    props.reason !== null ? React.createElement('p', null, props.reason) : null,
    // 完整原始参数：原样 JSON，不摘要。
    React.createElement('pre', { 'data-testid': 'approval-args' }, JSON.stringify(props.args, null, 2)),
    React.createElement('div', { 'data-testid': 'approval-countdown' },
      expired ? '已过期' : `剩余 ${Math.ceil(remaining / 1000)}s`),
    expired || answered
      ? null
      : React.createElement('div', { 'data-testid': 'approval-actions' },
        OUTCOME_OPTIONS.map(outcome =>
          React.createElement('button', {
            key: outcome,
            type: 'button',
            'data-outcome': outcome,
            onClick: () => {
              setAnswered(true)
              props.onAnswer(outcome)
            },
          }, outcome === 'allowed-once' ? '允许一次' : '拒绝'),
        ),
      ),
  )
}
