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
import http from 'node:http'
import net from 'node:net'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { IncomingMessage } from 'node:http'

import { GUARD_ROUTES, HUB_PROTOCOL_HEADER, PROTOCOL_VERSION, type RoleName } from '@core/index.js'

import { createApprovalBridge, deviceTargetsResolver, type ApprovalAuditRow } from './approval-bridge.js'
import { Config, DEFAULT_CONFIG, validateConfig, type Config as ConfigType } from './config.js'
import { createDeviceStore, expandHome } from './devices.js'
import { createDispatcher } from './dispatch.js'
import { remoteDevicePrincipal } from './principal.js'
import { PAIR_ISSUE_GLOBAL, PAIR_ISSUE_PIN_FILE, startGuard, type GuardDeps, type GuardHandle } from './guard.js'
import { createGuardMux } from './guard-mux.js'
import { createSensitiveApprovalGate } from './sensitive-approval.js'
import { createMetricsCollector } from './metrics.js'
import { createPairingService } from './pairing.js'
import { createVisibleResourceTracker, registerDevicePolicy } from './policy.js'
import { createRuntimeConfigStore } from './runtime-config.js'
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
  // ⚠️ 用 reflect.get(name, false) 读**实例**：reflect.props[name] 只是声明元数据
  // （{type:'service'}），对它做 shape 判断会误报 ok（2026-11-11 实机教训）。
  // strict=false：提供方 fiber 未激活时返回 undefined 而不抛错。
  const reflect = (ctx as unknown as {
    reflect?: { get?: (name: string, strict?: boolean) => unknown }
  }).reflect
  const readService = (name: string): unknown => {
    try { return reflect?.get?.(name, false) } catch { return undefined }
  }
  const shapeOk = (value: unknown): boolean =>
    typeof value === 'object' && value !== null
  const connection = shapeOk(readService('connection')) ? 'ok' : 'missing'
  const gateway = shapeOk(readService('typertGateway')) ? 'ok' : 'missing'
  const remoteAccess = shapeOk(readService('remoteAccess')) ? 'ok' : 'missing'
  // `typert.local.list()` 在 0.2.x 是 registry 的同步枚举；缺席时退化为 0。
  let claimableEndpoints = 0
  try {
    const typert = readService('typert') as { local?: { list?: () => readonly unknown[] } } | undefined
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
/** 诊断状态文件名（与设备表同目录；只含非敏感事实，供排查）。 */
export const HOST_STATUS_FILE = 'host-status.json'

/** 本进程守卫实例标识（每次装配重新生成；页面据此确认连的是当前实例）。 */
const INSTANCE_ID = `hub_${process.pid.toString(36)}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

/** 当前实例 id（供注入与诊断共用）。 */
export function hostInstanceId(): string {
  return INSTANCE_ID
}

/**
 * 守卫端口占用预检 + **自动+1 换端口**。
 *
 * 桌面端常见故障：上一个 DSH 进程没退干净、或 desktop/web 两个 profile 都装了本插件，
 * 于是第二个实例 bind 失败；`startGuard` 抛 EADDRINUSE 后只剩一行日志，用户看到的是
 * 「守卫没起来」。
 *
 * 策略（2026-11-12 修订，按用户要求）：
 * - 首选 `config.guardPort`；
 * - 被占就**顺延 +1** 探测下一个可用端口（默认最多 `MAX_PORT_SCAN` 个）；
 * - 找到即返回该端口并在状态文件里记下 `portShifted: { from, to }`，
 *   用户可在配置里显式改回固定端口。
 *
 * 为什么可以安全换：隧道用 `guard.origin`（**实际**绑定端口）构造上游，
 * 配对链接同样来自 `guard.origin`，所以端口漂移不会让它们指向错的位置。
 * 只有「用户手填了固定端口并依赖它」的场景会受影响——因此把漂移写进状态与日志。
 *
 * @param config - 插件配置（取 guardHost/guardPort）。
 * @returns 实际可用的端口。
 * @throws 扫描范围内全部不可用时抛可读错误（由装配 catch 转成 failed 状态）。
 */
/**
 * 探测某个端口是否可绑定。
 *
 * **用 bind 而不是 connect 判断**：connect 在 Windows 上对「已监听」的对端
 * 有时既不触发 `connect` 也不触发 `error`，只能靠 setTimeout 兜底（600ms/次），
 * 扫 20 个端口就会让启动明显变慢。直接尝试 bind 是权威判定，且立刻返回。
 *
 * @param host - 目标主机。
 * @param port - 目标端口。
 * @returns 可绑定时为 true。
 */
async function isPortFree(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const server = net.createServer()
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      try { server.close(() => { /* 已关闭 */ }) } catch { /* 已关闭 */ }
      resolve(value)
    }
    server.once('error', () => finish(false))
    try {
      server.listen({ host, port, exclusive: true }, () => finish(true))
    } catch {
      finish(false)
    }
    // 兜底：极端情况下 bind 回调不来。
    setTimeout(() => finish(false), 1_000).unref?.()
  })
}

export async function resolveGuardPort(config: ConfigType): Promise<number> {
  const hostForProbe = config.guardHost === '0.0.0.0' || config.guardHost === '::' || config.guardHost === '[::]'
    ? '127.0.0.1'
    : config.guardHost

  const preferred = config.guardPort
  const last = Math.min(65_535, preferred + MAX_PORT_SCAN - 1)
  for (let candidate = preferred; candidate <= last; candidate += 1) {
    if (await isPortFree(hostForProbe, candidate)) return candidate
  }

  // 全部被占：给出可读结论（区分「是本插件守卫」与「其它进程」）。
  const isOurGuard = await probeOurGuard(hostForProbe, preferred)
  throw new Error(isOurGuard
    ? `port-in-use-by-guard: ${hostForProbe}:${preferred}–${last} 范围内端口均被占用`
      + `（${preferred} 上是一个正在运行的守卫）；请改用其它 guardPort`
    : `port-in-use-by-other: ${hostForProbe}:${preferred}–${last} 范围内端口均被占用；`
      + '请改用其它 guardPort')
}

/** 自动换端口时最多向后探测多少个端口。 */
export const MAX_PORT_SCAN = 20

/**
 * 探测某端口上是否跑着**本插件**的守卫（用于错误文案与诊断）。
 *
 * **必须有硬超时**：被探测端可能是个只接受 TCP、不回 HTTP 的服务（或干脆是
 * 测试里的占位监听），只靠 `http.request` 的 `timeout` 在某些 keep-alive 场景下
 * 不会触发；这里额外挂一个 `setTimeout` 兜底，且成功路径也一定清理它。
 *
 * @param host - 探测主机。
 * @param port - 探测端口。
 * @returns 是本插件守卫时为 true。
 */
async function probeOurGuard(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(hardTimer)
      try { req.destroy() } catch { /* 已结束 */ }
      resolve(value)
    }
    const hardTimer = setTimeout(() => finish(false), 1_500)
    const req = http.request({
      host,
      port,
      path: GUARD_ROUTES.health,
      method: 'GET',
      agent: false,
      headers: { [HUB_PROTOCOL_HEADER]: String(PROTOCOL_VERSION) },
      timeout: 800,
    }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { ok?: unknown; protocolVersion?: unknown }
          finish(parsed.ok === true && typeof parsed.protocolVersion === 'number')
        } catch {
          finish(false)
        }
      })
      res.on('error', () => finish(false))
    })
    req.on('timeout', () => finish(false))
    req.on('error', () => finish(false))
    req.end()
  })
}

/**
 * 端口占用预检（保持向后兼容的严格版本）。
 *
 * @deprecated 装配已改用 {@link resolveGuardPort}（自动顺延）。保留此函数供
 * 需要「端口必须固定」的调用方与既有测试使用：**只检查首选端口**，被占即抛，
 * 不做顺延。
 * @param config - 插件配置。
 * @throws 端口被占用时。
 */
export async function assertGuardPortFree(config: ConfigType): Promise<void> {
  const hostForProbe = config.guardHost === '0.0.0.0' || config.guardHost === '::' || config.guardHost === '[::]'
    ? '127.0.0.1'
    : config.guardHost
  const free = await isPortFree(hostForProbe, config.guardPort)
  if (free) return
  const isOurGuard = await probeOurGuard(hostForProbe, config.guardPort)
  throw new Error(isOurGuard
    ? `port-in-use-by-guard: ${hostForProbe}:${config.guardPort} 已被另一个 DSH 实例的守卫占用`
      + '（该守卫正常响应 /remote/health，说明它仍在运行）；'
      + '请完全退出 DSH 后重试，或改用其它 guardPort'
    : `port-in-use-by-other: ${hostForProbe}:${config.guardPort} 已被其它进程占用，请改用其它 guardPort`)
}

/**
 * 状态写入串行队列。
 *
 * 为什么需要：每个装配阶段都会调用 `writeStatus`，而 `writeFileAtomic` 是异步的。
 * 并发写入会让**旧阶段覆盖新阶段**（2026-11-11 实测：守卫已监听 8443、pin 已写入，
 * 文件却停在 `policy:before`，把排障引到错误方向）。
 * 这里把写入排成单链 + 单调 `seq`，保证后写的一定胜出。
 */
let statusChain: Promise<void> = Promise.resolve()
let statusSeq = 0

/**
 * 写一份装配状态快照（非敏感）。
 *
 * 为什么需要它：桌面宿主没有可读日志时，`守卫未运行` 无法区分「服务未就绪」
 * 「端口被占」「设备表损坏」。这份文件给出确定答案，页面/排障脚本可直接读。
 * 失败静默（诊断不能反过来影响装配）。
 *
 * 注意：这份文件**不是**运行状态的权威来源——`/remote/health` 才是。文件只用于
 * 回答「装配停在哪一步」。因此页面显示「守卫不可用」但 health 成功时，应视为
 * 诊断文件滞后，而不是守卫未运行。
 * @param config - 插件配置（取设备表目录）。
 * @param status - 状态快照。
 */
function writeStatus(config: ConfigType, status: Record<string, unknown>): void {
  try {
    const path = expandHome(config.deviceTablePath.replace(/devices\.json$/u, HOST_STATUS_FILE))
    statusSeq += 1
    const body = `${JSON.stringify({
      seq: statusSeq,
      at: new Date().toISOString(),
      pid: process.pid,
      instanceId: INSTANCE_ID,
      ...status,
    }, null, 2)}\n`
    // 串行化：上一个写完才写下一个；同时带短退避重试应对 Windows rename 竞争。
    statusChain = statusChain.then(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await writeFileAtomic(path, body, { mode: 0o600, dirMode: 0o700 })
          return
        } catch (error) {
          if (attempt >= 2) return
          const message = error instanceof Error ? error.message : String(error)
          if (!/EPERM|EBUSY|EACCES/u.test(message)) return
          await new Promise(resolve => { setTimeout(resolve, 100) })
        }
      }
    }).catch(() => { /* 诊断写入失败不能影响装配 */ })
  } catch {
    // 诊断写入失败不能影响装配。
  }
}

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
  writeStatus(config, {
    phase: 'probe',
    probe,
    config: {
      guardHost: config.guardHost,
      guardPort: config.guardPort,
      network: config.network,
      deviceTablePath: config.deviceTablePath,
    },
  })

  // 服务就绪时再装配；宿主永不提供这些服务时回调不执行 → 插件安静地不装。
  ;(ctx as unknown as {
    inject(deps: readonly string[], callback: (scoped: Context) => void): unknown
  }).inject(['connection', 'typertGateway', 'remoteAccess'], scoped => {
    writeStatus(config, { phase: 'services-ready' })
    assembleRemoteHub(scoped, config)
  })
}

/**
 * 组装守卫的 WebSocket 依赖（整机接管，路线 β）。
 *
 * 需要两个官方能力，缺一不可：
 *  - `connection.admitConnection(request)` —— 认领 API socket 所有权；
 *  - `typertGateway.wireStream` —— 官方 carrier 适配器（`open` + `failure`）。
 *
 * @param ctx - 已注入 `connection` / `typertGateway` 的 Host Context。
 * @param audit - 审计记录器（不记令牌）。
 * @returns 守卫 WS 依赖；任一能力缺失时返回 undefined（不挂载 WS）。
 */
export function buildGuardWs(
  ctx: Context,
  audit: (event: string, fields: Record<string, unknown>) => void,
): GuardWsInjection | undefined {
  const connection = (ctx as unknown as {
    reflect?: { get?: (name: string, strict?: boolean) => unknown }
  }).reflect?.get?.('connection', false) as {
    admitConnection?: (request: IncomingMessage) => unknown
    createPeer?: (options: Record<string, unknown>) => unknown
  } | undefined

  const gateway = (ctx as unknown as {
    reflect?: { get?: (name: string, strict?: boolean) => unknown }
  }).reflect?.get?.('typertGateway', false) as {
    wireStream?: {
      open?: (...args: unknown[]) => unknown
      failure?: (error: unknown) => unknown
    }
  } | undefined

  if (typeof connection?.createPeer !== 'function') {
    audit('ws-disabled', { reason: 'connection.createPeer missing' })
    console.warn('[dsh-remote-hub] WS disabled: connection.createPeer missing')
    return undefined
  }
  const wire = gateway?.wireStream
  if (wire === undefined || typeof wire.open !== 'function') {
    audit('ws-disabled', { reason: 'typertGateway.wireStream.open missing' })
    console.warn('[dsh-remote-hub] WS disabled: typertGateway.wireStream.open missing')
    return undefined
  }
  audit('ws-enabled', {})

  const mux = createGuardMux({
    // wireStream.open(endpoint, payload, uplink, peer, signal, control, window)
    open: (endpoint, payload, uplink, peer, signal) =>
      Promise.resolve(wire.open!(endpoint, payload, uplink, peer, signal)) as Promise<AsyncIterable<unknown>>,
    failure: error => (typeof wire.failure === 'function' ? wire.failure(error) : { message: String(error) }),
    onError: (message, error) => {
      // 只记消息与错误名，不记令牌/载荷。
      audit('ws-mux-error', { message, error: error instanceof Error ? error.name : typeof error })
    },
  })

  return {
    mux,
    /**
     * 为已认证设备创建进程内 Peer。
     *
     * **为什么不用 `admitConnection`**：它认领的是「Host 自己的浏览器会话」——
     * 校验 Origin 与 Host 签发的 cookie。守卫是另一个端口、没有该会话，
     * 实测恒返回 `403`（2026-11-12 实机）。
     *
     * **为什么 principal 是 `remote-device` 而不是 `owner`**（设计 v0.3 ADR-03-02）：
     * 官方 Gateway 对 `$events` 事件流只要求 `interactions === 'answer'`
     * （`api-gateway/lib/index.js:1015` → `requireInteractions`），**不要求 owner**；
     * 只有 `$events/result`（事件应答）才强制 owner（同文件 `:996`）。
     * 所以设备拿 `remote-device` + `answer` 即可看事件流，且**角色矩阵照常生效**——
     * 与 HTTP 一元通道用同一个 principal，两条通道的授权语义一致。
     * 事件应答改走 `approval-bridge` 的 `hub/answerApproval`（已有可见性与租约约束）。
     *
     * @param request - 原始升级请求（仅供 reference 记录）。
     * @param device - 已认证设备（`role` 决定能力）。
     * @returns peer（release 为空操作）。
     */
    admit: (request, device) => {
      void request
      const peer = connection.createPeer!({
        principal: remoteDevicePrincipal({
          deviceId: device.deviceId,
          role: device.role as RoleName,
        }),
        interactions: 'answer',
      })
      return { peer, release: async () => { /* 进程内 Peer 随 fiber 回收 */ } }
    },
  }
}

/**
 * 读取 Host 自己的 HTTP origin（用于把守卫请求「伪装」成同源）。
 * @param ctx - Host Context。
 * @returns `http://127.0.0.1:<port>` 或 undefined。
 */
function resolveHostOrigin(ctx: Context): string | undefined {
  const webServer = (ctx as unknown as {
    reflect?: { get?: (name: string, strict?: boolean) => unknown }
  }).reflect?.get?.('webServer', false) as
    | { port?: number; address?: () => { port?: number } | string | null; server?: { address?: () => { port?: number } | string | null } }
    | undefined
  if (webServer === undefined) return undefined

  // 依次尝试官方 webServer 服务可能暴露端口的三种形态。
  const candidates: (number | undefined)[] = []
  candidates.push(webServer.port)
  try {
    const address = webServer.address?.()
    if (typeof address === 'object' && address !== null) candidates.push(address.port)
  } catch { /* 无 address */ }
  try {
    const address = webServer.server?.address?.()
    if (typeof address === 'object' && address !== null) candidates.push(address.port)
  } catch { /* 无 server */ }

  const port = candidates.find(value => typeof value === 'number' && value > 0)
  if (port === undefined) {
    console.warn(
      '[dsh-remote-hub] ws: cannot resolve Host origin (webServer.port unavailable); '
      + `keys=${Object.keys(webServer).slice(0, 12).join(',')}`,
    )
    return undefined
  }
  return `http://127.0.0.1:${port}`
}

/**
 * 复制一份 IncomingMessage，仅替换 Origin/Referer 为 Host origin。
 * @param request - 原始请求。
 * @param hostOrigin - Host 的 origin。
 * @returns 头部已改写的请求（浅拷贝，不改动原对象）。
 */
function withHostOrigin(request: IncomingMessage, hostOrigin: string): IncomingMessage {
  const headers: Record<string, string | string[] | undefined> = { ...request.headers }
  headers.origin = hostOrigin
  headers.referer = `${hostOrigin}/`
  // Host 判定同源还看 Sec-Fetch-Site。
  headers['sec-fetch-site'] = 'same-origin'
  return Object.assign(Object.create(Object.getPrototypeOf(request) as object), request, { headers })
}
/** `assembleRemoteHub` 内部用到的守卫 WS 注入形状（与 `GuardDeps['ws']` 对齐）。 */
export type GuardWsInjection = NonNullable<GuardDeps['ws']>

/** `ctx.inject` 回调里的真实装配（三个服务此时已就绪）。 */
function assembleRemoteHub(ctx: Context, config: ConfigType): void {
  ctx.effect(async () => {
    const disposers: (() => void | Promise<void>)[] = []
    const push = (dispose: () => void | Promise<void>): void => { disposers.push(dispose) }
    let guard: GuardHandle | undefined
    let tunnel: TunnelHandle | undefined
    // 装配阶段标记：失败时写进 host-status.json，避免「只知失败不知哪步」。
    let stage = 'start'
    const at = (next: string): void => {
      stage = next
      writeStatus(config, { phase: 'assembling', stage: next })
    }

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
      // 0. 端口解析：首选配置端口，被占就顺延 +1 直到可用（用户可再改回固定端口）。
      //    隧道与配对链接都用 guard.origin（**实际**端口），所以漂移不会指错。
      at('port-check')
      const requestedPort = config.guardPort
      const resolvedPort = await resolveGuardPort(config)
      if (resolvedPort !== requestedPort) {
        // 装配期就换端口：写入状态 + 审计，页面诊断能看到「漂移」。
        audit('guard-port-shifted', { from: requestedPort, to: resolvedPort })
        config.guardPort = resolvedPort
      }

      // 1. devices（原子写 + 文件锁；未知 version 在加载期抛错）
      at('devices')
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
      at('policy:before')
      // 可见资源真源：持久化全集(∪ live)。**不能用 ctx.sessions.list() 单干**——
      // 官方 session/list 按持久化全集过滤，而 ctx.sessions 只有 live 会话，
      // 实测会导致「磁盘上有会话、接管端却是空列表」。
      const visibleResources = createVisibleResourceTracker({
        ctx,
        onError: (message, error) => {
          audit('visible-resources-error', {
            message,
            error: error instanceof Error ? error.name : typeof error,
          })
        },
      })
      push(() => visibleResources.dispose())

      const policy = registerDevicePolicy(ctx, {
        devices,
        visibleResourceIds: () => visibleResources.resourceIds(),
        onDenied: row => { audit('access-denied', row) },
      })
      at('policy:registered')
      push(() => policy.dispose())

      // 5. streams（三条一元方法；上游 opener 走 Gateway）
      at('streams')
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
      at('streams:ready')
      push(() => streams.dispose())

      at('approvals')
      const approvals = createApprovalBridge(ctx, {
        streams,
        config: {
          approvalBridgeTimeoutMs: config.approvalBridgeTimeoutMs,
          bridgeApprovals: config.bridgeApprovals,
        },
        resolveTargets: deviceTargetsResolver({
          devices: () => devices.list(),
          visibleSessionIds: () => visibleResources.resourceIds().session,
        }),
        onAudit: (row: ApprovalAuditRow) => {
          audit('approval-answer', row as unknown as Record<string, unknown>)
        },
      })
      push(() => approvals.dispose())

      // 7. dispatcher（惰性 createPeer；interactions:'none'）
      //    敏感写入（写配置 / 写凭据 / 装插件）在派发前必须逐次获得 owner 审批（D-16）。
      at('dispatcher')
      at('sensitive-approval')
      const sensitiveApprovals = createSensitiveApprovalGate({
        streams,
        config: {
          approvalBridgeTimeoutMs: config.approvalBridgeTimeoutMs,
          bridgeApprovals: config.bridgeApprovals,
        },
        onAudit: row => { audit('sensitive-approval', row as unknown as Record<string, unknown>) },
      })
      push(() => sensitiveApprovals.dispose())
      const dispatcher = createDispatcher(ctx, tokens, { approvals: sensitiveApprovals })
      push(() => dispatcher.dispose())

      /**
       * 丢弃某设备**当前**的全部连接资源：HTTP Peer、WS socket、长轮询流、策略缓存。
       *
       * 必须是统一出口：令牌在握手/请求期校验过，已建立的 socket 不会自己失效。
       * 让位、吊销、角色降级都必须走这里，否则「已失效」只对新请求成立
       * （设计 v0.3 §7）。
       *
       * `ws` 在其后才能构建，所以用闭包惰性读取。
       * @param deviceId - 目标设备。
       * @param reason - 审计原因（`revoked` / `displaced` / `role-changed`）。
       */
      const dropDevice = (deviceId: string, reason: string): void => {
        const closedWs = ws?.mux.closeDevice?.(deviceId) ?? 0
        streams.markRevoked(deviceId)
        policy.invalidate(deviceId)
        void dispatcher.drop(deviceId)
        audit('device-connections-dropped', { deviceId, reason, ws: closedWs })
      }

      // 7.5 运行指标 + 运行时配置 + 守卫信息（管理面与 guard 共用；
      //     必须先于 registerRemoteServices：管理面服务要把它们注册进去）。
      const metrics = createMetricsCollector()
      const runtimeConfig = createRuntimeConfigStore({
        path: expandHome(config.deviceTablePath.replace(/devices\.json$/u, 'overrides.json')),
        current: () => ({
          singleController: config.singleController,
          bridgeApprovals: config.bridgeApprovals,
          defaultRole: config.defaultRole,
          maxPairAttempts: config.maxPairAttempts,
          network: config.network,
          guardPort: config.guardPort,
          pairQrTtlMs: config.pairQrTtlMs,
          pairCodeTtlMs: config.pairCodeTtlMs,
          tunnelKind: config.tunnel.kind,
        }),
      })
      const offPatched = runtimeConfig.onPatched(overrides => {
        if (Object.hasOwn(overrides, 'singleController')) {
          config.singleController = overrides.singleController as boolean
        }
        if (Object.hasOwn(overrides, 'bridgeApprovals')) {
          config.bridgeApprovals = overrides.bridgeApprovals as boolean
        }
        if (Object.hasOwn(overrides, 'maxPairAttempts')) {
          config.maxPairAttempts = overrides.maxPairAttempts as number
        }
      })
      push(() => offPatched())

      at('services')
      const services = registerRemoteServices(ctx, {
        streams,
        approvals,
        sensitiveApprovals,
        devices,
        tokens,
        policy,
        pairing,
        // 吊销：令牌即时失效 + 既有连接（HTTP Peer / WS / 长轮询流）一并丢弃。
        onRevoked: deviceId => { dropDevice(deviceId, 'revoked') },
        metrics,
        configStore: runtimeConfig,
        // guard 在 services 之后创建：用惰性 getter 读取（调用发生在请求期）。
        guard: () => ({
          origin: guard?.origin ?? '',
          loopbackOrigin: guard?.loopbackOrigin ?? '',
          port: guard?.port ?? config.guardPort,
          protocolVersion: PROTOCOL_VERSION,
          singleController: config.singleController,
          network: config.network,
        }),
      })
      push(() => services.dispose())

      // 9. guard（独立监听；端口被占即抛）
      at('guard:listening')
      // 整机接管的 WebSocket 端点（架构说明 §10.9 / A3 / 路线 β）：
      //   守卫校验设备令牌 → connection.admitConnection 认领 socket
      //   → guard-mux 把 mux 帧翻译成 typertGateway.wireStream.open 调用。
      // 两个官方能力缺失时**不挂载** WS（保持纯 HTTP），不让页面拿到半残能力。
      const ws = buildGuardWs(ctx, audit)
      guard = await startGuard({
        config,
        tokens,
        pairing,
        dispatcher,
        devices,
        metrics,
        configStore: runtimeConfig,
        audit,
        // 单控让位：只断连接（丢 Peer、断流、关 WS），**不**吊销令牌（设计 v0.3 §7）。
        onSessionDisplaced: deviceId => { dropDevice(deviceId, 'displaced') },
        ...(ws === undefined ? {} : { ws }),
      })
      at('guard:up')
      push(() => guard?.dispose())

      // 角色变化：既有 WS 里的 Peer 是握手时固定的 principal，必须断开重连，
      // 否则「降权」只对新请求生效（设计 v0.3 §7）。
      push(tokens.onRoleChanged(deviceId => { dropDevice(deviceId, 'role-changed') }))

      // 10. tunnel（只指向 guard.origin；默认 none 不 spawn）
      tunnel = await startTunnel(config.tunnel, guard.origin)
      push(() => tunnel?.dispose())

      // index 注入：把进程内 pairIssueToken 写进**本机页面**。
      // 隧道那侧的页面拿不到这个值（它不经过 webServer 渲染），这正是 R4 的补强。
      //
      // 路线 A：同时注入 `guardOrigin`（本机页面签发配对要用守卫地址，不是 web
      // 页面 origin）与**已配对设备快照**（非敏感字段：label/role/时间；不含
      // tokenHash）。快照在页面渲染时求值，配对新设备后刷新页面即可见。
      const injectOff = (ctx as unknown as {
        inject(deps: string[], callback: (scoped: Context) => void): void
      }).inject(['webServer'], scoped => {
        const off = (scoped as unknown as {
          on(event: string, listener: (table: unknown[], peer: unknown) => void): () => void
        }).on('webserver/index-inject', table => {
          let deviceRows: unknown[] = []
          try {
            deviceRows = devices.list()
              .filter(device => device.revokedAt === null)
              .slice(0, 50)
              .map(device => ({
                deviceId: device.deviceId,
                label: device.label,
                role: device.role,
                createdAt: device.createdAt,
                lastSeenAt: device.lastSeenAt,
              }))
          } catch {
            deviceRows = [] // 设备表读取失败不能拖垮页面注入。
          }
          table.push({
            kind: 'global',
            name: PAIR_ISSUE_GLOBAL,
            value: {
              pairIssueToken: guard?.pairIssueToken,
              guardOrigin: guard?.origin,
              loopbackOrigin: guard?.loopbackOrigin,
              // 注入握手：页面据此确认自己连的是**当前**守卫实例，而不是旧注入。
              instanceId: INSTANCE_ID,
              pid: process.pid,
              injectedAt: new Date().toISOString(),
              protocolVersion: PROTOCOL_VERSION,
              devices: deviceRows,
            },
          })
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

      writeStatus(config, {
        phase: 'running',
        guard: { origin: guard.origin, loopbackOrigin: guard.loopbackOrigin, port: guard.port },
        network: config.network,
        singleController: config.singleController,
        devices: devices.list().length,
      })
    } catch (error) {
      // 装配失败：先卸掉已装配的部分，然后**降级为不装配**而不是把错误交给
      // cordis fiber —— 一个端点被占 / 设备表损坏不该让宿主的 web boot 整体
      // 中止（同一次桌面崩溃的教训）。错误细节进日志，守卫保持关闭。
      for (const dispose of [...disposers].reverse()) {
        try { await dispose() } catch { /* 卸载错误不能盖住根因 */ }
      }
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      writeStatus(config, { phase: 'failed', stage, error: message })
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
