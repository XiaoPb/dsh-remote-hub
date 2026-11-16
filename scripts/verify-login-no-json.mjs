import { WebSocket } from 'ws'

const [, , target, guardOrigin] = process.argv
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

await send('Page.navigate', { url: `${guardOrigin}/remote-web/login` })
await new Promise(resolve => setTimeout(resolve, 3500))

// 填错误口令并提交，确认**页面还在**、错误显示在表单里（而不是跳到 JSON）。
const result = await evaluate(`
(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const user = document.querySelector('[data-testid=web-login-username]')
  const pass = document.querySelector('[data-testid=web-login-password]')
  const submit = document.querySelector('[data-testid=web-login-submit]')
  if (user === null || pass === null || submit === null) return { error: 'form missing' }
  const urlBefore = location.href
  user.value = 'admin'
  pass.value = 'definitely-wrong-password'
  submit.click()
  await wait(2500)
  const errorBox = document.querySelector('[data-testid=web-login-error]')
  return {
    urlBefore,
    urlAfter: location.href,
    stayedOnPage: location.href === urlBefore,
    stillHasForm: document.querySelector('[data-testid=web-login-username]') !== null,
    errorText: errorBox === null ? null : (errorBox.textContent || '').trim(),
    errorHidden: errorBox === null ? null : errorBox.hidden,
    bodyLooksJson: /^\s*\{\s*"/.test((document.body.innerText || '').trim()),
    bodyHead: (document.body.innerText || '').trim().slice(0, 80),
  }
})()`)

console.log(JSON.stringify(result, null, 2))
socket.close()
