/**
 * 本地插件管理直连传输层的单元测试。
 *
 * 覆盖 `03-tasks.md` 的 T2.1 / T2.2 验收：调用路径与形状、错误归一、abort 透传、
 * 事件订阅的 `since` 续传与断档 `reset`、退避重连与释放。
 *
 * @module test/local-plugin-manager-transport
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

import { val } from './_helpers.mjs'

/**
 * 把编译产物里的 `@core/...` 说明符改写成指向 `.build/client/core/src/` 的相对路径后加载。
 *
 * 产物本身由 tsdown 在打包时做别名替换；单测直接加载 `.build/client`，需要自己做同一个替换。
 * @param relativeFile - 相对 `.build/client/client/src/` 的模块路径。
 * @returns 模块命名空间。
 */
async function loadBuiltModule(relativeFile) {
  const source = readFileSync(new URL(`../.build/client/client/src/${relativeFile}`, import.meta.url), 'utf8')
  const directory = await mkdtemp(join(tmpdir(), 'lpm-transport-'))
  const coreDir = join(directory, 'core', 'src')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(coreDir, { recursive: true })
  for (const name of ['index', 'protocol', 'local-plugin-manager', 'roles', 'device', 'capabilities', 'capabilities-redlines', 'version-drift', 'redact', 'carrier-contract']) {
    try {
      const text = readFileSync(new URL(`../.build/client/core/src/${name}.js`, import.meta.url), 'utf8')
      await writeFile(join(coreDir, `${name}.js`), text, 'utf8')
    } catch {
      // 可选的 core 文件不存在时跳过。
    }
  }
  const target = join(directory, 'transport.mjs')
  const rewritten = source.replace(/from '@core\/([^']+)'/gu, (_match, rest) => `from './core/src/${rest}'`)
  await writeFile(target, rewritten, 'utf8')
  const mod = await import(pathToFileURL(target).href)
  await rm(directory, { recursive: true, force: true }).catch(() => {})
  return mod
}

const transportModule = await loadBuiltModule('local-plugin-manager/transport.js')
const LOCAL_PLUGIN_METHODS = val((await import('../lib/index.js')), 'LOCAL_PLUGIN_METHODS', [])

const Client = transportModule.LocalPluginManagerClient
const parseFrame = transportModule.parseFrame
const errorKindOf = transportModule.errorKindOf

/** 一个记录请求的 fetch 桩。 */
function recordingFetch(respond) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    return respond(url, init)
  }
  return { fetch: impl, calls }
}

