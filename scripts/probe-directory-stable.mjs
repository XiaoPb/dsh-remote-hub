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

// 先等页面完全稳定（WS 已连、工作区列表已加载），再点。
const probe = `
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  // 等“正在加载工作区”消失
  for (let i = 0; i < 40; i++) {
    if (!document.body.innerText.includes('正在加载')) break
    await sleep(300)
  }
  const before = document.body.innerText.slice(0, 120)
  const button = [...document.querySelectorAll('button')].find(b => /选择工作区|添加工作区/.test(b.innerText || ''))
  if (button === undefined) return { noButton: true, before }
  button.click()
  for (let i = 0; i < 20; i++) {
    await sleep(300)
    const dialogs = [...document.querySelectorAll('[role=dialog]')]
    for (const dialog of dialogs) {
      const text = dialog.innerText || ''
      if (/目录|文件夹/.test(text)) {
        return { kind: 'directory', label: dialog.getAttribute('aria-label'), text: text.slice(0, 180), at: i * 300 }
      }
    }
  }
  const slot = document.querySelector('[data-slot="conversation.hero.workspace.directoryFlow"]')
  return {
    kind: 'none',
    slotChildren: slot === null ? 'absent' : slot.children.length,
    dialogs: [...document.querySelectorAll('[role=dialog]')].map(d => d.getAttribute('aria-label')),
  }
})()`

console.log(JSON.stringify(await evaluate(probe), null, 2))
socket.close()
