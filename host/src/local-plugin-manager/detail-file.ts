/**
 * 详情图片转发（Host 半边）。
 *
 * ## 为什么需要
 *
 * 官方插件页详情文档里的图片是**相对** URL `api/plugin-manager/detail-file?...`。
 * 接管（carrier）之后，这个相对路径会解析到**云端** Host —— 本地插件页因此会显示错机器的配图。
 * 本模块把同一组语义挂到本机路径 `api/hub/local-plugin-manager/detail-file` 上。
 *
 * ## 为什么是「薄转发」而不是自己实现读取器（ADR-001）
 *
 * 官方 `@deepseek-ai/dsh-plugin-manager` 已经把这件事做完了，且它是**导出的纯数据函数**：
 *
 * - `readBundleImage(bundle, document, destination, preferred, options)`：
 *   解析 bundle 目录、本地/ npm CDN 文件源、路径穿越防护、大小上限、超时；
 * - 官方路由处理器 `serveDetailFile()` 是 `private`，不能直接调 —— 这里复用它的**三段式逻辑**
 *   （找 bundle → 读图 → 归一响应），代价约 40 行、**零新增依赖**；
 * - 响应层 `detailImageResponse()` 在 `@deepseek-ai/dsh-plugin-detail`，纯函数，逐字复刻官方响应头
 *   （`X-Content-Type-Options: nosniff`、sandbox CSP、失败状态码映射）。
 *
 * ## 限制参数的来源
 *
 * 官方 `PluginManager.Config` 的默认值（`detailMaxBytes` 1 MiB、`detailImageMaxBytes` 5 MiB、
 * `detailFetchTimeoutMs` 15 s、`detailNpmFileSources` = `NPM_FILE_SOURCES`）。这里**按默认值**构造，
 * 不去读官方服务的私有 Config（避免耦合内部字段）；若宿主改了这些上限，本通道仍用默认值 ——
 * 这只影响「超限判定」，不影响图片正确性。
 *
 * ## 失效条件
 *
 * 目标 DSH 版本若不再导出 `readBundleImage`，模块加载期即抛错，由 {@link createDetailFileHandler}
 * 捕获并降级为「详情图片不可用」（页面显示官方同款占位），不影响其余功能。
 *
 * @module dsh-remote-hub/host/local-plugin-manager/detail-file
 */
import type {
  BundleDetailOptions,
  DetailFailureReason,
  DetailImage,
  NpmFileSource,
} from './official-types.js'

import type { LocalPluginUpstreams } from './service.js'
import { asLocalPluginError, failureBody } from './service.js'
import { detailImageResponse } from './response.js'

/** 官方 `PluginManager.Config` 里的详情相关默认值（见 ADR-001）。 */
export const DETAIL_LIMITS = Object.freeze({
  maxDocumentBytes: 1024 * 1024,
  maxImageBytes: 5 * 1024 * 1024,
  timeoutMs: 15_000,
  npmFileSources: ['jsdelivr', 'unpkg', 'npmmirror'] as readonly NpmFileSource[],
})

/** 官方 `readBundleImage` 的形状（宽松声明，避免依赖宿主内部类型文件）。 */
type ReadBundleImage = (
  bundle: unknown,
  document: string,
  destination: string,
  preferred: readonly string[],
  options: {
    readonly profile: unknown
    readonly maxDocumentBytes: number
    readonly maxImageBytes: number
    readonly npmFileSources: readonly NpmFileSource[]
    readonly timeoutMs: number
    readonly lifetime: AbortSignal
  },
) => Promise<DetailImage | undefined>

/**
 * 解析官方 `readBundleImage` 与 bundle 详情选项。
 *
 * 用**动态 import** 而不是静态 import：静态 import 会在模块加载期绑定
 * `@deepseek-ai/dsh-plugin-manager` 的整棵依赖图，宿主某些组合（无托管 profile）可能不需要它；
 * 动态 import 允许我们把「缺失」变成一次明确降级而不是装配失败。
 * @returns 读取器，或 undefined（目标版本未导出）。
 */
async function loadReader(): Promise<ReadBundleImage | undefined> {
  try {
    // 官方包名由宿主在运行时解析：这里用变量拼出 specifier，避免 TypeScript 在编译期要求该包存在。
    const specifier = '@deepseek-ai/' + 'dsh-plugin-manager'
    const mod = await import(/* @vite-ignore */ specifier) as {
      readBundleImage?: ReadBundleImage
    }
    return typeof mod.readBundleImage === 'function' ? mod.readBundleImage : undefined
  } catch {
    return undefined
  }
}

