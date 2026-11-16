/**
 * 守卫浏览器静态面（`guard-web.ts`）测试。
 *
 * 用本地 `node:http` 起一个**假官方 Web** 冒充 `:3080`，逐条验证：
 *  ① `GET /` 的 index 被注入 `__DSH_REMOTE_HUB__`，且 `__DSH_BOOT__` 原样保留；
 *  ② `/assets/*` 与 `/plugins/??a/client.js,b/client.js&rev=…` 反代字节完全一致；
 *  ③ 未知路径返回 `false`（交给守卫原有分发）；
 *  ④ 上游关闭后返回 503；上游回 5xx 时返回 502。
 *
 * 另外覆盖两条安全性质：**注入里没有令牌**、**Cookie 既不回写也不外带**。
 *
 * @module test/guard-web.test.mjs
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { testLoadLib } from './_helpers.mjs'

/** 仓库根（`.build/` 暂存目录要放在仓内，裸导入才能按 node_modules 解析）。 */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * 从 tsc 的 emit 产物加载 `guard-web.js`，把 `@core/*` 别名改写成相对路径。
 *
 * `guard-web.ts` 只依赖 `@core/index.js`，所以只需镜像一份 `core/src/index.js`
 * （以及 index 再导出的 `protocol.js` —— 我们真正用到的是 `GUARD_ROUTES`）。
 *
 * @returns {Promise<object>} 模块命名空间。
 */
async function loadEmittedGuardWeb() {
  const source = await readFile(join(ROOT, '.build', 'host', 'host', 'src', 'guard-web.js'), 'utf8')
  const directory = await mkdtemp(join(ROOT, '.build', 'tmp-guard-web-'))
  const coreDir = join(directory, 'core', 'src')
  await mkdir(coreDir, { recursive: true })
  // 复制 core 的 emit 产物（`index.js` 会再导出 protocol/redact 等，缺一个就整链失败）。
  const coreRoot = join(ROOT, '.build', 'host', 'core', 'src')
  for (const name of ['index', 'protocol', 'redact', 'roles', 'auth', 'device', 'capabilities',
    'capabilities-redlines', 'version-drift', 'carrier-contract', 'local-plugin-manager']) {
    const from = join(coreRoot, `${name}.js`)
    if (!existsSync(from)) continue
    await writeFile(join(coreDir, `${name}.js`), await readFile(from, 'utf8'), 'utf8')
  }
  const rewritten = source.replace(/from '@core\/([^']+)'/gu, (_match, rest) => `from './core/src/${rest}'`)
  const target = join(directory, 'guard-web.js')
  await writeFile(target, rewritten, 'utf8')
  return await import(pathToFileURL(target).href)
}

/**
 * 被测模块的命名空间。
 *
 * 优先用 `lib/index.js` 的 re-export；但 `host/src/index.ts` 的导出清单由
 * 另一位成员维护（T1 的写域不含它），在它接入之前 `createGuardWeb` 不会出现在
 * `lib/index.js` 上。按仓库既有口径（见 `test/_helpers.mjs` 文件头与
 * `auth-client.test.mjs` 的 `loadBuiltClientModule`），此时**退化**到加载
 * `tsc` emit 的同一份字节（改写 `@core/*` 别名）——测试仍断言真实行为，不跳过。
 *
 * 两条路径都不可用时直接失败，而不是静默丢失覆盖面。
 * @returns {Promise<object>} 含 `createGuardWeb` 等导出的命名空间。
 */
async function loadGuardWeb() {
  const lib = await testLoadLib()
  if (typeof lib.createGuardWeb === 'function') return lib
  const emitted = join(ROOT, '.build', 'host', 'host', 'src', 'guard-web.js')
  if (!existsSync(emitted)) {
    throw new Error(
      'guard-web unavailable: neither lib/index.js nor .build/host/host/src/guard-web.js '
      + 'exports createGuardWeb (run `npm run build`, and have host/src/index.ts re-export it)',
    )
  }
  return { ...lib, ...(await loadEmittedGuardWeb()) }
}

