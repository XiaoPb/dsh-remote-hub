/**
 * Remote contribution mounting（同源模式）。
 *
 * 官方 API 是 `ctx.remote.$mount(contribution)`；`ctx.remote` 由
 * `@deepseek-ai/dsh-api-remotes/client` 装配提供。类型在 0.2.x 里是生成式的，
 * 所以这里用一个最小的结构形状调用，缺失时**抛明确错误**而不是静默失败。
 *
 * **跨源模式不支持**：另一台 Host 的守卫走 `transport.ts`（长轮询），
 * 不能也不该把远端 contribution 挂进本机 `ctx.remote`。
 *
 * @module dsh-remote-hub/client/mount
 */
import type { Context } from '@deepseek-ai/cordis'

/** 已挂载的远程 contribution。 */
export interface MountedRemote {
  /** 按注册逆序执行所有 disposer。 */
  dispose(): void
}

/** 一台远程 Host 的守卫地址；`null` = 本机同源模式。 */
export interface RemoteTarget {
  /** 守卫 origin（永远是守卫，不是 DSH 的 :3080）。 */
  origin: string
  deviceId: string
}

interface RemoteContribution {
  package: string
  descriptors: readonly unknown[]
}

interface RemoteFace {
  $mount(contribution: RemoteContribution): Promise<() => Promise<void>>
}

/**
 * 挂载同源远程面。
 * @param ctx - Client Cordis root。
 * @param target - `null`（同源）或远端目标（跨源，当前拒绝）。
 * @returns `MountedRemote`。
 * @throws 跨源模式、`ctx.remote` 缺失、或 `$mount` 返回了非函数 disposer。
 */
export function mountRemote(ctx: Context, target: RemoteTarget | null): MountedRemote {
  const location = globalThis.location as { origin?: string } | undefined
  const sameOrigin = target === null
    || (location?.origin !== undefined && target.origin.replace(/\/+$/u, '') === location.origin)
  if (!sameOrigin) {
    throw new Error(
      'dsh-remote-hub: cross-origin mounting is not supported; use createTransport instead',
    )
  }

  // 服务值读取：cordis 官方无 inject 软读 `ctx.get(name, strict)` —— 服务未被
  // 提供时返回 `undefined`，**不抛错、不触发 get trap**。
  // ⚠️ 两类错误读法都踩过坑（2026-11-11 桌面崩溃）：
  //  - 裸读 `ctx.remote`：scoped proxy 上未注入的服务抛
  //    `cannot get property "remote" without inject`（get trap）；
  //  - 读 `ctx.reflect.props.remote`：那是**属性声明表**元数据
  //    （`{ type: "service" }`），不是服务值——旧实现把元数据强转成 RemoteFace，
  //    `$mount` 永远 undefined，同源挂载从未成功过。
  const remote = (ctx as unknown as {
    get?: (name: string, strict?: boolean) => unknown
  }).get?.call(ctx, 'remote') as RemoteFace | undefined
  if (remote === undefined || typeof remote.$mount !== 'function') {
    throw new Error(
      'dsh-remote-hub: ctx.remote.$mount is unavailable; the same-origin mode requires '
      + '@deepseek-ai/dsh-api-remotes/client to be composed',
    )
  }

  const contribution: RemoteContribution = {
    package: '@xiaopb/dsh-remote-hub',
    descriptors: [],
  }

  const disposers: (() => void | Promise<void>)[] = []
  let mounted = false
  let failed = false
  const mountedPromise = Promise.resolve()
    .then(() => remote.$mount(contribution))
    .then(unmount => {
      if (typeof unmount !== 'function') {
        throw new Error('dsh-remote-hub: ctx.remote.$mount did not return a disposer')
      }
      disposers.push(() => unmount())
      mounted = true
    })
    .catch((error: unknown) => {
      failed = true
      // 不静默吞掉：把失败挂到句柄上，并提供一次可等待的检查入口。
      ;(handle as MountedRemote & { error?: unknown }).error = error
    })

  const handle: MountedRemote = {
    dispose() {
      for (const dispose of [...disposers].reverse()) void dispose()
      disposers.length = 0
    },
  }
  ;(handle as MountedRemote & { ready: Promise<boolean> }).ready = mountedPromise.then(() => mounted && !failed)
  return handle
}
