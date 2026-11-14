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

import { readCarrierMode } from '@core/carrier-contract.js'

import type { RemoteTransport, TransportOptions, AdminRequestDiagnostic, HubLogEntry } from './transport.js'
import { createTransport, RemoteHubError, HUB_LOG_LIMIT } from './transport.js'
import { createAccessStore } from './access.js'
import { mountRemote } from './mount.js'
import { createRemoteHubPageComponent, classifyPairSecret } from './panel/RemoteHubPage.js'
import type { CloudDeviceRow } from './panel/RemoteHubPage.js'
import { RemoteHubNavIcon } from './panel/NavIcon.js'
import { mountLocalPluginsPanel } from './local-plugin-manager/panel.js'
import { watchTakeover } from './local-plugin-manager/lifecycle.js'

/** 装配选项（缺省时从 `window.__DSH_REMOTE_HUB__` 读本机注入值）。 */
export interface ClientAssemblyOptions {
  origin?: string
  token?: string
  pairIssueToken?: string
  /** 注入 transport（测试用）。 */
  transport?: RemoteTransport
}

/** index 页注入的全局（host `webserver/index-inject` 写入，见 host/src/plugin.ts）。 */
interface HubGlobal {
  pairIssueToken?: string
  /** 守卫 origin（本机签发配对的目标地址，不是 web 页面 origin）。 */
  /** 对外可用地址（LAN 模式是 LAN IP；配对链接用它）。 */
  guardOrigin?: string
  /** 本机签发/设备管理用的回环地址（守卫签发端要求回环对端）。 */
  loopbackOrigin?: string
  /** 守卫实例标识（用于确认页面连的是当前实例）。 */
  instanceId?: string
  /** host 进程 pid。 */
  pid?: number
  /** 注入时间（ISO）。 */
  injectedAt?: string
  /** 协议版本。 */
  protocolVersion?: number
  /** 已配对设备快照（非敏感字段；页面渲染时求值）。 */
  devices?: readonly CloudDeviceRow[]
  origin?: string
  token?: string
}

/**
 * 最近一次管理请求诊断（模块级：transport 每次管理请求都会覆盖它）。
 *
 * 页面通过 `deps.diagnostic()` 同步读取——不需要事件总线，也不需要把诊断塞进
 * React 状态以外的任何地方。内容是纯诊断事实，不含凭据。
 */
let lastDiagnostic: ImportedDiagnostic | null = null

/** 用户可见日志环形缓冲（最近 N 条；凭据脱敏）。 */
const logBuffer: HubLogEntry[] = []

/**
 * 追加一条日志。
 * @param level - 级别。
 * @param title - 标题。
 * @param detail - 细节。
 * @param path - 相关端点。
 */
export function pushHubLog(level: HubLogEntry['level'], title: string, detail?: string, path?: string): void {
  logBuffer.push({
    at: Date.now(),
    level,
    title,
    ...(detail === undefined ? {} : { detail }),
    ...(path === undefined ? {} : { path }),
  })
  if (logBuffer.length > HUB_LOG_LIMIT) logBuffer.splice(0, logBuffer.length - HUB_LOG_LIMIT)
}

/** 读取日志快照（页面渲染用）。 */
export function hubLogs(): readonly HubLogEntry[] {
  return [...logBuffer]
}

type ImportedDiagnostic = NonNullable<AdminRequestDiagnostic>

/**
 * 统一构造管理 transport（devices/stats/config 共用；与页面 diag 共用回调）。
 *
 * 优先使用**同源管理通道**（`/api/hub/admin.*`）：桌面页面 origin 是
 * `dsh-app://app`，无法跨协议 fetch 守卫，但可以同源访问宿主 API。
 * 同源通道不依赖 pairIssueToken；缺失 pin 不再阻断管理面。
 */
function createAdminTransport(): RemoteTransport {
  const origin = hubGlobal().loopbackOrigin ?? hubGlobal().guardOrigin ?? ''
  return createTransport({
    origin,
    // 同源通道始终启用；守卫直连作为回退（web 部署）。
    adminChannel: '/api',
    ...(hubGlobal().pairIssueToken === undefined ? {} : { pairIssueToken: hubGlobal().pairIssueToken }),
    onAdminDiagnostic: diagnostic => {
      lastDiagnostic = { ...diagnostic }
      adminListener?.({ ...diagnostic })
    },
    onLog: entry => { pushHubLog(entry.level, entry.title, entry.detail, entry.path) },
  })
}

/** 页面订阅诊断更新（订阅后立即回放一次最近值）。 */
let adminListener: ((diagnostic: ImportedDiagnostic) => void) | null = null

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

/**
 * 云端设备页组件（模块级单例：hooks 身份必须跨渲染稳定）。
 *
 * connect/issue 各自新建一条 transport（origin 由页面表单决定），不复用装配期
 * 的 transport —— 后者的 origin 在页面加载时就固定了，而连接动作恰恰是要换
 * origin。
 */
