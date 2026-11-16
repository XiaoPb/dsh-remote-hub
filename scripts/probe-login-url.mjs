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
  if (result.exceptionDetails !== undefined) return { error: JSON.stringify(result.exceptionDetails).slice(0, 300) }
  return result.result.value
}

const info = await evaluate(`(() => {
  const html = document.body.innerHTML
  const urls = html.match(/https?:\\/\\/[^"'<>\\s]{10,200}/g)
  // 也找 data-* 属性里可能藏着的地址
  const attrs = []
  for (const el of document.querySelectorAll('*')) {
    for (const attr of el.attributes ?? []) {
      if (/url|href|link|src/i.test(attr.name) && /30(80|81)/.test(attr.value)) {
        attrs.push(attr.name + '=' + attr.value.slice(0, 120))
      }
    }
  }
  return {
    urls: urls === null ? [] : [...new Set(urls)].slice(0, 8),
    attrs: attrs.slice(0, 8),
    waiting: document.body.innerText.includes('等待登录'),
  }
})()`)

console.log(JSON.stringify(info, null, 2))
socket.close()