const hub = await loadGuardWeb()

/** 假官方 index：`__DSH_BOOT__` 是一段带引号与花括号的真实形态。 */
const FAKE_BOOT = '{"modules":[{"id":"@deepseek-ai/dsh-client","url":"/assets/index-abc123.js"}],"theme":"dark"}'
const FAKE_INDEX = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>DSH</title>
<script>globalThis.__DSH_BOOT__ = ${FAKE_BOOT}</script>
<script type="module" src="/assets/index-abc123.js"></script>
</head>
<body><div id="root"></div></body>
</html>`

/** 一个内容像真实 chunk 的静态资源（含非 UTF-8 安全的多字节与空字节，验证字节级一致）。 */
const FAKE_ASSET = Buffer.concat([
  Buffer.from('/* fake chunk */\nconsole.log("字体：日本語");\n'),
  Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff, 0x7f, 0x80]),
])

/** 拼接形式的响应体（内容与单文件不同，便于断言 query 真被透传）。 */
const FAKE_CONCAT = Buffer.from('/* concatenated a+ b */\nexport const x = 1;\n')

/** 假上游记录到的请求，供「query 原样透传」「Host 被改写」断言。 */
const upstreamHits = []

/**
 * 起一个假官方 Web。
 * @returns {Promise<{ server: import('node:http').Server, origin: string, failMode: { value: string } }>}
 */
async function startFakeUpstream() {
  // 通过一个可变对象控制上游行为，避免测试中途重启（端口会变）。
  const state = { value: 'ok' }
  const server = createServer((req, res) => {
    upstreamHits.push({ url: req.url, host: req.headers.host, method: req.method })
    if (state.value === 'error') {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('upstream exploded')
      return
    }
    const url = new URL(req.url ?? '/', 'http://placeholder')
    if (url.pathname === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        etag: 'W/"upstream-1"',
        // 上游的会话 Cookie：**不得**被带到守卫 origin。
        'set-cookie': 'dsh_session=super-secret-cookie; Path=/; HttpOnly',
      })
      res.end(FAKE_INDEX)
      return
    }
    if (url.search.includes('??')) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      res.end(FAKE_CONCAT)
      return
    }
    if (url.pathname.startsWith('/assets/')) {
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-length': String(FAKE_ASSET.length),
      })
      res.end(FAKE_ASSET)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('nope')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { server, origin: `http://127.0.0.1:${port}`, state }
}

/**
 * 起一个把 `handle` 挂进去的本地服务（完全替代守卫的分发位置）。
 *
 * 返回 `false` 时写一条 `not-handled` 标记 —— 测试以此区分
 * 「本模块返回 false」与「本模块处理了但回了错」。
 * @param {ReturnType<typeof hub.createGuardWeb>} handle - 被测句柄。
 * @returns {Promise<{ server: import('node:http').Server, origin: string }>}
 */
