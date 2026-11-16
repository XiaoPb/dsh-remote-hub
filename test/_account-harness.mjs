/**
 * 账号模式测试夹具：**不依赖邀请/短码**地建一个已认证的 Host。
 *
 * 其它测试（takeover / device-connection / guard-admin …）在 P4 之后都要改用
 * 账号登录建连；把这段「引导 → 绑 TOTP → 登录 → 取新鲜 2FA 会话」固定在这里，
 * 免得每个文件各写一遍。
 *
 * @module test/_account-harness
 */
import { generateKeyPairSync, createHash, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { testLoadAuth } from './_helpers.mjs'

export const OWNER = 'owner'
export const OWNER_PASSWORD = 'Correct-Horse-9-Battery!'

/** 生成 ECDSA P-256 客户端密钥对（公钥 JWK + 签名函数）。 */
export function clientKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  return {
    jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
    sign(payload) {
      return sign('sha256', Buffer.from(payload, 'utf8'), { key: privateKey, dsaEncoding: 'der' }).toString('base64')
    },
  }
}

/**
 * 引导一个可用账号，返回带新鲜 2FA 的管理员会话。
 *
 * @param {string} tag - 临时目录标记（便于排障）。
 * @returns 夹具：`service` / `store` / `sessionCookie` / `enroll()` / `signedRpc()`。
 */
export async function bootstrappedAccount(tag = 'harness') {
  const auth = await testLoadAuth()
  const dir = mkdtempSync(join(tmpdir(), `dsh-acct-${tag}-`))
  const store = await auth.createAuthStore(join(dir, 'auth.json'))
  let clock = Date.now()
  const now = () => clock
  const service = auth.createAuthService({ store, now })

  const boot = await service.bootstrap({ username: OWNER, password: OWNER_PASSWORD })
  const setup = await service.startTotpSetup(boot.cookie)
  const secret = setup.secret
  await service.confirmTotp(boot.cookie, auth.totpCodeAt(secret, now()))

  // 重新登录：拿到 lastMfaAt 新鲜的会话（enroll 要求 10 分钟内验证过）。
  const login = await service.login({ username: OWNER, password: OWNER_PASSWORD })
  if (login.ok !== true || login.response.mfaRequired !== true) throw new Error('harness: unexpected login result')
  const mfa = await service.verifyMfa({ mfaToken: login.response.mfaToken, code: auth.totpCodeAt(secret, now()) })
  if ('error' in mfa) throw new Error(`harness: mfa failed (${mfa.error})`)

  const audience = '127.0.0.1:8443'

  return {
    auth,
    dir,
    store,
    service,
    secret,
    sessionCookie: mfa.cookie,
    now,
    advanceMs: (ms) => { clock += ms },
    /** 用管理员会话登记一个浏览器客户端。 */
    async enroll(role = 'control') {
      const key = clientKeyPair()
      const enrolled = await service.enroll(mfa.cookie, {
        label: 'harness-browser',
        clientType: 'browser',
        publicKey: key.jwk,
        roleCeiling: role,
      })
      return { key, enrolled }
    },
    /**
     * 用租约签一个请求头集合。
     *
     * @param {object} enrolled - `enroll()` 返回的登记结果。
     * @param {object} key - 对应的客户端密钥。
     * @param {object} options - `path` / `body` / `generation` / `nonce`。
     */
    proofHeaders(enrolled, key, options = {}) {
      const body = options.body ?? '{}'
      const bodyDigest = createHash('sha256').update(body).digest('hex')
      const generation = options.generation ?? enrolled.lease.generation
      const timestamp = String(options.ts ?? now())
      const nonce = options.nonce ?? `n${Math.random().toString(36).slice(2, 12)}`
      const path = options.path ?? '/remote/rpc'
      const payload = auth.buildProofPayload({
        method: options.method ?? 'POST',
        path,
        audience: options.audience ?? audience,
        timestamp,
        nonce,
        clientId: enrolled.client.clientId,
        keyId: enrolled.client.keyId,
        generation,
        bodyDigest,
      })
      return {
        body,
        bodyDigest,
        headers: {
          'x-hub-client-id': enrolled.client.clientId,
          'x-hub-key-id': enrolled.client.keyId,
          'x-hub-ts': timestamp,
          'x-hub-nonce': nonce,
          'x-hub-body-sha256': bodyDigest,
          'x-hub-signature': key.sign(payload),
        },
      }
    },
    /** 直接用服务校验一次签名请求（不经过 HTTP）。 */
    verify(enrolled, key, options = {}) {
      const { headers, bodyDigest, body } = this.proofHeaders(enrolled, key, options)
      return service.verifyHubRequest({
        lease: `Bearer ${enrolled.lease.lease}`,
        method: options.method ?? 'POST',
        path: options.path ?? '/remote/rpc',
        audience: options.audience ?? audience,
        bodyDigest,
        headers,
      })
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
