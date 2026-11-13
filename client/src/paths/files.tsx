/**
 * 云端文件选择对话框（原 `@xiaopb/dsh-remote-paths` 伴生包，0.3.0 起内置）。
 *
 * 从**目标主机**的会话工作区挑选文件，把相对路径以 `@path` 形式追加到当前草稿；
 * 不发送消息、不读取文件内容、不涉及本机文件系统。
 *
 * @module dsh-remote-hub/client/paths/files
 */
import React from 'react'

import type { CloudPathContext, PathEntry, WorkspaceListing } from './context.js'
import { cloudPathContext, pathRpc } from './context.js'

const h = React.createElement

/** 打开云端文件选择器的全局事件名。 */
export const OPEN_REMOTE_FILES = 'dsh-remote-hub:open-remote-files'

/** 主插件 client ctx 里本模块用到的最小面（含 `sessions` / `conversation` 服务）。 */
interface PathsHostContext {
  sessions: {
    binding(sessionId: string): { ctx: unknown } | null | undefined
  }
  conversation: {
    input: {
      requestDraftInitialization(binding: { ctx: unknown }, init: { prompt: string, whenDraftExists: 'append' }): string
      for(ctx: unknown): { focus?(): void }
    }
  }
}

/**
 * 把绝对路径变成草稿里的 `@路径` 引用；含空白或引号时用 JSON 串包一层。
 * @param path - 目标主机上的路径。
 * @returns 可插入草稿的引用文本。
 */
export function quoteRemoteFile(path: string): string {
  return /[\s"\\]/u.test(path) ? `@${JSON.stringify(path)}` : `@${path}`
}

/**
 * 云端文件选择对话框。
 * @param props - `ctx` 是主插件 client ctx。
 * @returns React 元素或 `null`。
 */
export function RemoteFilesDialog({ ctx }: { ctx: PathsHostContext }): React.ReactElement | null {
  const [sessionId, setSessionId] = React.useState<string | null>(null)
  const [listing, setListing] = React.useState<WorkspaceListing | null>(null)
  const [selected, setSelected] = React.useState<string[]>([])
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const binding = React.useRef<{ ctx: unknown } | null>(null)
  const request = React.useRef<AbortController | null>(null)
  const context = React.useRef<CloudPathContext | null>(null)

  const load = async (path: string, id: string | null = sessionId): Promise<void> => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError('')
    try {
      const value = await pathRpc<WorkspaceListing>(context.current, 'workspaceFiles/list', { workspaceFileScopeId: id, path: path || '.' }, controller.signal)
      if (!controller.signal.aborted) setListing(value)
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  const close = (): void => {
    request.current?.abort()
    setSessionId(null)
  }

  React.useEffect(() => {
    const open = (event: Event): void => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail
      const id = detail?.sessionId
      if (typeof id !== 'string') return
      const retained = ctx.sessions.binding(id)
      const target = cloudPathContext()
      if (!retained || !target) return
      binding.current = retained
      context.current = target
      setSessionId(id)
      setListing(null)
      setSelected([])
      setError('')
      void load('', id)
    }
    globalThis.addEventListener(OPEN_REMOTE_FILES, open)
    return () => {
      globalThis.removeEventListener(OPEN_REMOTE_FILES, open)
      request.current?.abort()
    }
  }, [ctx])

  if (!sessionId) return null

  const button = (text: string, onClick: () => void, disabled = false, extra: Record<string, unknown> = {}): React.ReactElement =>
    h('button', { type: 'button', className: 'rhp-button', onClick, disabled, ...extra }, text)

  const add = (): void => {
    const current = binding.current
    if (current === null || ctx.sessions.binding(sessionId) !== current || cloudPathContext()?.origin !== context.current?.origin) {
      setError('会话或云端连接已变化，请关闭后重新选择。 / Session or target changed; reopen the picker.')
      return
    }
    const result = ctx.conversation.input.requestDraftInitialization(current, {
      prompt: selected.map(quoteRemoteFile).join(' '),
      whenDraftExists: 'append',
    })
    if (result !== 'applied') {
      setError('当前草稿正在提交，请稍后再添加。 / Draft is busy; try again.')
      return
    }
    close()
    ctx.conversation.input.for(current.ctx).focus?.()
  }

  const entries: PathEntry[] = listing?.entries ?? []
  const listPath = listing?.path ?? ''
  return h('div', { className: 'rhp-mask' }, h('section', {
    className: 'rhp-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': '选择云端文件', 'data-testid': 'remote-files-dialog',
  },
  h('h2', null, '选择云端文件'),
  h('p', { className: 'rhp-hint' }, `目标主机：${context.current?.origin ?? ''}`),
  h('p', null, '从当前会话的云端工作区选择文件，添加到消息中供 AI 读取。'),
  h('div', { className: 'rhp-row' },
    button('工作区根目录', () => void load(''), busy),
    listing?.path ? button('上一级', () => void load(listing.path.split('/').slice(0, -1).join('/')), busy) : null),
  h('p', { className: 'rhp-path' }, listPath || '/'),
  error ? h('p', { role: 'alert', className: 'rhp-error' }, error) : null,
  busy ? h('p', { role: 'status' }, '正在读取云端文件…') : null,
  h('div', { className: 'rhp-list' }, entries.map(entry => {
    const fullPath = [listPath, entry.name].filter(Boolean).join('/')
    if (entry.type === 'directory') {
      return h('div', { key: fullPath }, button(`▸ ${entry.name}`, () => void load(fullPath), busy, { 'data-remote-directory': entry.name }))
    }
    if (entry.type !== 'file') return null
    return h('label', { key: fullPath, className: 'rhp-file-row' },
      h('input', {
        type: 'checkbox',
        checked: selected.includes(fullPath),
        disabled: busy,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
          const checked = event.currentTarget.checked
          setSelected(previous => checked ? [...previous, fullPath] : previous.filter(item => item !== fullPath))
        },
      }),
      h('span', null, entry.name))
  }), entries.length === 0 ? h('p', null, '此目录为空') : null),
  listing?.truncated ? h('p', { className: 'rhp-hint' }, '目录列表已截断，请进入子目录选择。') : null,
  h('footer', { className: 'rhp-footer' },
    button('取消', close),
    button(`添加到消息${selected.length ? `（${selected.length}）` : ''}`, add, busy || !selected.length, { className: 'rhp-button rhp-primary', 'data-testid': 'remote-files-add' }))))
}

export type { PathsHostContext }
