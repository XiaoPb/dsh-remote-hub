/**
 * 隧道监督（可选；默认 `kind: 'none'` = 只有回环可达，零暴露）。
 *
 * 隧道是**不可信传输**：它终止 TLS、转发字节，从不鉴权任何人，也绝不采信它
 * 带来的任何「身份头」。`CF-Connecting-IP` / `X-Forwarded-For` /
 * `True-Client-IP` 只能进日志与限流辅助信号（本插件连读都不读）。
 *
 * **红线（R8 / §7.5）**：隧道**只指向守卫的 origin**。
 * 把它指向 DSH 自己的 `:3080` 是**事故** —— 那会让本机 GUI 直接暴露，
 * `browserAuth` 成为唯一防线，而官方自己说「URL 与栅栏都不保护监听端口本身」。
 * 所以 `startTunnel` 的 argv 断言：必须精确含
 * `tunnel --url http://127.0.0.1:8443`，且**不含** `:3080`；不匹配直接抛错。
 *
 * 生命周期三件套（照官方 `packages/experimental/liveshare/src/host/tunnel-supervision.ts`
 * 与 `retry-backoff.ts`）：
 * 1. 注册重放（子进程退出后按策略重新 spawn）
 * 2. 退避：500ms 起、指数、上限 10s；稳定 30s 后归零
 * 3. 停止序列：`dispose()` kill 子进程并等退出
 *
 * 永久拒绝（握手 401/403/410/426）**不重连**：白名单里的码出现即停止该注册，
 * 其余按退避重试。
 *
 * @module dsh-remote-hub/host/tunnel
 */
import { type ChildProcess, spawn } from 'node:child_process'

import type { TunnelConfig } from './config.js'

/** 隧道句柄。 */
export interface TunnelHandle {
  /** provider 报出的公网 URL（cloudflared quick tunnel 从 stderr 里读）；无则为 null。 */
  publicUrl: string | null
  /** 停止监督、kill 子进程。 */
  dispose(): Promise<void>
}

/** 被隧道服务端**永久**拒绝的 HTTP 状态；出现即不再重连。 */
export const PERMANENT_REFUSALS: readonly number[] = [401, 403, 410, 426]

/**
 * 判断一行隧道日志是否表示永久拒绝。
 * @param line - stdout/stderr 的一行。
 * @returns 命中任一永久拒绝状态时为 true。
 */
export function isPermanentRefusal(line: string): boolean {
  return PERMANENT_REFUSALS.some(status => new RegExp(`\\b${status}\\b`).test(line))
}

/**
 * 组装 cloudflared 的 argv，并做**红线断言**。
 *
 * @param config - 隧道配置（`args` 是用户附加参数，不含 `--url`）。
 * @param upstreamOrigin - 必须是守卫的 origin。
 * @returns 完整 argv。
 * @throws 当 upstream 不是守卫、或用户 args 里夹带 `:3080` / 另一个 `--url` 时。
 */
export function tunnelArgv(config: TunnelConfig, upstreamOrigin: string): string[] {
  const guardOrigin = /^http:\/\/127\.0\.0\.1:\d+$/u.test(upstreamOrigin)
    || /^http:\/\/\[::1\]:\d+$/u.test(upstreamOrigin)
  if (!guardOrigin || upstreamOrigin.includes(':3080')) {
    throw new Error(
      `dsh-remote-hub: refusing to point the tunnel at ${JSON.stringify(upstreamOrigin)}; `
      + 'the tunnel MUST target the guard origin (127.0.0.1:8443), never the DSH Web GUI on :3080',
    )
  }
  const extra = config.args ?? []
  if (extra.some(arg => arg.includes(':3080') || arg === '--url')) {
    throw new Error('dsh-remote-hub: tunnel args must not override --url or target :3080')
  }
  // 顺序固定：`tunnel --url <guard> [extra]`。验收脚本断言 argv 精确含这两项。
  return ['tunnel', '--url', upstreamOrigin, ...extra]
}

/** 从 cloudflared 日志里提取 quick tunnel 的公开 URL。 */
export function publicUrlFromLog(line: string): string | null {
  const match = /https:\/\/[A-Za-z0-9-]+\.trycloudflare\.com/u.exec(line)
  return match?.[0] ?? null
}

/** 退避状态（导出给测试）。 */
export interface BackoffState {
  delayMs: number
  stableSinceMs: number
}

/**
 * 计算下一次退避延迟：500ms 起、每次翻倍、封顶 10s；稳定 30s 后归零。
 * @param state - 当前状态（原地更新）。
 * @param now - 当前时间（epoch ms）。
 * @returns 本次应等待的毫秒数。
 */
export function nextBackoff(state: BackoffState, now: number): number {
  if (now - state.stableSinceMs >= 30_000) {
    state.delayMs = 0
    state.stableSinceMs = now
  }
  const delay = state.delayMs === 0 ? 500 : state.delayMs
  state.delayMs = Math.min(10_000, Math.max(500, delay * 2))
  return delay
}

/**
 * 启动隧道监督。
 *
 * `kind: 'none'` 时**不 spawn**，直接返回 `publicUrl: null`（零暴露的正确默认）。
 * @param config - 隧道配置。
 * @param upstreamOrigin - 守卫的 origin（来自 `GuardHandle.origin`）。
 * @returns `TunnelHandle`。
 */
export async function startTunnel(config: TunnelConfig, upstreamOrigin: string): Promise<TunnelHandle> {
  if (config.kind === 'none') {
    return { publicUrl: null, async dispose() {} }
  }

  const argv = tunnelArgv(config, upstreamOrigin)
  const command = config.command ?? 'cloudflared'
  let child: ChildProcess | null = null
  let publicUrl: string | null = null
  let disposed = false
  let permanent = false
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  const backoff: BackoffState = { delayMs: 0, stableSinceMs: Date.now() }

  const watch = (stream: NodeJS.ReadableStream | null | undefined): void => {
    if (!stream) return
    let buffer = ''
    stream.on('data', chunk => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')
      buffer += text
      const lines = buffer.split(/\r?\n/u)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const url = publicUrlFromLog(line)
        if (url !== null) publicUrl = url
        if (isPermanentRefusal(line)) permanent = true
      }
    })
  }

  const spawnOnce = (): void => {
    if (disposed || permanent || config.restart === 'never') return
    const startedAt = Date.now()
    child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
    watch(child.stdout)
    watch(child.stderr)
    child.once('exit', () => {
      child = null
      if (disposed || permanent || config.restart === 'never') return
      // 稳定运行 30s 以上视为「稳定」，退避归零。
      if (Date.now() - startedAt >= 30_000) {
        backoff.delayMs = 0
        backoff.stableSinceMs = Date.now()
      }
      const delay = nextBackoff(backoff, Date.now())
      restartTimer = setTimeout(spawnOnce, delay)
    })
    child.once('error', () => {
      // spawn 失败（命令不存在）也按同一退避重试；不静默吞掉。
      if (!disposed && config.restart === 'on-failure') {
        restartTimer = setTimeout(spawnOnce, nextBackoff(backoff, Date.now()))
      }
    })
  }

  spawnOnce()

  return {
    get publicUrl() { return publicUrl },
    async dispose() {
      disposed = true
      if (restartTimer !== null) clearTimeout(restartTimer)
      const current = child
      child = null
      if (current !== null && current.exitCode === null) {
        current.kill('SIGTERM')
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => {
            if (current.exitCode === null) current.kill('SIGKILL')
            resolve()
          }, 2_000)
          current.once('exit', () => { clearTimeout(timer); resolve() })
        })
      }
    },
  }
}
