/**
 * 守卫在账号认证模式下只接受「租约 + 客户端签名」。
 *
 * 起一个真实守卫（临时端口 + 真实认证服务），只把 dispatcher 换成桩。
 *
 * @module test/auth-guard
 */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

const mod = await import('../lib/index.js')
const auth = await import('../lib/auth.js')

const calls = []

const dispatcherStub = {
  peerFor(deviceId, role) {
    calls.push({ kind: 'peerFor', deviceId, role })
    return { deviceId, role }
  },
  async fetch(endpoint, envelope, peer) {
    calls.push({ kind: 'fetch', endpoint, peer })
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  },
  async drop() {},
  async dispose() {},
  get size() { return 0 },
}

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  return {
    jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
    sign: payload => sign('sha256', Buffer.from(payload, 'utf8'), { key: privateKey, dsaEncoding: 'der' }).toString('base64'),
  }
}

/** 构造一次带签名的 RPC 请求。 */
function signedRpc(base, enrolled, key, bodyText, overrides = {}) {
  const url = new URL('/remote/rpc', base)
  const bodyDigest = createHash('sha256').update(bodyText).digest('hex')
  const timestamp = String(Date.now())
  const nonce = overrides.nonce ?? `n${Math.random().toString(36).slice(2, 12)}`
  const payload = auth.buildProofPayload({
    method: 'POST',
    path: '/remote/rpc',
    audience: url.host.toLowerCase(),
    timestamp,
    nonce,
    clientId: enrolled.client.clientId,
    keyId: enrolled.client.keyId,
    generation: enrolled.lease.generation,
    bodyDigest,
  })
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-protocol': '1',
      authorization: `Bearer ${enrolled.lease.lease}`,
      'x-hub-client-id': enrolled.client.clientId,
      'x-hub-key-id': enrolled.client.keyId,
      'x-hub-ts': timestamp,
      'x-hub-nonce': nonce,
      'x-hub-body-sha256': bodyDigest,
      'x-hub-signature': key.sign(payload),
    },
    body: bodyText,
  })
}