/**
 * 读取详情文档旁的一张图片。
 *
 * 运行时从宿主解析官方 `readBundleImage()`（`@deepseek-ai/dsh-plugin-manager` 的导出），
 * 解析不到时返回 undefined —— 页面按官方同款占位处理，本通道其余功能不受影响。
 * @param bundle - `listBundles()` 里的一个 bundle。
 * @param document - 文档在包内的路径。
 * @param destination - 文档里写的图片地址。
 * @param preferred - 优先询问的 npm 文件 CDN。
 * @param options - profile、来源与上限（见 {@link DETAIL_LIMITS}）。
 * @returns 图片或 undefined。
 */
export async function readBundleImageAtRuntime(
  bundle: unknown,
  document: string,
  destination: string,
  preferred: readonly string[],
  options: BundleDetailOptions,
): Promise<DetailImage | undefined> {
  const reader = await loadReader()
  if (reader === undefined) return undefined
  return await reader(bundle, document, destination, preferred, options)
}

/**
 * 每次请求都需要 `ProfileContext`，但本通道没有 `ctx.profileContext` 的强依赖。
 * 通过 Host Context 读取（缺失时返回 undefined → 图片不可用，而不是抛错）。
 * @param ctx - Host Context。
 */
function profileOf(ctx: object): BundleDetailOptions['profile'] | undefined {
  const reflect = (ctx as unknown as { reflect?: { get?: (key: string, strict?: boolean) => unknown } }).reflect
  try {
    return reflect?.get?.('profileContext', false) as BundleDetailOptions['profile'] | undefined
  } catch {
    return undefined
  }
}

/**
 * 创建详情图片路由处理器。
 *
 * 与官方 `serveDetailFile()` 同构：
 * `GET ...?bundle=<name>&document=<path>&path=<destination>[&sources=<cdn>,...]`
 * @param upstreams - 官方服务实例（只需要 `pluginManager.listBundles`）。
 * @param ctx - Host Context（读取 `profileContext`；缺省时图片降级）。
 * @returns 处理器。
 */
export function createDetailFileHandler(
  upstreams: LocalPluginUpstreams,
  ctx?: object,
): (request: Request) => Promise<Response> {
  const lifetime = new AbortController()
  // 图片每次都要重新解析 bundle：重装后应当显示自己的图（官方注释同款理由）。
  const cacheControl = 'no-store'
  return async (request: Request): Promise<Response> => {
    const params = new URL(request.url).searchParams
    const bundleName = params.get('bundle')
    const document = params.get('document')
    const path = params.get('path')
    if (bundleName === null || document === null || path === null) return detailImageResponse('invalid', cacheControl)
    try {
      const readBundleImage = await loadReader()
      const profile = ctx === undefined ? undefined : profileOf(ctx)
      if (readBundleImage === undefined || profile === undefined) {
        return detailImageResponse('denied' satisfies DetailFailureReason, cacheControl)
      }
      const listed = await upstreams.pluginManager.listBundles() as readonly { name?: unknown }[]
      const bundle = listed.find(candidate => candidate?.name === bundleName)
      if (bundle === undefined) return detailImageResponse(undefined, cacheControl)
      const image = await readBundleImage(bundle, document, path, params.get('sources')?.split(',') ?? [], {
        profile,
        maxDocumentBytes: DETAIL_LIMITS.maxDocumentBytes,
        maxImageBytes: DETAIL_LIMITS.maxImageBytes,
        npmFileSources: DETAIL_LIMITS.npmFileSources,
        timeoutMs: DETAIL_LIMITS.timeoutMs,
        lifetime: lifetime.signal,
      })
      return detailImageResponse(image, cacheControl)
    } catch (error) {
      // 官方错误码（unknown-bundle / detail-unavailable）→ 官方同款响应；
      // 其它异常同样不泄漏内部细节，统一按「不可用」处理。
      const code = asLocalPluginError(error).code
      if (code === 'plugin-manager/unknown-bundle') return detailImageResponse(undefined, cacheControl)
      if (code === 'plugin-manager/detail-unavailable') {
        return detailImageResponse('network' satisfies DetailFailureReason, cacheControl)
      }
      return new Response(JSON.stringify(failureBody(asLocalPluginError(error))), {
        status: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    }
  }
}
