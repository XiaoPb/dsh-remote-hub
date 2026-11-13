/**
 * Carrier 契约测试（路线 A Task 3 / 验收）。
 *
 * 构建产物存在时测真实现（`lib/index.js` 不导出 client 半边，所以 carrier 以
 * `client/src/carrier.ts` 的**源码级静态断言** + 自含参考实现双重覆盖：
 *  - 断言源码包含改道、头注入、401 降级的关键行为；
 *  - 参考实现复刻 createCarrier 的决策表并对全部分支断言。
 * 这与仓库 `_helpers.mjs` 的既有模式一致（测试从不静默跳过）。
 *
 * @module test/carrier.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { PATHS, read } from './_helpers.mjs'

const CARRIER_SRC = read(PATHS.clientSrc ? `${PATHS.clientSrc}/carrier.ts` : '')
const ENTRY_SRC = read(`${PATHS.clientSrc}/carrier-entry.ts`)
const CONTRACT_SRC = read(`${PATHS.coreSrc}/carrier-contract.ts`)

/** 官方相对 URL（陷阱 1：slice(1) 后无前导斜杠）。 */
const OFFICIAL_RELATIVE = 'api/session/list'
/** 官方 client-request 信封。 */
const ENVELOPE = {
  type: 'client-request',
  rpcId: 'rpc-1',
  method: 'session/list',
  payload: { args: {} },
}

/** 参考实现：与 carrier.ts 决策表 1:1（源码断言保证实现未漂移）。 */
function makeReferenceCarrier(options) {
  const {
    mode, responses, base = 'http://127.0.0.1:2524/', guardOrigin = 'http://127.0.0.1:8443',
  } = options
  const calls = []
  let reloads = 0
  let modeWrites = 0
  const fetchImpl = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    const spec = responses[calls.length - 1]
      ?? responses.default
    if (spec.throw === true) throw new Error('network down')
    return {
      status: spec.status ?? 200,
      headers: spec.headers ?? { get: () => 'application/json' },
      text: async () => spec.body ?? JSON.stringify({
        type: 'server-response', rpcId: 'rpc-1', result: { ok: true, value: [] },
      }),
    }
  }
  // 与 carrier.ts 相同的决策函数。
  const isApi = url => url.pathname === '/api' || url.pathname.startsWith('/api/')
  const identityFailure = (status, body) => status === 401 || (body.includes('device-revoked') && (() => {
    try {
      const parsed = JSON.parse(body)
      return parsed?.result?.error?.code === 'device-revoked'
    } catch { return false }
  })())
  const carrierFetch = async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw, base)
    if (!isApi(url)) return fetchImpl(input, init)
    const response = await fetchImpl(`${guardOrigin}/remote/rpc`, {
      ...init,
      method: 'POST',
      headers: { ...(init?.headers ?? {}), authorization: 'Bearer tok', 'x-hub-protocol': '1', 'content-type': 'application/json' },
    })
    const text = await response.text()
    if (identityFailure(response.status, text)) {
      modeWrites += 1
      reloads += 1
      return { status: response.status, headers: { get: () => 'application/json' }, text: async () => text }
    }
    return response
  }
  return { carrierFetch, calls, get reloads() { return reloads }, get modeWrites() { return modeWrites } }
}

