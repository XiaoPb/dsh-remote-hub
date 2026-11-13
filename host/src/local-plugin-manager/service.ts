/**
 * 本地插件管理直连服务（Host 半边）。
 *
 * ## 它是什么
 *
 * 官方插件页的全部动作都经 `ctx.remote.pluginManager.*` → `/api/<ns>/<method>` 的一元 RPC 到达「当前 Host」。
 * 接管（carrier）后那条链路指向云端，于是官方页只能看到云端插件。本服务提供**同一批动作的本机直连面**，
 * 供「本地插件」页调用（需求：该接口不释放给 RPC，避免云端调用）。
 *
 * ## 它不是什么
 *
 * - **不是** `TypertRemoteService`，**没有** `@Remote`：所以它不在 Typert 注册表里，
 *   `api-gateway` 的 `claimsEndpoint()` 看不到它，`remoteAccess.decide()` 也不会为它裁决。
 * - **不重写业务逻辑**：每个方法都直接调用本机官方服务实例
 *   （`pluginManager` / `pluginInventory` / `pluginRegistryProbe`），参数与返回值**原样透传**，
 *   因此行为、错误码、进度语义与官方页天然一致。
 *
 * ## 依赖与降级
 *
 * 三个官方服务用 `ctx.inject` 延迟装配：任一缺席（例如极早期的 client 侧或无托管 profile 的宿主），
 * 通道就整体不挂（fail-closed），页面侧显示「本机插件管理不可用」，绝不抛错拖垮宿主。
 *
 * @module dsh-remote-hub/host/local-plugin-manager/service
 */
import type { Context } from '@deepseek-ai/cordis'

import {
  LOCAL_PLUGIN_ERRORS,
  type LocalPluginFailureBody,
  type LocalPluginMethod,
} from '@core/index.js'

/**
 * 从某个 `ctx` 上读一个可能未就绪的服务实例。
 *
 * 用 `reflect.get(name, false)`（strict = false）读**实例**：服务提供方 fiber 尚未激活时返回 `undefined`
 * 而不是抛错。直接读 `ctx.<name>` 会遇到 cordis 的 provide 校验（未 provide 的属性访问抛
 * `cannot get property … without provide`），在「宿主组合里没有该服务」时会把装配拖垮。
 * @param ctx - 任意 Context。
 * @param name - 服务键。
 * @returns 服务实例，或 undefined。
 */
export function readService(ctx: Context, name: string): unknown {
  const reflect = (ctx as unknown as {
    reflect?: { get?: (key: string, strict?: boolean) => unknown }
  }).reflect
  try {
    return reflect?.get?.(name, false)
  } catch {
    return undefined
  }
}

/** 官方 `pluginManager` 服务里本通道用到的成员。 */
interface PluginManagerLike {
  listBundles(): Promise<unknown>
  listPlugins(): Promise<unknown>
  registries(): Promise<unknown>
  inspect(spec: string, options?: unknown, signal?: AbortSignal): Promise<unknown>
  listVersions(name: string, options?: unknown, signal?: AbortSignal): Promise<unknown>
  readBundleDetail(name: string, language: string, options?: unknown): Promise<unknown>
  installBundle(spec: string, options?: unknown): Promise<unknown>
  waitForInstall(requestId: string): Promise<unknown>
  cancelInstall(requestId: string): Promise<unknown>
  updateBundle(name: string, version: string, options?: unknown): Promise<unknown>
  removeBundle(name: string): Promise<unknown>
  setPluginEnabled(id: string, enabled: boolean): Promise<unknown>
  setBundleEnabled(name: string, enabled: boolean): Promise<unknown>
}

/** 官方 `pluginInventory` 服务里本通道用到的成员。 */
interface PluginInventoryLike {
  list(): Promise<unknown>
}

/** 官方 `pluginRegistryProbe` 服务里本通道用到的成员。 */
interface PluginRegistryProbeLike {
  fastest(): Promise<string | null>
}

/** 本通道依赖的三个官方服务实例。 */
export interface LocalPluginUpstreams {
  readonly pluginManager: PluginManagerLike
  readonly pluginInventory?: PluginInventoryLike
  readonly pluginRegistryProbe?: PluginRegistryProbeLike
}

/**
 * 从 Host Context 解析三个官方服务。
 * @param ctx - Host Context（已就绪 `pluginManager`）。
 * @returns 上游集合；`pluginManager` 缺席时返回 undefined（通道不可用）。
 */
