/**
 * 「本地插件管理直连通道」的共享契约（Host 与 Client 共用一份，`tsdown` 各自内联）。
 *
 * ## 为什么需要它
 *
 * 官方「插件」页（`@deepseek-ai/dsh-client-ui-plugin-manager`）的控制器**硬绑 `ctx.remote`**：
 * 每个动作都经 `transport → /api/<ns>/<method>` 的一元 RPC 到达「当前 Host」。接管（carrier）后，
 * `__DSH_TRANSPORT__` 把这整条链路改道云端，于是官方页显示与操作的都是**云端**插件。
 *
 * 本地插件页要的是**本机** profile 的插件管理，因此必须有一条**不经过 transport、也不在 RPC 名册里**的
 * 直连通道（需求原文：「该接口不释放给 RPC，避免云端调用」）。
 *
 * ## 通道形状（详见 `dev/plans/local-plugins-page/02-contract.md`）
 *
 * - 一元方法：`POST /api/hub/local-plugin-manager/<method>`，body `{ args: [...] }`（位置参数，与官方签名一一对应）。
 *   注册方式是 `ctx.connection.fetch.register`（**精确路径**），不是 `rpc.intercept`、也不是 `@Remote`：
 *   - 精确路径只放行 `peer.principal.kind === 'owner'`（本机页面 / 同源调用），远端配对设备一律 403；
 *   - 请求不会进入 api-gateway，所以云端设备**看不到**这些 endpoint 的存在。
 * - 事件：`WS /api/hub/local-plugin-manager/events`（官方 4 个 `plugin-manager/*` 事件的本机订阅面）。
 * - 详情图片：`GET /api/hub/local-plugin-manager/detail-file?...`（与官方 `/api/plugin-manager/detail-file` 同构）。
 *
 * ## 红线
 *
 * 这里的方法名**永远不得**进入 `capabilities.ts` 的任何角色矩阵：
 * `assertLocalPluginNotDelegated()` 在模块加载期与 `assertMatrixIntegrity()` 一起断言。
 * 「在 ENDPOINT_TABLE 里登记事实条目」只是为了让「存在但永不授权」成为可静态检查的事实，
 * 不构成任何授予。
 *
 * @module @core/local-plugin-manager
 */

/**
 * 直连通道的路径前缀。
 *
 * 位于 `client-connection` 的 `/api` 前缀路由之下（复用其 Host/Origin 信任栅栏与浏览器认证），
 * 但只注册**精确**子路径，不参与共享 RPC 分发。
 */
export const LOCAL_PLUGIN_CHANNEL = '/api/hub/local-plugin-manager'

/**
 * 一元方法名（同时也是路由末段）。
 *
 * 顺序与官方 `pluginManager` 服务的方法清单一致，便于与
 * `@deepseek-ai/dsh-client-ui-plugin-manager` 的控制器调用点逐条对账。
 */
export const LOCAL_PLUGIN_METHODS = [
  'listBundles',
  'listPlugins',
  'listInventory',
  'registries',
  'fastestRegistry',
  'inspect',
  'listVersions',
  'readBundleDetail',
  'installBundle',
  'waitForInstall',
  'cancelInstall',
  'updateBundle',
  'removeBundle',
  'setPluginEnabled',
  'setBundleEnabled',
] as const

/** 一个直连方法名。 */
export type LocalPluginMethod = (typeof LOCAL_PLUGIN_METHODS)[number]

/** 事件通道（WebSocket 升级路径）——本机插件管理事件的唯一订阅面。 */
export const LOCAL_PLUGIN_EVENTS_PATH = '/api/hub/local-plugin-manager/events'

/**
 * 详情图片转发路由。
 *
 * 为什么必须存在：官方页的 `<img>` 用**相对** URL `api/plugin-manager/detail-file?...`，
 * 接管后会解析到云端 Host。本地页必须换成这条本机路由，否则详情文档的配图永远来自云端。
 */
export const LOCAL_PLUGIN_DETAIL_FILE_PATH = '/api/hub/local-plugin-manager/detail-file'

