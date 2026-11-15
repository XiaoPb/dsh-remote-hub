/**
 * 懒签名器：**同步**构造，首次用到时再读 IndexedDB。
 *
 * 为什么需要它：carrier 的安装点（`carrier-entry.ts`）是同步 IIFE，必须在
 * `__DSH_BOOT_READY__` 窗口内完成 `__DSH_TRANSPORT__` 注入，否则官方 shell
 * 早就写过全局对象了。可以私钥在 IndexedDB（异步）——签名器本身却是异步接口
 * （`headers()` 返回 Promise），所以「先给对象、后取密钥」完全可行。
 *
 * 失败语义：取不到密钥/绑定就抛错，由 carrier 的请求路径转成一次普通失败，
 * 不会静默降级成无签名请求（那样会被守卫 401）。
 *
 * @module dsh-remote-hub/client/auth/lazy
 */
import { createKeyring } from './keyring.js'
import { createAuthSigner, leaseFromGrant, type AuthSigner } from './session.js'

/** 懒签名器依赖（测试可注入）。 */
export interface LazySignerDeps {
  keyring?: ReturnType<typeof createKeyring>
  fetchImpl?: typeof fetch
  now?: () => number
}

/** 空快照：尚未加载完成时对外暴露的状态。 */
const EMPTY_LEASE = { lease: '', generation: 0, expiresAt: 0 } as const

/**
 * 创建一个按 origin 懒加载的签名器。
 * @param origin - 目标 Host origin（租约与绑定都按它索引）。
 * @param deps - 可注入的密钥环 / fetch / 时钟。
 * @returns 立即可用的 `AuthSigner`（内部异步准备）。
 */
export function createLazySigner(origin: string, deps: LazySignerDeps = {}): AuthSigner {
  const keyring = deps.keyring ?? createKeyring()
  let ready: AuthSigner | null = null
  let loading: Promise<AuthSigner> | null = null

  async function build(): Promise<AuthSigner> {
    const [identity, binding] = await Promise.all([keyring.load(), keyring.loadBinding(origin)])
    if (identity === null) throw new Error('本浏览器还没有客户端密钥；先在设置页完成一次信任')
    if (binding === null) throw new Error(`本浏览器尚未受信于 ${origin}；先在「连接其他设备」里完成登录`)
    return createAuthSigner({
      origin,
      identity,
      clientId: binding.clientId,
      keyId: binding.keyId,
      lease: leaseFromGrant({
        lease: binding.lease,
        generation: binding.generation,
        expiresAt: binding.expiresAt,
      }),
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    })
  }

  /** 幂等加载：并发调用合并成一次。 */
  function ensure(): Promise<AuthSigner> {
    if (ready !== null) return Promise.resolve(ready)
    if (loading === null) {
      loading = build()
        .then((signer) => {
          ready = signer
          return signer
        })
        .catch((error: unknown) => {
          // 允许下次重试（例如用户随后完成了信任）。
          loading = null
          throw error
        })
    }
    return loading
  }

  return {
    async headers(input) {
      return (await ensure()).headers(input)
    },
    snapshot() {
      return ready === null ? EMPTY_LEASE : ready.snapshot()
    },
    async renew() {
      const signer = await ensure()
      // 轮换后必须把新租约写回 IndexedDB：否则下一次加载会拿旧代次去签名，
      // 服务端会把它当成重放并撤销客户端。
      const binding = await keyring.loadBinding(origin)
      const next = await signer.renew()
      if (binding !== null) {
        await keyring.saveBinding({
          clientId: binding.clientId,
          keyId: binding.keyId,
          lease: next.lease,
          generation: next.generation,
          expiresAt: next.expiresAt,
        }, origin)
      }
      return next
    },
    needsRenewal() {
      return ready === null ? false : ready.needsRenewal()
    },
  }
}
