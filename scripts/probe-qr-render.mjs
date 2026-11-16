import { writeFileSync } from 'node:fs'
import { WebSocket } from 'ws'

const [, , target, outPath] = process.argv
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

// 在真实页面里就地渲染一个 TOTP 二维码（复用插件的 QrCode 与同一段 otpauth 链接），
// 量出实际尺寸与每模块像素，再截图确认观感。
const info = await evaluate(`
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const existing = document.getElementById('rh-qr-probe')
  if (existing !== null) existing.remove()

  const host = document.createElement('div')
  host.id = 'rh-qr-probe'
  Object.assign(host.style, {
    position: 'fixed', zIndex: '99999', left: '24px', top: '24px',
    padding: '16px', background: '#fff', borderRadius: '12px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.24)', fontFamily: 'system-ui',
  })
  host.innerHTML = '<div style="font:12px system-ui;margin-bottom:8px;color:#555">TOTP 二维码实测</div>'
  document.body.appendChild(host)

  // 等插件的模块表就绪后取它自己的 QrCode 与 encodeQr。
  const loader = globalThis.__ModuleLoader__
  const factory = loader && loader.require
  let QrCode = null
  try {
    const mod = factory === undefined ? null : await factory('@xiaopb/dsh-remote-hub/client')
    QrCode = mod && (mod.QrCode ?? mod.default?.QrCode)
  } catch (error) {
    QrCode = null
  }
  if (QrCode === undefined || QrCode === null) return { error: 'QrCode 组件不可达' }

  const uri = 'otpauth://totp/DeepSeek%20Harness%3Axiaopb'
    + '?secret=K6WFZPGB2ZUO3XNU4VKP36HH6RAVVD5H&issuer=DeepSeek+Harness&algorithm=SHA1&digits=6&period=30'
  const React = (await factory('react')).default ?? (await factory('react'))
  const root = document.createElement('div')
  host.appendChild(root)
  React.createRoot?.(root)?.render(React.createElement(QrCode, { text: uri, label: 'probe' }))
    ?? null
  await sleep(600)

  const svg = host.querySelector('svg')
  if (svg === null) return { error: '未渲染出 svg' }
  const rect = svg.getBoundingClientRect()
  const vb = svg.getAttribute('viewBox').split(' ').map(Number)
  const modules = vb[2] - 4
  return {
    width: Math.round(rect.width),
    modules,
    pxPerModule: +(rect.width / modules).toFixed(2),
    shapeRendering: getComputedStyle(svg).shapeRendering,
  }
})()`)

console.log(JSON.stringify(info, null, 2))
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(outPath, Buffer.from(shot.data, 'base64'))
console.log('shot:', outPath)
socket.close()
