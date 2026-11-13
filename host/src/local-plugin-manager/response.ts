/**
 * 详情图片路由的响应层。
 *
 * ## 出处
 *
 * 与 `deepseek-harness/packages/util/plugin-detail/src/response.ts` 的 `detailImageResponse()` **逐字对齐**
 * （DSH `0.2.2-rc.1`）。之所以就地复刻而不是 import：
 *
 * - 该包只在 DSH 宿主进程里存在，本仓库的 Node 测试环境没有它；
 * - 顶层静态 import 会让 `lib/index.js` 在本仓库范围内无法加载（`test/_helpers.mjs` 依赖它加载构建产物）；
 * - 这个函数只有 12 行、纯数据、无副作用，复刻的维护成本低于引入依赖。
 *
 * 若上游改动（响应头 / 状态码映射），`04-verification.md` §6b 的一致性测试会失败，提醒同步本文件。
 *
 * @module dsh-remote-hub/host/local-plugin-manager/response
 */
import type { DetailFailureReason, DetailImage } from './official-types.js'

/** 每种失败原因对应的 HTTP 状态（与官方 `FAILURE_STATUS` 逐字一致）。 */
const FAILURE_STATUS = {
  'too-large': 413,
  network: 502,
  denied: 403,
  'git-unavailable': 503,
  invalid: 400,
} as const satisfies Record<DetailFailureReason, number>

/**
 * 详情图片路由的响应：图片 / 404（无图）/ 失败原因对应的状态。
 *
 * 每个响应都带 `X-Content-Type-Options: nosniff` 与 sandbox CSP —— 直接打开的 SVG 否则会在
 * 已认证的 API origin 上执行脚本；只有图片本身拿 `cacheControl`。
 * @param outcome - 图片、undefined（没有）或失败原因（`invalid` 同时用于畸形请求）。
 * @param cacheControl - 图片的 `Cache-Control` 值。
 * @returns 响应。
 */
export function detailImageResponse(
  outcome: DetailImage | DetailFailureReason | undefined,
  cacheControl: string,
): Response {
  const [status, body, type] = typeof outcome === 'object'
    // 复制到新的 buffer：`Response` 接受任意字节视图。
    ? [200, new Uint8Array(outcome.bytes), outcome.mediaType] as const
    : outcome === undefined
      ? [404, 'not found', undefined] as const
      : [FAILURE_STATUS[outcome], outcome, undefined] as const
  return new Response(body, {
    status,
    headers: {
      'Content-Type': type ?? 'text/plain; charset=utf-8',
      'Cache-Control': status === 200 ? cacheControl : 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    },
  })
}
