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
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  const boot = await service.bootstrap({ username: 'owner', password: 'Correct-Horse-9-Battery!' })
  const setup = await service.startTotpSetup(boot.cookie)
  const secret = setup.secret
  const code = auth.totpCodeAt(secret, clock)
  await service.confirmTotp(boot.cookie, code)
  // 重新登录拿到 lastMfaAt 新鲜的会话。
  const login = await service.login({ username: 'owner', password: 'Correct-Horse-9-Battery!' })
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
    advanceMs: (ms) => { clock += ms },
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

test('auth store lives in SQLite, is 0600, and fails closed on corruption', { skip: !dynamic }, async () => {
  const { dir, path } = tempStore('store')
  try {
    const store = await auth.createAuthStore(path)
    await store.dispose()
    const dbPath = path.replace(/\.json$/u, '.db')
    assert.ok(existsSync(dbPath), '应创建 auth.db')
    if (process.platform !== 'win32') assert.equal(statSync(dbPath).mode & 0o777, 0o600)
    // 损坏的库文件：必须拒绝启动，而不是静默重建。
    writeFileSync(dbPath, 'not a database', 'utf8')
    await assert.rejects(() => auth.createAuthStore(path), /not a database|fail-closed|unsupported/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('legacy auth.json is imported once and renamed', { skip: !dynamic }, async () => {
  const { dir, path } = tempStore('import')
  try {
    const passwordHash = await auth.hashPassword('Correct-Horse-9-Battery!')
    const legacy = {
      version: 1,
      account: {
        username: 'owner',
        passwordHash,
        totp: { secret: 'JBSWY3DPEHPK3PXP', verified: true, createdAt: 1 },
        createdAt: 1,
        updatedAt: 1,
        lastLoginAt: null,
      },
      clients: [],
      sessions: [],
      challenges: [],
      nonces: {},
      settings: { passwordPolicy: 'strong' },
    }
    writeFileSync(path, JSON.stringify(legacy), 'utf8')
    const store = await auth.createAuthStore(path)
    assert.equal(store.data.account?.username, 'owner')
    assert.equal(store.data.account?.isAdmin, true)
    assert.equal(store.data.account?.roleCeiling, 'full')
    assert.equal(store.data.settings?.passwordPolicy, 'strong')
    await store.dispose()
    assert.ok(!existsSync(path), 'auth.json 应被改名')
    assert.ok(existsSync(`${path}.imported`), '必须保留 auth.json.imported 作为回滚退路')

    // 再次打开：不重复导入，数据仍在。
    const again = await auth.createAuthStore(path)
    assert.equal(again.data.account?.username, 'owner')
    await again.dispose()
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
    const login = await service.login({ username: 'owner', password: 'Correct-Horse-9-Battery!' })
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

test('default account seeding forces exactly one password change before trust', { skip: !dynamic }, async () => {
  const { dir, path } = tempStore('seed')
  const store = await auth.createAuthStore(path)
  const service = auth.createAuthService({ store, now: () => Date.now() })
  try {
    const created = await service.seedDefaultAccount({ username: 'admin', password: 'admin12345' })
    assert.equal(created, true)
    // 已有账号时不再覆盖。
    assert.equal(await service.seedDefaultAccount({ username: 'evil', password: 'whatever1' }), false)

    const login = await service.login({ username: 'admin', password: 'admin12345' })
    assert.equal(login.ok, true)
    assert.equal(login.response.mfaRequired, false, 'TOTP is not bound yet')
    const cookie = login.cookie

    const status = await service.status(cookie)
    assert.equal(status.bootstrapped, true)
    assert.equal(status.passwordChangeRequired, true)

    // 改密之前：绑定 2FA / 信任客户端都被拒 —— 因此也拿不到 Hub 租约。
    await assert.rejects(
      () => service.startTotpSetup(cookie),
      error => error.code === 'auth-password-change-required',
    )
    await assert.rejects(
      () => service.enroll(cookie, {
        label: 'browser', clientType: 'browser', publicKey: clientKeyPair().jwk, roleCeiling: 'control',
      }),
      error => error.code === 'auth-password-change-required',
    )
    await assert.rejects(
      () => service.listClients(cookie),
      error => error.code === 'auth-password-change-required',
    )

    // 改密校验：当前口令错 / 新口令太短 / 与旧口令相同，都拒绝。
    await assert.rejects(
      () => service.changePassword(cookie, { currentPassword: 'nope', newPassword: 'An0ther-Strong-Pass!' }),
      error => error.code === 'auth-current-password-invalid',
    )
    await assert.rejects(
      () => service.changePassword(cookie, { currentPassword: 'admin12345', newPassword: 'short' }),
      error => error.code === 'auth-password-weak',
    )
    await assert.rejects(
      () => service.changePassword(cookie, { currentPassword: 'admin12345', newPassword: 'admin12345' }),
      error => error.code === 'auth-password-unchanged',
    )

    await service.changePassword(cookie, { currentPassword: 'admin12345', newPassword: 'An0ther-Strong-Pass!' })
    assert.equal((await service.status(cookie)).passwordChangeRequired, false)
    assert.equal(await service.passwordChangeRequired(cookie), false)

    // 强制只发生一次：之后可以正常绑定 2FA，且不会再要求改密。
    const setup = await service.startTotpSetup(cookie)
    assert.match(setup.secret, /^[A-Z2-7]{16,}$/u)
    await service.confirmTotp(cookie, auth.totpCodeAt(setup.secret, Date.now()))
    assert.equal((await service.status(cookie)).passwordChangeRequired, false)

    // 旧口令失效，新口令可登录。
    const oldLogin = await service.login({ username: 'admin', password: 'admin12345' })
    assert.equal(oldLogin.ok, false)
    assert.equal(oldLogin.code, 'auth-invalid-credentials')
    const newLogin = await service.login({ username: 'admin', password: 'An0ther-Strong-Pass!' })
    assert.equal(newLogin.ok, true)
    assert.equal(newLogin.response.mfaRequired, true)
  } finally {
    await service.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('password policy: strong by default, weak rejected, switchable in settings', { skip: !dynamic }, async () => {
  // 纯函数判定（Host 与设置页共用）。
  assert.equal(auth.evaluatePassword('Short1!', 'strong').ok, false)
  assert.equal(auth.evaluatePassword('Correct-Horse-9!', 'strong').ok, true)
  assert.equal(auth.evaluatePassword('Correct-Horse-9!', 'strong', 'horse').ok, false)
  assert.deepEqual(
    auth.evaluatePassword('short', 'strong').failures.sort(),
    ['no-digit', 'no-symbol', 'no-upper', 'too-short'].sort(),
  )
  assert.equal(auth.evaluatePassword('abcdefgh', 'basic').ok, true)
  assert.equal(auth.evaluatePassword('abcdefgh', 'strong').ok, false)
  assert.equal(auth.passwordRules('strong').length, 6)
  assert.equal(auth.passwordRules('basic').length, 1)

  const { dir, path } = tempStore('policy')
  const store = await auth.createAuthStore(path)
  const service = auth.createAuthService({ store, now: () => Date.now() })
  try {
    assert.equal(service.passwordPolicy(), 'strong', 'default policy must be strong')
    await service.seedDefaultAccount({ username: 'admin', password: 'K7Qm-2xVt9-pLr4!sW' })
    const login = await service.login({ username: 'admin', password: 'K7Qm-2xVt9-pLr4!sW' })
    assert.equal(login.ok, true)
    const cookie = login.cookie
    assert.equal((await service.status(cookie)).passwordPolicy, 'strong')

    // 弱口令不能被使用（返回未满足项清单）。
    const weak = await service
      .changePassword(cookie, { currentPassword: 'K7Qm-2xVt9-pLr4!sW', newPassword: 'weakpass' })
      .catch(error => error)
    assert.equal(weak.code, 'auth-password-weak')
    assert.ok(Array.isArray(weak.failures) && weak.failures.includes('too-short'))

    // 强口令通过；改密同时清掉强制标记。
    await service.changePassword(cookie, { currentPassword: 'K7Qm-2xVt9-pLr4!sW', newPassword: 'Strong-Pass-10!' })
    assert.equal(service.initialPasswordPending(), false)

    // 设置页切到 basic：立即生效（无需重启）。
    assert.equal(await service.setPasswordPolicy(cookie, 'basic'), 'basic')
    assert.equal(service.passwordPolicy(), 'basic')
    assert.equal((await service.status(cookie)).passwordPolicy, 'basic')
    await service.changePassword(cookie, { currentPassword: 'Strong-Pass-10!', newPassword: 'basicpass' })
    assert.equal((await service.login({ username: 'admin', password: 'basicpass' })).ok, true)

    // 切回 strong 后同一类口令再次被拒。
    assert.equal(await service.setPasswordPolicy(cookie, 'strong'), 'strong')
    const rejected = await service
      .changePassword(cookie, { currentPassword: 'basicpass', newPassword: 'anotherweak' })
      .catch(error => error)
    assert.equal(rejected.code, 'auth-password-weak')

    // 非法策略值被拒绝。
    const bad = await service.setPasswordPolicy(cookie, 'whatever').catch(error => error)
    assert.equal(bad.code, 'auth-bad-request')
  } finally {
    await service.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('generated initial passwords satisfy the configured policy', { skip: !dynamic }, () => {
  const pluginSrc = read(join(PATHS.hostSrc, 'auth', 'plugin.ts'))
  assert.match(pluginSrc, /export function generateInitialPassword/u)
  assert.match(pluginSrc, /evaluatePassword\(candidate, policy\)\.ok/u)
  // 策略默认 strong，且可从设置页切换。
  assert.match(pluginSrc, /passwordPolicy: z\.union\(\[z\.const\('strong'\), z\.const\('basic'\)\]\)\.default\(DEFAULT_PASSWORD_POLICY\)/u)
})

test('account-auth defaults to enabled in the Host config schema', () => {
  const config = read(join(PATHS.hostSrc, 'config.ts'))
  assert.match(config, /accountAuth: z\.object\(\{[\s\S]*?enabled: z\.boolean\(\)\.default\(true\)/u)
  const patch = read(join(PATHS.packageJson, '..', 'cordis.patch.yml'))
  assert.match(patch, /accountAuth:\s*\n\s*enabled: true/u)
  assert.match(patch, /id: remote-hub-auth/u)
  assert.match(patch, /name: '@xiaopb\/dsh-remote-hub\/auth'/u)
  // 初始口令不是写死的固定值：默认空串 = 安装时随机生成到本地文件。
  assert.match(patch, /password: ''/u)
  assert.doesNotMatch(patch, /password: admin12345/u)
})

test('initial password is one-time: pending after seeding, cleared after the forced change', { skip: !dynamic }, async () => {
  const { dir, path } = tempStore('initial-password')
  const store = await auth.createAuthStore(path)
  const consumed = []
  const service = auth.createAuthService({
    store,
    now: () => Date.now(),
    onForcedPasswordChanged: () => { consumed.push(true) },
  })
  try {
    assert.equal(service.initialPasswordPending(), false, 'no account yet')
    const generated = 'K7Qm-2xVt9-pLr4!sW'
    assert.equal(await service.seedDefaultAccount({ username: 'admin', password: generated }), true)
    assert.equal(service.initialPasswordPending(), true)

    const login = await service.login({ username: 'admin', password: generated })
    assert.equal(login.ok, true)
    assert.equal((await service.status(login.cookie)).passwordChangeRequired, true)

    await service.changePassword(login.cookie, { currentPassword: generated, newPassword: 'My-0wn-Passphrase!' })
    assert.equal(service.initialPasswordPending(), false)
    assert.equal(consumed.length, 1, 'plugin must be told to delete the plaintext initial-password file')

    // 之后的普通改密不再触发「初始口令消费」回调。
    await service.changePassword(login.cookie, { currentPassword: 'My-0wn-Passphrase!', newPassword: 'Yet-An0ther-Pass!!' })
    assert.equal(consumed.length, 1)
  } finally {
    await service.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the initial password file is declared and never logged', () => {
  const core = read(join(PATHS.coreSrc, 'auth.ts'))
  assert.match(core, /INITIAL_PASSWORD_FILE = 'initial-password'/u)
  assert.match(core, /password: ''/u)
  const plugin = read(join(PATHS.hostSrc, 'auth', 'plugin.ts'))
  assert.match(plugin, /writePrivateFile\(initialPasswordPath, initialBody\)/u)
  assert.match(plugin, /onForcedPasswordChanged: removeInitialPassword/u)
  const store = read(join(PATHS.hostSrc, 'auth', 'store.ts'))
  assert.match(store, /export async function writePrivateFile/u)
  assert.match(store, /mode: 0o600/u)
  // 明确不把口令本身写进日志字符串：日志只带文件路径。
  assert.doesNotMatch(plugin, /logger\?\.warn\?\.\(`[^`]*\$\{password\}/u)
})

test('raising a client ceiling requires a fresh MFA; lowering does not', { skip: !dynamic }, async () => {
  const env = await bootstrappedService('ceiling-mfa')
  try {
    const key = clientKeyPair()
    const enrolled = await env.service.enroll(env.sessionCookie, {
      label: 'browser', clientType: 'browser', publicKey: key.jwk, roleCeiling: 'read-only',
    })
    // 刚验证过 2FA：可以直接提。
    const raised = await env.service.setRoleCeiling(env.sessionCookie, enrolled.client.clientId, 'control')
    assert.equal(raised.roleCeiling, 'control')

    // 超过 2FA 信任窗后：提升被拒，且给出可识别的错误码。
    env.advanceMs(11 * 60 * 1000)
    await assert.rejects(
      () => env.service.setRoleCeiling(env.sessionCookie, enrolled.client.clientId, 'full'),
      (error) => error.code === 'auth-mfa-required',
    )

    // 降级不需要重新验证（不应把管理员锁死）。
    const lowered = await env.service.setRoleCeiling(env.sessionCookie, enrolled.client.clientId, 'read-only')
    assert.equal(lowered.roleCeiling, 'read-only')

    // 重新验证：刷新 2FA 窗口并**轮换会话密钥**，旧令牌立即失效。
    const sessionBefore = (await env.service.status(env.sessionCookie)).session
    const rotated = await env.service.reauth(env.sessionCookie, {
      password: 'Correct-Horse-9-Battery!',
      code: auth.totpCodeAt(env.secret, env.now()),
    })
    assert.notEqual(rotated.cookie, env.sessionCookie, '会话密钥必须轮换')
    assert.equal((await env.service.status(env.sessionCookie)).session, null, '旧令牌必须失效')
    const sessionAfter = (await env.service.status(rotated.cookie)).session
    assert.equal(sessionAfter.accountId, sessionBefore.accountId)
    const raisedAgain = await env.service.setRoleCeiling(rotated.cookie, enrolled.client.clientId, 'full')
    assert.equal(raisedAgain.roleCeiling, 'full')

    // 口令错也必须拒绝，不能只凭验证码提权。
    env.advanceMs(11 * 60 * 1000)
    await assert.rejects(
      () => env.service.reauth(rotated.cookie, {
        password: 'wrong', code: auth.totpCodeAt(env.secret, env.now()),
      }),
      (error) => error.code === 'auth-invalid-credentials',
    )
  } finally {
    rmSync(env.dir, { recursive: true, force: true })
  }
})

test('login throttling is per source, so one attacker cannot lock the account', { skip: !dynamic }, async () => {
  const env = await bootstrappedService('rate-source')
  try {
    const wrong = 'definitely-not-it'
    // 同一来源连续失败达到上限。
    for (let attempt = 0; attempt < 6; attempt++) {
      await env.service.login({ username: 'owner', password: wrong, source: '10.0.0.1' })
    }
    const blocked = await env.service.login({ username: 'owner', password: wrong, source: '10.0.0.1' })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.code, auth.AUTH_ERROR_CODES.rateLimited)

    // 另一个来源不受影响：仍然走到口令校验。
    const other = await env.service.login({ username: 'owner', password: wrong, source: '10.0.0.2' })
    assert.equal(other.ok, false)
    assert.equal(other.code, auth.AUTH_ERROR_CODES.invalidCredentials)

    // 正常来源仍可登录（用户名维度更宽：4×上限）。
    const legitimate = await env.service.login({
      username: 'owner', password: 'Correct-Horse-9-Battery!', source: '10.0.0.2',
    })
    assert.equal(legitimate.ok, true)
  } finally {
    rmSync(env.dir, { recursive: true, force: true })
  }
})

test('idle sessions expire before their absolute TTL', { skip: !dynamic }, async () => {
  const env = await bootstrappedService('session-idle')
  try {
    // 刚登录：会话可用。
    const before = await env.service.status(env.sessionCookie)
    assert.notEqual(before.session, null)

    // 闲置超过 12 小时：会话作废，且被标记撤销。
    env.advanceMs(13 * 60 * 60 * 1000)
    const after = await env.service.status(env.sessionCookie)
    assert.equal(after.session, null)
    await assert.rejects(() => env.service.listClients(env.sessionCookie))
  } finally {
    rmSync(env.dir, { recursive: true, force: true })
  }
})

test('anonymous status hides the account name and password policy', { skip: !dynamic }, async () => {
  const env = await bootstrappedService('status-anon')
  try {
    const anonymous = await env.service.status(undefined)
    assert.equal(anonymous.bootstrapped, true)
    assert.equal(anonymous.session, null)
    assert.equal(anonymous.username, undefined, '匿名请求不应泄露账号名')
    assert.equal(anonymous.passwordPolicy, undefined, '匿名请求不应泄露口令策略')

    const authed = await env.service.status(env.sessionCookie)
    assert.equal(authed.username, 'owner')
    assert.equal(authed.passwordPolicy, 'strong')
  } finally {
    rmSync(env.dir, { recursive: true, force: true })
  }
})

test('header sessions can be issued with a shorter TTL', { skip: !dynamic }, async () => {
  const env = await bootstrappedService('header-ttl')
  try {
    const login = await env.service.login({
      username: 'owner', password: 'Correct-Horse-9-Battery!', sessionTtlMs: 60_000,
    })
    assert.equal(login.ok, true)
    const issued = await env.service.verifyMfa({
      mfaToken: login.response.mfaToken,
      code: auth.totpCodeAt(env.secret, env.now()),
      sessionTtlMs: 60_000,
    })
    assert.equal('error' in issued, false)
    assert.ok(issued.session.expiresAt - env.now() <= 61_000, '跨源会话应显著短于 7 天')

    // 超过短 TTL 后会话失效（不必等到 7 天）。
    env.advanceMs(120_000)
    assert.equal((await env.service.status(issued.cookie)).session, null)
  } finally {
    rmSync(env.dir, { recursive: true, force: true })
  }
})
