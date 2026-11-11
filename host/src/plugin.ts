/**
 * Host 装配。
 *
 * 顺序是**强制**的（D-13 / 红线 R12），任一步失败即整体抛错（fail loud）：
 *
 * ```
 * config → devices → tokens → pairing → policy(registerPolicy) → services(hub/*)
 *        → streams → approvals → guard → tunnel
 * ```
 *
 * **`registerPolicy` 必须先于第一个 `createPeer`**：`decide()` 对没有 policy 的
 * principal kind 一律 `no-allow` 拒绝（不是放行、也不是降级为只读），所以任何
 * 「先建 Peer、后注册策略」的窗口都是全量 403。本装配里 `dispatcher` 只在
 * 第一次请求时惰性创建 Peer，因此策略已在更早的步骤注册完毕。
 *
 * 同理 `interactions: 'none'` 由 `dispatcher` 显式传给 `createPeer`（D-13）。
 *
 * 全部资源通过一个 `ctx.effect` 的 disposer 统一卸载：插件 reload 不会留下
 * 守卫监听、隧道子进程或在途 Peer。disposer 按**逆序**执行。
 *
 * @module dsh-remote-hub/host/plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import { rm } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

import { GUARD_ROUTES, PROTOCOL_VERSION } from '@core/index.js'

import { createApprovalBridge, deviceTargetsResolver, type ApprovalAuditRow } from './approval-bridge.js'
import { Config, DEFAULT_CONFIG, validateConfig, type Config as ConfigType } from './config.js'
import { createDeviceStore, expandHome } from './devices.js'
import { createDispatcher } from './dispatch.js'
import { PAIR_ISSUE_GLOBAL, PAIR_ISSUE_PIN_FILE, startGuard, type GuardHandle } from './guard.js'
import { createPairingService } from './pairing.js'
import { registerDevicePolicy, visibleResourceIdsFromContext } from './policy.js'
import { registerRemoteServices } from './services/index.js'
import { createStreamEngine, gatewayStreamOpener } from './streams.js'
import { createTokenService } from './token.js'
import { startTunnel, type TunnelHandle } from './tunnel.js'

/** 插件稳定名（cordis.patch.yml 的 roster id 也是 `remote-hub`，不随版本改变）。 */
export const name = 'remote-hub'

/** 默认配置（re-export，供 `host/src/index.ts` 的公共 API 与验收脚本使用）。 */
export { DEFAULT_CONFIG }

/**
 * 必需服务。
 *
 * ⚠️ **不要**把这些放进声明式 `inject`（曾在桌面宿主上把整个 web boot 拖死：
 * desktop profile 的宿主进程不提供 `connection` / `typertGateway` /
 * `remoteAccess`，cordis 对缺失的声明依赖**拒绝激活**，而 web boot 对任何
 * `failed` 的 entry 是**整体中止** —— 见 2026-11-11 的
 * `crash-…-web-boot.log`：`web boot: 1 entry did not activate`）。
 *
 * 正确姿势是**启动期软探测**：`apply()` 里先用 `probeServices()` 检查三个服务
 * 是否已注册（cordis 的服务是异步装配的，插件激活时它们可能还没就绪，所以用
 * `ctx.inject([deps], …)` 在服务**就绪时**再装配，而不是在激活时硬性要求）。
 * 任一服务在装配回调里仍缺失 → 记一条明确告警并整体不装配：守卫不监听 =
 * 零暴露，保持 fail-closed，**绝不**抛错拖垮宿主。
 */
export const inject: string[] = []

/** Host 插件的 Config schema（schemastery，交给 DSH 的 settings 面持久化）。 */
export { Config }

/** 装配完成后的句柄（诊断 / 测试注入）。 */
export interface RemoteHubHost {
  dispose(): Promise<void>
  readonly guardOrigin: string
  readonly pairIssueToken: string
  readonly protocolVersion: number
}

