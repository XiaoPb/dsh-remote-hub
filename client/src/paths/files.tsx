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

/** 目标主机上的「目录根」伪会话 id：没有绑定会话时也能浏览目录。 */
const DIRECTORY_ROOT_SCOPE = ''

/**
 * 云端文件选择对话框。
 *
 * 两种入口：
 * - 绑定到会话：浏览该会话的工作区文件，可勾选并追加到草稿；
 * - **未绑定会话**（新建的空会话、绑定尚未就绪）：退化为浏览目标主机的目录，
 *   仍然可以查看/进入目录，只是没有可勾选的文件。这样入口永远不会「点了没反应」。
 *
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
  /** 本次打开是否解析到了会话绑定（false = 目录浏览模式）。 */
  const [bound, setBound] = React.useState(true)

  const load = async (path: string, id: string | null = sessionId): Promise<void> => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError('')
    const scope = id === null || id === DIRECTORY_ROOT_SCOPE
    try {
      // 有会话绑定 → 读该会话的工作区；没有 → 退化为读目标主机目录（仍然可浏览/新建）。
      const value = scope
        ? await pathRpc<WorkspaceListing>(context.current, 'directoryPicker/list', { path: path || '' }, controller.signal)
        : await pathRpc<WorkspaceListing>(context.current, 'workspaceFiles/list', { workspaceFileScopeId: id, path: path || '.' }, controller.signal)
      if (!controller.signal.aborted) {
        setBound(!scope)
        setListing(value)
      }
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
      const target = cloudPathContext()
      if (!target) return
      // 绑定可能尚未就绪（新建的空会话、接管刚完成）：**不吞掉这次点击**，
      // 退化为目录浏览模式，用户至少能看到目标主机有哪些文件。
      const retained = typeof id === 'string' ? ctx.sessions.binding(id) ?? null : null
      binding.current = retained
      context.current = target
      setBound(retained !== null)
      setSessionId(typeof id === 'string' ? id : DIRECTORY_ROOT_SCOPE)
      setListing(null)
      setSelected([])
      setError('')
      void load('', retained === null ? DIRECTORY_ROOT_SCOPE : id)
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
  h('h2', null, bound ? '选择云端文件' : '浏览目标主机'),
  h('p', { className: 'rhp-hint' }, `目标主机：${context.current?.origin ?? ''}`),
  h('p', null, bound
    ? '从当前会话的云端工作区选择文件，添加到消息中供 AI 读取。'
    : '当前没有可绑定的会话，这里只做浏览。新建或打开一个云端会话后即可选择文件加入消息。'),
  h('div', { className: 'rhp-row' },
    button(bound ? '工作区根目录' : '主目录', () => void load('', bound ? null : DIRECTORY_ROOT_SCOPE), busy),
    listing?.path ? button('上一级', () => void load(listing.path.split('/').slice(0, -1).join('/'), bound ? null : DIRECTORY_ROOT_SCOPE), busy) : null),
  h('p', { className: 'rhp-path' }, listPath || '/'),
  error ? h('p', { role: 'alert', className: 'rhp-error' }, error) : null,
  busy ? h('p', { role: 'status' }, '正在读取云端文件…') : null,
  h('div', { className: 'rhp-list' }, entries.map(entry => {
    const fullPath = [listPath, entry.name].filter(Boolean).join('/')
    if (entry.type === 'directory') {
      return h('div', { key: fullPath }, button(`▸ ${entry.name}`, () => void load(fullPath, bound ? null : DIRECTORY_ROOT_SCOPE), busy, { 'data-remote-directory': entry.name }))
    }
    if (entry.type !== 'file') return null
    return h('label', { key: fullPath, className: 'rhp-file-row' },
      h('input', {
        type: 'checkbox',
        checked: selected.includes(fullPath),
        // 未绑定会话时不能把路径追加进草稿（不知道是哪个工作区），只允许浏览。
        disabled: busy || !bound,
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
    button(`添加到消息${selected.length ? `（${selected.length}）` : ''}`, add, busy || !selected.length || !bound, { className: 'rhp-button rhp-primary', 'data-testid': 'remote-files-add' }))))
}

export type { PathsHostContext }
