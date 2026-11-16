import { WebSocket } from 'ws'

const [, , target] = process.argv
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find(item => item.id === target)
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.on('open', resolve); socket.on('error', reject) })
let id = 0
const pending = new Map()
socket.on('message', data => {
  const message = JSON.parse(String(data))
  const entry = pending.get(message.id)
  if (entry === undefined) return
  pending.delete(message.id)
  if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)))
  else entry.resolve(message.result)
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const rpcId = ++id
  pending.set(rpcId, { resolve, reject })
  socket.send(JSON.stringify({ id: rpcId, method, params }))
})
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) return { error: JSON.stringify(result.exceptionDetails).slice(0, 400) }
  return result.result.value
}

const probe = `
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const cookieVisible = document.cookie.length
  // 1) 当前是否有会话（status 200 且 session 非空）
  const status = await (await fetch('/remote-auth/status')).json()
  const out = { hasSessionCookie: cookieVisible > 0, session: status.session ? status.session.username : null }

  // 2) 插槽占用
  const slotEl = document.querySelector('[data-slot="conversation.hero.workspace.directoryFlow"]')
  out.slotChildren = slotEl === null ? 'absent' : slotEl.children.length

  // 3) className 里是否有 browse 对话框痕迹
  out.dialogs = [...document.querySelectorAll('[role=dialog]')].map(d => d.getAttribute('aria-label'))
  return out
})()`

console.log(JSON.stringify({ before: await evaluate(probe) }, null, 2))

// 重新加载（Cookie 仍在），等 uiWorkspace 完成初始化后再看插槽。
await send('Page.reload', { ignoreCache: false })
await new Promise(r => setTimeout(r, 14_000))

const after = await evaluate(`(() => {
  const out = {}
  for (const name of ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow']) {
    const el = document.querySelector('[data-slot="' + name + '"]')
    out[name] = el === null ? 'absent' : el.children.length
  }
  out.dialogs = [...document.querySelectorAll('[role=dialog]')].map(d => d.getAttribute('aria-label'))
  out.bodyTail = document.body.innerText.slice(-90)
  return out
})()`)
console.log(JSON.stringify({ after }, null, 2))
socket.close()