/**
 * 探针：确认该 profile 装了 Connection / Gateway，且 `remote-device` kind 有 policy。
 *
 * 这是 ROADMAP T0.4 的**源码级**结论的函数化：服务层没有包名 allow-list（A2），
 * 所以探针只回答「装没装」+「有没有 policy」。失败点只可能落在
 * 「服务不存在 / endpoint 未被认领 / policy 未注册」三者之一。
 * @param ctx - Host Context。
 * @returns 可打印的探针结论。
 */
export function probeServices(ctx: Context): {
  connection: 'ok' | 'missing'
  typertGateway: 'ok' | 'missing'
  remoteAccess: 'ok' | 'missing'
  claimableEndpoints: number
  sessionListOk: boolean
} {
  // ⚠️ **必须走 reflect.props，绝不裸读 `ctx.connection`**：插件 fiber 的 ctx 是
  // scoped proxy，裸读未注入的服务会抛 `cannot get property "connection" without
  // inject`（cordis ReflectService.handler 的 get trap 行为；root ctx 才返回
  // undefined —— 本机 2026-11-11 实测）。这就是软探测第一版在 desktop 上仍然
  // 崩溃的原因。`reflect.props` 读的是注册表元数据，缺服务时得到 undefined，
  // 不触发 trap、不抛错、不走 internal/get waterfall。
  const props = (ctx as unknown as {
    reflect?: { props?: Record<string, unknown> }
  }).reflect?.props ?? {}
  const shapeOk = (value: unknown): boolean =>
    typeof value === 'object' && value !== null
  const connection = shapeOk(props.connection) ? 'ok' : 'missing'
  const gateway = shapeOk(props.typertGateway) ? 'ok' : 'missing'
  const remoteAccess = shapeOk(props.remoteAccess) ? 'ok' : 'missing'
  // `typert.local.list()` 在 0.2.x 是 registry 的同步枚举；缺席时退化为 0。
  let claimableEndpoints = 0
  try {
    const typert = props.typert as { local?: { list?: () => readonly unknown[] } } | undefined
    const rows = typert?.local?.list?.()
    claimableEndpoints = Array.isArray(rows) ? rows.length : 0
  } catch {
    claimableEndpoints = 0
  }
  return {
    connection,
    typertGateway: gateway,
    remoteAccess,
    claimableEndpoints,
    sessionListOk: connection === 'ok' && gateway === 'ok' && remoteAccess === 'ok',
  }
}

/**
 * 装配全部子系统。
 *
 * **软探测语义**：先检查 `connection` / `typertGateway` / `remoteAccess` 三个服务
 * 是否已注册。任一缺失 → 记一条明确告警并**整体不装配**（守卫不监听 = 零暴露，
 * 保持 fail-closed），**不抛错** —— 一次错误的 profile 组合不该拖垮宿主的 web boot
 * （2026-11-11 桌面崩溃的教训）。
 *
 * 服务是异步装配的，激活瞬间可能还没就绪，所以探测放在
 * `ctx.inject([deps], callback)` 的回调里：服务就绪时才执行装配；宿主从不提供
 * 这些服务时回调永远不跑，插件安静地什么都不做（比「能连但什么都不做」的僵尸
 * 状态更安全——这里没有监听、没有 Peer、没有文件写）。
 *
 * @param ctx - Host Context。
 * @param config - 已按 `Config` 解析的配置；缺省用 `DEFAULT_CONFIG`。
 */
