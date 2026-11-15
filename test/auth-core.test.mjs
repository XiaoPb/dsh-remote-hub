/**
 * 认证核心：口令哈希、TOTP、备用码、存储与账号/会话/客户端/租约语义。
 *
 * 这些测试直接消费 `lib/auth.js`（认证插件入口）。构建缺失时以静态断言兜底，
 * 绝不静默跳过。
 *
 * @module test/auth-core
 */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { PATHS, read, testLoadAuth } from './_helpers.mjs'

const auth = await testLoadAuth()
const dynamic = typeof auth.createAuthService === 'function'

/** 构造一个临时存储路径。 */
function tempStore(tag) {
  const dir = mkdtempSync(join(tmpdir(), `dsh-auth-${tag}-`))
  return { dir, path: join(dir, 'auth.json') }
}

/** 生成 ECDSA P-256 客户端密钥对（公钥 JWK + 签名函数）。 */
function clientKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  return {
    jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
    sign: (payload) => sign('sha256', Buffer.from(payload, 'utf8'), { key: privateKey, dsaEncoding: 'der' }).toString('base64'),
  }
}

/** 建一个已引导 + 已确认 MFA 的服务实例。 */
async function bootstrappedService(tag) {
  const { dir, path } = tempStore(tag)
  const store = await auth.createAuthStore(path)
  // 用真实时间起点，让签名时间戳与服务的 now() 一致（否则会被 skew 判据拒绝）。
  let clock = Date.now()
  const service = auth.createAuthService({ store, now: () => clock })
  const boot = await service.bootstrap({ username: 'owner', password: 'correct horse battery' })
  const setup = await service.startTotpSetup(boot.cookie)
  const secret = setup.secret
  const code = auth.totpCodeAt(secret, clock)
  await service.confirmTotp(boot.cookie, code)
  // 重新登录拿到 lastMfaAt 新鲜的会话。
  const login = await service.login({ username: 'owner', password: 'correct horse battery' })
  assert.equal(login.ok, true)
  assert.equal(login.response.mfaRequired, true, 'MFA must be required after confirmation')
  const mfa = await service.verifyMfa({
    mfaToken: login.response.mfaToken,
    code: auth.totpCodeAt(secret, clock),
  })
  return {
    service,
    dir,
    boot,
    secret,
    sessionCookie: mfa.cookie,
    advance: () => { clock += 1_000 },
    now: () => clock,
  }
}

test('auth module is exported from lib/auth.js', () => {
  if (dynamic) {
    for (const name of [
      'createAuthService', 'createAuthStore', 'hashPassword', 'verifyPassword',
      'verifyTotp', 'totpCodeAt', 'generateBackupCodes', 'hashBackupCode',
      'verifyEcdsa', 'buildProofPayload', 'createAuthHandler',
    ]) {
      assert.equal(typeof auth[name] === 'function' || typeof auth[name] === 'object', true, `${name} missing`)
    }
  }
  assert.match(read(join(PATHS.hostSrc, 'auth', 'service.ts')), /verifyHubRequest/u)
  assert.match(read(join(PATHS.hostSrc, 'auth', 'crypto.ts')), /timingSafeEqual/u)
})

test('password hashes are scrypt, salted, and never plaintext', { skip: !dynamic }, async () => {
  const a = await auth.hashPassword('hunter2-hunter2')
  const b = await auth.hashPassword('hunter2-hunter2')
  assert.match(a, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/u)
  assert.notEqual(a, b, 'salt must differ per hash')
  assert.equal(a.includes('hunter2'), false)
  assert.equal(await auth.verifyPassword('hunter2-hunter2', a), true)
  assert.equal(await auth.verifyPassword('wrong', a), false)
})

test('plaintext legacy verifier values are rejected', { skip: !dynamic }, async () => {
  assert.equal(await auth.verifyPassword('secret', 'secret'), false)
  assert.equal(await auth.verifyPassword('secret', 'scrypt$only-two'), false)
})

