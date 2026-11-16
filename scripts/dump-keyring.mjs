/** 读 keyring 的 IndexedDB，看是否残留 binding。 */
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
  if (result.exceptionDetails !== undefined) return { error: JSON.stringify(result.exceptionDetails).slice(0, 300) }
  return result.result.value
}

const dump = await evaluate(`(async () => {
  const open = () => new Promise((resolve, reject) => {
    const request = indexedDB.open('dsh-remote-hub-auth')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const db = await open()
  const stores = [...db.objectStoreNames]
  const out = { stores, data: {} }
  for (const name of stores) {
    out.data[name] = await new Promise((resolve, reject) => {
      const tx = db.transaction(name, 'readonly')
      const request = tx.objectStore(name).getAll()
      request.onsuccess = () => resolve(request.result.map(row => JSON.stringify(row).slice(0, 160)))
      request.onerror = () => reject(request.error)
    })
  }
  db.close()
  return out
})()`)
console.log(JSON.stringify(dump, null, 2))
socket.close()