export function applyRemoteHub(ctx: Context, config: ConfigType = DEFAULT_CONFIG): void {
  validateConfig(config)

  const probe = probeServices(ctx)
  if (probe.connection === 'missing' || probe.typertGateway === 'missing' || probe.remoteAccess === 'missing') {
    const warn = (ctx as unknown as { logger?: { warn?: (message: string) => void } }).logger?.warn
    try {
      warn?.(
        `remote-hub: required services not ready `
        + `(connection=${probe.connection}, typertGateway=${probe.typertGateway}, remoteAccess=${probe.remoteAccess}); `
        + 'assembly deferred to ctx.inject() — the guard stays off (fail-closed, zero exposure)',
      )
    } catch {
      // 日志后端缺席不能影响宿主。
    }
  }

  // 服务就绪时再装配；宿主永不提供这些服务时回调不执行 → 插件安静地不装。
  (ctx as unknown as {
    inject(deps: readonly string[], callback: (scoped: Context) => void): unknown
  }).inject(['connection', 'typertGateway', 'remoteAccess'], scoped => {
    assembleRemoteHub(scoped, config)
  })
}

/** `ctx.inject` 回调里的真实装配（三个服务此时已就绪）。 */
function assembleRemoteHub(ctx: Context, config: ConfigType): void {
  ctx.effect(async () => {
    const disposers: (() => void | Promise<void>)[] = []
    const push = (dispose: () => void | Promise<void>): void => { disposers.push(dispose) }
    let guard: GuardHandle | undefined
    let tunnel: TunnelHandle | undefined

    const audit = (event: string, fields: Record<string, unknown>): void => {
      // 结构化日志。**绝不**打印 Authorization / 票据 / 短码 / 明文令牌。
      const safe = Object.fromEntries(
        Object.entries(fields).filter(([key]) => !/token|ticket|code|authorization|secret/iu.test(key)),
      )
      try {
        (ctx as unknown as { logger?: { info?: (message: string) => void } })
          .logger?.info?.(`remote-hub: ${event} ${JSON.stringify(safe)}`)
      } catch {
        // 日志后端缺席不能影响守卫。
      }
    }

    try {
      // 1. devices（原子写 + 文件锁；未知 version 在加载期抛错）
      const devices = await createDeviceStore(config.deviceTablePath)

      // 2. tokens（吊销/角色变更通知 → dispatcher 丢弃 Peer）
      const tokens = createTokenService({ devices })

      // 3. pairing（两条路径共享签发出口；成功兑换写一行审计）
      const pairing = createPairingService({
        config: {
          pairQrTtlMs: config.pairQrTtlMs,
          pairCodeTtlMs: config.pairCodeTtlMs,
          maxPairAttempts: config.maxPairAttempts,
          defaultRole: config.defaultRole,
        },
        tokens,
        onAudit: row => {
          audit('pair-redeemed', {
            deviceId: row.deviceId,
            role: row.role,
            path: row.path,
            at: row.at,
          })
        },
      })

      // 4. policy —— **必须早于第一个 createPeer**（D-13）
      const policy = registerDevicePolicy(ctx, {
        devices,
        visibleResourceIds: () => visibleResourceIdsFromContext(ctx),
        onDenied: row => { audit('access-denied', row) },
      })
      push(() => policy.dispose())

      // 5. streams（三条一元方法；上游 opener 走 Gateway）
      const streams = createStreamEngine({
        config: {
          streamHoldMs: config.streamHoldMs,
          streamBatchMax: config.streamBatchMax,
          streamBatchWindowMs: config.streamBatchWindowMs,
          streamReadTimeoutMs: config.streamReadTimeoutMs,
          streamIdleTtlMs: config.streamIdleTtlMs,
          maxStreamsPerDevice: config.maxStreamsPerDevice,
        },
        openUpstream: gatewayStreamOpener(ctx),
        onAudit: row => { audit('stream', row) },
      })
      push(() => streams.dispose())

      // 6. approvals（root-scope waterfall 监听器，不接管就 next()）
      const approvals = createApprovalBridge(ctx, {
        streams,
        config: {
          approvalBridgeTimeoutMs: config.approvalBridgeTimeoutMs,
          bridgeApprovals: config.bridgeApprovals,
        },
        resolveTargets: deviceTargetsResolver({
          devices: () => devices.list(),
          visibleSessionIds: () => visibleResourceIdsFromContext(ctx).session,
        }),
        onAudit: (row: ApprovalAuditRow) => {
          audit('approval-answer', row as unknown as Record<string, unknown>)
        },
      })
      push(() => approvals.dispose())

      // 7. dispatcher（惰性 createPeer；interactions:'none'）
      const dispatcher = createDispatcher(ctx, tokens)
      push(() => dispatcher.dispose())

      // 8. hub/* 服务（必须在 guard 之前：Gateway 要认领这些 endpoint）
      const services = registerRemoteServices(ctx, {
        streams,
        approvals,
        devices,
        tokens,
        policy,
        onRevoked: deviceId => { streams.markRevoked(deviceId); policy.invalidate(deviceId) },
      })
      push(() => services.dispose())

      // 9. guard（独立监听，只绑回环；端口被占即抛）
      guard = await startGuard({ config, tokens, pairing, dispatcher, audit })
      push(() => guard?.dispose())

      // 10. tunnel（只指向 guard.origin；默认 none 不 spawn）
      tunnel = await startTunnel(config.tunnel, guard.origin)
      push(() => tunnel?.dispose())

      // index 注入：把进程内 pairIssueToken 写进**本机页面**。
      // 隧道那侧的页面拿不到这个值（它不经过 webServer 渲染），这正是 R4 的补强。
      const injectOff = (ctx as unknown as {
        inject(deps: string[], callback: (scoped: Context) => void): void
      }).inject(['webServer'], scoped => {
        const off = (scoped as unknown as {
          on(event: string, listener: (table: unknown[], peer: unknown) => void): () => void
        }).on('webserver/index-inject', table => {
          table.push({ kind: 'global', name: PAIR_ISSUE_GLOBAL, value: { pairIssueToken: guard?.pairIssueToken } })
        })
        return off
      })
      void injectOff

      // 无界面 host 的 CLI 通道：把 pairIssueToken 以 0600 落盘，供
      // `dsh-remote-hub-pair` CLI（bin/）读取后签发 QR 票据 / 短码。
      // 服务器上没有 GUI 页面，这条是**唯一**的签发凭据出口；文件属于同一
      // Unix 用户、每次启动重新生成，隧道侧拿不到。
      const pinPath = expandHome(config.deviceTablePath.replace(/devices\.json$/u, PAIR_ISSUE_PIN_FILE))
      await writeFileAtomic(pinPath, `${guard.pairIssueToken}\n`, { mode: 0o600, dirMode: 0o700 })
      push(() => { void rm(pinPath, { force: true }) })
    } catch (error) {
      // 装配失败：先卸掉已装配的部分，然后**降级为不装配**而不是把错误交给
      // cordis fiber —— 一个端点被占 / 设备表损坏不该让宿主的 web boot 整体
      // 中止（同一次桌面崩溃的教训）。错误细节进日志，守卫保持关闭。
      for (const dispose of [...disposers].reverse()) {
        try { await dispose() } catch { /* 卸载错误不能盖住根因 */ }
      }
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      try {
        (ctx as unknown as { logger?: { error?: (message: string) => void } })
          .logger?.error?.(`remote-hub: assembly failed, plugin stays dormant (guard off): ${message}`)
      } catch {
        // 日志后端缺席不能影响宿主。
      }
      // Dormant：仍然返回一个 no-op disposer，让 effect 的类型与生命周期保持完整。
      return () => {}
    }

    const handle: RemoteHubHost = {
      guardOrigin: guard?.origin ?? '',
      pairIssueToken: guard?.pairIssueToken ?? '',
      protocolVersion: PROTOCOL_VERSION,
      async dispose() {
        for (const dispose of [...disposers].reverse()) await dispose()
      },
    }
    ;(ctx as unknown as { remoteHubHost?: RemoteHubHost }).remoteHubHost = handle

    return () => handle.dispose()
  }, 'dsh-remote-hub: full assembly')
}

/** 守卫路由表（供外部诊断；避免两份真相）。 */
export { GUARD_ROUTES }
