/**
 * 给守卫托管的浏览器页面截图（方案 A 的实机证据）。
 *
 * @module scripts/shot-guard-page
 */
import { writeFileSync } from 'node:fs'
import { WebSocket } from 'ws'

const [, , target, outPath, guardOrigin = 'http://127.0.0.1:8850'] = process.argv
const PORT = Number(process.env.CDP_PORT ?? 9222)

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find(item => item.id === target)
if (page === undefined) throw new Error(`target not found: ${target}`)
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
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

await send('Page.navigate', { url: `${guardOrigin}/` })
await sleep(9000)
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(outPath, Buffer.from(shot.data, 'base64'))
const state = await send('Runtime.evaluate', {
  expression: '({ url: location.href, text: document.body.innerText.slice(0, 160) })',
  returnByValue: true,
})
console.log(JSON.stringify({ outPath, state: state.result.value }, null, 2))
socket.close()
