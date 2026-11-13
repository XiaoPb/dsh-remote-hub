/**
 * M1：carrier 契约测试。
 *
 * 依据 `installConnection` 的官方源码，验证 `installCarrier()` 产出的
 * transport 满足六字段契约，且行为符合官方调用方式。
 *
 * 关键回归点（旧实现的 bug）：
 * 1. 官方 fetch 入参是 `'api/session/list'`（无前导斜杠）→ 必须补全；
 * 2. 必须提供 `createWebSocket` 与 `streamBaseUrl`，否则长连接连回本机；
 * 3. Response 必须**原样返回**（旧实现读 text() 破坏 multipart）；
 * 4. 桌面 shell 预置字段必须保留，退出时恢复。
 *
 * @module test/carrier-contract.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { registerAlias } from './panel-alias-loader.mjs'

await registerAlias()
const carrier = await import('../.build/client/client/src/carrier.js')

const CLOUD_MODE = {
  mode: 'cloud',
  origin: 'http://192.168.0.17:8443',
  token: 't'.repeat(43),
  deviceLabel: 'v4debian',
}

/** 构造一个可注入的全局对象。 */
function makeGlobal(initial = undefined) {
  return initial === undefined ? {} : { __DSH_TRANSPORT__: initial }
}

describe('transport 六字段契约', () => {
  it('cloud 模式：fetch / createWebSocket / streamBaseUrl / ownsHost 全部就位', () => {
    const result = carrier.createCarrier({
      readMode: () => CLOUD_MODE,
      globalObject: makeGlobal(),
    })
    assert.equal(result.active, true)
    const transport = result.transport
    assert.equal(typeof transport.fetch, 'function', 'fetch 必须存在')
    assert.equal(typeof transport.createWebSocket, 'function', 'createWebSocket 必须存在')
    assert.equal(transport.streamBaseUrl, 'http://192.168.0.17:8443', 'streamBaseUrl 必须是守卫 origin')
    assert.equal(transport.ownsHost, true, 'ownsHost 必须为 true')
  })

  it('local 模式：不产出 transport', () => {
    const result = carrier.createCarrier({
      readMode: () => ({ mode: 'local' }),
      globalObject: makeGlobal(),
    })
    assert.equal(result.active, false)
    assert.equal(result.transport, undefined)
  })
})

describe('fetch 改道契约', () => {
  it('官方入参是相对路径 api/xxx（无前导斜杠）也能正确改道', async () => {
    const seen = []
    const result = carrier.createCarrier({
      readMode: () => CLOUD_MODE,
      globalObject: makeGlobal(),
      fetchImpl: async (url, init) => {
        seen.push({ url: String(url), headers: init?.headers, method: init?.method })
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })
    // 官方 createWebConnectionRpc 的真实调用形式：
    await result.transport.fetch('api/session/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/list', payload: {} }),
    })
    assert.equal(seen[0].url, 'http://192.168.0.17:8443/remote/rpc', '必须改写到 /remote/rpc')
    assert.equal(seen[0].method, 'POST')
    assert.equal(seen[0].headers['x-hub-protocol'], '1', '必须带协议头')
    assert.match(seen[0].headers.authorization ?? seen[0].headers.Authorization ?? '', /^Bearer t+$/u)
  })

  it('非 /api 请求原样放行（静态资源、插件 bundle）', async () => {
    const seen = []
    const result = carrier.createCarrier({
      readMode: () => CLOUD_MODE,
      globalObject: makeGlobal(),
      fetchImpl: async (url) => {
        seen.push(String(url))
        return new Response('x', { status: 200 })
      },
    })
    await result.transport.fetch('/plugins/x/client.js', { method: 'GET' })
    assert.equal(seen[0], '/plugins/x/client.js', '非 api 必须原样透传')
  })

  it('Response 原样返回：body 未被消费（multipart 不丢失）', async () => {
    const payload = 'binary-attachment-bytes'
    const result = carrier.createCarrier({
      readMode: () => CLOUD_MODE,
      globalObject: makeGlobal(),
      fetchImpl: async () => new Response(payload, {
        status: 200,
        headers: { 'content-type': 'multipart/form-data; boundary=x' },
      }),
    })
    const response = await result.transport.fetch('api/session/list', { method: 'POST' })
    assert.equal(response.headers.get('content-type'), 'multipart/form-data; boundary=x')
    // 关键：body 必须还能读（旧实现读 text() 后这里会失败或丢附件）。
    assert.equal(await response.text(), payload)
  })

  it('401 → 触发降级（先落盘 local，再 reload）', async () => {
    // 设计 v0.3 §8：启动时磁盘优先，所以必须**先**把 local 写进磁盘再重载，
    // 否则重载后又从磁盘读到 cloud，连回同一个失效目标（401 循环）。
    const order = []
    const result = carrier.createCarrier({
      readMode: () => CLOUD_MODE,
      globalObject: makeGlobal(),
      fetchImpl: async () => new Response('unauthorized', { status: 401 }),
      fallbackMode: () => { order.push('localStorage') },
      persistLocal: async () => { order.push('disk') },
      reload: () => { order.push('reload') },
    })
    await result.transport.fetch('api/session/list', { method: 'POST' })
    // 落盘是异步的：等 fallback 链跑完再断言。
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(order, ['localStorage', 'disk', 'reload'], '必须先写回 local、再落盘、最后重载')
  })

  it('降级只触发一次（不进入重连死循环）', async () => {
    let count = 0
    const result = carrier.createCarrier({
      readMode: () => CLOUD_MODE,
      globalObject: makeGlobal(),
      fetchImpl: async () => new Response('unauthorized', { status: 401 }),
      fallbackMode: () => { count += 1 },
      reload: () => {},
    })
    await result.transport.fetch('api/a', { method: 'POST' })
    await result.transport.fetch('api/b', { method: 'POST' })
    assert.equal(count, 1, '降级必须幂等')
  })
})

