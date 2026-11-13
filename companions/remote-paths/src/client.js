import React from 'react'
import { cloudPathContext, pathRpc } from './context.js'
import { installPathStyles } from './styles.js'
import { OPEN_REMOTE_FILES, RemoteFilesDialog } from './files.js'
const h = React.createElement
const PERMISSION_EVENT = 'dsh-remote-hub:permission-denied'
export const inject = ['slots', 'commandUi', 'sessions', 'conversation']

function RemotePermissionNotice() {
  const [notice, setNotice] = React.useState(null)
  React.useEffect(() => {
    const onDenied = event => setNotice(event.detail)
    globalThis.addEventListener?.(PERMISSION_EVENT, onDenied)
    return () => globalThis.removeEventListener?.(PERMISSION_EVENT, onDenied)
  }, [])
  if (!notice) return null
  return h('div', { className: 'rhp-mask', style: { zIndex: 11000 } },
    h('section', { role: 'alertdialog', 'aria-modal': true, 'aria-labelledby': 'remote-permission-title', className: 'rhp-dialog', style: { maxWidth: 520 } },
      h('h2', { id: 'remote-permission-title' }, notice.title),
      h('p', null, notice.message),
      h('p', null, `${notice.code}: ${notice.endpoint}`),
      h('footer', { className: 'rhp-footer' }, h('button', { type: 'button', className: 'rhp-button rhp-primary', 'data-testid': 'remote-permission-close', onClick: () => setNotice(null) }, '关闭 / Close'))))
}

function RemoteDirectoryFlow(props) {
  const [listing, setListing] = React.useState(null)
  const [path, setPath] = React.useState('')
  const [name, setName] = React.useState('')
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [hidden, setHidden] = React.useState(false)
  const request = React.useRef(null)
  const context = React.useMemo(() => cloudPathContext(), [])
  const cancelPending = () => { request.current?.abort(); request.current = null }
  const load = React.useCallback(async (target) => {
    cancelPending()
    const controller = new AbortController()
    request.current = controller
    setBusy(true); setError('')
    try {
      const value = await pathRpc(context, 'directoryPicker/list', target ? { path: target } : {}, controller.signal)
      if (!controller.signal.aborted) { setListing(value); setPath(value.path) }
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason.message)
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }, [context])
  React.useEffect(() => {
    if (props.open && context) void load()
    return cancelPending
  }, [props.open, context, load])
  if (!props.open || !context) return null
  const close = () => { cancelPending(); props.onCancel() }
  const create = async () => {
    if (!listing || !name.trim() || busy) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true); setError('')
    try {
      const created = await pathRpc(context, 'directoryPicker/createDirectory', { path: listing.path, name: name.trim() }, controller.signal)
      if (!controller.signal.aborted) { setName(''); await load(created) }
    } catch (reason) {
      if (!controller.signal.aborted) { setError(reason.message); setBusy(false) }
    }
  }
  const button = (label, onClick, disabled = false, extra = {}) => h('button', { type: 'button', onClick, disabled, className: 'rhp-button', ...extra }, label)
  return h('div', { className: 'rhp-mask' },
    h('section', { role: 'dialog', 'aria-modal': true, 'aria-label': '云端文件夹', 'data-testid': 'remote-paths-dialog', className: 'rhp-dialog' },
      h('h2', null, '选择云端文件夹'),
      h('p', null, `目标主机：${context.origin}`),
      h('p', null, '这里浏览和新建的是云端主机的目录。'),
      h('form', { onSubmit: event => { event.preventDefault(); void load(path) }, className: 'rhp-row' },
        h('input', { 'aria-label': '云端绝对路径', value: path, onChange: event => setPath(event.target.value), className: 'rhp-input rhp-path' }),
        button('前往', () => void load(path), busy)),
      listing ? h('nav', { 'aria-label': '目录层级', className: 'rhp-crumbs' }, listing.crumbs.map(crumb => button(crumb.name, () => void load(crumb.path), busy, { key: crumb.path }))) : null,
      h('label', { className: 'rhp-toggle' }, h('input', { type: 'checkbox', checked: hidden, onChange: event => setHidden(event.target.checked) }), '显示隐藏目录'),
      error ? h('p', { role: 'alert', className: 'rhp-error' }, error) : null,
      busy ? h('p', { role: 'status' }, '正在读取目标主机…') : null,
      h('div', { className: 'rhp-list' },
        listing?.entries.filter(entry => hidden || !entry.hidden).map(entry => h('div', { key: entry.path }, button(h(React.Fragment, null, h('svg', { className: 'rhp-directory-icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true }, h('path', { d: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z' })), entry.name), () => void load(entry.path), busy, { 'data-remote-directory': entry.name }))),
        listing?.entries.length === 0 ? h('p', null, '此目录下没有子文件夹') : null),
      listing?.truncated ? h('p', { role: 'status' }, '目录过多，列表已截断；可以输入完整路径前往。') : null,
      h('div', { className: 'rhp-row' }, h('input', { className: 'rhp-input', 'aria-label': '新文件夹名称', placeholder: '新文件夹名称', value: name, onChange: event => setName(event.target.value) }), button('新建文件夹', create, busy || !listing || !name.trim(), { 'data-testid': 'remote-paths-create' })),
      h('footer', { className: 'rhp-footer' },
        button('取消', close),
        button('选择此文件夹', () => { cancelPending(); props.onPicked(listing.path) }, busy || !listing, { 'data-testid': 'remote-paths-select', className: 'rhp-button rhp-primary' }))))
}




export function apply(ctx) {
  // Local mode: no slot registrations at all, preserving native and dsh-hardssh -1.
  if (!cloudPathContext()) return
  installPathStyles(globalThis.document)
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'remote-permission-notice', priority: -2,
  }, RemotePermissionNotice))
  ctx.commandUi.register({
    name: 'cloud-file',
    label: () => document.documentElement.lang.startsWith('en') ? 'Cloud files' : '云端文件',
    description: () => document.documentElement.lang.startsWith('en') ? 'Choose files from the remote workspace' : '选择云端工作区文件并添加到消息',
    available: session => !!cloudPathContext() && !!ctx.sessions.binding(session.sessionId),
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
