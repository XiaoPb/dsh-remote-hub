/**
 * 云端路径 UI（原 `@xiaopb/dsh-remote-paths` 伴生包，0.3.0 起**内置**到本插件）。
 *
 * 为什么不再单独发布：它是 Remote Hub 接管能力的一部分，独立成包会让用户多装一次、
 * 版本还要与主包严格同步，且空宿主入口 `apply(){}` 没有任何意义。
 * 现在同一个 npm 包通过 `cordis.patch.yml` 插入两条 roster（见 `remote-hub` 与
 * `remote-paths`），与 dsh-hardssh 的 bundle patch 做法一致。
 *
 * 它仍然是**按需生效**的：`cloudPathContext()` 为 null（本机模式 / 未接管）时
 * 一个插槽都不注册，本机原生目录选择与 dsh-hardssh 两条流程保持原样。
 *
 * @module dsh-remote-hub/client/paths
 */
import React from 'react'

import { REMOTE_PERMISSION_DENIED_EVENT, type PermissionDeniedNotice } from '../permission-notice.js'
import { cloudPathContext, pathRpc, type DirectoryListing } from './context.js'
import { OPEN_REMOTE_FILES, RemoteFilesDialog } from './files.js'
import { installPathStyles } from './styles.js'

const h = React.createElement

/** 主插件 client ctx 的最小面（只声明本模块用到的服务）。 */
export interface PathsContext {
  slots: {
    /** cordis 槽位接口：回调可以直接返回销毁器，也可以返回 generator 逐个 yield。 */
    inject(name: string, callback: () => (() => void) | Generator<() => void, void, unknown> | void): (() => void) | void
    register(options: { name: string, id?: string, priority?: number }, component: unknown): () => void
  }
  commandUi: {
    register(command: {
      name: string
      label: () => string
      description: () => string
      available: (session: { sessionId: string }) => boolean
      ui: { kind: 'action', run: (session: { sessionId: string }) => void }
    }): void
  }
  sessions: { binding(sessionId: string): { ctx: unknown } | null | undefined }
  conversation: {
    input: {
      requestDraftInitialization(binding: { ctx: unknown }, init: { prompt: string, whenDraftExists: 'append' }): string
      for(ctx: unknown): { focus?(): void }
    }
  }
}

/** 语言判定：优先 `<html lang>`，退回导航器语言。 */
function isChinese(): boolean {
  const lang = globalThis.document?.documentElement?.lang ?? globalThis.navigator?.language ?? 'zh'
  return !lang || lang.toLowerCase().startsWith('zh')
}

/** 权限不足时的提示层（复用主插件已广播的 `remote-access/denied` 事件）。 */
function RemotePermissionNotice(): React.ReactElement | null {
  const [notice, setNotice] = React.useState<PermissionDeniedNotice | null>(null)
  React.useEffect(() => {
    const onDenied = (event: Event): void => setNotice((event as CustomEvent<PermissionDeniedNotice>).detail)
    globalThis.addEventListener?.(REMOTE_PERMISSION_DENIED_EVENT, onDenied)
    return () => globalThis.removeEventListener?.(REMOTE_PERMISSION_DENIED_EVENT, onDenied)
  }, [])
  if (!notice) return null
  return h('div', { className: 'rhp-mask', style: { zIndex: 11000 } },
    h('section', { role: 'alertdialog', 'aria-modal': true, 'aria-labelledby': 'remote-permission-title', className: 'rhp-dialog', style: { maxWidth: 520 } },
      h('h2', { id: 'remote-permission-title' }, notice.title),
      h('p', null, notice.message),
      h('p', null, `${notice.code}: ${notice.endpoint}`),
      h('footer', { className: 'rhp-footer' },
        h('button', { type: 'button', className: 'rhp-button rhp-primary', 'data-testid': 'remote-permission-close', onClick: () => setNotice(null) }, '关闭 / Close'))))
}

