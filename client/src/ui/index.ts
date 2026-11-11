/**
 * UI 面板与入口门控。
 *
 **所有写入口必须**经 `AccessStore.can(endpoint)`：无权时**不渲染该 DOM 节点**
 *（不是 `disabled`），且对该 endpoint 的 fetch 计数为 0（验收 A5-1 / A5-2）。
 *
 * 面板用官方 `ctx.slots.register()` 注册到 `shell.overlay`（list / root 槽），
 * 卸载时 disposer 由 `ctx.effect` 统一回收，无残留订阅。
 *
 * @module dsh-remote-hub/client/ui
 */
import React from 'react'

import { isWriteAction } from '@core/capabilities.js'
import type { RoleName } from '@core/roles.js'

import type { AccessStore } from '../access.js'
import { ApprovalSheet, type ApprovalCardProps } from './ApprovalSheet.js'

/** 面板选项。 */
export interface RemotePanelOptions {
  access: AccessStore
  /** 发一条一元 RPC；由 transport 注入。 */
  call: (method: string, args: Record<string, unknown>) => Promise<unknown>
  /**
   * 显式传入已探测的 `slots` 服务（推荐）：caller 用 `ctx.get('slots')` 软探测后
   * 传入实例，本函数就**不再裸读 `ctx.slots`**——scoped proxy 上裸读未注入的
   * 服务会抛 `cannot get property "slots" without inject`（cordis get trap）。
   * 缺省时回退到裸读（保持对既有调用方与测试的兼容）。
   */
  slots?: { register(options: unknown, component: unknown): () => void }
  /** 可选：注入审批帧（测试用）。 */
  approvals?: readonly ApprovalCardProps[]
}

/** 面板句柄。 */
export interface RemotePanel {
  dispose(): void
  /** 纯渲染函数（DOM 门控断言可直接调用，不需要挂载 React）。 */
  render(): React.ReactNode
}

/** 面板关心的入口 endpoint 列表。 */
export const PANEL_ENDPOINTS: readonly string[] = [
  'session/prompt',
  'session/cancel',
  'session/create',
  'fileUploads/upload',
  'hub/revoke',
  'hub/answerApproval',
  'session/list',
  'session/events',
  'hub/stream.open',
  'hub/stream.next',
  'hub/stream.cancel',
]

/**
 * 门控后的入口节点集合：无权入口**不存在**（不是 disabled）。
 * @param access - 权限快照。
 * @returns 可渲染的 endpoint 列表。
 */
export function visibleEndpoints(access: AccessStore): readonly string[] {
  return PANEL_ENDPOINTS.filter(endpoint => access.can(endpoint))
}

/**
 * 面板的纯渲染体。
 * @param options - 面板选项。
 * @returns React 节点。
 */
export function renderPanel(options: RemotePanelOptions): React.ReactNode {
  const snapshot = options.access.current()
  const visible = visibleEndpoints(options.access)

  // 写入口：只有被授予时才渲染 composer；`read-only` 下这个节点**不存在**。
  const canCompose = visible.includes('session/prompt')
  const canUpload = visible.includes('fileUploads/upload')
  const canRevoke = visible.includes('hub/revoke')

  return React.createElement(
    'div',
    { 'data-testid': 'remote-hub-panel', 'data-role': snapshot?.role ?? 'unpaired' },
    React.createElement('header', null, 'Remote Hub', snapshot === null ? null : ` · ${snapshot.role}`),
    canCompose
      ? React.createElement('textarea', {
        'data-testid': 'composer',
        'aria-label': 'send a prompt',
        onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
          if (event.key !== 'Enter' || event.ctrlKey === false) return
          const value = event.currentTarget.value
          if (value.trim() !== '') void options.call('session/prompt', { content: value })
        },
      })
      : null,
    canUpload
      ? React.createElement('button', { type: 'button', 'data-testid': 'upload' }, '上传')
      : null,
    canRevoke
      ? React.createElement('button', { type: 'button', 'data-testid': 'revoke' }, '吊销设备')
      : null,
    // 其它被授予的只读入口渲染成一个小列表，方便 UI 门控断言统计。
    React.createElement('ul', { 'data-testid': 'granted-endpoints' },
      visible.filter(endpoint => !isWriteAction(endpoint)).map(endpoint =>
        React.createElement('li', { key: endpoint, 'data-endpoint': endpoint }, endpoint))),
    ...(options.approvals ?? []).map(card =>
      React.createElement(ApprovalSheet, { key: card.requestId, ...card })),
  )
}

/**
 * 挂载面板。
 *
 * `slots` 缺席时**不静默失败**：抛明确错误（同源模式要求
 * `@deepseek-ai/dsh-client-ui-slots` 已装配）。返回句柄的 `dispose()` 会执行所有
 * disposer，且顺序与注册相反。
 * @param ctx - Client Cordis root。
 * @param options - 面板选项。
 * @returns `RemotePanel`。
 */
export function mountRemotePanel(ctx: unknown, options: RemotePanelOptions): RemotePanel {
  // 优先用 caller 显式传入的 slots 实例（无 get-trap 风险）；缺省才裸读回退。
  const slots = options.slots
    ?? (ctx as { slots?: { register(opts: unknown, component: unknown): () => void } } | undefined)?.slots
  const disposers: (() => void)[] = []

  if (slots !== undefined && typeof slots.register === 'function') {
    // `shell.overlay` 是 list/root 槽：注册一个条目而不替换别人的条目。
    disposers.push(slots.register({
      name: 'shell.overlay',
      id: 'remote-hub-panel',
      order: 100,
    }, () => renderPanel(options)))
  } else {
    throw new Error(
      'dsh-remote-hub: ctx.slots is unavailable; the panel requires @deepseek-ai/dsh-client-ui-slots',
    )
  }

  return {
    render() { return renderPanel(options) },
    dispose() {
      for (const dispose of [...disposers].reverse()) dispose()
      disposers.length = 0
      options.access.dispose()
    },
  }
}

/** 角色标签（与 `core/roles.ts` 的 `ROLE_LABELS` 对齐，UI 本地不硬编码语义）。 */
export type PanelRole = RoleName | 'unpaired'