test('TOTP follows RFC 6238 SHA-1 6-digit semantics', { skip: !dynamic }, () => {
  // RFC 6238 test vector secret ("12345678901234567890") in base32.
  const secret = auth.base32Encode(Buffer.from('12345678901234567890', 'utf8'))
  assert.equal(auth.base32Decode(auth.base32Encode(Buffer.from('abc'))).toString(), 'abc')
  // RFC vector: T=59 → 94287082 (8 digits); 6-digit truncation is the low 6 digits.
  const at59 = auth.totpCodeAt(secret, 59_000)
  assert.match(at59, /^\d{6}$/u)
  assert.equal(at59, '287082')
  assert.equal(auth.verifyTotp(secret, at59, { now: () => 59_000 }), true)
  assert.equal(auth.verifyTotp(secret, '000000', { now: () => 59_000 }), false)
  // ±1 step window tolerance.
  assert.equal(auth.verifyTotp(secret, at59, { now: () => 89_000 }), true)
  assert.equal(auth.verifyTotp(secret, at59, { now: () => 200_000 }), false)
})

test('backup codes hash deterministically and are 10 distinct readable codes', { skip: !dynamic }, () => {
  const codes = auth.generateBackupCodes(10)
  assert.equal(codes.length, 10)
  assert.equal(new Set(codes).size, 10)
  for (const code of codes) assert.match(code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/u)
  assert.equal(auth.hashBackupCode(' abcde-fghjk '), auth.hashBackupCode('ABCDE-FGHJK'))
  assert.match(auth.hashBackupCode('ABCDE-FGHJK'), /^[0-9a-f]{64}$/u)
})

test('bashless bootstrap is loopback-only by route contract', () => {
  const routes = read(join(PATHS.hostSrc, 'auth', 'routes.ts'))
  assert.match(routes, /isLoopbackRequest\(req\)/u)
  assert.match(routes, /the first administrator may only be created from loopback/u)
  assert.match(routes, /SameSite=Strict/u)
})

