import React from 'react'
import { cloudPathContext, pathRpc } from './context.js'
const h = React.createElement
export const OPEN_REMOTE_FILES = 'dsh-remote-paths:open-files'
export function quoteRemoteFile(path) {
  return /[\s"\\]/u.test(path) ? `@${JSON.stringify(path)}` : `@${path}`
}
export function RemoteFilesDialog({ ctx }) {
  const [sessionId, setSessionId] = React.useState(null)
  const [listing, setListing] = React.useState(null)
  const [selected, setSelected] = React.useState([])
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const binding = React.useRef(null)
  const request = React.useRef(null)
  const context = React.useRef(null)
  const load = async (path, id = sessionId) => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setBusy(true); setError('')
    try {
      const value = await pathRpc(context.current, 'workspaceFiles/list', { workspaceFileScopeId: id, path: path || '.' }, controller.signal)
      if (!controller.signal.aborted) setListing(value)
    } catch (reason) { if (!controller.signal.aborted) setError(reason.message) }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  const close = () => { request.current?.abort(); setSessionId(null) }
  React.useEffect(() => {
    const open = event => {
      const id = event.detail.sessionId
      const retained = ctx.sessions.binding(id)
      const target = cloudPathContext()
      if (!retained || !target) return
      binding.current = retained; context.current = target
      setSessionId(id); setListing(null); setSelected([]); setError('')
      void load('', id)
    }
    globalThis.addEventListener(OPEN_REMOTE_FILES, open)
    return () => { globalThis.removeEventListener(OPEN_REMOTE_FILES, open); request.current?.abort() }
  }, [ctx])
  if (!sessionId) return null
  const button = (text, onClick, disabled = false, extra = {}) => h('button', { type:'button', className:'rhp-button', onClick, disabled, ...extra }, text)
  const add = () => {
    if (ctx.sessions.binding(sessionId) !== binding.current || cloudPathContext()?.origin !== context.current.origin) {
      setError('会话或云端连接已变化，请关闭后重新选择。 / Session or target changed; reopen the picker.'); return
    }
    const result = ctx.conversation.input.requestDraftInitialization(binding.current, {
      prompt: selected.map(quoteRemoteFile).join(' '), whenDraftExists:'append',
    })
    if (result !== 'applied') { setError('当前草稿正在提交，请稍后再添加。 / Draft is busy; try again.'); return }
    close()
    ctx.conversation.input.for(binding.current.ctx).focus()
  }
  return h('div', {className:'rhp-mask'}, h('section', {
    className:'rhp-dialog',role:'dialog','aria-modal':true,'aria-label':'选择云端文件','data-testid':'remote-files-dialog',
  },
    h('h2',null,'选择云端文件'),
    h('p',{className:'rhp-hint'},`目标主机：${context.current.origin}`),
    h('p',null,'从当前会话的云端工作区选择文件，添加到消息中供 AI 读取。'),
    h('div',{className:'rhp-row'},button('工作区根目录',()=>void load(''),busy),
      listing?.path ? button('上一级',()=>void load(listing.path.split('/').slice(0,-1).join('/')),busy):null),
    h('p',{className:'rhp-path'},listing?.path || '/'),
    error?h('p',{role:'alert',className:'rhp-error'},error):null,
    busy?h('p',{role:'status'},'正在读取云端文件…'):null,
    h('div',{className:'rhp-list'},listing?.entries.map(entry=>{
      const path = [listing.path,entry.name].filter(Boolean).join('/')
      if(entry.type==='directory') return h('div',{key:path},button(`▸ ${entry.name}`,()=>void load(path),busy,{'data-remote-directory':entry.name}))
      if(entry.type!=='file') return null
      return h('label',{key:path,className:'rhp-file-row'},h('input',{type:'checkbox',checked:selected.includes(path),disabled:busy,onChange:event=>setSelected(previous=>event.target.checked?[...previous,path]:previous.filter(item=>item!==path))}),h('span',null,entry.name))
    }),listing?.entries.length===0?h('p',null,'此目录为空'):null),
    listing?.truncated?h('p',{className:'rhp-hint'},'目录列表已截断，请进入子目录选择。'):null,
    h('footer',{className:'rhp-footer'},button('取消',close),button(`添加到消息${selected.length?`（${selected.length}）`:''}`,add,busy||!selected.length,{className:'rhp-button rhp-primary','data-testid':'remote-files-add'}))))
}
