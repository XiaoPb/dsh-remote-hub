/**
 * 本地插件管理直连通道用到的官方类型形状（**仅类型，零运行时依赖**）。
 *
 * ## 为什么手写而不是装包（ADR-007）
 *
 * `@deepseek-ai/dsh-plugin-detail` / `dsh-plugin-manager` 只存在于 DSH 宿主安装目录里，
 * 不在本仓库的 `node_modules`，也不随本包发布。把它们装成 `devDependency` 会拖进 30+ 传递依赖，
 * 而运行时一个字节都用不到（Host bundle 对 `@deepseek-ai/*` 全部 external）。
 *
 * 更关键的是：**顶层静态 import 会让 `lib/index.js` 在仓库范围内无法加载**
 * （`test/_helpers.mjs` 的 `testLoadLib()` 需要能 import 构建产物做断言）。
 * 因此本通道对官方的依赖被压缩成：
 *
 * - 一处**运行时动态解析**：`readBundleImage`（`detail-file.ts` 的 `loadReader()`，缺失即降级）；
 * - 一处**逐字复刻的纯函数**：`detailImageResponse`（其官方源码只有 12 行，见 `plugin-detail/src/response.ts`）。
 *
 * ## 维护方式
 *
 * 形状取自 DSH `0.2.2-rc.1`。上游签名变化时由 `04-verification.md` §5 的 drift 检查提示同步本文件。
 *
 * @module dsh-remote-hub/host/local-plugin-manager/official-types
 */

/** 详情文档/图片读不出时的原因（官方 `DetailFailureReason`）。 */
export type DetailFailureReason = 'too-large' | 'network' | 'denied' | 'git-unavailable' | 'invalid'

/** 一张详情图片（官方 `DetailImage`）。 */
export interface DetailImage {
  readonly bytes: Uint8Array
  readonly mediaType: string
}

/** npm 文件 CDN 标识（官方 `NpmFileSource`）。 */
export type NpmFileSource = 'jsdelivr' | 'unpkg' | 'npmmirror'

/** 详情读取的限制与来源（官方 `BundleDetailOptions`，`profile` 对外收敛成 unknown）。 */
export interface BundleDetailOptions {
  readonly profile: unknown
  readonly maxDocumentBytes: number
  readonly maxImageBytes: number
  readonly npmFileSources: readonly NpmFileSource[]
  readonly timeoutMs: number
  readonly lifetime: AbortSignal
}
