/**
 * 云端路径上下文（原 `@xiaopb/dsh-remote-paths` 伴生包，0.3.0 起内置）。
 *
 * 只有 Remote Hub 载体已激活、且官方传输已接管时才返回上下文；
 * 否则所有云端路径 UI 都不注册，本机原生流程与 dsh-hardssh 完全不受影响。
 *
 * @module dsh-remote-hub/client/paths/context
 */

/** 载体安装结果（由 `carrier.ts` 写在全局上）。 */
interface CarrierGlobal {
  active?: boolean
}

/** 官方传输里本模块用到的两个字段。 */
interface TransportGlobal {
  fetch?: (input: string, init?: { method?: string, headers?: Record<string, string>, signal?: AbortSignal, body?: string }) => Promise<Response>
  streamBaseUrl?: string
}

/** 云端路径上下文：目标主机 origin + 已接管的 fetch。 */
export interface CloudPathContext {
  origin: string
  fetch: NonNullable<TransportGlobal['fetch']>
}

/** 可注入的全局对象（测试用）。 */
type GlobalLike = {
  __DSH_REMOTE_HUB_CARRIER__?: CarrierGlobal
  __DSH_TRANSPORT__?: TransportGlobal
}

/**
 * 解析当前云端路径上下文。
 * @param globalObject - 全局对象，默认 `globalThis`。
 * @returns 上下文；载体未激活或传输未接管时为 `null`。
 */
export function cloudPathContext(globalObject: GlobalLike = globalThis as unknown as GlobalLike): CloudPathContext | null {
  const carrier = globalObject.__DSH_REMOTE_HUB_CARRIER__
  const transport = globalObject.__DSH_TRANSPORT__
  if (carrier?.active !== true || typeof transport?.fetch !== 'function' || !transport.streamBaseUrl) return null
  return { origin: transport.streamBaseUrl, fetch: transport.fetch }
}

/** 允许经云端路径通道调用的 endpoint（白名单，避免变成任意 RPC 代理）。 */
const PATH_METHODS = ['directoryPicker/list', 'directoryPicker/createDirectory', 'workspaceFiles/list'] as const

export type PathMethod = typeof PATH_METHODS[number]

/** 目录项。 */
export interface PathEntry {
  name: string
  path: string
  type?: string
  hidden?: boolean
}

/** `directoryPicker/list` 的返回。 */
export interface DirectoryListing {
  path: string
  crumbs: { name: string, path: string }[]
  entries: PathEntry[]
  truncated?: boolean
}

/** `workspaceFiles/list` 的返回。 */
export interface WorkspaceListing {
  path: string
  entries: PathEntry[]
  truncated?: boolean
}

/** 一次 `client-request` 信封的官方响应。 */
interface RpcResponse {
  result?: {
    ok?: boolean
    value?: unknown
    error?: { code?: string, message?: string }
  }
}

/**
 * 调一次云端路径 RPC，并把官方错误翻成可读文案。
 *
 * @param context - 云端路径上下文。
 * @param method - 白名单内的 endpoint。
 * @param args - 该 endpoint 的参数。
 * @param signal - 取消信号。
 * @returns 官方 `result.value`。
 * @throws 当 HTTP 失败、被拒或返回非法信封时（消息可直接展示给用户）。
 */
export async function pathRpc<T = unknown>(
  context: CloudPathContext | null,
  method: PathMethod,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  if (context === null) throw new Error('云端连接不可用 / Remote connection is unavailable')
  if (!(PATH_METHODS as readonly string[]).includes(method)) {
    throw new Error('Unsupported remote path operation')
  }
  const response = await context.fetch(`api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `paths-${globalThis.crypto.randomUUID()}`,
      method,
      payload: { args },
    }),
  })
  if (!response.ok) throw new Error(`目标主机返回 HTTP ${response.status}`)
  const message = (await response.json()) as RpcResponse
  if (message.result?.ok !== true) {
    const error = message.result?.error
    throw new Error(error?.code === 'remote-access/denied'
      ? '当前配对没有浏览或新建目录权限，请使用完全控制配对。'
      : error?.message ?? '目标主机没有返回有效的目录结果')
  }
  return message.result.value as T
}
