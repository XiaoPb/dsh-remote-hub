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
  // 设计系统（`rhui/`）也被 AccountPage 依赖：整个目录镜像过去，同样重写 `@core/*`。
  const rhuiDir = join(directory, 'rhui')
  await mkdir(rhuiDir, { recursive: true })
  for (const name of ['index', 'tokens', 'components', 'format', 'qr-code', 'i18n']) {
    try {
      const text = await readFile(new URL(`../.build/client/client/src/rhui/${name}.js`, import.meta.url), 'utf8')
      await writeFile(join(rhuiDir, `${name}.js`), rewriteCore(text, '../core/src'), 'utf8')
    } catch {
      // 缺失时由导入方报错，测试自然失败。
    }
  }
  // `rhui/i18n.js` 的双语字典在 `rhui/locales/` 下（同目录结构一并镜像）。
  const localeDir = join(rhuiDir, 'locales')
  await mkdir(localeDir, { recursive: true })
  for (const name of ['zh-CN', 'en']) {
    try {
      const text = await readFile(new URL(`../.build/client/client/src/rhui/locales/${name}.js`, import.meta.url), 'utf8')
      await writeFile(join(localeDir, `${name}.js`), rewriteCore(text, '../../core/src'), 'utf8')
    } catch {
      // 缺失时由导入方报错，测试自然失败。
    }
  }
  // `rhui/qr-code.js` 依赖 `panel/qr.js`（同一份相对结构），一并镜像。
  await mkdir(join(directory, 'panel'), { recursive: true })
  try {
    const qrText = await readFile(new URL('../.build/client/client/src/panel/qr.js', import.meta.url), 'utf8')
    await writeFile(join(directory, 'panel', 'qr.js'), rewriteCore(qrText, '../core/src'), 'utf8')
  } catch {
    // 缺失时由导入方报错。
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

/**
 * 固定页面语言为中文。
 *
 * ## 为什么必须显式固定
 *
 * `i18n.ts` 的 `detectLocale()` 走 `navigator.languages[0] ?? navigator.language`，
 * 而 **Node 21+ 自带 `navigator` 全局**。于是同一个测试在不同机器上渲染出不同语言：
 *
 *   - 本机 `navigator.language === 'zh-CN'` → 中文 → 断言「本机账号」通过
 *   - GitHub Actions runner 是 `en-US` → 英文 → 同一条断言失败
 *
 * 实测就卡在这里：产品代码完全正确，只是测试**依赖了宿主系统语言**。
 *
 * ## 实现要点
 *
 * `loadBuiltClientModule` 每次调用都建新的临时目录，因此拿到的是**不同的模块实例**。
 * 直接 import 一份 `rhui/i18n.js` 再 `setLocale()` 不会影响 `AccountPage` 内部那份。
 * 可靠做法是从 `AccountPage` 暴露的同一路径入手：`__DSH_REMOTE_HUB_I18N__` 是
 * `i18n.ts` 挂在 globalThis 上的单例钩子，`AccountPage` 与本测试看到的是同一个对象。
 */
function pinLocaleToChinese() {
  const hook = globalThis.__DSH_REMOTE_HUB_I18N__
  if (hook !== undefined && typeof hook.setLocale === 'function') {
    hook.setLocale('zh')
    return true
  }
  return false
}
assert.equal(pinLocaleToChinese(), true, '必须能把测试语言固定为中文（否则断言依赖宿主 locale）')

/**
 * 去掉 `ThemeStyle` 注入的 `<style data-rh-theme>` 节点。
 *
 * ## 为什么必须剥掉再序列化
 *
 * 页面根容器会注入约 4 万字符的 `RH_CSS`。它和页面内容挤在同一个 HTML 字符串里，
 * 导致两个问题：
 *
 *  1. **输出被截断**：CI 上实测 `renderToStaticMarkup` 的结果在样式表中间就断了，
 *     页面主体完全没出现，于是「找不到本机账号」这类断言误报——而产品代码无误。
 *  2. **正则误命中**：`/本机账号/u` 可能匹配到 CSS 注释里的同名字样。
 *
 * 这些测试关心的是**页面结构**，不是样式内容；剥掉样式表既让断言可靠，
 * 也让它更聚焦。真正需要验证样式的地方另有专门的测试。
 *
 * @param node - React 节点。
 * @returns 不含样式表节点的新树。
 */
function stripThemeStyle(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(stripThemeStyle)
  if (node.props === undefined) return node
  if (node.props['data-rh-theme'] !== undefined) return null
  const nextProps = {}
  for (const key of Object.keys(node.props)) {
    const value = node.props[key]
    nextProps[key] = Array.isArray(value) || (typeof value === 'object' && value !== null)
      ? stripThemeStyle(value)
      : value
  }
  return { ...node, props: nextProps }
}

/** 把 React 树渲染成静态 HTML（不依赖浏览器；已剥离样式表，见 stripThemeStyle）。 */
async function renderMarkup(node) {
  const { renderToStaticMarkup } = await import('react-dom/server')
  return renderToStaticMarkup(stripThemeStyle(node))
}

/**
 * 遍历 React 元素树，收集 `data-testid` 与文本。
 *
 * ## 为什么需要它（为什么不再只靠 `renderToStaticMarkup`）
 *
 * `renderToStaticMarkup` 把整棵树序列化成一个字符串，其中**混着完整的 CSS**
 * （`ThemeStyle` 注入的 `RH_CSS` 有 4 万字符）。用它做断言有两个问题：
 *
 *  1. **脆弱**：CI 上曾出现过输出在样式表中间被截断的情况（同一个提交本地通过、
 *     CI 失败），断言随之失败，但**产品代码并没有问题**。排查成本极高。
 *  2. **语义错位**：`/本机账号/u` 这类正则既可能命中真实文案，也可能命中 CSS
 *     注释里的同名字样，断言通过不代表结构正确。
 *
 * 因此结构性断言改为**直接读元素树**（不经过字符串序列化），只有确实需要
 * 检查 HTML 形态的地方（如 `<svg>`）才继续用 `renderMarkup`。
 *
 * @param node - React 节点。
 * @param testid - 要查找的 `data-testid`。
 * @returns 匹配的元素数组。
 */
function findByTestId(node, testid, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findByTestId(child, testid, out)
    return out
  }
  if (node.props === undefined) return out
  if (node.props['data-testid'] === testid) out.push(node)
  // 递归所有 prop 值：文案常挂在 title/desc/children 上，只走 children 会漏。
  for (const key of Object.keys(node.props)) findByTestId(node.props[key], testid, out)
  return out
}

