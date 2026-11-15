/**
 * 量出四项事实在单行下的**实测宽度**（用于确定 `--rh-fact-min` 的下限）。
 *
 * 用法：`node scripts/measure-facts.mjs <target>`
 */
import { WebSocket } from 'ws'

const target = process.argv[2]
const PORT = Number(process.env.CDP_PORT ?? 9222)
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
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
  if (result.exceptionDetails !== undefined) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 300))
  return result.result.value
}

const measured = await evaluate(`(() => {
  const items = [...document.querySelectorAll('[data-testid=outbound-facts] .rh-fact-item')]
  if (items.length === 0) return { missing: true }
  return items.map(item => {
    const key = item.querySelector('.rh-fact-key')
    const value = item.querySelector('.rh-fact-value')
    // 用 Range 量出「不换行时」的真实文本宽度。
    const textWidth = (node) => {
      const range = document.createRange()
      range.selectNodeContents(node)
      return Math.ceil(range.getBoundingClientRect().width)
    }
    return {
      key: key ? key.textContent : null,
      value: value ? value.textContent : null,
      keyWidth: key ? textWidth(key) : 0,
      valueWidth: value ? textWidth(value) : 0,
      needs: Math.max(key ? textWidth(key) : 0, value ? textWidth(value) : 0),
    }
  })
})()`)
socket.close()
console.log(JSON.stringify(measured, null, 2))
