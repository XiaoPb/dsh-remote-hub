/**
 * 客户端认证原语：WebCrypto 密钥环、每请求签名、租约轮换、WS 票据。
 *
 * 浏览器半区产物是 CJS 闭包，测试改为加载 `.build/client` 里的 ESM 模块
 * （与 `local-plugin-manager-transport.test.mjs` 同一套别名重写手法），
 * 并用 host 侧 `lib/auth.js` 做**跨实现**验签。
 *
 * @module test/auth-client
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

const hostAuth = await import('../lib/auth.js')

const CORE_FILES = ['index', 'protocol', 'auth', 'roles', 'device', 'capabilities', 'capabilities-redlines', 'version-drift', 'redact', 'carrier-contract']

/**
 * 加载 `.build/client` 里的一个模块（把 `@core/...` 改写成相对路径）。
 * @param relativeFile - 相对 `.build/client/client/src/` 的路径。
 * @returns 模块命名空间。
 */
async function loadBuiltClientModule(relativeFile) {
  const source = await readFile(new URL(`../.build/client/client/src/${relativeFile}`, import.meta.url), 'utf8')
  // 临时目录放在仓库内（`.build/`），这样模块里的 `react` 等裸导入能按仓库
  // node_modules 解析；放在系统 tmp 下会 ERR_MODULE_NOT_FOUND。
  const stagingRoot = new URL('../.build/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1')
  const directory = await mkdtemp(join(stagingRoot, 'tmp-auth-client-'))
  const coreDir = join(directory, 'core', 'src')
  await mkdir(coreDir, { recursive: true })
  for (const name of CORE_FILES) {
    try {
      const text = await readFile(new URL(`../.build/client/core/src/${name}.js`, import.meta.url), 'utf8')
      await writeFile(join(coreDir, `${name}.js`), text, 'utf8')
    } catch {
      // 可选 core 文件缺失时跳过。
    }
  }
  // 依赖的相对路径也要镜像过去（auth/ 子目录）。
  // ⚠️ 每个镜像文件都要把 `@core/*` 改写成相对路径——只改目标文件会让
  // 被依赖的模块（如 `lazy.js` 依赖的 `session.js`）解析失败。
  const authDir = join(directory, 'auth')
  await mkdir(authDir, { recursive: true })
  const rewriteCore = (text, prefix) => text.replace(/from '@core\/([^']+)'/gu, (_match, rest) => `from '${prefix}/${rest}'`)
  for (const name of ['keyring', 'session', 'lazy']) {
    try {
      const text = await readFile(new URL(`../.build/client/client/src/auth/${name}.js`, import.meta.url), 'utf8')
      await writeFile(join(authDir, `${name}.js`), rewriteCore(text, '../core/src'), 'utf8')
    } catch {
      // 缺失时由导入方报错，测试自然失败。
    }
  }
  // 目标保留原目录结构，模块内部的相对导入（`./keyring.js`）才能解析。
  const target = join(directory, relativeFile)
  await mkdir(join(target, '..'), { recursive: true })
  const depth = relativeFile.split('/').length - 1
  const corePrefix = `${'../'.repeat(depth)}core/src`
  const rewritten = rewriteCore(source, corePrefix)
  await writeFile(target, rewritten, 'utf8')
  try {
    return await import(pathToFileURL(target).href)
  } catch (error) {
    // 保留目录便于复现；`.build/` 已在 .gitignore 内。
    throw error
  }
}

const keyring = await loadBuiltClientModule('auth/keyring.js')
const session = await loadBuiltClientModule('auth/session.js')
const accountPage = await loadBuiltClientModule('auth/AccountPage.js')

/** 把 React 树渲染成静态 HTML（不依赖浏览器）。 */
async function renderMarkup(node) {
  const { renderToStaticMarkup } = await import('react-dom/server')
  return renderToStaticMarkup(node)
}