export function resolveLocalPluginUpstreams(ctx: Context): LocalPluginUpstreams | undefined {
  const pluginManager = readService(ctx, 'pluginManager') as PluginManagerLike | undefined
  if (pluginManager === undefined || typeof pluginManager.listBundles !== 'function') return undefined
  const inventory = readService(ctx, 'pluginInventory') as PluginInventoryLike | undefined
  const probe = readService(ctx, 'pluginRegistryProbe') as PluginRegistryProbeLike | undefined
  return {
    pluginManager,
    ...(typeof inventory?.list === 'function' ? { pluginInventory: inventory } : {}),
    ...(typeof probe?.fastest === 'function' ? { pluginRegistryProbe: probe } : {}),
  }
}

/** 直连调用失败：带稳定错误码，路由层据此映射 HTTP 状态。 */
export class LocalPluginError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly status = 500,
  ) {
    super(message)
    this.name = 'LocalPluginError'
  }
}

/**
 * 参数校验失败。
 * @param message - 人类可读原因。
 * @param details - 结构化细节（会原样返回给客户端）。
 */
export function badRequest(message: string, details: Record<string, unknown> = {}): never {
  throw new LocalPluginError(LOCAL_PLUGIN_ERRORS.badRequest, message, details, 400)
}

/**
 * 上游服务缺席。
 * @param what - 缺席的服务名。
 */
export function unavailable(what: string): never {
  throw new LocalPluginError(LOCAL_PLUGIN_ERRORS.unavailable, `${what} is not available on this Host`, { service: what }, 503)
}

/** 断言一个值是字符串（非空）。 */
function assertString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') badRequest(`${name} must be a non-empty string`, { parameter: name })
  return value
}

/** 断言一个值是布尔。 */
function assertBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') badRequest(`${name} must be a boolean`, { parameter: name })
  return value
}

/**
 * 断言一个可选的 plain-object 参数只含允许的字段。
 *
 * 与 Gateway 的 `assertExactArguments` 同精神：多余字段一律拒绝，避免客户端悄悄依赖一个并不存在的选项。
 * @param value - 待校验值。
 * @param name - 参数名（错误信息用）。
 * @param allowed - 允许的字段名。
 * @returns 原始对象（字段值由下游官方服务校验）。
 */
function assertOptions(value: unknown, name: string, allowed: readonly string[]): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) badRequest(`${name} must be an object`, { parameter: name })
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) badRequest(`${name} has an unknown field`, { parameter: name, field: key })
  }
  return record
}

/**
 * 校验一个可选数组参数（例如 `npmFileSources` / `approvedBuilds`）。
 * @param value - 待校验值。
 * @param name - 参数名。
 * @returns 原数组，或 undefined。
 */
function assertStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    badRequest(`${name} must be a string array`, { parameter: name })
  }
  return value as string[]
}

/**
 * 把官方服务抛出的异常归一成 {@link LocalPluginError}。
 *
 * 官方错误自带 `code` / `message` / `details`（`RemoteError` 形状）；其它异常归为 `upstream`。
 * @param error - 捕获到的异常。
 */
function normalizeUpstreamError(error: unknown): LocalPluginError {
  if (error instanceof LocalPluginError) return error
  const shaped = error as { code?: unknown; message?: unknown; details?: unknown; status?: unknown } | undefined
  if (typeof shaped?.code === 'string' && /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/u.test(shaped.code)) {
    return new LocalPluginError(
      shaped.code,
      typeof shaped.message === 'string' ? shaped.message : shaped.code,
      typeof shaped.details === 'object' && shaped.details !== null ? shaped.details as Record<string, unknown> : {},
      mapStatus(shaped.code),
    )
  }
  return new LocalPluginError(
    LOCAL_PLUGIN_ERRORS.upstream,
    error instanceof Error ? error.message : String(error),
    {},
    500,
  )
}

/**
 * 官方错误码 → HTTP 状态。
 *
 * 只做「让浏览器与测试能区分」的最小映射；客户端最终读的是信封里的 `code`，不是状态码。
 * @param code - 官方错误码。
 */
function mapStatus(code: string): number {
  if (code === 'plugin-manager/unknown-bundle' || code === 'plugin-manager/detail-unavailable') return 404
  if (code === 'plugin-manager/invalid-language' || code === 'plugin-manager/invalid-spec') return 400
  return 500
}

/** 一次直连调用的上下文（目前只需要 abort signal）。 */
export interface LocalPluginCallContext {
  readonly signal?: AbortSignal
}