describe('WebSocket 接管契约', () => {
  it('把 /api/remote.mux 改写到守卫 /remote/ws 并附加令牌', () => {
    const created = []
    const result = carrier.createCarrier({
      readMode: () => CLOUD_MODE,
      globalObject: makeGlobal(),
      webSocketImpl: (url) => { created.push(url); return { close() {} } },
    })
    // 官方 openConnectionWebSocket 的产物：
    result.transport.createWebSocket('http://192.168.0.17:8443/api/remote.mux')
    assert.equal(created.length, 1)
    const url = new URL(created[0])
    assert.equal(url.protocol, 'ws:', 'http → ws')
    assert.equal(url.pathname, '/remote/ws', '必须指向守卫 WS 入口')
    assert.equal(url.searchParams.get('token'), CLOUD_MODE.token, '必须带令牌')
    assert.equal(url.searchParams.get('ws-target'), '/api/remote.mux', '必须记录转发目标')
  })

  it('https → wss', () => {
    const created = []
    const result = carrier.createCarrier({
      readMode: () => ({ ...CLOUD_MODE, origin: 'https://guard.example:8443' }),
      globalObject: makeGlobal(),
      webSocketImpl: (url) => { created.push(url); return { close() {} } },
    })
    result.transport.createWebSocket('https://guard.example:8443/api/remote.mux')
    assert.equal(new URL(created[0]).protocol, 'wss:')
  })

  it('streamBaseUrl 与 createWebSocket 同源（避免 RPC/WS 撕裂）', () => {
    const created = []
    const result = carrier.createCarrier({
      readMode: () => CLOUD_MODE,
      globalObject: makeGlobal(),
      webSocketImpl: (url) => { created.push(url); return { close() {} } },
    })
    const base = new URL(result.transport.streamBaseUrl)
    // 模拟官方：new URL('/api/remote.mux'.slice(1), streamBaseUrl)
    const officialUrl = new URL('/api/remote.mux'.slice(1), result.transport.streamBaseUrl).href
    result.transport.createWebSocket(officialUrl)
    assert.equal(new URL(created[0]).host, base.host, 'WS 必须打到同一个 host')
  })

  it('回归：默认**不得**提供 openStream（否则官方不启动 WS mux）', () => {
    // 官方 ClientRemoteService 的逻辑：
    //   if (connection.rpc.open === void 0) this.streams.start()
    // 即 rpc.open 存在时官方**不**启动 Remote mux。浏览器场景必须走 mux，
    // 所以整机接管绝不能提供 openStream，否则长连接能力被自己关掉。
    const result = carrier.createCarrier({
      readMode: () => CLOUD_MODE,
      globalObject: makeGlobal(),
      webSocketImpl: () => ({ close() {} }),
    })
    assert.equal(result.transport.openStream, undefined, '默认不得提供 openStream')
  })
})