/** 空动作集（渲染测试不触发副作用）。 */
function noopActions() {
  return {
    onSubmitBootstrap() {},
    onSubmitLogin() {},
    onSubmitMfa() {},
    onChangePassword() {},
    onForgetPeer() {},
    onEscalationChange() {},
    onEscalationSubmit() {},
    onEscalationCancel() {},
    onStartTotp() {},
    onTotpChange() {},
    onConfirmTotp() {},
    onDisableTotp() {},
    onCancelTotp() {},
    onSetPasswordPolicy() {},
    onTrustClient() {},
    onRevokeClient() {},
    onSetRole() {},
    onSetCeiling() {},
    onLogout() {},
    onRefresh() {},
  }
}

test('WebCrypto keyring produces a non-extractable ECDSA P-256 key', async () => {
  const identity = await keyring.generateClientIdentity()
  assert.equal(identity.publicKey.kty, 'EC')
  assert.equal(identity.publicKey.crv, 'P-256')
  assert.match(identity.publicKey.x, /^[A-Za-z0-9_-]{20,}$/u)
  assert.equal(identity.privateKey.extractable, false, 'private key must never be exportable')
  assert.equal(identity.privateKey.type, 'private')
  await assert.rejects(() => globalThis.crypto.subtle.exportKey('jwk', identity.privateKey))
})

test('client signature verifies against the host verifier (cross-implementation)', async () => {
  const identity = await keyring.generateClientIdentity()
  const payload = hostAuth.buildProofPayload({
    method: 'POST',
    path: '/remote/rpc',
    audience: '127.0.0.1:8443',
    timestamp: '1700000000000',
    nonce: 'nonce-abcdefgh',
    clientId: 'cli_0123456789abcdef01234567',
    keyId: 'key_abc',
    generation: 1,
    bodyDigest: 'a'.repeat(64),
  })
  const signature = await keyring.signPayload(identity.privateKey, payload)
  assert.equal(hostAuth.verifyEcdsa(identity.publicKey, payload, signature), true)
  // 改一个字节就必须失败。
  assert.equal(hostAuth.verifyEcdsa(identity.publicKey, `${payload}x`, signature), false)
})

test('sha256Hex matches node crypto', async () => {
  const text = '正文参与摘要：{"a":1}'
  assert.equal(await keyring.sha256Hex(text), createHash('sha256').update(text, 'utf8').digest('hex'))
})

test('signer emits a full lease + proof header set the host accepts', async () => {
  const identity = await keyring.generateClientIdentity()
  const origin = 'http://127.0.0.1:8443'
  const clientId = 'cli_0123456789abcdef01234567'
  const keyId = hostAuth.AUTH_HEADERS // 占位，避免未使用告警
  void keyId
  const signer = session.createAuthSigner({
    origin,
    identity,
    clientId,
    keyId: 'key_abc123',
    lease: { lease: `${clientId}.1.secretsecretsecret`, generation: 1, expiresAt: Date.now() + 60_000 },
    now: () => 1_700_000_000_000,
  })
  const body = JSON.stringify({ type: 'client-request' })
  const headers = await signer.headers({ method: 'POST', path: '/remote/rpc?x=1', body })
  assert.equal(headers.authorization, `Bearer ${clientId}.1.secretsecretsecret`)
  assert.equal(headers['x-hub-client-id'], clientId)
  assert.equal(headers['x-hub-key-id'], 'key_abc123')
  assert.equal(headers['x-hub-body-sha256'], createHash('sha256').update(body).digest('hex'))

  // 用 host 侧同一套规范化字符串复算，必须验签通过。
  const payload = hostAuth.buildProofPayload({
    method: 'POST',
    path: '/remote/rpc',
    audience: '127.0.0.1:8443',
    timestamp: headers['x-hub-ts'],
    nonce: headers['x-hub-nonce'],
    clientId,
    keyId: 'key_abc123',
    generation: 1,
    bodyDigest: headers['x-hub-body-sha256'],
  })
  assert.equal(hostAuth.verifyEcdsa(identity.publicKey, payload, headers['x-hub-signature']), true)
})

