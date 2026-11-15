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
import { randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  AUTH_ROUTES,
  DEFAULT_ACCOUNT,
  DEFAULT_PASSWORD_POLICY,
  INITIAL_PASSWORD_FILE,
  evaluatePassword,
  type PasswordPolicy,
} from '@core/auth.js'

import { createAuthService, type AuthService } from './service.js'
import { createAuthStore, defaultAuthStorePath, writePrivateFile } from './store.js'
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
  /**
   * 首次启动自动创建的默认账号（**只在账号库为空时创建**）。
   *
   * `password: ''`（默认）= 安装时**随机生成**，明文写入
   * `<auth.json 同目录>/initial-password`（0600），强制改密成功后删除。
   * 填了非空值则使用该固定口令（同样强制首次改密）。
   */
  defaultAccount: {
    username: string
    password: string
  }
  /**
   * 默认口令策略（存储里没有设置时使用）。
   *
   * `strong`（默认）：≥12 位 + 大小写 + 数字 + 符号 + 不含用户名；
   * `basic`：≥8 位。设置页可随时切换，立即生效。
   */
  passwordPolicy: PasswordPolicy
}

export const Config: z<AuthConfig> = z.object({
  enabled: z.boolean().default(true),
  issuer: z.string().default('DeepSeek Harness'),
  storePath: z.string().default(''),
  requireMfa: z.boolean().default(true),
  maxLoginAttempts: z.number().min(1).max(100).default(5),
  loginWindowMs: z.number().min(1_000).default(15 * 60_000),
  secureCookie: z.boolean().default(false),
  defaultAccount: z.object({
    username: z.string().default(DEFAULT_ACCOUNT.username),
    password: z.string().default(DEFAULT_ACCOUNT.password),
  }).default({}),
  passwordPolicy: z.union([z.const('strong'), z.const('basic')]).default(DEFAULT_PASSWORD_POLICY),
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
  defaultAccount: { username: DEFAULT_ACCOUNT.username, password: DEFAULT_ACCOUNT.password },
  passwordPolicy: DEFAULT_PASSWORD_POLICY,
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

/**
 * 生成满足当前策略的初始口令（24 位 base64url；极端情况补后缀兜底）。
 *
 * 初始口令只是「引导窗口」里的临时凭据，但仍要求它自己就能通过策略，
 * 以免设置页一边要求强密码、一边给出的初始口令不达标。
 * @param policy - 目标策略。
 * @returns 明文口令（只写入 0600 文件，绝不写日志）。
 */
export function generateInitialPassword(policy: PasswordPolicy): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = randomBytes(18).toString('base64url')
    if (evaluatePassword(candidate, policy).ok) return candidate
  }
  return `${randomBytes(15).toString('base64url')}-Aa1`
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

    // 初始口令文件与 auth.json 同目录（默认 `~/.dsh/remote-hub/initial-password`）。
    const initialPasswordPath = join(dirname(storePath), INITIAL_PASSWORD_FILE)
    const removeInitialPassword = async (): Promise<void> => {
      await rm(initialPasswordPath, { force: true })
    }

    const service: AuthService = createAuthService({
      store,
      issuer: config.issuer,
      requireMfa: config.requireMfa,
      maxLoginAttempts: config.maxLoginAttempts,
      loginWindowMs: config.loginWindowMs,
      // 强制改密成功 → 明文初始口令立即失去意义，删除文件。
      onForcedPasswordChanged: removeInitialPassword,
      defaultPasswordPolicy: config.passwordPolicy,
    })

    // 0) 首次启动：无账号时创建默认账号（带强制改密标记）。
    //    口令在配置为空时**随机生成**并写入 0600 文件；绝不写日志、不打印到 stdout。
    try {
      const configured = config.defaultAccount.password
      const password = configured === '' ? generateInitialPassword(config.passwordPolicy) : configured
      const seeded = await service.seedDefaultAccount({
        username: config.defaultAccount.username,
        password,
      })
      if (seeded) {
        const initialBody = `${password}\n`
        // 注意：下一行以 `(` 开头，上一句必须显式分号，否则会被解析成函数调用链。
        await writePrivateFile(initialPasswordPath, initialBody);
        (ctx as unknown as { logger?: { warn?: (message: string) => void } })
          .logger?.warn?.(
            `remote-hub-auth: created the default account ${JSON.stringify(config.defaultAccount.username)}; `
            + `its one-time initial password is in ${initialPasswordPath} (deleted after the forced password change). `
            + 'The first sign-in must change it before 2FA, client trust or Hub access is allowed',
          )
      } else if (!service.initialPasswordPending()) {
        // 账号已存在且已完成强制改密：清掉遗留文件（旧口令不应长期驻留）。
        await removeInitialPassword()
      }
    } catch (error) {
      // 种子失败不阻断认证面：用户仍可用 bootstrap 在本机创建管理员。
      (ctx as unknown as { logger?: { error?: (message: string) => void } })
        .logger?.error?.(`remote-hub-auth: default account seeding failed: ${String(error)}`)
    }

    // 1) 提供 Cordis 服务：Hub 用 `ctx.inject(['remoteHubAuth'])` 等它。
    const provide = (ctx as unknown as {
      provide?: (name: string, value: unknown) => unknown
    }).provide
    if (typeof provide !== 'function') {
      await store.dispose()
      return () => {}
    }
    push(toDisposer(provide.call(ctx, 'remoteHubAuth', service)))

    // 1.5) 守卫也可挂认证面（跨源「账号 + TOTP → 登记公钥」）：
    //      用**头会话**版本，避免跨源 Cookie 的 SameSite 限制。
    const guardHandler = createAuthHandler({ service, secureCookie: config.secureCookie, allowHeaderSession: true })
    push(toDisposer(provide.call(ctx, 'remoteHubAuthHttp', {
      paths: Object.values(AUTH_ROUTES),
      handle: (request: unknown, response: unknown) => guardHandler(
        request as IncomingMessage,
        response as ServerResponse,
      ),
    })))

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