/**
 * 收集元素树里所有可见文本片段。
 * @param node - React 节点。
 * @param out - 累加器。
 * @returns 文本数组。
 */
function collectText(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    // 跳过样式表字符串：它是实现细节，不是可见文案。
    const text = String(node)
    if (!text.includes('--rh-') && text.length < 400) out.push(text)
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (node.props === undefined) return out
  for (const key of Object.keys(node.props)) collectText(node.props[key], out)
  return out
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
      expanded: {
        'local-account': true,
        'trust-section': true,
        'totp-section': true,
        'password-policy-section': true,
        'clients-list': true,
        'peer-accounts': true,
        'sub-accounts': true,
      },
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

test('a revoked client is hidden from the list entirely', async () => {  const markup = await renderMarkup(accountPage.renderAccountPage(
    {
      phase: 'ready',
      expanded: {
        'local-account': true,
        'trust-section': true,
        'totp-section': true,
        'password-policy-section': true,
        'clients-list': true,
        'peer-accounts': true,
        'sub-accounts': true,
      },
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
  // 已撤销的客户端不再出现在列表里（Host 保留一天后连记录一起清除）。
  assert.doesNotMatch(markup, /旧手机/u)
  assert.doesNotMatch(markup, /data-revoked="true"/u)
  assert.match(markup, /data-testid="clients-empty"/u, '没有在用客户端时给出空态')
})

test('a long client list shows a preview with a show-all action', async () => {
  const makeClient = (index) => ({
    clientId: 'cli_' + String(index).padStart(26, '0'),
    keyId: 'k' + index,
    label: '设备 ' + index,
    clientType: 'browser',
    fingerprint: String(index).padStart(16, '0'),
    roleCeiling: 'control',
    activeRole: 'control',
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
    leaseExpiresAt: null,
    leaseGeneration: 1,
    revokedAt: null,
  })
  const stateWith = (expanded) => ({
    phase: 'ready',
    expanded: { 'clients-list': true, ...expanded },
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
      clients: [0, 1, 2, 3, 4, 5, 6].map(makeClient),
    },
    binding: null,
    enrollment: null,
    notice: null,
    busy: false,
    mfaToken: null,
  })

  const preview = await renderMarkup(accountPage.renderAccountPage(
    stateWith({}), noopActions(), accountPage.initialDraft(), () => {},
  ))
  const previewRows = (preview.match(/data-testid="trusted-client"/gu) ?? []).length
  assert.equal(previewRows, 3, '默认只展示 3 台')
  assert.match(preview, /还有 4 台未显示/u)
  assert.match(preview, /data-testid="clients-show-all"/u)

  const all = await renderMarkup(accountPage.renderAccountPage(
    stateWith({ 'clients-show-all': true }), noopActions(), accountPage.initialDraft(), () => {},
  ))
  const allRows = (all.match(/data-testid="trusted-client"/gu) ?? []).length
  assert.equal(allRows, 7, '「显示全部」后展示所有在用客户端')
  // 展开后按钮仍在，但文案变成「收起」，摘要变成「共 N 台，已全部显示」。
  assert.match(all, /data-testid="clients-show-all"/u)
  assert.match(all, /收起/u)
  assert.match(all, /共 7 台，已全部显示/u)
})

test('settings exposes the password policy switch and a live rule checklist', async () => {
  const readyState = (policy) => ({
    phase: 'ready',
    expanded: {
      'local-account': true,
      'trust-section': true,
      'totp-section': true,
      'password-policy-section': true,
      'clients-list': true,
      'peer-accounts': true,
      'sub-accounts': true,
    },
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
    expanded: {
      'local-account': true,
      'trust-section': true,
      'totp-section': true,
      'password-policy-section': true,
      'clients-list': true,
      'peer-accounts': true,
      'sub-accounts': true,
    },
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

  // 用元素树断言（同上方说明）：renderToStaticMarkup 的输出混着 4 万字符 CSS，
  // 在 CI 上曾于样式表处截断，导致页面主体丢失、断言误报。
  const escTree = accountPage.renderAccountPage(base, noopActions(), accountPage.initialDraft(), () => {})
  assert.equal(findByTestId(escTree, 'escalation').length, 1, '提权面板')
  assert.equal(findByTestId(escTree, 'escalation-password').length, 1, '口令输入')
  assert.equal(findByTestId(escTree, 'escalation-code').length, 1, '动态码输入')
  const escTexts = collectText(escTree).join(' ')
  assert.match(escTexts, /提升权限需要重新验证/u, '说明文案')
  const submit = findByTestId(escTree, 'escalation-submit')
  assert.equal(submit.length, 1, '提交按钮')
  assert.equal(submit[0].props.disabled, true, '空输入时不可提交')

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
    expanded: {
      'local-account': true,
      'trust-section': true,
      'totp-section': true,
      'password-policy-section': true,
      'clients-list': true,
      'peer-accounts': true,
      'sub-accounts': true,
    },
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

  // ⚠️ 用元素树断言，不用 renderToStaticMarkup 的字符串：
  // 后者把 4 万字符的 CSS 一起序列化进来，既脆弱（CI 上曾截断）又可能误命中文案。
  const emptyTree = accountPage.renderAccountPage(base, noopActions(), accountPage.initialDraft(), () => {})
  assert.equal(findByTestId(emptyTree, 'local-account').length, 1, '本机账号区块')
  assert.equal(findByTestId(emptyTree, 'peer-accounts').length, 1, '对端账号区块')
  assert.equal(findByTestId(emptyTree, 'peers-empty').length, 1, '无对端时显示空态')
  const emptyTexts = collectText(emptyTree)
  assert.ok(emptyTexts.some(text => text.includes('本机账号')), '本机账号文案')
  assert.ok(emptyTexts.some(text => text.includes('对端账号')), '对端账号文案')

  const withPeerTree = accountPage.renderAccountPage({
    ...base,
    peers: [{
      id: 'a'.repeat(64),
      origin: 'http://192.168.1.20:8443',
      label: '家里的机器',
      role: 'control',
      lastConnectedAt: Date.now(),
    }],
  }, noopActions(), accountPage.initialDraft(), () => {})
  const peerNode = findByTestId(withPeerTree, 'peer-account')
  assert.equal(peerNode.length, 1, '对端账号行')
  assert.equal(findByTestId(withPeerTree, 'forget-peer').length, 1, '移除按钮')
  assert.equal(findByTestId(withPeerTree, 'peers-empty').length, 0, '有对端时不显示空态')
  const peerTexts = collectText(peerNode).join(' ')
  assert.match(peerTexts, /192\.168\.1\.20:8443/u, '显示 origin')
  assert.match(peerTexts, /家里的机器/u, '显示设备名')

  // 对端账号过多时同样只显示前 3 个，其余收进「显示全部」。
  const manyPeers = Array.from({ length: 5 }, (_, index) => ({
    id: String(index).padStart(64, 'a'),
    origin: `http://192.168.1.${20 + index}:8443`,
    label: `机器 ${index}`,
    role: 'control',
    lastConnectedAt: Date.now() - index * 60_000,
  }))
  // 卡片默认收起：断言列表内容前必须显式展开。
  const preview = await renderMarkup(accountPage.renderAccountPage(
    { ...base, peers: manyPeers, expanded: { 'peer-accounts': true } },
    noopActions(), accountPage.initialDraft(), () => {},
  ))
  assert.equal((preview.match(/data-testid="peer-account"/gu) ?? []).length, 3, '默认只展示 3 个')
  assert.match(preview, /还有 2 个未显示/u)
  assert.match(preview, /data-testid="peers-show-all"/u)
  // 最近连接的排在最前。
  assert.match(preview, /机器 0/u)

  const all = await renderMarkup(accountPage.renderAccountPage(
    { ...base, peers: manyPeers, expanded: { 'peer-accounts': true, 'peers-show-all': true } },
    noopActions(), accountPage.initialDraft(), () => {},
  ))
  assert.equal((all.match(/data-testid="peer-account"/gu) ?? []).length, 5, '显示全部后列出所有对端')
  assert.match(all, /data-testid="peers-show-all"/u)
  assert.match(all, /收起/u)
  assert.match(all, /共 5 个，已全部显示/u)
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
    expanded: {
      'local-account': true,
      'trust-section': true,
      'totp-section': true,
      'password-policy-section': true,
      'clients-list': true,
      'peer-accounts': true,
      'sub-accounts': true,
    },
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