/** 一个最小的假 WebSocket，可手动派发事件。 */
class FakeSocket {
  static instances = []
  constructor(url) {
    this.url = url
    this.listeners = new Map()
    this.readyState = 1
    this.OPEN = 1
    FakeSocket.instances.push(this)
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  dispatch(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  close() {
    this.readyState = 3
    this.dispatch('close', {})
  }

  send() {}
}

test('一元调用：路径、方法、body 与同源凭据', async () => {
  assert.equal(typeof Client, 'function', 'LocalPluginManagerClient must be loadable')
  const responder = recordingFetch(() => new Response(JSON.stringify([{ name: 'a' }]), { status: 200 }))
  const client = new Client({ fetch: responder.fetch, WebSocket: FakeSocket })
  const answer = await client.call('listBundles', [])
  assert.deepEqual(answer, { ok: true, value: [{ name: 'a' }] })
  assert.equal(responder.calls.length, 1)
  assert.equal(responder.calls[0].url, '/api/hub/local-plugin-manager/listBundles')
  assert.equal(responder.calls[0].init.method, 'POST')
  assert.equal(responder.calls[0].init.credentials, 'same-origin')
  assert.deepEqual(JSON.parse(responder.calls[0].init.body), { args: [] })
})

test('全部 15 个方法都能构造出对应路径', async () => {
  const responder = recordingFetch(() => new Response('null', { status: 200 }))
  const client = new Client({ fetch: responder.fetch, WebSocket: FakeSocket })
  for (const method of LOCAL_PLUGIN_METHODS) await client.call(method, [])
  const paths = responder.calls.map(call => call.url)
  assert.equal(paths.length, LOCAL_PLUGIN_METHODS.length)
  for (const method of LOCAL_PLUGIN_METHODS) {
    assert.ok(paths.includes(`/api/hub/local-plugin-manager/${method}`), `missing ${method}`)
  }
})

test('HTTP 错误体归一为 ok:false / error', async () => {
  const responder = recordingFetch(() => new Response(
    JSON.stringify({ code: 'plugin-manager/unknown-bundle', message: 'nope', details: { name: 'x' } }),
    { status: 404 },
  ))
  const client = new Client({ fetch: responder.fetch, WebSocket: FakeSocket })
  const answer = await client.call('removeBundle', ['x'])
  assert.equal(answer.ok, false)
  assert.equal(answer.error.code, 'plugin-manager/unknown-bundle')
  assert.deepEqual(answer.error.details, { name: 'x' })
})

test('非 JSON 的错误响应给出可读的兜底错误', async () => {
  const responder = recordingFetch(() => new Response('forbidden', { status: 403 }))
  const client = new Client({ fetch: responder.fetch, WebSocket: FakeSocket })
  const answer = await client.call('listPlugins', [])
  assert.equal(answer.ok, false)
  assert.equal(answer.error.code, 'local-plugin-manager/forbidden')
  assert.match(answer.error.message, /403/u)
})

test('网络异常不抛错，映射成 ok:false', async () => {
  const client = new Client({
    fetch: async () => { throw new TypeError('Failed to fetch') },
    WebSocket: FakeSocket,
  })
  const answer = await client.call('listBundles', [])
  assert.equal(answer.ok, false)
  assert.match(answer.error.message, /Failed to fetch/u)
})

test('abort 信号透传给 fetch', async () => {
  let seen
  const client = new Client({
    fetch: async (_url, init) => {
      seen = init.signal
      return new Response('null', { status: 200 })
    },
    WebSocket: FakeSocket,
  })
  const controller = new AbortController()
  await client.call('inspect', ['pkg@1'], controller.signal)
  assert.equal(seen, controller.signal)
})

test('事件订阅：hello/since 续传/reset/退避重连', async () => {
  FakeSocket.instances = []
  const client = new Client({ fetch: async () => new Response('null'), WebSocket: FakeSocket })
  const frames = []
  let resets = 0
  let opened = 0
  const subscription = client.subscribe({
    onFrame: frame => frames.push(frame),
    onReset: () => { resets += 1 },
    onOpen: seq => { opened = seq },
  })
  const first = FakeSocket.instances.at(-1)
  assert.ok(first.url.startsWith('/') || first.url.startsWith('ws'), 'socket url must be absolute or rooted')
  assert.match(first.url, /\/api\/hub\/local-plugin-manager\/events$/u)
  first.dispatch('message', { data: JSON.stringify({ type: 'hello', seq: 7 }) })
  assert.equal(opened, 7)
  first.dispatch('message', { data: JSON.stringify({ type: 'changed', seq: 8, change: { reason: 'bundle' } }) })
  assert.equal(frames.length, 1)
  assert.equal(subscription.watermark(), 8)
  first.dispatch('message', { data: JSON.stringify({ type: 'reset', seq: 9 }) })
  assert.equal(resets, 1)
  // 断线后重连会带上 since=水位。
  first.close()
  await new Promise(resolve => setTimeout(resolve, 260))
  const second = FakeSocket.instances.at(-1)
  assert.notEqual(second, first, 'a reconnect must open a new socket')
  assert.match(second.url, /since=9/u)
  subscription.dispose()
  client.dispose()
})

test('畸形帧被忽略，分类函数稳定', () => {
  assert.equal(typeof parseFrame, 'function')
  assert.equal(parseFrame('not json'), null)
  assert.equal(parseFrame('{"type":"hello"}'), null)
  assert.deepEqual(parseFrame('{"type":"hello","seq":1}'), { type: 'hello', seq: 1 })
  assert.equal(errorKindOf(200), 'ok')
  assert.equal(errorKindOf(0), 'network-unreachable')
  assert.equal(errorKindOf(403), 'http-403')
  assert.equal(errorKindOf(500), 'http-5xx')
})

test('detailFileUrl 构造本机图片路由', () => {
  const client = new Client({ fetch: async () => new Response('null'), WebSocket: FakeSocket })
  const url = client.detailFileUrl({ bundle: 'a', document: 'README.md', path: 'img/x.png', sources: ['npmmirror'] })
  assert.equal(
    url,
    '/api/hub/local-plugin-manager/detail-file?bundle=a&document=README.md&path=img%2Fx.png&sources=npmmirror',
  )
})