/**
 * 本地插件管理直连服务。
 *
 * 方法签名与官方 `pluginManager` 逐位一致（位置参数顺序相同），方便与 vendored 控制器的调用点逐行对账。
 */
export class LocalPluginManagerService {
  /**
   * @param upstreams - 已解析的三个官方服务实例。
   */
  constructor(private readonly upstreams: LocalPluginUpstreams) {}

  /**
   * 执行一个直连方法。
   *
   * 统一入口：按方法名分发、捕获并归一异常。路由层只依赖这一个方法。
   * @param method - 一元方法名（已由 {@link isLocalPluginMethod} 校验过）。
   * @param args - 位置参数数组。
   * @param call - 调用上下文（可选 abort signal）。
   * @returns 官方服务的原始返回值。
   */
  async call(method: LocalPluginMethod, args: readonly unknown[], call: LocalPluginCallContext = {}): Promise<unknown> {
    try {
      return await this.dispatch(method, args, call)
    } catch (error) {
      throw normalizeUpstreamError(error)
    }
  }

  private async dispatch(method: LocalPluginMethod, args: readonly unknown[], call: LocalPluginCallContext): Promise<unknown> {
    const { pluginManager } = this.upstreams
    switch (method) {
      case 'listBundles':
        return await pluginManager.listBundles()
      case 'listPlugins':
        return await pluginManager.listPlugins()
      case 'listInventory': {
        const inventory = this.upstreams.pluginInventory
        if (inventory === undefined) unavailable('pluginInventory')
        return await inventory.list()
      }
      case 'registries':
        return await pluginManager.registries()
      case 'fastestRegistry': {
        const probe = this.upstreams.pluginRegistryProbe
        if (probe === undefined) return null
        return await probe.fastest()
      }
      case 'inspect': {
        const [spec, rawOptions] = args
        const options = assertOptions(rawOptions, 'options', ['registry'])
        return await pluginManager.inspect(assertString(spec, 'spec'), options, call.signal)
      }
      case 'listVersions': {
        const [name, rawOptions] = args
        const options = assertOptions(rawOptions, 'options', ['registry'])
        return await pluginManager.listVersions(assertString(name, 'name'), options, call.signal)
      }
      case 'readBundleDetail': {
        const [name, language, rawOptions] = args
        const options = assertOptions(rawOptions, 'options', ['npmFileSources'])
        const sources = assertStringArray(options.npmFileSources, 'options.npmFileSources')
        return await pluginManager.readBundleDetail(
          assertString(name, 'name'),
          assertString(language, 'language'),
          sources === undefined ? {} : { npmFileSources: sources },
        )
      }
      case 'installBundle': {
        const [spec, rawOptions] = args
        const options = assertOptions(rawOptions, 'options', ['enabled', 'saveExact', 'requestId', 'approvedBuilds', 'registry'])
        return await pluginManager.installBundle(assertString(spec, 'spec'), options)
      }
      case 'waitForInstall':
        return await pluginManager.waitForInstall(assertString(args[0], 'requestId'))
      case 'cancelInstall':
        return await pluginManager.cancelInstall(assertString(args[0], 'requestId'))
      case 'updateBundle': {
        const [name, version, rawOptions] = args
        const options = assertOptions(rawOptions, 'options', ['registry', 'requestId'])
        return await pluginManager.updateBundle(assertString(name, 'name'), assertString(version, 'version'), options)
      }
      case 'removeBundle':
        return await pluginManager.removeBundle(assertString(args[0], 'name'))
      case 'setPluginEnabled': {
        const [id, enabled] = args
        return await pluginManager.setPluginEnabled(assertString(id, 'id'), assertBoolean(enabled, 'enabled'))
      }
      case 'setBundleEnabled': {
        const [name, enabled] = args
        return await pluginManager.setBundleEnabled(assertString(name, 'name'), assertBoolean(enabled, 'enabled'))
      }
    }
  }
}

/**
 * 把 {@link LocalPluginError} 渲染成 HTTP 响应的 body。
 * @param error - 归一后的错误。
 */
export function failureBody(error: LocalPluginError): LocalPluginFailureBody {
  return { code: error.code, message: error.message, details: error.details }
}

/**
 * 兜底：把任意异常归一为 {@link LocalPluginError}。
 * @param error - 捕获到的异常。
 */
export function asLocalPluginError(error: unknown): LocalPluginError {
  return normalizeUpstreamError(error)
}