/** 稳定错误码（客户端据此分类，官方服务错误码原样透传）。 */
export const LOCAL_PLUGIN_ERRORS = {
  /** 本机缺少官方 `pluginManager` / `pluginInventory` / `pluginRegistryProbe` 服务。 */
  unavailable: 'local-plugin-manager/unavailable',
  /** 参数不合法（arity / 类型 / 未知 options 字段）。 */
  badRequest: 'local-plugin-manager/bad-request',
  /** 调用方不是本机 owner（远端配对设备、跨源页面）。 */
  forbidden: 'local-plugin-manager/forbidden',
  /** 未知方法名。 */
  notFound: 'local-plugin-manager/not-found',
  /** 官方服务抛出非结构化的异常。 */
  upstream: 'local-plugin-manager/upstream',
} as const

/** 一个直连错误的响应体。 */
export interface LocalPluginFailureBody {
  readonly code: string
  readonly message: string
  readonly details: Record<string, unknown>
}

/** 一元请求体：位置参数数组（与官方方法签名逐位对应）。 */
export interface LocalPluginCallBody {
  readonly args?: readonly unknown[]
}

/** 事件通道的客户端 → 服务端帧（当前只有续传水位由 URL 查询串表达，预留该形状）。 */
export type LocalPluginClientFrame = { readonly type: 'ping' }

/**
 * 事件通道的服务端 → 客户端帧。
 *
 * 四个事件帧与官方 Cordis 事件一一对应；`seq` 进程内单调递增，客户端靠它做断线续传与断档检测。
 */
export type LocalPluginEventFrame =
  /** 建链成功：`seq` 是当前水位（客户端可从这里开始计数）。 */
  | { readonly type: 'hello'; readonly seq: number }
  /** 官方 `plugin-manager/changed`：插件 / bundle / 组合发生变化。 */
  | { readonly type: 'changed'; readonly seq: number; readonly change: { readonly reason: string } }
  /** 官方 `plugin-manager/install-log`：安装输出的一段。 */
  | { readonly type: 'install-log'; readonly seq: number; readonly chunk: unknown }
  /** 官方 `plugin-manager/install-state`：安装阶段变化。 */
  | { readonly type: 'install-state'; readonly seq: number; readonly progress: unknown }
  /** 官方 `plugin-manager/update-state`：更新步骤变化。 */
  | { readonly type: 'update-state'; readonly seq: number; readonly progress: unknown }
  /** 断档：客户端请求的水位已不在缓冲里，要求做一次全量刷新。 */
  | { readonly type: 'reset'; readonly seq: number }
  /** 慢消费者：某一段帧被丢弃（之后一定紧跟一次 `reset`）。 */
  | { readonly type: 'dropped'; readonly seq: number; readonly count: number }

/** 事件通道里除 `hello` 外的业务帧类型（订阅方按此分发）。 */
export type LocalPluginEventKind = Exclude<LocalPluginEventFrame['type'], 'hello' | 'reset' | 'dropped'>

/** 事件缓冲的默认上限：最多保留多少帧。 */
export const LOCAL_PLUGIN_EVENT_BUFFER_FRAMES = 512

/** 事件缓冲的默认上限：最多保留多少字节（超限时丢最旧的帧）。 */
export const LOCAL_PLUGIN_EVENT_BUFFER_BYTES = 2 * 1024 * 1024

/**
 * 拼出一个直连方法的完整路由路径。
 * @param method - 一元方法名。
 * @returns 形如 `/api/hub/local-plugin-manager/listBundles` 的绝对路径。
 */
export function localPluginPath(method: LocalPluginMethod): string {
  return `${LOCAL_PLUGIN_CHANNEL}/${method}`
}

/**
 * 判断一个字符串是否是已知的一元方法名。
 * @param value - 待判定值（通常来自服务端路由或客户端调用）。
 * @returns 命中 {@link LOCAL_PLUGIN_METHODS} 时为 true。
 */
export function isLocalPluginMethod(value: unknown): value is LocalPluginMethod {
  return typeof value === 'string' && (LOCAL_PLUGIN_METHODS as readonly string[]).includes(value)
}

/**
 * 该方法在「官方 pluginManager 名册」里的等价 endpoint。
 *
 * 只用于文档对账与审计断言（证明本地方法有一等一的官方对应物），**不参与任何授权**。
 * @param method - 一元方法名。
 * @returns `pluginManager/<method>`；没有官方对应物时（`listInventory` / `fastestRegistry`）返回它们真正的所属 namespace。
 */
export function officialEndpointFor(method: LocalPluginMethod): string {
  if (method === 'listInventory') return 'pluginInventory/list'
  if (method === 'fastestRegistry') return 'pluginRegistryProbe/fastest'
  return `pluginManager/${method}`
}
