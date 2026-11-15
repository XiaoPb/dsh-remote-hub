/**
 * 认证插件的 Cordis 入口（`@xiaopb/dsh-remote-hub/auth`）。
 *
 * 与 Hub 入口的关系：
 * - 本入口**提供** Cordis 服务 `remoteHubAuth`（见 `@core/auth` 的 `HubAuthPort`）；
 * - Hub 入口在启用账号认证时 `ctx.inject(['remoteHubAuth'])` 等待它，并只消费认证结论。
 *
 * 独立性：认证启用与否不影响 Hub 自身的装配代码；但 Hub 在账号认证开启时若拿不到
 * 本服务，会保持守卫关闭（fail-closed）。
 *
 * @module dsh-remote-hub/host/auth/plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { AUTH_ROUTES } from '@core/auth.js'

import { createAuthService, type AuthService } from './service.js'
import { createAuthStore, defaultAuthStorePath } from './store.js'
import { createAuthHandler } from './routes.js'

/** 认证插件配置。 */
export interface AuthConfig {
  /** 总开关。关闭 = 不提供认证服务、不挂 `/remote-auth/*`。 */
  enabled: boolean
  /** 认证器显示的 issuer。 */
  issuer: string
  /** 存储路径；默认 `~/.dsh/remote-hub/auth.json`。 */
  storePath: string
  /** 是否要求 TOTP（默认 true；关闭仅用于本地调试）。 */
  requireMfa: boolean
  /** 登录失败预算。 */
  maxLoginAttempts: number
  /** 登录失败窗口（毫秒）。 */
  loginWindowMs: number
  /** 给 Cookie 加 `Secure`（HTTPS 部署应开启）。 */
  secureCookie: boolean
}

export const Config: z<AuthConfig> = z.object({
  enabled: z.boolean().default(true),
  issuer: z.string().default('DeepSeek Harness'),
  storePath: z.string().default(''),
  requireMfa: z.boolean().default(true),
  maxLoginAttempts: z.number().min(1).max(100).default(5),
  loginWindowMs: z.number().min(1_000).default(15 * 60_000),
  secureCookie: z.boolean().default(false),
})

/** 默认配置。 */
export const DEFAULT_AUTH_CONFIG: AuthConfig = {
  enabled: true,
  issuer: 'DeepSeek Harness',
  storePath: '',
  requireMfa: true,
  maxLoginAttempts: 5,
  loginWindowMs: 15 * 60_000,
  secureCookie: false,
}

/** 插件稳定名（与 `cordis.patch.yml` 的 roster id 对应）。 */
export const name = 'remote-hub-auth'

/** 需要的服务（webServer 只在注册 HTTP 面时使用；缺失则只提供认证服务）。 */
export const inject: string[] = []

/** 提供一个 disposable（兼容函数 / Promise / `{dispose}` 三种返回）。 */
function toDisposer(value: unknown): () => void {
  if (typeof value === 'function') return value as () => void
  if (value !== null && typeof value === 'object') {
    const dispose = (value as { dispose?: unknown }).dispose
    if (typeof dispose === 'function') {
      return () => { void (dispose as () => unknown).call(value) }
    }
  }
  return () => { /* 无可卸载资源 */ }
}

/** 读出 webServer 的精确路由注册能力。 */
function webServerOf(ctx: Context): { register?: (route: unknown) => unknown } | undefined {
  const reflect = (ctx as unknown as {
    reflect?: { get?: (name: string, strict?: boolean) => unknown }
  }).reflect
  try {
    return reflect?.get?.('webServer', false) as { register?: (route: unknown) => unknown } | undefined
  } catch {
    return undefined
  }
}

/**
 * 认证插件入口。
 * @param ctx - Host Context。
 * @param config - 已解析配置。
 */
export function apply(ctx: Context, config: AuthConfig = DEFAULT_AUTH_CONFIG): void {
  if (!config.enabled) {
    try {
      (ctx as unknown as { logger?: { info?: (message: string) => void } })
        .logger?.info?.('remote-hub-auth: disabled by config (no auth service provided)')
    } catch {
      // 日志后端缺席不能影响宿主。
    }
    return
  }

  ctx.effect(async () => {
    const disposers: (() => void | Promise<void>)[] = []
    const push = (dispose: () => void | Promise<void>): void => { disposers.push(dispose) }

    const storePath = config.storePath === '' ? defaultAuthStorePath() : config.storePath
    const store = await createAuthStore(storePath)
    const service: AuthService = createAuthService({
      store,
      issuer: config.issuer,
      requireMfa: config.requireMfa,
      maxLoginAttempts: config.maxLoginAttempts,
      loginWindowMs: config.loginWindowMs,
    })

    // 1) 提供 Cordis 服务：Hub 用 `ctx.inject(['remoteHubAuth'])` 等它。
    const provide = (ctx as unknown as {
      provide?: (name: string, value: unknown) => unknown
    }).provide
    if (typeof provide !== 'function') {
      await store.dispose()
      return () => {}
    }
    push(toDisposer(provide.call(ctx, 'remoteHubAuth', service)))

    // 2) 挂认证 HTTP 面（webServer 就绪时）。
    const handler = createAuthHandler({ service, secureCookie: config.secureCookie })
    const mount = (): void => {
      const webServer = webServerOf(ctx)
      if (typeof webServer?.register !== 'function') {
        try {
          (ctx as unknown as { logger?: { warn?: (message: string) => void } })
            .logger?.warn?.('remote-hub-auth: webServer unavailable; auth HTTP surface not mounted')
        } catch {
          // 忽略
        }
        return
      }
      for (const path of Object.values(AUTH_ROUTES)) {
        const dispose = webServer.register({
          kind: 'exact',
          path,
          handler: (req: IncomingMessage, res: ServerResponse) => handler(req, res),
        })
        push(toDisposer(dispose))
      }
    }
    mount()

    // webServer 晚于本插件就绪时补挂（只挂一次）。
    let mountedWithService = webServerOf(ctx)?.register !== undefined
    if (!mountedWithService) {
      try {
        const fiber = (ctx as unknown as {
          inject(deps: readonly string[], callback: (scoped: Context) => void): unknown
        }).inject(['webServer'], () => {
          if (mountedWithService) return
          mountedWithService = true
          mount()
        })
        void fiber
      } catch {
        // 注入能力缺席：认证服务仍可用（Hub 在进程内直接调用），只是没有 HTTP 面。
      }
    }

    try {
      (ctx as unknown as { logger?: { info?: (message: string) => void } })
        .logger?.info?.(`remote-hub-auth: ready (store=${storePath})`)
    } catch {
      // 忽略
    }

    return async () => {
      for (const dispose of [...disposers].reverse()) {
        try {
          await dispose()
        } catch {
          // 卸载异常不能盖住根因。
        }
      }
      await service.dispose()
    }
  }, 'dsh-remote-hub: auth assembly')
}
