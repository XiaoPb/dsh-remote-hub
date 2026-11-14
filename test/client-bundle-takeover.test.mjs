/**
 * 真实 bundle 的页面级接管验证。
 *
 * 不依赖浏览器库：用 Node 的 `vm` 造一个最小浏览器全局
 * （globalThis / location / localStorage / WebSocket / fetch），
 * 加载**真实的** `lib/client.js` 构建产物，复刻桌面页面启动序列：
 *
 *   ① 插件 bundle 求值 → carrier-entry 调用 installCarrierAfterBoot
 *   ② 桌面 shell 写 __DSH_TRANSPORT__
 *   ③ boot resolve → carrier 接管
 *
 * 断言：最终 __DSH_TRANSPORT__ 的 fetch / createWebSocket / streamBaseUrl
 * 全部指向远端守卫 —— 这是「侧栏能看到远端数据」的前提。
 *
 * @module test/client-bundle-takeover.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const BUNDLE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const CLOUD_MODE = {
  mode: 'cloud',
  origin: 'http://192.168.0.17:8443',
  token: 'T'.repeat(43),
  deviceLabel: 'v4debian',
}

/**
 * 造一个模拟浏览器环境并加载真实 bundle。
 * @param {object} options - 注入项。
 * @returns 上下文（含 globalThis 上的各类句柄）。
 */
function makeBrowser(options) {
  const { mode, bootResolvers } = options
  const store = new Map([['remote-hub.mode', JSON.stringify(mode)]])
  const created = { sockets: [], fetched: [] }

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    AbortSignal,
    Response,
    Headers,
    Request,
    Promise,
    JSON,
    Math,
    Date,
    Object,
    Array,
    Symbol,
    WeakMap,
    WeakSet,
    Map,
    Set,
    Error,
    TypeError,
    // 浏览器全局
    location: { origin: 'dsh-app://app', href: 'dsh-app://app/', reload() {} },
    localStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, value) },
      removeItem: key => { store.delete(key) },
    },
    navigator: { clipboard: { writeText: async () => {} } },
    document: undefined,
    // 记录 WebSocket 目标
    WebSocket: class {
      constructor(url) { created.sockets.push(url) }
      close() {}
      addEventListener() {}
    },
    // 记录 fetch 目标
    fetch: (input, init) => {
      created.fetched.push({ input: String(input), init })
      return Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }))
    },
    // 桌面 boot 就绪信号
    __DSH_BOOT_READY__: bootResolvers,
    /**
     * 同步 XHR 桩：carrier 用它在 connection 捕获 fetch **之前**拿到磁盘状态。
     * 这里让同步查询失败（返回 null），迫使 carrier 走 localStorage 缓存路径，
     * 正好覆盖「有缓存时同步注入」这条主线。
     */
    XMLHttpRequest: class {
      open() {}
      setRequestHeader() {}
      send() { throw new Error('sync XHR disabled in this sandbox') }
      get status() { return 0 }
      get responseText() { return '' }
    },
    __DSH_REMOTE_HUB__: {
      pairIssueToken: 'pin',
      loopbackOrigin: 'http://127.0.0.1:8443',
      guardOrigin: 'http://192.168.0.17:8443',
    },
    // DSH 模块加载器：bundle 末尾调用 load({ id, factory }) 注册。
    __ModuleLoader__: {
      load(entry) { sandbox.__bundleEntry = entry },
      create() { return {} },
    },
  }
  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  // 最小 DOM 事件面：vendored 的 ui-primitives 在求值期注册 window 级指针/键盘监听。
  sandbox.addEventListener = () => {}
  sandbox.removeEventListener = () => {}
  const context = createContext(sandbox)
  return { context, created, store, sandbox }
}

/**
 * 求值 bundle 并执行其注册的工厂（模拟 DSH 激活插件）。
 * @param {object} env - makeBrowser 的返回值。
 */
function evaluateBundle(env) {
  runInContext(BUNDLE, env.context, { filename: 'client.js' })
  const entry = env.sandbox.__bundleEntry
  assert.ok(entry !== undefined, 'bundle 必须调用 __ModuleLoader__.load')
  assert.equal(typeof entry.factory, 'function', 'entry.factory 必须是函数')
  // DSH 激活插件时才调用工厂；carrier-entry 在工厂体内求值。
  // require 桩：bundle 是自包含的，外部 import 在此环境里不会被用到 —— 除了 `react` /
  // `react-dom`：本地插件页在模块求值期就会构造 react 元素（本测试不需要它们的行为），
  // 所以这里给一个**够用**的最小桩，避免 vm 里的 bundle 求值失败。
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    forwardRef: render => render,
    createContext: defaultValue => ({ Provider: ({ children }) => children, _defaultValue: defaultValue }),
    cloneElement: element => element,
    Fragment: 'Fragment',
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: factory => factory(),
    useCallback: callback => callback,
    useRef: value => ({ current: value }),
    useContext: context => context._defaultValue,
    useId: () => 'test-id',
  }
  const reactDom = {
    createPortal: node => node,
    flushSync: callback => callback(),
  }
  // JSX 运行时：vendored 页面在模块求值期就会调用 jsx/jsxs 生成元素。
  const jsxRuntime = {
    jsx: react.createElement,
    jsxs: react.createElement,
    jsxDEV: react.createElement,
    Fragment: react.Fragment,
  }
  entry.factory(specifier => {
    if (specifier === 'react/jsx-runtime') return jsxRuntime
    if (specifier.startsWith('react-dom')) return reactDom
    return react
  })
}