test('signer renews once for concurrent callers and refreshes the lease', async () => {
  const identity = await keyring.generateClientIdentity()
  const clientId = 'cli_0123456789abcdef01234567'
  let calls = 0
  const fetchImpl = async (url, init) => {
    calls += 1
    assert.match(String(url), /\/remote-auth\/lease$/u)
    assert.match(String(init.headers.authorization ?? ''), /^Bearer cli_/u)
    return new Response(JSON.stringify({
      ok: true,
      lease: `${clientId}.2.newsecretnewsecret`,
      generation: 2,
      expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const signer = session.createAuthSigner({
    origin: 'http://127.0.0.1:8443',
    identity,
    clientId,
    keyId: 'key_abc123',
    lease: { lease: `${clientId}.1.oldsecretoldsecret`, generation: 1, expiresAt: Date.now() + 1_000 },
    fetchImpl,
  })
  const [a, b] = await Promise.all([signer.renew(), signer.renew()])
  assert.equal(calls, 1, 'concurrent renewal must be coalesced (old generation would be revoked)')
  assert.equal(a.generation, 2)
  assert.equal(b.generation, 2)
  assert.equal(signer.snapshot().generation, 2)
  assert.match(signer.snapshot().lease, /\.2\./u)
})

test('expired lease is reported so callers can re-authenticate', async () => {
  const identity = await keyring.generateClientIdentity()
  const state = session.leaseFromGrant({ lease: 'x.1.y', generation: 1, expiresAt: 1_000 })
  assert.equal(session.leaseExpired(state, 2_000), true)
  assert.equal(session.leaseExpired(state, 500), false)
})

test('ws ticket request carries a signature and returns the one-time ticket', async () => {
  const identity = await keyring.generateClientIdentity()
  const clientId = 'cli_0123456789abcdef01234567'
  let seen = null
  const fetchImpl = async (url, init) => {
    seen = { url: String(url), headers: init.headers }
    return new Response(JSON.stringify({ ok: true, ticket: 'TICKET_ABC', expiresAt: Date.now() + 30_000 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const signer = session.createAuthSigner({
    origin: 'http://127.0.0.1:8443',
    identity,
    clientId,
    keyId: 'key_abc123',
    lease: { lease: `${clientId}.1.secretsecretsecret`, generation: 1, expiresAt: Date.now() + 60_000 },
    fetchImpl,
  })
  const ticket = await session.fetchWsTicket(signer, 'http://127.0.0.1:8443', fetchImpl)
  assert.equal(ticket, 'TICKET_ABC')
  assert.equal(seen.url, 'http://127.0.0.1:8443/remote/ws-ticket')
  assert.match(seen.headers.authorization, /^Bearer cli_/u)
  assert.ok(seen.headers['x-hub-signature'])
  assert.ok(seen.headers['x-hub-nonce'])
})

test('account page asks for bootstrap when no account exists', async () => {
  const markup = await renderMarkup(accountPage.renderAccountPage(
    {
      phase: 'bootstrap',
      policy: 'strong',
      peers: [],
      escalation: null,
      totp: null,
      totpDraft: { code: '', password: '' },
      status: { ready: true, bootstrapped: false, mfaEnabled: true, session: null, username: null },
      binding: null,
      enrollment: null,
      notice: null,
      busy: false,
      mfaToken: null,
    },
    noopActions(),
    accountPage.initialDraft(),
    () => {},
  ))
  assert.match(markup, /data-testid="bootstrap-username"/u)
  assert.match(markup, /data-testid="bootstrap-password"/u)
  assert.match(markup, /loopback|本机/u)
  assert.doesNotMatch(markup, /data-testid="trust-submit"/u)
})

test('account page gates on MFA and never renders a session while pending', async () => {
  const markup = await renderMarkup(accountPage.renderAccountPage(
    {
      phase: 'mfa',
      policy: 'strong',
      peers: [],
      escalation: null,
      totp: null,
      totpDraft: { code: '', password: '' },
      status: { ready: true, bootstrapped: true, mfaEnabled: true, session: null, username: 'owner' },
      binding: null,
      enrollment: null,
      notice: null,
      busy: false,
      mfaToken: 'challenge',
    },
    noopActions(),
    accountPage.initialDraft(),
    () => {},
  ))
  assert.match(markup, /data-testid="mfa-code"/u)
  assert.doesNotMatch(markup, /data-testid="clients-list"/u)
})

test('ready page lists trusted clients with role controls and offers trust', async () => {
  const client = {
    clientId: 'cli_0123456789abcdef01234567',
    keyId: 'key_abc',
    label: '本浏览器',
    clientType: 'browser',
    fingerprint: '0123456789abcdef',
    roleCeiling: 'control',
    activeRole: 'read-only',
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
    leaseExpiresAt: Date.now() + 1000,
    leaseGeneration: 2,
    revokedAt: null,
  }
  const markup = await renderMarkup(accountPage.renderAccountPage(
    {
      phase: 'ready',
      policy: 'strong',
      peers: [],
      escalation: null,
      totp: null,
      totpDraft: { code: '', password: '' },
      status: {
        ready: true,
        bootstrapped: true,
        mfaEnabled: true,
        session: {
          accountId: 'owner', username: 'owner', role: 'admin',
          createdAt: new Date().toISOString(), expiresAt: Date.now() + 1000, lastMfaAt: Date.now(),
        },
        username: 'owner',
        clients: [client],
      },
      binding: null,
      enrollment: null,
      notice: null,
      busy: false,
      mfaToken: null,
    },
    noopActions(),
    accountPage.initialDraft(),
    () => {},
  ))
  assert.match(markup, /data-testid="trusted-client"/u)
  assert.match(markup, /data-testid="client-role-select"/u)
  assert.match(markup, /data-testid="revoke-client"/u)
  assert.match(markup, /data-testid="trust-submit"/u, 'untrusted browser must be offered trust')
  assert.match(markup, /0123456789abcdef/u, 'fingerprint is shown for human recognition')
})

test('first sign-in with the default account is gated on a password change', async () => {
  const markup = await renderMarkup(accountPage.renderAccountPage(
    {
      phase: 'change-password',
      policy: 'strong',
      peers: [],
      escalation: null,
      totp: null,
      totpDraft: { code: '', password: '' },
      status: {
        ready: true,
        bootstrapped: true,
        mfaEnabled: true,
        username: 'admin',
        passwordChangeRequired: true,
        session: {
          accountId: 'admin', username: 'admin', role: 'admin',
          createdAt: new Date().toISOString(), expiresAt: Date.now() + 1000, lastMfaAt: null,
        },
      },
      binding: null,
      enrollment: null,
      notice: null,
      busy: false,
      mfaToken: null,
    },
    noopActions(),
    accountPage.initialDraft(),
    () => {},
  ))
  assert.match(markup, /data-testid="current-password"/u)
  assert.match(markup, /data-testid="new-password"/u)
  assert.match(markup, /data-testid="change-password-submit"/u)
  // 改密之前不出现信任/客户端管理入口。
  assert.doesNotMatch(markup, /data-testid="trust-submit"/u)
  assert.doesNotMatch(markup, /data-testid="clients-list"/u)
  assert.match(markup, /只需一次/u)
})

test('a revoked client is rendered disabled', async () => {  const markup = await renderMarkup(accountPage.renderAccountPage(
    {
      phase: 'ready',
      policy: 'strong',
      peers: [],
      escalation: null,
      totp: null,
      totpDraft: { code: '', password: '' },
      status: {
        ready: true,
        bootstrapped: true,
        mfaEnabled: true,
        session: {
          accountId: 'owner', username: 'owner', role: 'admin',
          createdAt: new Date().toISOString(), expiresAt: Date.now() + 1000, lastMfaAt: Date.now(),
        },
        username: 'owner',
        clients: [{
          clientId: 'cli_ffffffffffffffffffffffff', keyId: 'k', label: '旧手机', clientType: 'app',
          fingerprint: 'ffffffffffffffff', roleCeiling: 'full', activeRole: 'full',
          createdAt: new Date().toISOString(), lastSeenAt: null, leaseExpiresAt: null,
          leaseGeneration: 1, revokedAt: new Date().toISOString(),
        }],
      },
      binding: null,
      enrollment: null,
      notice: null,
      busy: false,
      mfaToken: null,
    },
    noopActions(),
    accountPage.initialDraft(),
    () => {},
  ))
  assert.match(markup, /已撤销/u)
  assert.match(markup, /data-revoked="true"/u)
})

test('settings exposes the password policy switch and a live rule checklist', async () => {
  const readyState = (policy) => ({
    phase: 'ready',
    status: {
      ready: true,
      bootstrapped: true,
      mfaEnabled: true,
      username: 'admin',
      passwordPolicy: policy,
      session: {
        accountId: 'admin', username: 'admin', role: 'admin',
        createdAt: new Date().toISOString(), expiresAt: Date.now() + 1000, lastMfaAt: Date.now(),
      },
      clients: [],
    },
    binding: null,
    enrollment: null,
    notice: null,
    busy: false,
    mfaToken: null,
    policy,
    peers: [],
  })

  const strongDraft = { ...accountPage.initialDraft(), currentPassword: 'Old-Pass-123!', newPassword: 'weakpass' }
  const strongMarkup = await renderMarkup(accountPage.renderAccountPage(
    readyState('strong'),
    noopActions(),
    strongDraft,
    () => {},
  ))
  assert.match(strongMarkup, /data-testid="password-policy-section"/u)
  assert.match(strongMarkup, /data-testid="policy-strong"[^>]*data-selected="true"/u)
  assert.match(strongMarkup, /data-testid="password-rules"/u)
  assert.match(strongMarkup, /data-policy="strong"/u)
  // 强策略下 6 条规则，弱口令全部未满足。
  assert.equal((strongMarkup.match(/data-rule="/gu) ?? []).length, 6)
  assert.match(strongMarkup, /data-rule="too-short" data-ok="false"/u)
  // 未达标时提交按钮禁用。
  assert.match(strongMarkup, /data-testid="change-password-apply" disabled/u)

  const strongDraftOk = { ...strongDraft, newPassword: 'Correct-Horse-9-Battery!' }
  const okMarkup = await renderMarkup(accountPage.renderAccountPage(
    readyState('strong'), noopActions(), strongDraftOk, () => {},
  ))
  assert.match(okMarkup, /data-rule="no-upper" data-ok="true"/u)
  assert.doesNotMatch(okMarkup, /data-testid="change-password-apply" disabled/u)

  const basicMarkup = await renderMarkup(accountPage.renderAccountPage(
    readyState('basic'), noopActions(), strongDraft, () => {},
  ))
  assert.match(basicMarkup, /data-testid="policy-basic"[^>]*data-selected="true"/u)
  assert.equal((basicMarkup.match(/data-rule="/gu) ?? []).length, 1)
})

test('raising a ceiling without fresh 2FA opens the escalation prompt', async () => {
  const base = {
    phase: 'ready',
    status: {
      ready: true,
      bootstrapped: true,
      mfaEnabled: true,
      username: 'admin',
      passwordPolicy: 'strong',
      session: {
        accountId: 'admin', username: 'admin', role: 'admin',
        createdAt: new Date().toISOString(), expiresAt: Date.now() + 1000, lastMfaAt: Date.now(),
      },
      clients: [{
        clientId: 'c1', label: 'browser', fingerprint: 'ab'.repeat(8), clientType: 'browser',
        roleCeiling: 'control', activeRole: 'control', leaseGeneration: 1,
        revokedAt: null, createdAt: new Date().toISOString(), lastSeenAt: null,
      }],
    },
    binding: null,
    enrollment: null,
    notice: null,
    busy: false,
    mfaToken: null,
    policy: 'strong',
    peers: [],
    escalation: { clientId: 'c1', role: 'full', password: '', code: '', error: null },
  }

  const markup = await renderMarkup(accountPage.renderAccountPage(base, noopActions(), accountPage.initialDraft(), () => {}))
  assert.match(markup, /data-testid="escalation"/u)
  assert.match(markup, /提升权限需要重新验证/u)
  assert.match(markup, /data-testid="escalation-password"/u)
  assert.match(markup, /data-testid="escalation-code"/u)
  assert.match(markup, /data-testid="escalation-submit"[^>]*disabled/u, '空输入时不可提交')

  const withError = await renderMarkup(accountPage.renderAccountPage({
    ...base,
    escalation: { ...base.escalation, password: 'x', code: '123456', error: '验证失败' },
  }, noopActions(), accountPage.initialDraft(), () => {}))
  assert.match(withError, /data-testid="escalation-error"/u)
  assert.doesNotMatch(withError, /data-testid="escalation-submit"[^>]*disabled/u, '填好后可提交')

  const idle = await renderMarkup(accountPage.renderAccountPage(
    { ...base, escalation: null }, noopActions(), accountPage.initialDraft(), () => {},
  ))
  assert.doesNotMatch(idle, /data-testid="escalation"/u)
})

test('settings separates the local account from peer accounts', async () => {
  const base = {
    phase: 'ready',
    status: {
      ready: true,
      bootstrapped: true,
      mfaEnabled: true,
      username: 'admin',
      passwordPolicy: 'strong',
      session: {
        accountId: 'admin', username: 'admin', role: 'admin',
        createdAt: new Date().toISOString(), expiresAt: Date.now() + 1000, lastMfaAt: Date.now(),
      },
      clients: [],
    },
    binding: null,
    enrollment: null,
    notice: null,
    busy: false,
    mfaToken: null,
    policy: 'strong',
    peers: [],
  }

  const empty = await renderMarkup(accountPage.renderAccountPage(base, noopActions(), accountPage.initialDraft(), () => {}))
  assert.match(empty, /data-testid="local-account"/u)
  assert.match(empty, /本机账号/u)
  assert.match(empty, /data-testid="peer-accounts"/u)
  assert.match(empty, /对端账号/u)
  assert.match(empty, /data-testid="peers-empty"/u)

  const withPeer = await renderMarkup(accountPage.renderAccountPage({
    ...base,
    peers: [{
      id: 'a'.repeat(64),
      origin: 'http://192.168.1.20:8443',
      label: '家里的机器',
      role: 'control',
      lastConnectedAt: Date.now(),
    }],
  }, noopActions(), accountPage.initialDraft(), () => {}))
  assert.match(withPeer, /data-testid="peer-account"/u)
  assert.match(withPeer, /http:\/\/192\.168\.1\.20:8443/u)
  assert.match(withPeer, /家里的机器/u)
  assert.match(withPeer, /data-testid="forget-peer"/u)
  assert.doesNotMatch(withPeer, /data-testid="peers-empty"/u)
})



test('bindings are keyed by origin so two targets do not overwrite each other', async () => {
  const ring = keyring.createKeyring()
  const a = { clientId: 'c-a', keyId: 'k-a', lease: 'a.1.secret', generation: 1, expiresAt: Date.now() + 1000 }
  const b = { clientId: 'c-b', keyId: 'k-b', lease: 'b.1.secret', generation: 1, expiresAt: Date.now() + 1000 }
  await ring.saveBinding(a, 'http://127.0.0.1:3091')
  await ring.saveBinding(b, 'http://192.168.1.20:8443')
  assert.equal((await ring.loadBinding('http://127.0.0.1:3091')).clientId, 'c-a')
  assert.equal((await ring.loadBinding('http://192.168.1.20:8443')).clientId, 'c-b')
  await ring.clearBinding('http://192.168.1.20:8443')
  assert.equal(await ring.loadBinding('http://192.168.1.20:8443'), null)
  assert.equal((await ring.loadBinding('http://127.0.0.1:3091')).clientId, 'c-a', '清除一个不能影响另一个')
})

test('lazy signer reads the per-origin binding on first use', async () => {
  const lazyModule = await loadBuiltClientModule('auth/lazy.js')
  const ring = keyring.createKeyring()
  await ring.loadOrCreate()
  const origin = 'http://peer.test:8443'
  await ring.saveBinding({
    clientId: 'c-lazy', keyId: 'k-lazy', lease: 'c-lazy.1.secret', generation: 1,
    expiresAt: Date.now() + 3_600_000,
  }, origin)

  const signer = lazyModule.createLazySigner(origin, { keyring: ring })
  assert.equal(signer.snapshot().lease, '', '未加载前不应有快照')
  const headers = await signer.headers({ method: 'POST', path: '/remote/rpc', body: '{}' })
  assert.equal(headers['x-hub-client-id'], 'c-lazy')
  assert.match(headers['x-hub-signature'], /^[A-Za-z0-9+/=]+$/u)
  assert.equal(signer.snapshot().lease, 'c-lazy.1.secret')

  const missing = lazyModule.createLazySigner('http://never-trusted.test', { keyring: ring })
  await assert.rejects(() => missing.headers({ method: 'POST', path: '/remote/rpc', body: '{}' }),
    /尚未受信/u)
})

test('settings offers TOTP enrollment until it is enabled', async () => {
  const state = (overrides) => ({
    phase: 'ready',
    status: {
      ready: true, bootstrapped: true, mfaEnabled: true, totpEnabled: false, username: 'admin',
      passwordPolicy: 'strong',
      session: {
        accountId: 'admin', username: 'admin', role: 'admin',
        createdAt: new Date().toISOString(), expiresAt: Date.now() + 1000, lastMfaAt: Date.now(),
      },
      clients: [],
    },
    binding: null, enrollment: null, notice: null, busy: false, mfaToken: null,
    policy: 'strong', peers: [], escalation: null,
    totp: null, totpDraft: { code: '', password: '' },
    ...overrides,
  })

  const idle = await renderMarkup(accountPage.renderAccountPage(state({}), noopActions(), accountPage.initialDraft(), () => {}))
  assert.match(idle, /data-testid="totp-section"/u)
  assert.match(idle, /data-testid="totp-start"/u)
  assert.doesNotMatch(idle, /data-testid="totp-secret"/u)

  const setup = await renderMarkup(accountPage.renderAccountPage(
    state({ totp: { secret: 'ABCDEF', otpauth: 'otpauth://totp/dsh?secret=ABCDEF', backupCodes: ['aaaa-bbbb'] } }),
    noopActions(), accountPage.initialDraft(), () => {},
  ))
  assert.match(setup, /data-testid="totp-secret"/u)
  assert.match(setup, /data-testid="totp-otpauth"/u)
  assert.match(setup, /data-testid="totp-backup-codes"/u)
  assert.match(setup, /data-testid="totp-confirm"/u)

  const enabled = await renderMarkup(accountPage.renderAccountPage(
    state({ status: { ...state({}).status, totpEnabled: true } }),
    noopActions(), accountPage.initialDraft(), () => {},
  ))
  assert.match(enabled, /data-testid="totp-disable"/u)
  assert.doesNotMatch(enabled, /data-testid="totp-start"/u)
})

test('renewing a lease persists the rotated one into the keyring', async () => {
  const lazyModule = await loadBuiltClientModule('auth/lazy.js')
  const ring = keyring.createKeyring()
  await ring.loadOrCreate()
  const origin = 'http://peer.test:8443'
  await ring.saveBinding({
    clientId: 'c-rot', keyId: 'k-rot', lease: 'c-rot.1.old', generation: 1,
    expiresAt: Date.now() + 60_000,
  }, origin)

  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), authorization: init?.headers?.authorization })
    return new Response(JSON.stringify({
      ok: true, lease: 'c-rot.2.new', generation: 2, expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const signer = lazyModule.createLazySigner(origin, { keyring: ring, fetchImpl })
  const renewed = await signer.renew()
  assert.equal(renewed.generation, 2)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].authorization, 'Bearer c-rot.1.old', '轮换请求本身也要用当前租约签名')

  const stored = await ring.loadBinding(origin)
  assert.equal(stored.lease, 'c-rot.2.new')
  assert.equal(stored.generation, 2)
})