/** 云端目录选择流程（接管会话/工作区目录选择时使用）。 */
function RemoteDirectoryFlow(props: { open: boolean, onCancel(): void, onPicked(path: string): void }): React.ReactElement | null {
  const [listing, setListing] = React.useState<DirectoryListing | null>(null)
  const [path, setPath] = React.useState('')
  const [name, setName] = React.useState('')
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [hidden, setHidden] = React.useState(false)
  const request = React.useRef<AbortController | null>(null)
  const context = React.useMemo(() => cloudPathContext(), [])

  const cancelPending = (): void => {
    request.current?.abort()
    request.current = null
  }

  const load = React.useCallback(async (target: string): Promise<void> => {
    cancelPending()
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError('')
    try {
      const value = await pathRpc<DirectoryListing>(context, 'directoryPicker/list', target ? { path: target } : {}, controller.signal)
      if (!controller.signal.aborted) {
        setListing(value)
        setPath(value.path)
      }
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }, [context])

  React.useEffect(() => {
    if (props.open && context) void load('')
    return cancelPending
  }, [props.open, context, load])

  if (!props.open || !context) return null

  const close = (): void => {
    cancelPending()
    props.onCancel()
  }

  const create = async (): Promise<void> => {
    if (!listing || !name.trim() || busy) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError('')
    try {
      const created = await pathRpc<string>(context, 'directoryPicker/createDirectory', { path: listing.path, name: name.trim() }, controller.signal)
      if (!controller.signal.aborted) {
        setName('')
        await load(created)
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : String(reason))
        setBusy(false)
      }
    }
  }

  const button = (label: React.ReactNode, onClick: () => void, disabled = false, extra: Record<string, unknown> = {}): React.ReactElement =>
    h('button', { type: 'button', onClick, disabled, className: 'rhp-button', ...extra }, label)

  const entries = listing?.entries ?? []
  return h('div', { className: 'rhp-mask' },
    h('section', { role: 'dialog', 'aria-modal': true, 'aria-label': '云端文件夹', 'data-testid': 'remote-paths-dialog', className: 'rhp-dialog' },
      h('h2', null, '选择云端文件夹'),
      h('p', null, `目标主机：${context.origin}`),
      h('p', null, '这里浏览和新建的是云端主机的目录。'),
      h('form', { onSubmit: (event: React.FormEvent) => { event.preventDefault(); void load(path) }, className: 'rhp-row' },
        h('input', { 'aria-label': '云端绝对路径', value: path, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setPath(event.currentTarget.value), className: 'rhp-input rhp-path' }),
        button('前往', () => void load(path), busy)),
      listing ? h('nav', { 'aria-label': '目录层级', className: 'rhp-crumbs' }, listing.crumbs.map(crumb => button(crumb.name, () => void load(crumb.path), busy, { key: crumb.path }))) : null,
      h('label', { className: 'rhp-toggle' }, h('input', { type: 'checkbox', checked: hidden, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setHidden(event.currentTarget.checked) }), '显示隐藏目录'),
      error ? h('p', { role: 'alert', className: 'rhp-error' }, error) : null,
      busy ? h('p', { role: 'status' }, '正在读取目标主机…') : null,
      h('div', { className: 'rhp-list' },
        entries.filter(entry => hidden || !entry.hidden).map(entry => h('div', { key: entry.path },
          button(h(React.Fragment, null, h('svg', { className: 'rhp-directory-icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true }, h('path', { d: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z' })), entry.name), () => void load(entry.path), busy, { 'data-remote-directory': entry.name }))),
        entries.length === 0 ? h('p', null, '此目录下没有子文件夹') : null),
      listing?.truncated ? h('p', { role: 'status' }, '目录过多，列表已截断；可以输入完整路径前往。') : null,
      h('div', { className: 'rhp-row' },
        h('input', { className: 'rhp-input', 'aria-label': '新文件夹名称', placeholder: '新文件夹名称', value: name, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setName(event.currentTarget.value) }),
        button('新建文件夹', () => void create(), busy || !listing || !name.trim(), { 'data-testid': 'remote-paths-create' })),
      h('footer', { className: 'rhp-footer' },
        button('取消', close),
        button('选择此文件夹', () => { cancelPending(); if (listing) props.onPicked(listing.path) }, busy || !listing, { 'data-testid': 'remote-paths-select', className: 'rhp-button rhp-primary' }))))
}

/**
 * 注册云端路径 UI。
 *
 * @param ctx - 主插件 client ctx。
 */
export function apply(ctx: PathsContext): void {
  // 本机模式：一个插槽都不注册，原生目录选择与 dsh-hardssh 保持原样。
  if (!cloudPathContext()) return
  installPathStyles(globalThis.document)
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'remote-permission-notice', priority: -2,
  }, RemotePermissionNotice))
  ctx.commandUi.register({
    name: 'cloud-file',
    label: () => isChinese() ? '云端文件' : 'Cloud files',
    description: () => isChinese() ? '选择云端工作区文件并添加到消息' : 'Choose files from the remote workspace',
    available: session => cloudPathContext() !== null && ctx.sessions.binding(session.sessionId) !== null,
    ui: { kind: 'action', run: session => globalThis.dispatchEvent(new CustomEvent(OPEN_REMOTE_FILES, { detail: { sessionId: session.sessionId } })) },
  })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'remote-files-picker',
  }, () => h(RemoteFilesDialog, { ctx })))
  ctx.slots.inject('conversation.hero.workspace.directoryFlow', () => ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
    for (const name of ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow']) {
      yield ctx.slots.register({ name, priority: -2 }, RemoteDirectoryFlow)
    }
  }))
}

export { cloudPathContext, pathRpc, OPEN_REMOTE_FILES, RemoteFilesDialog, RemoteDirectoryFlow }