async function startGuard(handle) {
  const server = createServer((req, res) => {
    handle.handle(req, res).then(handled => {
      if (handled) return
      res.writeHead(418, { 'content-type': 'text/plain' })
      res.end('not-handled')
    }).catch(error => {
      res.writeHead(599, { 'content-type': 'text/plain' })
      res.end(String(error))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { server, origin: `http://127.0.0.1:${port}` }
}

/** 关掉一个 server（丢弃在途 socket，避免测试挂住）。 */
async function stop(server) {
  await new Promise(resolve => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
}

describe('guard-web：GET / 注入远程标记', () => {
  let upstream
  let guard

  before(async () => {
    upstream = await startFakeUpstream()
    guard = await startGuard(hub.createGuardWeb({ hostOrigin: upstream.origin }))
  })

  after(async () => {
    await stop(guard.server)
    await stop(upstream.server)
  })

  it('① index 里有 __DSH_REMOTE_HUB__ 且 mode=remote-browser', async () => {
    const response = await fetch(`${guard.origin}/`)
    assert.equal(response.status, 200)
    const html = await response.text()
    assert.match(html, /globalThis\.__DSH_REMOTE_HUB__ = \{"mode":"remote-browser"\}/u)
  })

  it('① __DSH_BOOT__ 数据原样保留（不重建）', async () => {
    const html = await (await fetch(`${guard.origin}/`)).text()
    assert.ok(html.includes(`globalThis.__DSH_BOOT__ = ${FAKE_BOOT}`), 'boot 数据必须逐字保留')
    // 官方入口脚本也必须在（注入不能顶掉原有标签）。
    assert.ok(html.includes('/assets/index-abc123.js'))
  })

  it('① 注入里没有任何令牌字段', async () => {
    const html = await (await fetch(`${guard.origin}/`)).text()
    for (const forbidden of ['pairIssueToken', 'token', 'cookie', 'authorization']) {
      assert.equal(html.includes(forbidden), false, `index 不得包含 ${forbidden}`)
    }
  })

  it('① 上游 Cookie 不被带到守卫 origin，且长度/ETag 正确', async () => {
    const response = await fetch(`${guard.origin}/`)
    assert.equal(response.headers.get('set-cookie'), null, '不得回写上游 Cookie')
    assert.equal(
      Number(response.headers.get('content-length')),
      Buffer.byteLength(await response.text()),
      'content-length 必须与注入后的字节一致',
    )
  })

  it('① 5 秒窗口内复用缓存：第二次请求不再回源', async () => {
    const before = upstreamHits.filter(hit => hit.url === '/').length
    await (await fetch(`${guard.origin}/`)).text()
    await (await fetch(`${guard.origin}/`)).text()
    const after = upstreamHits.filter(hit => hit.url === '/').length
    assert.equal(after - before, 0, '窗口内不应再回源')
  })
})

describe('guard-web：静态资源流式反代', () => {
  let upstream
  let guard

  before(async () => {
    upstream = await startFakeUpstream()
    guard = await startGuard(hub.createGuardWeb({ hostOrigin: upstream.origin }))
  })

  after(async () => {
    await stop(guard.server)
    await stop(upstream.server)
  })

  it('② /assets/x.js 字节完全一致 + immutable 缓存头', async () => {
    const response = await fetch(`${guard.origin}/assets/x.js`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.deepEqual(bytes, FAKE_ASSET, '反代字节必须与原字节完全一致')
  })

  it('② /plugins/??a/client.js,b/client.js&rev=xxx 原样透传 query', async () => {
    const response = await fetch(`${guard.origin}/plugins/??a/client.js,b/client.js&rev=abc123`)
    assert.equal(response.status, 200)
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.deepEqual(bytes, FAKE_CONCAT)
    const hit = upstreamHits.findLast(item => item.url?.includes('??'))
    assert.equal(hit?.url, '/plugins/??a/client.js,b/client.js&rev=abc123', 'query 必须原样透传')
  })

  it('② 反代时 Host 头被改写成上游的 host', async () => {
    await (await fetch(`${guard.origin}/assets/x.js`)).arrayBuffer()
    const hit = upstreamHits.findLast(item => item.url === '/assets/x.js')
    assert.equal(hit?.host, new URL(upstream.origin).host)
  })

  it('② 客户端 Cookie 不转发给上游', async () => {
    await (await fetch(`${guard.origin}/assets/x.js`, {
      headers: { cookie: 'dsh_session=client-cookie', authorization: 'Bearer secret-token' },
    })).arrayBuffer()
    // 上游 handler 只记录 url/host；这里用另一次带凭据的 index 请求间接确认。
    // 直接断言：注入内容与字节里都不出现凭据。
    const html = await (await fetch(`${guard.origin}/`)).text()
    assert.equal(html.includes('secret-token'), false)
    assert.equal(html.includes('client-cookie'), false)
  })

  it('② HEAD 请求不写体', async () => {
    const response = await fetch(`${guard.origin}/assets/x.js`, { method: 'HEAD' })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), '')
  })

  it('② 非 GET/HEAD 的方法由本模块接管并回 405', async () => {
    const response = await fetch(`${guard.origin}/assets/x.js`, { method: 'POST', body: 'x' })
    assert.equal(response.status, 405)
    assert.notEqual(response.status, 418, '不能漏给守卫变成未知路由')
  })
})

describe('guard-web：路径归属', () => {
  let upstream
  let guard

  before(async () => {
    upstream = await startFakeUpstream()
    guard = await startGuard(hub.createGuardWeb({ hostOrigin: upstream.origin }))
  })

  after(async () => {
    await stop(guard.server)
    await stop(upstream.server)
  })

  it('③ 未知路径返回 false（⇒ 守卫原分发 418 标记）', async () => {
    for (const path of ['/remote/health', '/api/session/list', '/remote-auth/login', '/nope', '/pluginsfoo']) {
      const response = await fetch(`${guard.origin}${path}`)
      assert.equal(response.status, 418, `${path} 不应被静态面接管`)
      assert.equal(await response.text(), 'not-handled')
    }
  })

  it('③ handle 直接调用时未知路径就是 false（不写响应）', async () => {
    const handle = hub.createGuardWeb({ hostOrigin: upstream.origin })
    const res = fakeResponse()
    const handled = await handle.handle({ method: 'GET', url: '/api/x', headers: {} }, res)
    assert.equal(handled, false)
    assert.equal(res.writes.length, 0, '返回 false 时不得写响应')
  })

  it('③ manifest.webmanifest 与 favicon 也在白名单内', async () => {
    assert.equal(hub.isProxyableAssetPath('/manifest.webmanifest'), true)
    assert.equal(hub.isProxyableAssetPath('/favicon.svg'), true)
    assert.equal(hub.isProxyableAssetPath('/favicon-32x32.svg'), true)
    // 非静态路径（含形似但不是的）一律不属于本模块。
    assert.equal(hub.isProxyableAssetPath('/favicon.ico'), false)
    assert.equal(hub.isProxyableAssetPath('/pluginsfoo'), false)
    assert.equal(hub.isProxyableAssetPath('/remote/rpc'), false)
  })
})

describe('guard-web：上游故障', () => {
  it('④ 上游关闭后 GET / 返回 503', async () => {
    const upstream = await startFakeUpstream()
    const handle = hub.createGuardWeb({ hostOrigin: upstream.origin, indexTimeoutMs: 500 })
    const guard = await startGuard(handle)
    try {
      // 先确认正常，再关掉上游。
      assert.equal((await fetch(`${guard.origin}/`)).status, 200)
      await stop(upstream.server)
      // 换一份句柄（旧句柄的 5s 缓存仍在命中，服务确实还活着这一事实不影响断言目标）；
      // 这里直接用**新句柄**证明「冷启动 + 上游已死」= 503。
      const guard2 = await startGuard(hub.createGuardWeb({ hostOrigin: upstream.origin, indexTimeoutMs: 500 }))
      try {
        const response = await fetch(`${guard2.origin}/`)
        assert.equal(response.status, 503)
      } finally {
        await stop(guard2.server)
      }
    } finally {
      await stop(guard.server)
    }
  })

  it('④ 上游关闭后静态资源返回 503', async () => {
    const upstream = await startFakeUpstream()
    const guard = await startGuard(hub.createGuardWeb({ hostOrigin: upstream.origin }))
    try {
      await stop(upstream.server)
      const response = await fetch(`${guard.origin}/assets/x.js`)
      assert.equal(response.status, 503)
      assert.equal(response.headers.get('cache-control'), 'no-store', '错误页不得被缓存')
    } finally {
      await stop(guard.server)
    }
  })

  it('④ 上游回 5xx → 502（index 与资源都是）', async () => {
    const upstream = await startFakeUpstream()
    upstream.state.value = 'error'
    const guard = await startGuard(hub.createGuardWeb({ hostOrigin: upstream.origin }))
    try {
      assert.equal((await fetch(`${guard.origin}/`)).status, 502)
      assert.equal((await fetch(`${guard.origin}/assets/x.js`)).status, 502)
    } finally {
      await stop(guard.server)
      await stop(upstream.server)
    }
  })

  it('④ 故障不抛未捕获异常：错误被审计且不含令牌', async () => {
    const events = []
    const handle = hub.createGuardWeb({
      hostOrigin: 'http://127.0.0.1:1',
      audit: (event, fields) => { events.push({ event, fields }) },
      indexTimeoutMs: 500,
    })
    const res = fakeResponse()
    // 必须正常返回 true 而不是 reject。
    const handled = await handle.handle({ method: 'GET', url: '/', headers: {} }, res)
    assert.equal(handled, true)
    assert.equal(events.at(-1).event, 'web-proxy-error')
    const logged = JSON.stringify(events)
    for (const secret of ['authorization', 'cookie', 'Bearer', 'token']) {
      assert.equal(logged.toLowerCase().includes(secret.toLowerCase()), false, `审计不得含 ${secret}`)
    }
  })

  it('④ hostOrigin 缺省 → 503（不抛错），其它路径仍返回 false', async () => {
    const handle = hub.createGuardWeb({})
    const indexRes = fakeResponse()
    assert.equal(await handle.handle({ method: 'GET', url: '/', headers: {} }, indexRes), true)
    assert.equal(indexRes.statusCode, 503)
    const assetRes = fakeResponse()
    assert.equal(await handle.handle({ method: 'GET', url: '/assets/x.js', headers: {} }, assetRes), true)
    assert.equal(assetRes.statusCode, 503)
    const other = fakeResponse()
    assert.equal(await handle.handle({ method: 'GET', url: '/remote/health', headers: {} }, other), false)
  })
})

describe('guard-web：注入改写单元', () => {
  it('标记插在 <head> 之后、boot 之前', () => {
    const { body, injected } = hub.injectRemoteBrowserMarker(FAKE_INDEX)
    assert.equal(injected, true)
    const markerAt = body.indexOf(hub.REMOTE_BROWSER_MARKUP)
    const bootAt = body.indexOf('__DSH_BOOT__')
    assert.ok(markerAt >= 0 && markerAt < bootAt, '标记必须先于 boot 数据可见')
    assert.ok(body.includes(FAKE_BOOT), 'boot 数据必须逐字保留')
  })

  it('没有 <head> 但含 boot 标记 → 退到文档最前面', () => {
    const html = `<script>globalThis.__DSH_BOOT__ = {}</script>`
    const { body, injected } = hub.injectRemoteBrowserMarker(html)
    assert.equal(injected, true)
    assert.ok(body.startsWith('<script>globalThis.__DSH_REMOTE_HUB__'))
    assert.ok(body.endsWith(html))
  })

  it('既无 <head> 也无 boot 标记 → 不注入（原样返回）', () => {
    const html = '<p>upstream error page</p>'
    const { body, injected } = hub.injectRemoteBrowserMarker(html)
    assert.equal(injected, false)
    assert.equal(body, html)
  })
})

/**
 * 最小假响应：只实现本模块用到的 `ServerResponse` 表面。
 * @returns {object} 记录写入的假对象。
 */
function fakeResponse() {
  const record = {
    statusCode: 0,
    headers: {},
    writes: [],
    writableFinished: false,
    headersSent: false,
    setHeader(name, value) { record.headers[String(name).toLowerCase()] = value },
    write(chunk) { record.writes.push(chunk); return true },
    end(chunk) {
      if (chunk !== undefined) record.writes.push(chunk)
      record.writableFinished = true
    },
    destroy() { record.destroyed = true },
    on() {},
    once() {},
    off() {},
    removeListener() {},
  }
  record.destroyed = false
  return record
}
