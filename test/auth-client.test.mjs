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
  const directory = await mkdtemp(join(tmpdir(), 'hub-auth-client-'))
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
  const authDir = join(directory, 'auth')
  await mkdir(authDir, { recursive: true })
  for (const name of ['keyring', 'session']) {
    try {
      const text = await readFile(new URL(`../.build/client/client/src/auth/${name}.js`, import.meta.url), 'utf8')
      await writeFile(join(authDir, `${name}.js`), text, 'utf8')
    } catch {
      // 缺失时由导入方报错，测试自然失败。
    }
  }
  // 目标保留原目录结构，模块内部的相对导入（`./keyring.js`）才能解析。
  const target = join(directory, relativeFile)
  await mkdir(join(target, '..'), { recursive: true })
  const depth = relativeFile.split('/').length - 1
  const corePrefix = `${'../'.repeat(depth)}core/src`
  const rewritten = source.replace(/from '@core\/([^']+)'/gu, (_match, rest) => `from '${corePrefix}/${rest}'`)
  await writeFile(target, rewritten, 'utf8')
  try {
    return await import(pathToFileURL(target).href)
  } finally {
    // 模块已进缓存；目录留给进程结束由 OS 清理（避免删掉正在使用的模块）。
    void rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}

const keyring = await loadBuiltClientModule('auth/keyring.js')
const session = await loadBuiltClientModule('auth/session.js')

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
