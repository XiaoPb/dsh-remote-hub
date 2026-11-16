/**
 * 把本地 SVG 文件渲染成 PNG（用已连上 CDP 的真实 Edge，避免额外依赖）。
 *
 * @module scripts/svg-to-png
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { WebSocket } from 'ws'

const [, , svgPath, pngPath, targetId] = process.argv
const svg = readFileSync(svgPath, 'utf8')

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find(item => item.id === targetId)
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

// 用一个 data: URL 全屏打开 SVG，截整页，再切回原来的页面。
const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
const previous = page.url

await send('Page.navigate', { url: dataUrl })
await new Promise(resolve => setTimeout(resolve, 1500))
const metrics = await send('Page.getLayoutMetrics')
const width = Math.ceil(metrics.cssContentSize.width) || 760
const height = Math.ceil(metrics.cssContentSize.height) || 340
const shot = await send('Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: true,
  clip: { x: 0, y: 0, width, height, scale: 1 },
})
writeFileSync(pngPath, Buffer.from(shot.data, 'base64'))

await send('Page.navigate', { url: previous })
console.log(JSON.stringify({ pngPath, width, height, restored: previous }, null, 2))
socket.close()
