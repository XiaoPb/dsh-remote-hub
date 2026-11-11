/**
 * Client 装配。
 *
 * 顺序（固定）：transport → mount → access → UI。
 * 所有资源都通过 `ctx.effect(() => disposer, label)` 注册；卸载时 cordis 按
 * **逆序**执行 disposer，无残留订阅、无残留轮询。
 *
 * v0.2 变更点：
 * - transport 是三方法长轮询，**不是 WebSocket**（D-3）。
 * - `ClientContext` 就是 `@deepseek-ai/cordis` 的 `Context`（D-8）；
 *   `@deepseek-ai/dsh-client-runtime` 在 0.2.2-rc.1 检出里不存在。
 * - access 快照读的是 `core/capabilities.ts` 的同一张矩阵（D-11）。
 *
 * @module dsh-remote-hub/client/plugin
 */
import type { Context } from '@deepseek-ai/cordis'

import type { RemoteTransport, TransportOptions } from './transport.js'
import { createTransport } from './transport.js'
import { createAccessStore } from './access.js'
import { mountRemote } from './mount.js'
import { mountRemotePanel } from './ui/index.js'

/** 装配选项（缺省时从 `window.__DSH_REMOTE_HUB__` 读本机注入值）。 */
export interface ClientAssemblyOptions {
  origin?: string
  token?: string
  pairIssueToken?: string
  /** 注入 transport（测试用）。 */
  transport?: RemoteTransport
}

interface HubGlobal {
  pairIssueToken?: string
  origin?: string
  token?: string
}

/** `ctx.remote`（`@deepseek-ai/dsh-api-remotes/client` 装配提供）的最小形状。 */
interface RemoteFace {
  $mount(contribution: { package: string; descriptors: readonly unknown[] }): Promise<() => Promise<void>>
}

/** 降级告警：装配失败只留痕，不让异常逃出 effect 回调拖垮 web boot。 */
function warnDegrade(stage: 'mount' | 'panel', error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  try {
    console.warn(`dsh-remote-hub: ${stage} unavailable, degraded (${message})`)
  } catch {
    // 连 console 都没有的环境就静默降级。
  }
}

function hubGlobal(): HubGlobal {
  return (globalThis as { __DSH_REMOTE_HUB__?: HubGlobal }).__DSH_REMOTE_HUB__ ?? {}
}

/**
 * 服务软探测：cordis 官方无 inject 读取（`ReflectService.get(name, strict)`）。
 * 服务从未被提供 → 返回 `undefined`，**不抛错、不触发 get trap**。
 *
 * ⚠️ 绝不裸读 `ctx.<name>`：client 插件 fiber 的 ctx 是 scoped proxy，`inject: []`
 * 时裸读未注入的服务会抛 `cannot get property "<name>" without inject`
 * （cordis ReflectService.handler 的 get trap；2026-11-11 桌面崩溃的死因）。
 * 也不读 `ctx.reflect.props`：那是**属性声明表**（`{ type: "service" }` 元数据），
 * 不代表服务当前真的可用，会产生假阳性。
 */
function probeService(ctx: Context, name: string): unknown {
  try {
    const get = (ctx as unknown as { get?: (name: string, strict?: boolean) => unknown }).get
    if (typeof get !== 'function') return undefined
    const value = (get as (this: unknown, name: string, strict?: boolean) => unknown).call(ctx, name)
    return typeof value === 'object' && value !== null ? value : undefined
  } catch {
    return undefined
  }
}

/** 装配完成后暴露给诊断的句柄。 */
export interface ClientAssembly {
  transport: RemoteTransport
  dispose(): void
}

/**
 * Client 插件入口。
 * @param ctx - Client Cordis root。
 * @param options - 装配选项。
 */
export function applyRemoteHubClient(ctx: Context, options: ClientAssemblyOptions = {}): void {
  const injected = hubGlobal()
  const origin = options.origin ?? injected.origin ?? (globalThis.location as { origin?: string } | undefined)?.origin ?? ''

  // **软探测**（probeService，见上）：`slots` / `remote` 服务缺席时降级为不装
  // 对应的部分（不抛错——client 激活失败会拖垮宿主的 web boot，2026-11-11 桌面
  // 崩溃的教训）。transport / access 不依赖这两个服务，所以它们仍可装配。
  const slots = probeService(ctx, 'slots') as
    | { register(options: unknown, component: unknown): () => void }
    | undefined
  const remote = probeService(ctx, 'remote') as RemoteFace | undefined

  ctx.effect(() => {
    const disposers: (() => void)[] = []
    const push = (dispose: () => void): void => { disposers.push(dispose) }

    // 1. access（**先建**：transport 的回调闭包引用它，不能落在后面）
    const access = createAccessStore()
    push(() => access.dispose())

    // 2. transport
    const transportOptions: TransportOptions = {
      origin,
      ...(options.token ?? injected.token ?? undefined) === undefined
        ? {}
        : { token: options.token ?? injected.token },
      pairIssueToken: options.pairIssueToken ?? injected.pairIssueToken,
      onUnauthorized: () => { access.clear() },
      onAccessSnapshot: snapshot => { access.update(snapshot) },
    }
    const transport = options.transport ?? createTransport(transportOptions)
    push(() => transport.close())

    // 3. mount（同源模式；跨源由 transport 负责）。**三重护栏**：
    //    a) 只在 origin 就是当前页面时尝试；
    //    b) `remote` 服务缺席（desktop 宿主不装配 dsh-api-remotes）→ 直接跳过；
    //    c) 挂载过程任何错误 → 记日志、降级为不挂载，**绝不**让异常逃出 effect
    //       回调（那会让本 entry 变成 `failed`，web boot 整体中止）。
    const locationOrigin = (globalThis.location as { origin?: string } | undefined)?.origin
    if (origin === locationOrigin && typeof remote?.$mount === 'function') {
      try {
        const mounted = mountRemote(ctx, null)
        push(() => mounted.dispose())
      } catch (error) {
        warnDegrade('mount', error)
      }
    }

    // 4. UI（LAST：永远从 access 读权限，不从本地猜）。slots 缺席 → 跳过 UI，
    //    保留 transport + access 句柄（插件激活成功，面板不出现）。
    //    slots 服务实例**显式传入** mountRemotePanel，不让它再裸读 `ctx.slots`。
    if (slots !== undefined) {
      try {
        const panel = mountRemotePanel(ctx, {
          slots,
          access,
          call: (method, args) => transport.call(method, args),
        })
        push(() => panel.dispose())
      } catch (error) {
        warnDegrade('panel', error)
      }
    }

    const assembly: ClientAssembly = {
      transport,
      dispose() {
        for (const dispose of [...disposers].reverse()) dispose()
      },
    }
    ;(ctx as unknown as { remoteHubClient?: ClientAssembly }).remoteHubClient = assembly
    return () => assembly.dispose()
  }, 'dsh-remote-hub: client assembly')
}
