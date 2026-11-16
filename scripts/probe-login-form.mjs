import { WebSocket } from 'ws'

const [, , target, guardOrigin] = process.argv
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find(item => item.id === target)
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.on('open', resolve); socket.on('error', reject) })
let id = 0
const pending = new Map()
const events = []
socket.on('message', data => {
  const message = JSON.parse(String(data))
  if (message.method !== undefined) { events.push(message); return }
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
  if (result.exceptionDetails !== undefined) return { error: JSON.stringify(result.exceptionDetails).slice(0, 500) }
  return result.result.value
}

await send('Runtime.enable')
await send('Log.enable')
await send('Page.navigate', { url: `${guardOrigin}/remote-web/login` })
await new Promise(resolve => setTimeout(resolve, 4000))

const state = await evaluate(`(() => {
  const form = document.querySelector('form[data-step=login]')
  return {
    url: location.href,
    hasForm: form !== null,
    formAction: form === null ? null : form.getAttribute('action'),
    hasSubmitHandler: typeof HTMLFormElement.prototype.requestSubmit === 'function',
    scriptCount: document.scripts.length,
    inlineScriptExecuted: typeof window.__RH_LOGIN_READY__ !== 'undefined',
    submitBtn: document.querySelector('[data-testid=web-login-submit]') !== null,
  }
})()`)

const messages = []
for (const event of events) {
  if (event.method === 'Runtime.exceptionThrown') {
    messages.push(`EXC ${String(event.params.exceptionDetails.text).slice(0, 200)}`)
  }
  if (event.method === 'Runtime.consoleAPICalled') {
    messages.push(`[${event.params.type}] ${event.params.args.map(a => String(a.value ?? a.description ?? '')).join(' ').slice(0, 200)}`)
  }
  if (event.method === 'Log.entryAdded') {
    messages.push(`[log:${event.params.entry.level}] ${String(event.params.entry.text).slice(0, 200)}`)
  }
}

// 用错误口令提交一次，观察是 fetch 还是原生表单提交。
const submitted = await evaluate(`
(async () => {
  const form = document.querySelector('form[data-step=login]')
  if (form === null) return { error: 'no form' }
  let prevented = null
  const probe = (event) => { prevented = event.defaultPrevented }
  form.addEventListener('submit', probe, { capture: false })
  document.querySelector('[data-testid=web-login-username]').value = 'probe-user'
  document.querySelector('[data-testid=web-login-password]').value = 'probe-pass'
  const before = location.href
  form.requestSubmit()
  await new Promise(r => setTimeout(r, 2500))
  form.removeEventListener('submit', probe, { capture: false })
  return {
    defaultPrevented: prevented,
    urlBefore: before,
    urlAfter: location.href,
    bodyLooksJson: /^\s*\{/.test((document.body.innerText || '').trim()),
    bodyHead: (document.body.innerText || '').slice(0, 120),
  }
})()`)

console.log(JSON.stringify({ state, submitted, messages: messages.slice(0, 10) }, null, 2))
socket.close()