test('auth store is atomic, 0600, and fails closed on corruption', { skip: !dynamic }, async () => {
  const { dir, path } = tempStore('store')
  try {
    const store = await auth.createAuthStore(path)
    await store.dispose()
    const mode = statSync(path).mode & 0o777
    if (process.platform !== 'win32') assert.equal(mode, 0o600)
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(raw.version, 1)
    assert.equal(raw.account, null)
    // 损坏的 JSON：必须拒绝启动，而不是静默清空。
    const { writeFileSync } = await import('node:fs')
    writeFileSync(path, '{ not json', 'utf8')
    await assert.rejects(() => auth.createAuthStore(path), /fail-closed|not valid JSON/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('bootstrap, MFA and session lifecycle', { skip: !dynamic }, async () => {
  const { service, dir, boot, sessionCookie } = await bootstrappedService('lifecycle')
  try {
    assert.match(boot.totpSecret, /^[A-Z2-7]{16,}$/u)
    assert.ok(Array.isArray(boot.backupCodes) && boot.backupCodes.length === 10)

    const status = await service.status(sessionCookie)
    assert.equal(status.bootstrapped, true)
    assert.equal(status.username, 'owner')
    assert.ok(status.session !== null)
    assert.equal(status.session.lastMfaAt !== null, true)

    // 未带会话 → 不返回客户端列表。
    const anon = await service.status(undefined)
    assert.equal(anon.session, null)
    assert.equal(anon.clients, undefined)

    // 登出后会话失效。
    await service.logout(sessionCookie)
    assert.equal(await service.readSession(sessionCookie), null)
  } finally {
    await service.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('login rate limits and does not leak account existence', { skip: !dynamic }, async () => {
  const { service, dir } = await bootstrappedService('ratelimit')
  try {
    const missing = await service.login({ username: 'nobody', password: 'x' })
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'auth-invalid-credentials')
    for (let index = 0; index < 6; index++) {
      await service.login({ username: 'nobody', password: 'wrong' })
    }
    const limited = await service.login({ username: 'nobody', password: 'wrong' })
    assert.equal(limited.ok, false)
    assert.equal(limited.code, 'auth-rate-limited')
  } finally {
    await service.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('MFA challenge is single-use and burns after 5 wrong codes', { skip: !dynamic }, async () => {
  const { service, dir, secret, now } = await bootstrappedService('challenge')
  try {
    const login = await service.login({ username: 'owner', password: 'correct horse battery' })
    assert.equal(login.response.mfaRequired, true)
    const token = login.response.mfaToken
    for (let index = 0; index < 5; index++) {
      const bad = await service.verifyMfa({ mfaToken: token, code: '000000' })
      assert.equal('error' in bad, true)
    }
    const burned = await service.verifyMfa({ mfaToken: token, code: auth.totpCodeAt(secret, now()) })
    assert.equal('error' in burned, true)
    assert.equal(burned.error, 'auth-rate-limited')
  } finally {
    await service.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('client enrollment requires a recent 2FA and yields a distinct key/lease', { skip: !dynamic }, async () => {
  const { service, dir, sessionCookie } = await bootstrappedService('enroll')
  try {
    const one = clientKeyPair()
    const two = clientKeyPair()
    const first = await service.enroll(sessionCookie, {
      label: 'browser-a', clientType: 'browser', publicKey: one.jwk, roleCeiling: 'control',
    })
    const second = await service.enroll(sessionCookie, {
      label: 'app-b', clientType: 'app', publicKey: two.jwk, roleCeiling: 'full',
    })
    assert.notEqual(first.client.clientId, second.client.clientId)
    assert.notEqual(first.lease.lease, second.lease.lease)
    assert.match(first.client.fingerprint, /^[0-9a-f]{16}$/u)
    assert.equal(first.client.roleCeiling, 'control')

    const clients = await service.listClients(sessionCookie)
    assert.equal(clients.length, 2)
    // 对外视图绝不包含公钥或租约密文。
    const json = JSON.stringify(clients)
    assert.equal(json.includes('"lease"'), false)
    assert.equal(json.includes('publicKey'), false)
    assert.equal(json.includes(first.lease.lease), false)
  } finally {
    await service.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('signed requests verify; replays and tampering are refused', { skip: !dynamic }, async () => {
  const { service, dir, sessionCookie } = await bootstrappedService('proof')
  try {
    const key = clientKeyPair()
    const enrolled = await service.enroll(sessionCookie, {
      label: 'browser', clientType: 'browser', publicKey: key.jwk, roleCeiling: 'control',
    })
    const lease = enrolled.lease.lease
    const audience = '127.0.0.1:8443'
    const bodyDigest = createHash('sha256').update('{}').digest('hex')
    const proof = (overrides = {}) => {
      const timestamp = String(Date.now())
      const nonce = overrides.nonce ?? `nonce${Math.random().toString(36).slice(2, 10)}`
      const payload = auth.buildProofPayload({
        method: 'POST',
        path: '/remote/rpc',
        audience,
        timestamp,
        nonce,
        clientId: enrolled.client.clientId,
        keyId: enrolled.client.keyId,
        generation: enrolled.lease.generation,
        bodyDigest,
        ...overrides,
      })
      return {
        'x-hub-client-id': enrolled.client.clientId,
        'x-hub-key-id': enrolled.client.keyId,
        'x-hub-ts': timestamp,
        'x-hub-nonce': nonce,
        'x-hub-body-sha256': bodyDigest,
        'x-hub-signature': key.sign(payload),
      }
    }

    const ok = await service.verifyHubRequest({
      lease: `Bearer ${lease}`, method: 'POST', path: '/remote/rpc', audience, bodyDigest, headers: proof(),
    })
    assert.equal(ok.ok, true, ok.ok ? '' : ok.reason)
    assert.equal(ok.claims.activeRole, 'control')

    // 同一 nonce 再来一次 → 拒绝。
    const headers = proof({ nonce: 'fixednonce1234' })
    const first = await service.verifyHubRequest({
      lease: `Bearer ${lease}`, method: 'POST', path: '/remote/rpc', audience, bodyDigest, headers,
    })
    assert.equal(first.ok, true)
    const replay = await service.verifyHubRequest({
      lease: `Bearer ${lease}`, method: 'POST', path: '/remote/rpc', audience, bodyDigest, headers,
    })
    assert.equal(replay.ok, false)
    assert.equal(replay.code, 'auth-proof-invalid')

    // 换了路径但签名没变 → 拒绝。
    const wrongPath = await service.verifyHubRequest({
      lease: `Bearer ${lease}`, method: 'POST', path: '/remote/devices', audience, bodyDigest, headers: proof(),
    })
    assert.equal(wrongPath.ok, false)

    // 无签名 → 拒绝（只有 Cookie/租约不够）。
    const noProof = await service.verifyHubRequest({
      lease: `Bearer ${lease}`, method: 'POST', path: '/remote/rpc', audience, bodyDigest, headers: {},
    })
    assert.equal(noProof.ok, false)
    assert.equal(noProof.code, 'auth-proof-invalid')
  } finally {
    await service.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('seven-day leases rotate, old generation is rejected and revokes the client', { skip: !dynamic }, async () => {
  const { service, dir, sessionCookie } = await bootstrappedService('lease')
  try {
    const key = clientKeyPair()
    const enrolled = await service.enroll(sessionCookie, {
      label: 'browser', clientType: 'browser', publicKey: key.jwk, roleCeiling: 'full',
    })
    const audience = '127.0.0.1:8443'
    const bodyDigest = createHash('sha256').update('').digest('hex')
    const signedHeaders = (generation, nonce) => {
      const timestamp = String(Date.now())
      const payload = auth.buildProofPayload({
        method: 'POST', path: '/remote-auth/lease', audience, timestamp, nonce,
        clientId: enrolled.client.clientId, keyId: enrolled.client.keyId, generation, bodyDigest,
      })
      return {
        'x-hub-client-id': enrolled.client.clientId,
        'x-hub-key-id': enrolled.client.keyId,
        'x-hub-ts': timestamp,
        'x-hub-nonce': nonce,
        'x-hub-body-sha256': bodyDigest,
        'x-hub-signature': key.sign(payload),
      }
    }
    const renewed = await service.renewLease({
      lease: enrolled.lease.lease,
      keyId: enrolled.client.keyId,
      generation: enrolled.lease.generation,
      proofHeaders: signedHeaders(enrolled.lease.generation, 'renewsignonce01'),
      audience, method: 'POST', path: '/remote-auth/lease', bodyDigest,
    })
    assert.equal('error' in renewed, false, renewed.reason ?? '')
    assert.equal(renewed.generation, enrolled.lease.generation + 1)
    assert.notEqual(renewed.lease, enrolled.lease.lease)

    // 旧租约重放 → 拒绝，并撤销该客户端。
    const stale = await service.verifyHubRequest({
      lease: `Bearer ${enrolled.lease.lease}`, method: 'POST', path: '/remote/rpc', audience,
      bodyDigest,
      headers: signedHeaders(enrolled.lease.generation, 'stalesignonce1'),
    })
    assert.equal(stale.ok, false)
    assert.equal(stale.code, 'auth-lease-expired')

    const clients = await service.listClients(sessionCookie)
    assert.equal(clients[0].revokedAt !== null, true, 'stale-generation replay must revoke the client')
  } finally {
    await service.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('role ceiling is enforced server-side', { skip: !dynamic }, async () => {
  const { service, dir, sessionCookie } = await bootstrappedService('roles')
  try {
    const key = clientKeyPair()
    const enrolled = await service.enroll(sessionCookie, {
      label: 'browser', clientType: 'browser', publicKey: key.jwk, roleCeiling: 'control',
    })
    const raised = await service.setActiveRole(sessionCookie, enrolled.client.clientId, 'full')
      .catch(error => error)
    assert.equal(raised.code, 'auth-role-exceeded')
    const ok = await service.setActiveRole(sessionCookie, enrolled.client.clientId, 'read-only')
    assert.equal(ok.activeRole, 'read-only')
  } finally {
    await service.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
