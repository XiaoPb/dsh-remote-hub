/**
 * 文件传输的两条腿（D-6）。
 *
 * 已验证事实（`01-harness-facts.md` F14 / A11）：
 * - `fileUploads/upload` 是 **Remote 方法**，非 owner 可以走 `decide()` 放行；
 *   exact Fetch 路由 `POST /api/session/uploadFileBinary` **绕过 Gateway 访问判定**，
 *   对非 owner **恒 403**（`rpc-host.ts:218-222`）。所以上传**只能**走前者。
 * - `workspaceFiles/read()` 返回的是**一个行窗口**（`offset`/`limit`/`lines`/`eof`），
 *   不是整文件；文本里含 NUL 时抛 `workspace-file/not-text`
 *   （`workspace-files/src/index.ts:243-245`）。
 * - 二进制/图片必须走 `workspaceFiles/readBytes()`（带 `range`，
 *   `maxFileBytes` 默认 32 MiB）。
 *
 * 本文件不自己发 HTTP 请求：它给出的是**端点常量、参数形状与错误分类**，供
 * `guard.ts` 的 `/remote/rpc` 派发与自有 `hub/*` 服务使用。真正的一元调用仍走
 * `createSharedFetchHandler('/api')`，因此附件投影（`ConnectionRpcHandlerResult`
 * 的 `attachments`）由 Connection 负责，参数校验由 Gateway 负责。
 *
 * @module dsh-remote-hub/host/files
 */
import { OFFICIAL_ERROR_CODES } from '@core/index.js'

/** 上传：唯一可行的 Remote 方法。 */
export const UPLOAD_ENDPOINT = 'fileUploads/upload'

/** 文本预览：行窗口。 */
export const PREVIEW_TEXT_ENDPOINT = 'workspaceFiles/read'

/** 二进制/图片预览：字节范围。 */
export const PREVIEW_BINARY_ENDPOINT = 'workspaceFiles/readBytes'

/** 目录浏览。 */
export const PREVIEW_LIST_ENDPOINT = 'workspaceFiles/list'

/** 文件元信息。 */
export const PREVIEW_STAT_ENDPOINT = 'workspaceFiles/stat'

/**
 * **恒 404 的路由**：守卫的路由表里没有它，且 `/api/*` 对守卫一律 404。
 * 它属于 DSH 自己的 exact Fetch 路由，非 owner 恒 403 —— **不可用**。
 */
export const EXACT_FETCH_UPLOAD_ROUTE = '/api/session/uploadFileBinary'

/** `readBytes` 的默认上限（官方 `workspace-files/src/index.ts:188`）。 */
export const MAX_FILE_BYTES = 32 * 1024 * 1024

/** 文本预览的参数形状。 */
export interface PreviewTextArgs {
  workspaceFileScopeId: string
  path: string
  offset?: number
  limit?: number
}

/** 二进制预览的参数形状。 */
export interface PreviewBinaryArgs {
  workspaceFileScopeId: string
  path: string
  range: { offset: number; length: number }
  maxFileBytes?: number
}

/**
 * 把官方 `workspace-file/not-text` 翻译成「请走二进制通道」而不是 `internal`。
 *
 * 守卫层**不包装官方码**（DESIGN §8.7：官方码原样透传），所以这里返回的是一个
 * 给客户端消费的**提示结构**：客户端看到 `workspace-file/not-text` 时应改用
 * `workspaceFiles/readBytes`。守卫的 HTTP 响应体里仍保留官方码本身。
 * @param code - 官方错误码。
 * @returns 分类结果。
 */
export function classifyPreviewError(code: string): {
  kind: 'use-binary-channel' | 'other'
  message: string
} {
  if (code === OFFICIAL_ERROR_CODES.workspaceFileNotText) {
    return {
      kind: 'use-binary-channel',
      message: 'file is binary; use workspaceFiles/readBytes with a byte range instead of workspaceFiles/read',
    }
  }
  return { kind: 'other', message: '' }
}

/**
 * 构造文本预览的 `args`（官方端点参数名是 `workspaceFileScopeId`，不是 `sessionId`）。
 * @param input - 会话 id、路径与行窗口。
 * @returns 直接可作为 `payload.args` 的对象。
 */
export function previewTextArgs(input: {
  sessionId: string
  path: string
  offset?: number
  limit?: number
}): PreviewTextArgs {
  return {
    workspaceFileScopeId: input.sessionId,
    path: input.path,
    ...(input.offset === undefined ? {} : { offset: input.offset }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  }
}

/**
 * 构造二进制预览的 `args`。`range.length` 受 `MAX_FILE_BYTES` 约束。
 * @param input - 会话 id、路径与字节范围。
 * @returns 直接可作为 `payload.args` 的对象。
 * @throws 当 `range.length` 超过上限时（防止手机一次拉满整个文件）。
 */
export function previewBinaryArgs(input: {
  sessionId: string
  path: string
  offset: number
  length: number
}): PreviewBinaryArgs {
  if (!Number.isSafeInteger(input.length) || input.length < 0 || input.length > MAX_FILE_BYTES) {
    throw new Error(`files: readBytes range length must be between 0 and ${MAX_FILE_BYTES} bytes`)
  }
  return {
    workspaceFileScopeId: input.sessionId,
    path: input.path,
    range: { offset: input.offset, length: input.length },
    maxFileBytes: MAX_FILE_BYTES,
  }
}