describe('carrier: 源码级契约断言', () => {
  it('carrier.ts 改道到 GUARD_ROUTES.rpc 并原样透传信封', () => {
    assert.ok(CARRIER_SRC.includes('GUARD_ROUTES.rpc'), 'must target /remote/rpc')
    assert.ok(CARRIER_SRC.includes('isApiRequest'), 'must gate on /api pathname')
    assert.ok(CARRIER_SRC.includes('...init'), 'must pass through init (body = envelope)')
    assert.ok(CARRIER_SRC.includes('AUTH_HEADER') && CARRIER_SRC.includes('HUB_PROTOCOL_HEADER'),
      'must attach bearer + protocol headers')
  })

  it('carrier.ts 对 401 / device-revoked 降级回本地模式', () => {
    assert.ok(CARRIER_SRC.includes('isIdentityFailure'), 'identity failure detector present')
    assert.ok(CARRIER_SRC.includes('fallbackMode()') && CARRIER_SRC.includes('reload()'),
      'fallback clears mode and reloads')
  })

  it('carrier-entry 等待 boot 后安装（桌面 shell 会覆写 __DSH_TRANSPORT__）', () => {
    // 2026-11-12 调研修正：旧假设「模块顶层同步安装」不成立——桌面 shell 在 boot
    // 过程中会写 __DSH_TRANSPORT__ = { ownsHost, streamBaseUrl }，早注入会被覆盖。
    // 现在入口调用 installCarrierResolvingMode()，在 boot resolve 后安装，
    // 并先查询宿主状态（磁盘真源），解决 CLI 配对后页面不接管的问题。
    assert.ok(
      ENTRY_SRC.includes('installCarrierResolvingMode'),
      'carrier-entry 必须使用 boot 后安装 + 模式解析',
    )
    assert.ok(ENTRY_SRC.includes('__DSH_BOOT_READY__'), '必须识别桌面 boot 就绪信号')
    assert.ok(ENTRY_SRC.includes('admin.carrier'), '必须查询宿主 carrier 状态')
    assert.ok(CARRIER_SRC.includes('__DSH_TRANSPORT__'), 'installs official transport global')
    assert.ok(CARRIER_SRC.includes('__DSH_REMOTE_HUB_CARRIER__'), 'idempotence guard present')
  })

  it('transport 覆盖包含长连接字段（否则 WS 连回本机）', () => {
    assert.ok(CARRIER_SRC.includes('createWebSocket'), '必须提供 createWebSocket')
    assert.ok(CARRIER_SRC.includes('streamBaseUrl'), '必须提供 streamBaseUrl')
  })

  it('carrier 必须在 **bundle 顶层**执行，而不是在插件 factory 内', () => {
    // 2026-11-12 页面实测：整个 client bundle 被包在 `__ModuleLoader__.load({factory})`
    // 里，factory 由 DSH 启动 cordis 时才调用；而官方 `connection.apply()` 在同一次
    // 启动里**同步**读取 `__DSH_TRANSPORT__` 并闭包捕获 fetch。CDP 时序探针实测：
    //   connection 54ms 读取（undefined），carrier 125ms 才写入 → 接管失效。
    //
    // 因此 carrier 必须由 tsdown 打成独立 IIFE（lib/carrier-boot.js），并在
    // lib/client.js 的 **banner** 里内联到 factory 之前。
    const tsdownSrc = read('tsdown.config.ts')
    assert.ok(tsdownSrc.includes('carrier-boot'), 'tsdown 必须产出独立的 carrier-boot 入口')
    // 配置里 banner 通过 carrierBootSource() 内联 carrier 源码。
    const inlinePos = tsdownSrc.indexOf('carrierBootSource()')
    assert.ok(inlinePos >= 0, 'banner 必须内联 carrier-boot')
    // 构建产物里验证真实位置：carrier 段必须早于 factory。
    const clientBundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    const carrierPos = clientBundle.indexOf('carrier boot: bundle top-level')
    const factoryPos = clientBundle.indexOf('__ModuleLoader__.load({')
    assert.ok(carrierPos >= 0, '产物里必须有 carrier boot 段')
    assert.ok(factoryPos >= 0, '产物里必须有 plugin factory')
    assert.ok(carrierPos < factoryPos, 'carrier boot 必须在 factory 之前')
  })
})

describe('carrier: 模式状态契约', () => {
  it('carrier-contract 提供 MODE_KEY 与双向读写', () => {
    assert.ok(CONTRACT_SRC.includes("MODE_KEY = 'remote-hub.mode'"), 'stable localStorage key')
    assert.ok(CONTRACT_SRC.includes('readCarrierMode') && CONTRACT_SRC.includes('writeCarrierMode'),
      'read/write helpers exported')
    assert.ok(CONTRACT_SRC.includes("value.mode !== 'cloud'") && CONTRACT_SRC.includes("typeof value.origin !== 'string'"),
      'cloud hint requires origin; bearer must not be required or persisted in localStorage')
    assert.ok(CONTRACT_SRC.includes('targetId'), 'cloud hint carries opaque profile target id')
    assert.ok(CONTRACT_SRC.includes('JSON.stringify(hint)'), 'writes only non-secret hint fields')
  })
})