const RemoteHubPage = createRemoteHubPageComponent({
  injected: () => hubGlobal(),
  /** 守卫诊断：最近一次管理请求（transport 写回模块级变量）。 */
  diagnostic: () => lastDiagnostic,
  /** 用户可见日志时间线。 */
  logs: () => hubLogs(),
  /** 页面侧主动记录一条日志（例如签发结果）。 */
  log: (level, title, detail, path) => { pushHubLog(level, title, detail, path) },
  async listDevices() {
    const snapshot = await createAdminTransport().listDevices()
    return {
      guard: snapshot.guard,
      protocolVersion: snapshot.protocolVersion,
      singleController: snapshot.singleController,
      devices: snapshot.devices,
    }
  },
  async forgetDevice(deviceId) {
    return createAdminTransport().forgetDevice(deviceId)
  },
  async revokeDevices(input) {
    return createAdminTransport().revokeDevices(input)
  },
  async issueTicket({ origin, pairIssueToken, role }) {
    const transport = createTransport({ origin, pairIssueToken, adminChannel: '' })
    return transport.issueTicket(role)
  },
  async issueCode({ origin, pairIssueToken, role }) {
    const transport = createTransport({ origin, pairIssueToken, adminChannel: '' })
    return transport.issueCode(role)
  },
  /**
   * 同源签发（桌面端唯一可行路径）。
   *
   * 走 `hub/admin.issue`：owner 页面经 Electron `forwardWebRequest` 同源转发，
   * 不需要 pin，也不受 `dsh-app://app` 跨协议限制。
   */
  async adminIssue({ kind, role }) {
    const transport = createAdminTransport()
    if (kind === 'ticket') {
      const issued = await transport.issueTicket(role)
      return { kind: 'ticket' as const, value: issued.ticket, expiresAt: issued.expiresAt, role: issued.role }
    }
    const issued = await transport.issueCode(role)
    return { kind: 'code' as const, value: issued.code, expiresAt: issued.expiresAt, role: issued.role }
  },
  /**
   * 本机连接信息（局域网 IPv4 + 端口）。
   *
   * 守卫在 loopback 模式下公告的是 `127.0.0.1:8443`，**对其他设备无意义**；
   * 配对二维码 / 链接必须带局域网地址，否则扫码方会连到自己的回环。
   */
  async endpoints() {
    return createAdminTransport().endpoints()
  },
  /** 出站状态快照（磁盘真源；页面 2 秒轮询）。 */
  async carrier() {
    return createAdminTransport().carrier()
  },
  /** 把页面出站状态写回磁盘。 */
  async carrierWrite(mode) {
    return createAdminTransport().carrierWrite(mode)
  },
  async listOutboundTargets() {
    return createAdminTransport().listOutboundTargets()
  },
  async saveOutboundTarget(target) {
    return createAdminTransport().saveOutboundTarget(target)
  },
  async activateOutboundTarget(targetId) {
    return createAdminTransport().activateOutboundTarget(targetId)
  },
  async forgetOutboundTarget(targetId) {
    return createAdminTransport().forgetOutboundTarget(targetId)
  },
  /** 出站状态变更后重新装配页面（整页重载，重置 RPC 通道）。 */
  reload() {
    globalThis.location?.reload()
  },
  async connect({ origin, secret }) {
    const transport = createTransport({ origin })
    const kind = classifyPairSecret(secret)
    if (kind === null) throw new Error('pair-invalid：无法识别的配对凭据')
    const issued = await transport.redeem({
      ...(kind === 'ticket' ? { ticket: secret } : { code: secret }),
      clientLabel: 'DSH 主控端',
    })
    return {
      token: issued.token,
      role: issued.role,
      deviceId: issued.deviceId,
      label: issued.deviceId,
      ...(issued.displacedDevices === undefined ? {} : { displacedDevices: issued.displacedDevices }),
    }
  },
  // ③ 运行指标（守卫 /remote/stats；旧版本 404 → 页面降级卡）。
  async stats() {
    const snapshot = await createAdminTransport().stats()
    return {
      startedAt: snapshot.startedAt,
      pairIssued: snapshot.pairIssued,
      pairRedeemed: snapshot.pairRedeemed,
      pairRejected: snapshot.pairRejected,
      authAccepted: snapshot.authAccepted,
      authDenied: snapshot.authDenied,
      activeStreams: snapshot.activeStreams,
      streamsOpened: snapshot.streamsOpened,
      hourly: snapshot.hourly,
      daily: snapshot.daily,
    }
  },
  // ④ 配置读写（守卫 /remote/config）。
  async getConfig() {
    const { config } = await createAdminTransport().getConfig()
    return config
  },
  async patchConfig(input) {
    const { config } = await createAdminTransport().patchConfig(input)
    return config
  },
})

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
 * 装配句柄注册表（模块级）。
 *
 * ⚠️ **绝不**把句柄写到 ctx 属性上（`ctx.remoteHubClient = …`）：cordis 的 fiber
 * scope proxy 对**写属性**同样有 trap——裸写未 provide 的属性抛
 * `cannot set property … without provide`，apply 抛错 → entry `failed` →
 * web boot 整体中止（2026-11-11 15:41 桌面第三次崩溃的死因；读和写都必须走
 * 显式方法或模块级存储，绝不能裸操作 proxy）。
 */
