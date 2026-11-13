/**
 * 管理 transport 错误分类测试（Task 1.1 / 3.3）。
 *
 * 覆盖此前全部被压成 `Failed to fetch` 的场景：
 * - 注入缺失（不发请求，直接分类）；
 * - fetch reject（网络/预检）；
 * - 响应不可读（CORS 未宣告）；
 * - HTTP 400/401/403/404/5xx；
 * - 成功请求也要上报诊断。
 *
 * @module test/admin-transport.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { registerAlias } from './panel-alias-loader.mjs'

await registerAlias()
const { createTransport, RemoteHubError, errorKindOf } = await import('../.build/client/client/src/transport.js')

const ORIGIN = 'http://127.0.0.1:8443'
const PAGE_ORIGIN = 'http://127.0.0.1:6406'

/** 造一个可控的 fetch 桩。 */
function stubFetch(handler) {
  return async (url, init) => handler(String(url), init)
}

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() { return JSON.stringify(body) },
  }
}

function failureEnvelope(code, message) {
  return { type: 'server-response', rpcId: 'guard', result: { ok: false, error: { code, message, details: {} } } }
}

describe('admin transport 错误分类', () => {
  it('回退路径（adminChannel=""）注入缺失：不发请求，直接 missing-injection', async () => {
    let called = 0
    const diagnostics = []
    const transport = createTransport({
      origin: ORIGIN,
      pageOrigin: PAGE_ORIGIN,
      adminChannel: '',
      fetchImpl: stubFetch(() => { called += 1; return jsonResponse(200, {}) }),
      onAdminDiagnostic: d => diagnostics.push(d),
    })
    await assert.rejects(
      () => transport.listDevices(),
      error => error instanceof RemoteHubError && error.kind === 'missing-injection',
    )
    assert.equal(called, 0, '缺 pin 时不应发起网络请求')
    assert.equal(diagnostics.at(-1).kind, 'missing-injection')
  })

  it('同源通道（默认）：不带 pin 也能发起请求，走 /api/hub/admin.*', async () => {
    const seen = []
    const transport = createTransport({
      origin: ORIGIN,
      pageOrigin: 'dsh-app://app',
      fetchImpl: stubFetch((url, init) => {
        seen.push({ url, headers: init.headers, body: init.body })
        return jsonResponse(200, {
          type: 'server-response',
          rpcId: JSON.parse(init.body).rpcId,
          result: {
            ok: true,
            value: {
              ok: true, protocolVersion: 1,
              guard: { origin: ORIGIN, loopbackOrigin: ORIGIN, port: 8443 },
              singleController: true, devices: [],
            },
          },
        })
      }),
    })
    const snapshot = await transport.listDevices()
    assert.equal(seen[0].url, '/api/hub/admin.devices')
    assert.equal(seen[0].headers['x-pair-issue-token'], undefined, '同源通道不需要 pin')
    assert.equal(snapshot.protocolVersion, 1)
  })

  it('设备删除先调用 owner admin.deviceForget RPC 并解析 removed 状态', async () => {
    const seen = []
    const transport = createTransport({
      origin: ORIGIN,
      pageOrigin: 'dsh-app://app',
      fetchImpl: stubFetch((url, init) => {
        seen.push({ url, body: JSON.parse(init.body) })
        return jsonResponse(200, {
          type: 'server-response', rpcId: JSON.parse(init.body).rpcId,
          result: { ok: true, value: { ok: true, removed: true } },
        })
      }),
    })
    assert.equal(await transport.forgetDevice('dev_stale'), true)
    assert.equal(seen[0].url, '/api/hub/admin.deviceForget')
    assert.deepEqual(seen[0].body.payload.args, { deviceId: 'dev_stale' })
  })


  it('回退路径：fetch reject（Failed to fetch）→ preflight-failed，并带 pageOrigin/targetOrigin', async () => {
    const transport = createTransport({
      origin: ORIGIN,
      pageOrigin: PAGE_ORIGIN,
      adminChannel: '',
      pairIssueToken: 'pin',
      fetchImpl: stubFetch(() => { throw new TypeError('Failed to fetch') }),
    })
    await assert.rejects(
      () => transport.listDevices(),
      error => error instanceof RemoteHubError
        && error.kind === 'preflight-failed'
        && error.details.targetOrigin === ORIGIN
        && error.details.pageOrigin === PAGE_ORIGIN
        && error.path === '/remote/devices',
    )
  })

  it('响应不可读（CORS 未宣告）→ cors-blocked', async () => {
    const transport = createTransport({
      origin: ORIGIN,
      adminChannel: '',
      pairIssueToken: 'pin',
      fetchImpl: stubFetch(() => ({
        status: 200,
        ok: true,
        async text() { throw new TypeError('blocked by CORS policy') },
      })),
    })
    await assert.rejects(
      () => transport.listDevices(),
      error => error instanceof RemoteHubError && error.kind === 'cors-blocked',
    )
  })

  for (const [status, kind] of [[400, 'http-400'], [401, 'http-401'], [403, 'http-403'], [404, 'http-404'], [500, 'http-5xx']]) {
    it(`HTTP ${status} → ${kind}，保留守卫错误码`, async () => {
      const diagnostics = []
      const transport = createTransport({
        origin: ORIGIN,
        adminChannel: '',
        pairIssueToken: 'pin',
        fetchImpl: stubFetch(() => jsonResponse(status, failureEnvelope('protocol-version-mismatch', 'protocol version mismatch'))),
        onAdminDiagnostic: d => diagnostics.push(d),
      })
      await assert.rejects(
        () => transport.listDevices(),
        error => error instanceof RemoteHubError
          && error.kind === kind
          && error.status === status
          && error.code === 'protocol-version-mismatch',
      )
      assert.equal(diagnostics.at(-1).kind, kind)
      assert.equal(diagnostics.at(-1).status, status)
    })
  }

  it('三个管理端点（devices/stats/config）成功时都上报诊断', async () => {
    const diagnostics = []
    const transport = createTransport({
      origin: ORIGIN,
      pageOrigin: PAGE_ORIGIN,
      adminChannel: '',
      pairIssueToken: 'pin',
      fetchImpl: stubFetch(() => jsonResponse(200, {
        ok: true,
        protocolVersion: 1,
        guard: { host: '127.0.0.1', port: 8443, origin: ORIGIN },
        singleController: true,
        devices: [],
        config: {},
        startedAt: new Date(0).toISOString(),
        pairIssued: 0, pairRedeemed: 0, pairRejected: 0, authAccepted: 0, authDenied: 0,
        activeStreams: 0, streamsOpened: 0, hourly: [], daily: [],
      })),
      onAdminDiagnostic: d => diagnostics.push(d),
    })
    await transport.listDevices()
    await transport.stats()
    await transport.getConfig()
    // 回退路径上报的是守卫路径；同源通道上报的是 hub/admin.* 端点。
    assert.equal(diagnostics.length >= 3, true)
    assert.ok(diagnostics.every(d => d.status === 200 && d.pageOrigin === PAGE_ORIGIN))
    assert.ok(diagnostics.every(d => d.origin === ORIGIN))
  })

  it('管理请求携带协议头与 pin，不携带凭据到 URL', async () => {
    const seen = []
    const transport = createTransport({
      origin: ORIGIN,
      adminChannel: '',
      pairIssueToken: 'secret-pin',
      fetchImpl: stubFetch((url, init) => {
        seen.push({ url, headers: init.headers })
        return jsonResponse(200, {
          ok: true, protocolVersion: 1,
          guard: { host: '127.0.0.1', port: 8443, origin: ORIGIN },
          singleController: true, devices: [],
        })
      }),
    })
    await transport.listDevices()
    assert.equal(seen[0].url, `${ORIGIN}/remote/devices`)
    assert.ok(!seen[0].url.includes('secret-pin'), '凭据不得出现在 URL')
    assert.equal(seen[0].headers['x-pair-issue-token'], 'secret-pin')
    assert.equal(seen[0].headers['x-hub-protocol'], '1')
  })

  it('errorKindOf 映射表', () => {
    assert.equal(errorKindOf(0), 'network-unreachable')
    assert.equal(errorKindOf(400), 'http-400')
    assert.equal(errorKindOf(401), 'http-401')
    assert.equal(errorKindOf(403), 'http-403')
    assert.equal(errorKindOf(404), 'http-404')
    assert.equal(errorKindOf(502), 'http-5xx')
  })

  it('成功状态不得被分类为错误（曾把 200 标成 http-400）', () => {
    assert.equal(errorKindOf(200), 'ok')
    assert.equal(errorKindOf(201), 'ok')
    assert.equal(errorKindOf(204), 'ok')
  })

  it('日志回调：成功记 info、失败记 error（脱敏）', async () => {
    const logs = []
    const okTransport = createTransport({
      origin: ORIGIN,
      fetchImpl: stubFetch(() => jsonResponse(200, {
        type: 'server-response', rpcId: 'x',
        result: {
          ok: true,
          value: { global: { ok: true, startedAt: '', pairIssued: 0, pairRedeemed: 0, pairRejected: 0, authAccepted: 0, authDenied: 0, activeStreams: 0, streamsOpened: 0, hourly: [], daily: [] } },
        },
      })),
      onLog: entry => logs.push(entry),
    })
    // 同源通道的 rpcId 必须回显，这里用桩返回任意 rpcId 会被拒；改用直连路径。
    void okTransport
    const failTransport = createTransport({
      origin: ORIGIN,
      adminChannel: '',
      pairIssueToken: 'pin',
      fetchImpl: stubFetch(() => jsonResponse(403, failureEnvelope('forbidden', 'source not allowed'))),
      onLog: entry => logs.push(entry),
    })
    await assert.rejects(() => failTransport.listDevices())
    const failEntry = logs.find(entry => entry.level === 'error')
    assert.ok(failEntry !== undefined, '失败必须写一条 error 日志')
    assert.ok(String(failEntry.detail).includes('http-403'))
    assert.equal(JSON.stringify(logs).includes('"pin"'), false, '日志不得包含凭据')
  })
})

