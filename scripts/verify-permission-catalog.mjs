import { WebSocket } from 'ws'

const [, , target, guardOrigin = 'http://127.0.0.1:8850'] = process.argv
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

await send('Page.navigate', { url: `${guardOrigin}/` })
await sleep(10_000)

// 1) 直接测 WS 升级：未带 Cookie 与带 Cookie 两种。
const upgrade = await evaluate(`
(async () => {
  const test = (withCookie) => new Promise((resolve) => {
    const ws = new WebSocket(location.origin.replace('http', 'ws') + '/api/remote.mux')
    const done = (state) => { try { ws.close() } catch {} resolve(state) }
    ws.onopen = () => done('open')
    ws.onerror = () => done('error')
    ws.onclose = (event) => done('close:' + event.code)
    setTimeout(() => done('timeout'), 4000)
  })
  return { result: await test(true) }
})()`)

// 2) 权限目录：开设置页看那句提示是否还在。
const permission = await evaluate(`
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const settings = [...document.querySelectorAll('button')].find(b => /设置|Settings/.test(b.getAttribute('aria-label') || ''))
  if (settings !== undefined) settings.click()
  await sleep(1500)
  const dialogs = [...document.querySelectorAll('[role=dialog]')]
  const text = dialogs.map(d => d.innerText).join('\\n')
  return {
    hasDialog: dialogs.length > 0,
    permissionUnavailable: /permission catalog has no active Host connection|权限.*不可用/.test(text),
    snippet: text.slice(0, 220),
  }
})()`)

console.log(JSON.stringify({ upgrade, permission }, null, 2))
socket.close()