describe('守卫：账号认证模式', () => {
  let dir
  let guard
  let base
  let service
  let sessionCookie
  let enrolled
  let key
  let store
  let totpSecret
  let clockNow = () => Date.now()

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hub-auth-guard-'))
    const config = {
      ...mod.DEFAULT_CONFIG,
      guardPort: 0,
      deviceTablePath: join(dir, 'devices.json'),
      accountAuth: { enabled: true },
    }

    store = await auth.createAuthStore(join(dir, 'auth.json'))
    const clock = Date.now()
    clockNow = () => clock
    service = auth.createAuthService({ store, now: clockNow })
    const boot = await service.bootstrap({ username: 'owner', password: 'Correct-Horse-9-Battery!' })
    const setup = await service.startTotpSetup(boot.cookie)
    totpSecret = setup.secret
    await service.confirmTotp(boot.cookie, auth.totpCodeAt(setup.secret, clock))
    const login = await service.login({ username: 'owner', password: 'Correct-Horse-9-Battery!' })
    const mfa = await service.verifyMfa({
      mfaToken: login.response.mfaToken,
      code: auth.totpCodeAt(setup.secret, clock),
    })
    sessionCookie = mfa.cookie
    key = keyPair()
    enrolled = await service.enroll(sessionCookie, {
      label: 'browser',
      clientType: 'browser',
      publicKey: key.jwk,
      roleCeiling: 'control',
    })

    const devices = await mod.createDeviceStore(config.deviceTablePath)
    const tokens = mod.createTokenService({ devices })
    const pairing = mod.createPairingService({
      config: {
        pairQrTtlMs: config.pairQrTtlMs,
        pairCodeTtlMs: config.pairCodeTtlMs,
        maxPairAttempts: config.maxPairAttempts,
        defaultRole: config.defaultRole,
      },
      tokens,
    })
    guard = await mod.startGuard({
      config,
      tokens,
      pairing,
      dispatcher: dispatcherStub,
      devices,
      pairIssueToken: 'test-issue-token',
      auth: service,
      // 跨源「账号 + TOTP」面：同一个处理器，头会话版本。
      authHttp: {
        paths: Object.values(auth.AUTH_ROUTES),
        handle: (request, response) => auth.createAuthHandler({
          service,
          allowHeaderSession: true,
        })(request, response),
      },
    })
    base = guard.origin
  })

  after(async () => {
    await guard?.dispose()
    await service?.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('rejects an RPC carrying only a lease (no client signature)', async () => {
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: 'r1',
      method: 'session/list',
      payload: { args: {} },
    })
    const response = await fetch(`${base}/remote/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-protocol': '1',
        authorization: `Bearer ${enrolled.lease.lease}`,
      },
      body,
    })
    assert.equal(response.status, 401, 'a stolen lease alone must not authenticate')
  })

  it('rejects a legacy long-lived device token in account-auth mode', async () => {
    // 旧设备令牌不会被静默升级成受信客户端。
    const devices = await mod.createDeviceStore(join(dir, 'devices-legacy.json'))
    const tokens = mod.createTokenService({ devices })
    const legacy = await tokens.issue({ label: 'legacy', role: 'control' })
    const response = await fetch(`${base}/remote/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-protocol': '1',
        authorization: `Bearer ${legacy.token}`,
      },
      body: '{}',
    })
    assert.equal(response.status, 401)
  })

  it('accepts a properly signed RPC and forwards the granted role', async () => {
    calls.length = 0
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: 'r2',
      method: 'session/list',
      payload: { args: {} },
    })
    const response = await signedRpc(base, enrolled, key, body)
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal(response.headers.get('x-hub-protocol'), '1')
    const peer = calls.find(call => call.kind === 'peerFor')
    assert.equal(peer.deviceId, enrolled.client.clientId)
    assert.equal(peer.role, 'control')
  })

  it('refuses a replayed nonce even when the signature is valid', async () => {
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: 'r3',
      method: 'session/list',
      payload: { args: {} },
    })
    const first = await signedRpc(base, enrolled, key, body, { nonce: 'fixed-nonce-0001' })
    assert.equal(first.status, 200)
    const replay = await signedRpc(base, enrolled, key, body, { nonce: 'fixed-nonce-0001' })
    assert.equal(replay.status, 401)
  })

  it('ws-ticket requires a client signature and returns a one-time ticket', async () => {
    const url = new URL('/remote/ws-ticket', base)
    const bodyText = '{}'
    const bodyDigest = createHash('sha256').update(bodyText).digest('hex')
    const timestamp = String(Date.now())
    const nonce = 'wsticketnonce01'
    const payload = auth.buildProofPayload({
      method: 'POST',
      path: '/remote/ws-ticket',
      audience: url.host.toLowerCase(),
      timestamp,
      nonce,
      clientId: enrolled.client.clientId,
      keyId: enrolled.client.keyId,
      generation: enrolled.lease.generation,
      bodyDigest,
    })
    const headers = {
      'content-type': 'application/json',
      'x-hub-protocol': '1',
      authorization: `Bearer ${enrolled.lease.lease}`,
      'x-hub-client-id': enrolled.client.clientId,
      'x-hub-key-id': enrolled.client.keyId,
      'x-hub-ts': timestamp,
      'x-hub-nonce': nonce,
      'x-hub-body-sha256': bodyDigest,
      'x-hub-signature': key.sign(payload),
    }

    const unsigned = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-protocol': '1', authorization: `Bearer ${enrolled.lease.lease}` },
      body: bodyText,
    })
    assert.equal(unsigned.status, 401)

    const granted = await fetch(url, { method: 'POST', headers, body: bodyText })
    assert.equal(granted.status, 200)
    const grant = await granted.json()
    assert.match(grant.ticket, /^[A-Za-z0-9_-]{40,}$/u)
    assert.ok(grant.expiresAt > Date.now())
  })

  it('serves the account surface on the guard for cross-origin clients', async () => {
    // 不要求 x-hub-protocol：这是给控制端浏览器用的标准 JSON API。
    const status = await fetch(`${base}/remote-auth/status`)
    assert.equal(status.status, 200)
    const statusBody = await status.json()
    assert.equal(statusBody.bootstrapped, true)

    const login = await fetch(`${base}/remote-auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'wrong' }),
    })
    assert.equal(login.status, 401)
    assert.equal((await login.json()).code, 'auth-invalid-credentials')

    // 头会话：登录 → 第二步 → 拿 sessionToken，之后用它读写设置面。
    const ok = await fetch(`${base}/remote-auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'Correct-Horse-9-Battery!' }),
    })
    assert.equal(ok.status, 200)
    const challenge = await ok.json()
    assert.equal(challenge.mfaRequired, true, 'MFA is bound, so login stops at the second step')

    const second = await fetch(`${base}/remote-auth/mfa`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mfaToken: challenge.mfaToken,
        code: auth.totpCodeAt(totpSecret, clockNow()),
      }),
    })
    assert.equal(second.status, 200)
    const token = (await second.json()).sessionToken
    assert.equal(typeof token, 'string')
    const clients = await fetch(`${base}/remote-auth/clients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: 'list' }),
    })
    assert.equal(clients.status, 200, 'header session must authenticate without a cookie')
    assert.equal((await clients.json()).ok, true)
  })

  it('refuses legacy invitation redemption while account auth is enabled', async () => {
    // 旧流程会签发一个紧接着就被守卫拒绝的 bearer —— 必须显式报错而不是发无效令牌。
    const response = await fetch(`${base}/remote/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-protocol': '1' },
      body: JSON.stringify({ code: 'ABCD1234', clientLabel: 'legacy' }),
    })
    assert.equal(response.status, 403)
    const body = await response.json()
    assert.equal(body.result.error.code, 'auth-account-required')
  })

  it('rejects requests whose body does not match the signed digest', async () => {
    const signedBody = JSON.stringify({
      type: 'client-request', rpcId: 'r4', method: 'session/list', payload: { args: {} },
    })
    const url = new URL('/remote/rpc', base)
    const bodyDigest = createHash('sha256').update(signedBody).digest('hex')
    const timestamp = String(Date.now())
    const nonce = 'bodymismatch001'
    const payload = auth.buildProofPayload({
      method: 'POST',
      path: '/remote/rpc',
      audience: url.host.toLowerCase(),
      timestamp,
      nonce,
      clientId: enrolled.client.clientId,
      keyId: enrolled.client.keyId,
      generation: enrolled.lease.generation,
      bodyDigest,
    })
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-protocol': '1',
        authorization: `Bearer ${enrolled.lease.lease}`,
        'x-hub-client-id': enrolled.client.clientId,
        'x-hub-key-id': enrolled.client.keyId,
        'x-hub-ts': timestamp,
        'x-hub-nonce': nonce,
        'x-hub-body-sha256': bodyDigest,
        'x-hub-signature': key.sign(payload),
      },
      // 换了正文：摘要不符。
      body: JSON.stringify({ type: 'client-request', rpcId: 'r4', method: 'settings/update', payload: { args: {} } }),
    })
    assert.equal(response.status, 401)
  })
})