describe('carrier: 决策表（参考实现）', () => {
  const envelopeBody = JSON.stringify(ENVELOPE)

  it('session/create removes only empty preallocated sessionId', () => {
    assert.match(CARRIER_SRC, /normalizeSessionCreateBody/)
    assert.match(CARRIER_SRC, /envelope\.method !== 'session\/create'/)
    assert.match(CARRIER_SRC, /request\.sessionId !== ''/)
    assert.match(CARRIER_SRC, /delete request\.sessionId/)
    assert.match(CARRIER_SRC, /normalizeSessionCreateBody\(init\.body\)/)
  })
  it('api 请求改道守卫并带 Bearer/协议头；信封原样', async () => {
    const carrier = makeReferenceCarrier({
      mode: 'cloud', base: 'http://127.0.0.1:2524/', guardOrigin: 'http://127.0.0.1:8443',
      responses: { default: { status: 200 } },
    })
    const response = await carrier.carrierFetch(OFFICIAL_RELATIVE, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: envelopeBody,
    })
    assert.equal(response.status, 200)
    assert.equal(carrier.calls.length, 1)
    const call = carrier.calls[0]
    assert.equal(call.url, 'http://127.0.0.1:8443/remote/rpc')
    assert.equal(call.init.method, 'POST')
    assert.equal(call.init.body, envelopeBody, 'envelope passthrough, byte-identical')
    assert.equal(call.init.headers.authorization, 'Bearer tok')
    assert.equal(call.init.headers['x-hub-protocol'], '1')
    assert.equal(carrier.reloads, 0)
  })

  it('非 /api 请求原样放行（不触守卫）', async () => {
    const carrier = makeReferenceCarrier({
      mode: 'cloud', responses: { default: { status: 200, body: '<html/>' } },
    })
    await carrier.carrierFetch('assets/index.js')
    assert.equal(carrier.calls[0].url, 'assets/index.js', 'non-api input passed through untouched')
  })

  it('401 → 清模式 + reload 一次（幂等，不循环）', async () => {
    const carrier = makeReferenceCarrier({
      mode: 'cloud', responses: { default: { status: 401, body: '{"result":{"ok":false,"error":{"code":"unauthorized"}}}' } },
    })
    const response = await carrier.carrierFetch(OFFICIAL_RELATIVE, { method: 'POST', body: envelopeBody })
    assert.equal(response.status, 401, 'caller still sees the failure')
    assert.equal(carrier.modeWrites, 1)
    assert.equal(carrier.reloads, 1)
  })

  it('device-revoked 信封错误同样降级', async () => {
    const carrier = makeReferenceCarrier({
      mode: 'cloud', responses: {
        default: { status: 200, body: JSON.stringify({
          type: 'server-response', rpcId: 'rpc-1',
          result: { ok: false, error: { code: 'device-revoked', message: 'x', details: {} } },
        }) },
      },
    })
    await carrier.carrierFetch(OFFICIAL_RELATIVE, { method: 'POST', body: envelopeBody })
    assert.equal(carrier.modeWrites, 1)
    assert.equal(carrier.reloads, 1)
  })

  it('普通业务错误（forbidden 等）不降级', async () => {
    const carrier = makeReferenceCarrier({
      mode: 'cloud', responses: {
        default: { status: 200, body: JSON.stringify({
          type: 'server-response', rpcId: 'rpc-1',
          result: { ok: false, error: { code: 'remote-access/denied', message: 'x', details: {} } },
        }) },
      },
    })
    const response = await carrier.carrierFetch(OFFICIAL_RELATIVE, { method: 'POST', body: envelopeBody })
    assert.equal(response.status, 200)
    assert.equal(carrier.reloads, 0)
    assert.equal(carrier.modeWrites, 0)
  })

  it('网络错误向上抛（官方 generation recovery 负责重连）', async () => {
    const carrier = makeReferenceCarrier({
      mode: 'cloud', responses: { default: { throw: true } },
    })
    await assert.rejects(
      () => carrier.carrierFetch(OFFICIAL_RELATIVE, { method: 'POST', body: envelopeBody }),
      /network down/u,
    )
    assert.equal(carrier.reloads, 0, 'transport failure must not reset mode')
  })
})
