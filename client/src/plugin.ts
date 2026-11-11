/**
 * Client 装配。
 *
 * 顺序（固定）：transport → access →（延迟）mount →（延迟）UI。
 * transport / access 不依赖宿主服务，**立即装配**；`remote` / `slots` 由宿主的
 * 其它 client entry 提供（`remote` ← api-gateway client，依赖 typert+connection；
 * `slots` ← dsh-client-ui-renderer client），**晚于本 entry** 激活——所以这两块
 * 用 `ctx.inject(deps, cb)` 做**延迟装配**：cordis 响应式子 fiber，服务就绪时
 * 自动执行、服务卸载时自动回收，永不就绪则安静不挂。
 *
 * ⚠️ 本 entry 自身保持 `inject: []`（见 index.ts）：声明式硬 inject 若遇到
 * 服务永不出现的组合，fiber 会 pending 到 web boot 收尾被 qZ 判死
 * （`web boot: N entries did not activate`，2026-11-11 桌面崩溃的死因）。
 * 延迟子 fiber 的 pending **不属于** entry fiber，不影响 boot 判定。
 *
 * 所有资源通过 `ctx.effect(() => disposer, label)` 注册；卸载时 cordis 按
 * **逆序**执行 disposer，无残留订阅、无残留轮询。
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

/** 降级告警：装配失败只留痕，不让异常逃出 effect 回调拖垮 web boot。 */
function warnDegrade(stage: string, error: unknown): void {
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

/** `ctx.inject(deps, cb)` 返回的子 fiber（只需 dispose 能力）。 */
interface InjectFiber {
  dispose?: () => unknown
}

/**
 * 延迟装配：等 `deps` 里的服务全部就绪后执行 `setup`（cordis `ctx.inject` 语义：
 * 即 `ctx.plugin({ inject: deps, apply: cb })` 的响应式子 fiber——服务卸载时回收、
 * 重现时重跑）。**绝不**让异常逃出回调；宿主永不提供这些服务时安静不挂。
 * @returns 子 fiber（用于主动回收），宿主 ctx 不支持 inject 时为 `undefined`。
 */
function injectWhenReady(
  ctx: Context,
  deps: readonly string[],
  stage: string,
  setup: (scoped: Context) => (() => void) | void,
): InjectFiber | undefined {
  try {
    const inject = (ctx as unknown as Context & {
      inject?: (deps: readonly string[], callback: (scoped: Context) => (() => void) | void) => InjectFiber
    }).inject
    if (typeof inject !== 'function') return undefined
    return inject.call(ctx, deps, scoped => {
      try {
        return setup(scoped)
      } catch (error) {
        warnDegrade(stage, error)
      }
    })
  } catch (error) {
    warnDegrade(stage, error)
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
  const locationOrigin = (globalThis.location as { origin?: string } | undefined)?.origin
  const sameOrigin = origin !== '' && origin === locationOrigin

  ctx.effect(() => {
    const disposers: (() => void)[] = []
    const push = (dispose: () => void): void => { disposers.push(dispose) }

    // 1. access（**先建**：transport 的回调闭包引用它，不能落在后面）
    const access = createAccessStore()
    push(() => access.dispose())

    // 2. transport（不依赖宿主服务，立即装配）
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

    // 3. mount（同源模式；跨源由 transport 负责）——延迟到 `remote` 就绪。
    //    scoped ctx 已声明注入，mount 内部读服务不会再触发 get trap。
    if (sameOrigin) {
      const fiber = injectWhenReady(ctx, ['remote'], 'mount', scoped => {
        const mounted = mountRemote(scoped, null)
        return () => { mounted.dispose() }
      })
      const disposeFiber = fiber?.dispose
      if (disposeFiber !== undefined) push(() => { void disposeFiber() })
    }

    // 4. UI（LAST：永远从 access 读权限，不从本地猜）——延迟到 `slots` 就绪。
    //    面板 slots 实例取自 inject 作用域（已注入，裸读安全）。
    const panelFiber = injectWhenReady(ctx, ['slots'], 'panel', scoped => {
      const slots = (scoped as unknown as {
        slots?: { register(options: unknown, component: unknown): () => void }
      }).slots
      if (slots === undefined || typeof slots.register !== 'function') return
      const panel = mountRemotePanel(scoped, {
        slots,
        access,
        call: (method, args) => transport.call(method, args),
      })
      return () => { panel.dispose() }
    })
    const disposePanelFiber = panelFiber?.dispose
    if (disposePanelFiber !== undefined) push(() => { void disposePanelFiber() })

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
