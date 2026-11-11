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

function hubGlobal(): HubGlobal {
  return (globalThis as { __DSH_REMOTE_HUB__?: HubGlobal }).__DSH_REMOTE_HUB__ ?? {}
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

  // **软探测**：`slots` / `remote` 服务缺席时降级为不装 UI（不抛错——client 激活
  // 失败会拖垮宿主的 web boot，同一次桌面崩溃的教训）。transport 不依赖这两个
  // 服务，所以 transport 本身仍可装配（对纯 transport 消费者有用）。
  //
  // ⚠️ 走 reflect.props 读，**绝不裸读 `ctx.slots`**：client 插件 fiber 的 ctx 是
  // scoped proxy，裸读未注入的服务会抛 `cannot get property "slots" without
  // inject`（cordis ReflectService get trap；2026-11-11 桌面第二次崩溃的教训）。
  const slots = (ctx as unknown as {
    reflect?: { props?: Record<string, unknown> }
  }).reflect?.props?.slots
  const hasSlots = typeof slots === 'object' && slots !== null

  ctx.effect(() => {
    const disposers: (() => void)[] = []
    const push = (dispose: () => void): void => { disposers.push(dispose) }

    // 1. transport
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

    // 2. mount（同源模式；跨源由 transport 负责，mount 会抛明确错误 —— 这里
    //    只在 origin 就是当前页面时尝试挂载，避免无谓的加载期失败）
    const locationOrigin = (globalThis.location as { origin?: string } | undefined)?.origin
    if (origin === locationOrigin) {
      const mounted = mountRemote(ctx, null)
      push(() => mounted.dispose())
    }

    // 3. access
    const access = createAccessStore()
    push(() => access.dispose())

    // 4. UI（LAST：永远从 access 读权限，不从本地猜）。slots 缺席 → 跳过 UI，
    //    保留 transport + access 句柄（插件激活成功，面板不出现）。
    if (hasSlots) {
      const panel = mountRemotePanel(ctx, {
        access,
        call: (method, args) => transport.call(method, args),
      })
      push(() => panel.dispose())
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