describe('真实 client bundle 的页面级接管', () => {
  it('cloud 模式下，bundle 在求值时即把 __DSH_TRANSPORT__ 指向远端', async () => {
    const bootResolvers = Promise.withResolvers()
    const env = makeBrowser({ mode: CLOUD_MODE, bootResolvers })

    // ① 求值真实 bundle：carrier 作为 **bundle 顶层**代码立即执行。
    //    （2026-11-12：这正是修复「connection 先于 carrier 捕获 fetch」的关键）
    evaluateBundle(env)

    // 等 boot 回调与微任务跑完。
    bootResolvers.resolve()
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))

    const transport = env.context.__DSH_TRANSPORT__
    assert.equal(typeof transport?.fetch, 'function', 'fetch 必须被注入')
    assert.equal(typeof transport?.createWebSocket, 'function', 'createWebSocket 必须被注入')
    assert.equal(transport.streamBaseUrl, CLOUD_MODE.origin, 'streamBaseUrl 必须指向远端守卫')
    assert.equal(transport.ownsHost, true, 'ownsHost 必须保留')
    assert.equal(transport.openStream, undefined, '不得提供 openStream（会禁掉官方 mux）')
  })

  it('shell 在 carrier 之后写入时，不得把远端 fetch 覆盖回本机', async () => {
    // 桌面 shell 会在 boot 期间写 `{ ownsHost, streamBaseUrl }`。
    // carrier 已经注入了远端 fetch，这次写入只能补充字段，不能把 fetch 抹掉。
    const bootResolvers = Promise.withResolvers()
    const env = makeBrowser({ mode: CLOUD_MODE, bootResolvers })
    evaluateBundle(env)
    // 模拟 shell 直接赋值（最粗暴的覆盖方式）。
    env.context.__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl: 'http://127.0.0.1:3080' }
    bootResolvers.resolve()
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))

    const transport = env.context.__DSH_TRANSPORT__
    // 已知限制：如果宿主直接整体赋值，carrier 无法阻止。这里断言**至少**在
    // boot 回调里 carrier 会重新合并一次，把远端 fetch 装回去。
    assert.equal(typeof transport?.fetch, 'function',
      'boot 回调必须把远端 fetch 重新装回（否则 shell 写入会让接管失效）')
    assert.equal(transport.streamBaseUrl, CLOUD_MODE.origin, 'streamBaseUrl 必须回到远端')
  })

  it('注入后的 fetch 确实改道到远端守卫', async () => {
    const bootResolvers = Promise.withResolvers()
    const env = makeBrowser({ mode: CLOUD_MODE, bootResolvers })
    evaluateBundle(env)
    bootResolvers.resolve()
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))

    const transport = env.context.__DSH_TRANSPORT__
    // 按官方 createWebConnectionRpc 的方式调用
    await transport.fetch('api/session/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/list', payload: {} }),
    })

    assert.equal(env.created.fetched.length >= 1, true, '必须发出请求')
    // 2026-11-12：boot 时先查一次 admin.carrier（磁盘真源），之后的 RPC 才改道。
    const rpcCall = env.created.fetched.find(entry => entry.input.includes('/remote/rpc'))
    assert.ok(rpcCall !== undefined, '必须改道到远端守卫')
    assert.equal(rpcCall.input, 'http://192.168.0.17:8443/remote/rpc')
    const headers = rpcCall.init.headers
    assert.equal(headers['x-hub-protocol'], '1')
    assert.match(String(headers.authorization ?? headers.Authorization), /^Bearer T+$/u)
  })

  it('注入后的 createWebSocket 指向守卫 /remote/ws 并带令牌', async () => {
    const bootResolvers = Promise.withResolvers()
    const env = makeBrowser({ mode: CLOUD_MODE, bootResolvers })
    evaluateBundle(env)
    bootResolvers.resolve()
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))

    const transport = env.context.__DSH_TRANSPORT__
    transport.createWebSocket(new URL('/api/remote.mux'.slice(1), transport.streamBaseUrl).href)

    assert.equal(env.created.sockets.length, 1, '必须建一次 WS')
    const url = new URL(env.created.sockets[0])
    assert.equal(url.protocol, 'ws:')
    assert.equal(url.host, '192.168.0.17:8443', '必须连远端守卫')
    assert.equal(url.pathname, '/remote/ws')
    assert.equal(url.searchParams.get('token'), CLOUD_MODE.token)
    assert.equal(url.searchParams.get('ws-target'), '/api/remote.mux')
  })

  it('local 模式下 bundle 不注入 transport（保持本机）', async () => {
    const bootResolvers = Promise.withResolvers()
    const env = makeBrowser({ mode: { mode: 'local' }, bootResolvers })
    evaluateBundle(env)
    bootResolvers.resolve()
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))

    // local 模式不应注入 fetch/createWebSocket
    const transport = env.context.__DSH_TRANSPORT__
    assert.equal(transport?.fetch, undefined, 'local 模式不得注入 fetch')
    assert.equal(transport?.createWebSocket, undefined, 'local 模式不得注入 createWebSocket')
  })
})
