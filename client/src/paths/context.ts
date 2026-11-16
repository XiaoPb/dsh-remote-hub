/**
 * 云端路径上下文（原 `@xiaopb/dsh-remote-paths` 伴生包，0.3.0 起内置）。
 *
 * 只有处于「远程会话」时才返回上下文；否则所有云端路径 UI 都不注册，
 * 本机原生流程与 dsh-hardssh 完全不受影响。
 *
 * 两种远程形态：
 * 1. **控制端**：跨源，载体已激活且官方传输被改写（`__DSH_TRANSPORT__`）；
 * 2. **浏览器直连**（守卫托管的同源页面）：`/api/*` 直接被守卫承接，
 *    不需要改写传输，只靠守卫注入的 `__DSH_REMOTE_HUB__` 标记识别。
 *
 * 两种都返回非空上下文 → `paths/index.tsx` 的 `apply()` 会接管
 * `directoryFlow` 槽位，仓库/工作区目录一律走远程弹窗，**不会**拉起浏览器本地文件夹。
 *
 * @module dsh-remote-hub/client/paths/context
 */

/** 载体安装结果（由 `carrier.ts` 写在全局上）。 */
interface CarrierGlobal {
  active?: boolean
}

/**
 * 守卫注入的远程浏览器标记（写在 index 里，不含任何凭据）。
 *
 * 认证靠 HttpOnly Cookie，JS 读不到也不该读，所以这里只有模式字符串。
 */
interface RemoteBrowserGlobal {
  mode?: string
}

/** 远程浏览器模式的标记值。 */
export const REMOTE_BROWSER_MODE = 'remote-browser'

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
  /** 守卫注入的远程浏览器标记。 */
  __DSH_REMOTE_HUB__?: RemoteBrowserGlobal
  /** 页面 location（浏览器直连模式取 origin）。 */
  location?: { origin?: string }
}

/**
 * 解析当前云端路径上下文。
 *
 * 顺序很重要：控制端模式优先（它有自己的传输改写），浏览器直连模式其次，
 * 都不满足才返回 `null`（= 本机模式，官方原生目录选择器生效）。
 *
 * @param globalObject - 全局对象，默认 `globalThis`。
 * @returns 上下文；非远程会话时为 `null`。
 */
export function cloudPathContext(globalObject: GlobalLike = globalThis as unknown as GlobalLike): CloudPathContext | null {
  // ① 控制端：载体激活 + 传输已改写（跨源调用，需要签名）。
  const carrier = globalObject.__DSH_REMOTE_HUB_CARRIER__
  const transport = globalObject.__DSH_TRANSPORT__
  if (carrier?.active === true && typeof transport?.fetch === 'function' && transport.streamBaseUrl) {
    return { origin: transport.streamBaseUrl, fetch: transport.fetch }
  }

  // ② 浏览器直连：同源，守卫已承接 /api/*，不需要任何传输改写。
  if (globalObject.__DSH_REMOTE_HUB__?.mode === REMOTE_BROWSER_MODE) {
    const origin = globalObject.location?.origin
    if (typeof origin !== 'string' || origin === '') return null
    return { origin, fetch: (input, init) => fetch(input, init) }
  }

  return null
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