const assemblies = new WeakMap<object, ClientAssembly>()

/** 诊断：按 ctx 查询装配句柄（同 fiber 生命周期，卸载后清除）。 */
export function getRemoteHubClient(ctx: object): ClientAssembly | undefined {
  return assemblies.get(ctx)
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

    // 4. 同源 remote contribution（不注册任何覆盖层 UI）。
    //    ⚠️ v0.3 起**不再**往 `shell.overlay` 注册面板：路线 A 的入口是侧栏
    //    `sidebar.panellist` 行 + `main` 页，overlay 面板会盖在桌面标题栏上
    //    （2026-11-11 实机反馈）。审批卡片走官方原生 UI，不需要自绘浮层。

    // 5. 云端设备入口（路线 A）：侧栏导航行 + main 页。
    //    与官方「插件管理」同模式：sidebar.panellist 行 id == main key。
    const navFiber = injectWhenReady(ctx, ['slots'], 'nav', scoped => {
      const slots = (scoped as unknown as {
        slots?: {
          register(options: unknown, component: unknown): () => void
          inject?: (name: string, setup: () => void) => unknown
        }
      }).slots
      if (slots === undefined || typeof slots.register !== 'function') return
      const disposersNav: (() => void)[] = []
      const injectable = slots

      // 每个槽位一条 inject 声明（声明 = 渲染授权，官方契约）。
      const declare = (name: string, setup: () => void): void => {
        if (typeof injectable.inject === 'function') injectable.inject(name, setup)
        else setup() // 测试桩无 inject 时行为等价。
      }

      declare('sidebar.panellist', () => {
        // 侧栏行：图标行；label 供展开态文本与收起态 tooltip。
        disposersNav.push(slots.register(
          { name: 'sidebar.panellist', id: 'remote-hub', order: 60, label: '云端设备' },
          RemoteHubNavIcon,
        ))
      })
      declare('main', () => {
        // 中央页：云端设备控制台（连接 / 签发 / 设备列表 / 模式切换）。
        disposersNav.push(slots.register(
          { name: 'main', key: 'remote-hub' },
          RemoteHubPage,
        ))
      })
      return () => { for (const dispose of [...disposersNav].reverse()) dispose() }
    })
    const disposeNavFiber = navFiber?.dispose
    if (disposeNavFiber !== undefined) push(() => { void disposeNavFiber() })

    // 6. 本地插件页（仅在「接管云端设备」期间出现）。
    //
    //    为什么单独一块：它承载的是**本机**插件管理（官方页此时显示的是云端那份），
    //    数据走自己的 owner-only 直连通道（`/api/hub/local-plugin-manager/*`），与上面
    //    的 transport / ctx.remote 完全无关。可见性由 `watchTakeover` 轮询 carrier 状态决定：
    //    接管出现 → 装配；断开 / 吊销 / 插件卸载 → 立刻撤下（`mountLocalPluginsPanel` 的 dispose
    //    会收掉侧栏行、主面板、toast、WS 订阅、控制器与样式表）。
    //
    //    ⚠️ `configForms` 必须列进 inject：vendored 页面的注入面从 `ctx.configForms.describe()/get()`
    //    取配置账本（官方 `ui-plugin-manager` 同样 inject 这一项）。少了它，fiber 作用域 proxy 在
    //    读取未注入的服务时抛 `cannot get property "configForms" without inject`，面板会被跳过。
    const localFiber = injectWhenReady(ctx, ['slots', 'locale', 'configForms'], 'local-plugins', scoped => {
      let panel: { dispose(): void } | undefined
      const stopWatching = watchTakeover((active) => {
        if (active && panel === undefined) {
          try {
            panel = mountLocalPluginsPanel(scoped)
          } catch (error) {
            warnDegrade('local-plugins', error)
            panel = undefined
          }
          return
        }
        if (!active && panel !== undefined) {
          panel.dispose()
          panel = undefined
        }
      })
      return () => {
        stopWatching()
        panel?.dispose()
        panel = undefined
      }
    })
    const disposeLocalFiber = localFiber?.dispose
    if (disposeLocalFiber !== undefined) push(() => { void disposeLocalFiber() })

    const assembly: ClientAssembly = {
      transport,
      dispose() {
        for (const dispose of [...disposers].reverse()) dispose()
      },
    }
    assemblies.set(ctx, assembly)
    return () => {
      assemblies.delete(ctx)
      assembly.dispose()
    }
  }, 'dsh-remote-hub: client assembly')
}