describe('安装 / 快照 / 恢复', () => {
  it('保留桌面 shell 预置字段（ownsHost 覆盖为 true）', () => {
    const shell = { ownsHost: true, streamBaseUrl: 'http://127.0.0.1:13355' }
    const globalObject = makeGlobal(shell)
    const result = carrier.installCarrier({
      readMode: () => CLOUD_MODE,
      globalObject,
    })
    assert.equal(result.active, true)
    const merged = globalObject.__DSH_TRANSPORT__
    assert.equal(merged.streamBaseUrl, 'http://192.168.0.17:8443', 'streamBaseUrl 必须被改写指向守卫')
    assert.equal(typeof merged.fetch, 'function')
    assert.equal(typeof merged.createWebSocket, 'function')
  })

  it('快照保存 shell 原值，uninstall 后精确恢复', () => {
    const shell = { ownsHost: true, streamBaseUrl: 'http://127.0.0.1:13355' }
    const globalObject = makeGlobal({ ...shell })
    const result = carrier.installCarrier({
      readMode: () => CLOUD_MODE,
      globalObject,
    })
    assert.deepEqual(result.snapshot, shell)
    result.uninstall()
    assert.deepEqual(globalObject.__DSH_TRANSPORT__, shell, 'uninstall 必须精确恢复快照')
  })

  it('幂等：重复 install 返回同一结果', () => {
    const globalObject = makeGlobal()
    const a = carrier.installCarrier({ readMode: () => CLOUD_MODE, globalObject })
    const b = carrier.installCarrier({ readMode: () => CLOUD_MODE, globalObject })
    assert.equal(a, b, '必须返回同一安装结果')
  })

  it('回归：local 模式不占用幂等位，后续切 cloud 仍能安装', () => {
    const globalObject = makeGlobal()
    // 首次：local
    const first = carrier.installCarrier({ readMode: () => ({ mode: 'local' }), globalObject })
    assert.equal(first.active, false)
    assert.equal(globalObject.__DSH_TRANSPORT__, undefined)

    // 用户点击「连接」后模式变 cloud，再次 install 必须真正生效
    const second = carrier.installCarrier({ readMode: () => CLOUD_MODE, globalObject })
    assert.equal(second.active, true, 'local 之后切 cloud 必须能安装')
    assert.equal(typeof globalObject.__DSH_TRANSPORT__?.fetch, 'function')
    assert.equal(globalObject.__DSH_TRANSPORT__.streamBaseUrl, 'http://192.168.0.17:8443')
  })

  it('local 模式不写全局', () => {
    const globalObject = makeGlobal()
    carrier.installCarrier({ readMode: () => ({ mode: 'local' }), globalObject })
    assert.equal(globalObject.__DSH_TRANSPORT__, undefined, 'local 模式不得注入')
  })
})

describe('注入时机（boot 后）', () => {
  it('等待 __DSH_BOOT_READY__.promise 后再写全局（避免被 shell 覆盖）', async () => {
    let resolveBoot
    const bootPromise = new Promise(resolve => { resolveBoot = resolve })
    const globalObject = { __DSH_BOOT_READY__: { promise: bootPromise } }

    const pending = carrier.installCarrierAfterBoot({ readMode: () => CLOUD_MODE, globalObject })
    // boot 未 resolve：全局还是空的
    assert.equal(globalObject.__DSH_TRANSPORT__, undefined, 'boot 前不得注入')

    // 模拟 shell 写入
    globalObject.__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl: 'http://127.0.0.1:13355' }
    resolveBoot()

    const result = await pending
    assert.equal(result.active, true)
    assert.equal(globalObject.__DSH_TRANSPORT__.streamBaseUrl, 'http://192.168.0.17:8443', 'boot 后必须覆盖为守卫')
  })

  it('无 boot 全局（纯 web）时同步安装', async () => {
    const globalObject = makeGlobal()
    const result = await carrier.installCarrierAfterBoot({ readMode: () => CLOUD_MODE, globalObject })
    assert.equal(result.active, true)
    assert.equal(typeof globalObject.__DSH_TRANSPORT__.fetch, 'function')
  })
})