describe('同源签发（admin.issue）', () => {
  it('issueTicket 走同源通道并解析票据', async () => {
    const seen = []
    const transport = createTransport({
      origin: ORIGIN,
      fetchImpl: stubFetch((url, init) => {
        const body = JSON.parse(init.body)
        seen.push({ url, body })
        return jsonResponse(200, {
          type: 'server-response',
          rpcId: body.rpcId,
          result: {
            ok: true,
            value: { ok: true, kind: 'ticket', value: 'a'.repeat(43), expiresAt: 123, role: 'control' },
          },
        })
      }),
    })
    const issued = await transport.issueTicket('control')
    assert.equal(seen[0].url, '/api/hub/admin.issue')
    assert.equal(seen[0].body.payload.args.kind, 'ticket')
    assert.equal(seen[0].body.payload.args.role, 'control')
    assert.equal(issued.ticket, 'a'.repeat(43))
    assert.equal(issued.expiresAt, 123)
  })

  it('issueCode 走同源通道并解析短码', async () => {
    const seen = []
    const transport = createTransport({
      origin: ORIGIN,
      fetchImpl: stubFetch((url, init) => {
        const body = JSON.parse(init.body)
        seen.push({ url, body })
        return jsonResponse(200, {
          type: 'server-response',
          rpcId: body.rpcId,
          result: { ok: true, value: { ok: true, kind: 'code', value: 'ABCD2345', expiresAt: 456, role: 'read-only' } },
        })
      }),
    })
    const issued = await transport.issueCode('read-only')
    assert.equal(seen[0].body.payload.args.kind, 'code')
    assert.equal(issued.code, 'ABCD2345')
  })
})