describe('模式解析（同步优先 + 磁盘纠正）', () => {
  it('有同步来源时，缓存为空也能立即接管（不等异步查询）', async () => {
    // 新架构：同步来源（同步 XHR 问磁盘）让接管控在 connection 捕获 fetch 之前。
    const globalObject = makeGlobal()
    const result = await carrier.installCarrierResolvingMode({
      readMode: () => ({ mode: 'local' }),
      fetchModeSync: () => CLOUD_MODE,
      fetchMode: async () => CLOUD_MODE,
      globalObject,
    })
    assert.equal(result.active, true, '同步来源必须立即生效')
    assert.equal(globalObject.__DSH_TRANSPORT__.streamBaseUrl, 'http://192.168.0.17:8443')
  })

  it('只有异步来源时，本轮的注入在同步段完成（可能为 local），由异步段纠正', async () => {
    // 这是页面上真实发生的时序：connection 早于异步查询完成。
    // 正确行为是「本轮不接管，但把结果写回缓存并重载，让下一轮同步生效」。
    let reloaded = false
    const globalObject = makeGlobal()
    const result = await carrier.installCarrierResolvingMode({
      readMode: () => ({ mode: 'local' }),
      fetchMode: async () => CLOUD_MODE,
      globalObject: { ...globalObject, location: { reload: () => { reloaded = true } } },
    })
    assert.equal(result.active, false, '只有异步来源时，首轮同步段拿不到 cloud')
    // 异步段随后写入缓存并触发重载（等一拍让它跑完）。
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(reloaded, true, '异步段发现磁盘是 cloud 时必须重载以让下一轮同步接管')
  })

  it('磁盘优先：异步段仍会查询磁盘（用于纠正缓存）', async () => {
    let queried = false
    await carrier.installCarrierResolvingMode({
      readMode: () => CLOUD_MODE,
      fetchMode: async () => { queried = true; return CLOUD_MODE },
      globalObject: makeGlobal(),
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(queried, true, '异步纠正段必须查询磁盘')
  })

  it('磁盘显式断开（explicit）→ 清缓存并回本机', async () => {
    // 缓存里残留上次连接的 cloud，但用户点过「断开」；磁盘写的是 local。
    // 新一轮加载：同步段会用**磁盘**（若可用同步来源），否则异步段纠正后重载。
    let reloaded = false
    const globalObject = { ...makeGlobal(), location: { reload: () => { reloaded = true } } }
    const result = await carrier.installCarrierResolvingMode({
      readMode: () => CLOUD_MODE,
      fetchModeSync: () => ({ mode: 'local', explicit: true }),
      fetchMode: async () => ({ mode: 'local', explicit: true }),
      globalObject,
    })
    assert.equal(result.active, false, '用户显式断开必须生效（同步来源即可判定）')
    await new Promise(resolve => setTimeout(resolve, 20))
    void reloaded
  })

  it('磁盘文件不存在（explicit:false）→ 回落 localStorage', async () => {
    const result = await carrier.installCarrierResolvingMode({
      readMode: () => CLOUD_MODE,
      fetchMode: async () => ({ mode: 'local', explicit: false }),
      globalObject: makeGlobal(),
    })
    // 磁盘没文件，说明从未写过；localStorage 的 cloud 仍然有效（旧用户升级场景）
    assert.equal(result.active, true)
  })

  it('服务端查询抛错 → 回落 local，不阻塞启动', async () => {
    const result = await carrier.installCarrierResolvingMode({
      readMode: () => ({ mode: 'local' }),
      fetchMode: async () => { throw new Error('network down') },
      globalObject: makeGlobal(),
    })
    assert.equal(result.active, false, '查询失败按 local 处理')
  })

  it('服务端返回 local → 保持本机', async () => {
    const result = await carrier.installCarrierResolvingMode({
      readMode: () => ({ mode: 'local' }),
      fetchMode: async () => ({ mode: 'local' }),
      globalObject: makeGlobal(),
    })
    assert.equal(result.active, false)
  })

  it('boot 窗口：同步段先跑，异步段负责纠正（不再 await 查询后才注入）', async () => {
    // 2026-11-12 架构变更：不能在 boot 回调里 `await` 查询——那会让注入晚于
    // connection 捕获 fetch（CDP 实测 connection 54ms 读、carrier 125ms 写）。
    // 现在：同步段立即按可用信息决定；异步段核对磁盘，不一致就重载。
    let resolveBoot
    let reloaded = false
    const globalObject = {
      __DSH_BOOT_READY__: { promise: new Promise(r => { resolveBoot = r }) },
      location: { reload: () => { reloaded = true } },
    }
    const pending = carrier.installCarrierResolvingMode({
      readMode: () => ({ mode: 'local' }),
      fetchMode: async () => CLOUD_MODE,
      fetchModeSync: () => CLOUD_MODE,
      globalObject,
    })
    resolveBoot()
    const result = await pending
    assert.equal(result.active, true, '有同步来源时，boot 后立即接管')
    assert.equal(globalObject.__DSH_TRANSPORT__.streamBaseUrl, 'http://192.168.0.17:8443')
    void reloaded
  })
})

describe('路径工具', () => {  it('normalizePath 处理四种入参形态', () => {
    assert.equal(carrier.normalizePath('api/session/list'), '/api/session/list')
    assert.equal(carrier.normalizePath('/api/session/list'), '/api/session/list')
    assert.equal(carrier.normalizePath(new URL('http://x/api/y')), '/api/y')
    assert.equal(carrier.normalizePath('http://x/api/y'), '/api/y')
  })

  it('isApiRequest 只认 /api 前缀', () => {
    assert.equal(carrier.isApiRequest(new URL('http://x/api/a')), true)
    assert.equal(carrier.isApiRequest(new URL('http://x/api')), true)
    assert.equal(carrier.isApiRequest(new URL('http://x/plugins/a.js')), false)
  })
})
