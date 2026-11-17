/**
 * 运行时配置存取：`overrides.json` 持久层 + 白名单可写子集。
 *
 * 职责（与 config.ts 的 schema 层分工）：
 * - schema（config.ts）定义**全部**配置项与默认值，装配期读取；
 * - 这里维护**用户在页面上改过的覆盖值**（`~/.dsh/remote-hub/overrides.json`），
 *   装配时 merge 到 schema 结果之上（优先级：overrides > 配置文件 > 默认）；
 * - `get()` 返回**可展示子集**（不含路径类内部项）；`patch()` 只接受白名单内、
 *   类型合法的字段，越界/非法即抛（guard 转 400）。
 *
 * 热生效 vs 冷生效：
 * - 热项（singleController/bridgeApprovals/defaultRole/maxPairAttempts）：写入后
 *   立即反映到守卫/配对行为（plugin.ts 订阅 patch 事件或下轮读取）；
 * - 冷项（guardPort/network 等）**不在白名单**：改它们需要重启进程，页面显示
 *   「重启后生效」标注（本文件不做、也不该做热改端口）。
 *
 * 写入走 `writeFileAtomic` + `withFileLock`（与设备表同一套崩溃安全保证）；
 * 文件损坏时**降级为空覆盖**并留日志，不抛——诊断层不能拖垮装配。
 *
 * @module dsh-remote-hub/host/runtime-config
 */
import { readFile } from 'node:fs/promises'

import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'

import { isRoleName } from '@core/index.js'
import type { RoleName } from '@core/index.js'

import { expandHome } from './devices.js'
import { canonicalAuthority, isLoopbackLiteral, isPrivateAddress } from './config.js'

/** 页面可改的字段白名单（运行时可变、立即热生效）。 */
export const CONFIG_WRITABLE_KEYS = [
  'singleController',
  'bridgeApprovals',
  'defaultRole',
  'maxPairAttempts',
] as const

export type ConfigWritableKey = (typeof CONFIG_WRITABLE_KEYS)[number]

/**
 * 页面可改、但**必须重启**才生效的字段。
 *
 * 为什么不做热改：守卫的端口在装配时一次性 bind，换端口必须重建监听并丢弃
 * 全部在途连接（还会连带隧道与配对链接）；自动热切等于「点一下保存就断线」，
 * 风险高于收益。这里只持久化覆盖值，并在快照里标记 `restartPending`。
 *
 * `publicAuthorities` 同理：它是守卫来源围栏（`fence.ts`）的组成部分，
 * 围栏在装配时构建。改它等于改变「哪些 Host 被信任」这个安全边界，
 * 和换端口是同一类操作，不适合热切。
 */
export const CONFIG_COLD_WRITABLE_KEYS = ['guardPort', 'network', 'publicAuthorities'] as const

export type ConfigColdKey = (typeof CONFIG_COLD_WRITABLE_KEYS)[number]

/** 页面可展示（只读）的字段：含热项 + 冷项（冷项标注「重启后生效」）。 */
export const CONFIG_READONLY_KEYS = [
  'pairQrTtlMs',
  'pairCodeTtlMs',
  'tunnelKind',
] as const

export type ConfigReadableKey = ConfigWritableKey | ConfigColdKey | (typeof CONFIG_READONLY_KEYS)[number]

export type ConfigSnapshot = Partial<Record<ConfigReadableKey | 'restartPending', unknown>>

/** 运行时配置存取接口（guard ConfigStore 的实现）。 */
export interface RuntimeConfigStore {
  get(): Promise<ConfigSnapshot>
  patch(input: Record<string, unknown>): Promise<ConfigSnapshot>
  /** 覆盖值（装配时 merge 进 Config；热项与冷项都在这里）。 */
  overrides(): Promise<Partial<Record<ConfigWritableKey | ConfigColdKey, unknown>>>
  /** patch 事件订阅（plugin.ts 用于刷新守卫内存态）。 */
  onPatched(listener: (overrides: Partial<Record<ConfigWritableKey | ConfigColdKey, unknown>>) => void): () => void
}

/** `createRuntimeConfigStore` 依赖。 */
export interface RuntimeConfigDeps {
  /** overrides.json 路径（`~/.dsh/remote-hub/overrides.json`）。 */
  path: string
  /** 当前生效配置（get 快照的冷项来源）。 */
  current: () => ConfigSnapshot
  /** 注入时钟（测试）。 */
  now?: () => Date
}

const BOOLEAN_KEYS: readonly string[] = ['singleController', 'bridgeApprovals']

/** 全部可写键（热 + 冷）。 */
const ALL_WRITABLE: readonly string[] = [...CONFIG_WRITABLE_KEYS, ...CONFIG_COLD_WRITABLE_KEYS]

/** 冷键集合（写入后需重启）。 */
const COLD_SET: ReadonlySet<string> = new Set(CONFIG_COLD_WRITABLE_KEYS)

/**
 * 校验并规范化 `publicAuthorities`。
 *
 * 这是**安全边界**的输入，必须严格：
 *  - 每项是裸 authority（`host` 或 `host:port`），不带 scheme / 路径 / userinfo；
 *  - 拒绝通配符（`*`、`*.example.com`）——放行所有来源等于关掉围栏；
 *  - 拒绝回环与私网地址——它们本来就无条件放行，写进来只会让人误以为必须配；
 *  - 去重（大小写不敏感），保持稳定顺序。
 *
 * 复用 `canonicalAuthority`（与 `assertPublicAuthorities` 同源），不另写正则，
 * 避免客户端与服务端判定漂移。
 * @param value - 页面传来的值。
 * @returns 规范化后的数组。
 * @throws 任一项不合法时。
 */
function coercePublicAuthorities(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('config: publicAuthorities must be an array')
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') throw new Error('config: publicAuthorities items must be strings')
    const raw = item.trim()
    if (raw === '') throw new Error('config: publicAuthorities must not contain empty entries')
    if (raw.includes('*')) {
      throw new Error(`config: publicAuthorities must not use wildcards (${JSON.stringify(raw)})`)
    }
    const canonical = canonicalAuthority(raw)
    if (canonical === undefined) {
      throw new Error(
        `config: publicAuthorities entry ${JSON.stringify(raw)} must be a bare host[:port] `
        + 'authority (no scheme, path, userinfo, percent-encoding, unbracketed IPv6 or zero-padded port)',
      )
    }
    // 回环 / 私网本来就被围栏无条件放行，写进白名单是冗余且误导。
    // ⚠️ `isLoopbackLiteral` 只认 IP 字面量（127.0.0.0/8、::1），
    // `localhost` 是**主机名**，要单独判。
    const hostname = canonical.replace(/:\d+$/u, '')
    if (hostname === 'localhost' || isLoopbackLiteral(hostname) || hostname === '[::1]') {
      throw new Error(
        `config: ${JSON.stringify(raw)} is a loopback address and is always allowed; no need to add it`,
      )
    }
    if (isPrivateAddress(hostname)) {
      throw new Error(
        `config: ${JSON.stringify(raw)} is a private/LAN address and is allowed by the LAN mode; `
        + 'only public hostnames need to be declared here',
      )
    }
    const key = canonical.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(canonical)
  }
  return out
}

/** 两个冷项值是否等价（数组按内容比较，避免 `!==` 永远为真的假待重启）。 */
function sameColdValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => item === b[index])
  }
  return a === b
}

/** 校验并收敛一个可写字段；非法抛错。 */
function coerce(key: string, value: unknown): unknown {
  if (key === 'publicAuthorities') return coercePublicAuthorities(value)
  if (BOOLEAN_KEYS.includes(key)) {
    if (typeof value !== 'boolean') throw new Error(`config: ${key} must be boolean`)
    return value
  }
  if (key === 'defaultRole') {
    if (!isRoleName(value as RoleName)) throw new Error(`config: ${key} must be a known role`)
    return value
  }
  if (key === 'guardPort') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) {
      throw new Error('config: guardPort must be an integer 1..65535')
    }
    return value
  }
  if (key === 'network') {
    if (value !== 'loopback' && value !== 'lan') throw new Error('config: network must be loopback or lan')
    return value
  }
  // maxPairAttempts
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error('config: maxPairAttempts must be integer 1..100')
  }
  return value
}

/**
 * 创建运行时配置存取。
 * @param deps - 路径、当前配置读取器、时钟。
 */
export function createRuntimeConfigStore(deps: RuntimeConfigDeps): RuntimeConfigStore {
  const listeners = new Set<(overrides: Partial<Record<ConfigWritableKey | ConfigColdKey, unknown>>) => void>()
  let cache: Partial<Record<ConfigWritableKey | ConfigColdKey, unknown>> | undefined

  async function load(): Promise<Partial<Record<ConfigWritableKey | ConfigColdKey, unknown>>> {
    if (cache !== undefined) return cache
    try {
      const raw = await readFile(expandHome(deps.path), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      const clean: Partial<Record<ConfigWritableKey | ConfigColdKey, unknown>> = {}
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        for (const key of ALL_WRITABLE) {
          if (Object.hasOwn(parsed, key)) clean[key as ConfigWritableKey | ConfigColdKey] = coerce(key, (parsed as Record<string, unknown>)[key])
        }
      }
      cache = clean
    } catch {
      // 缺文件 / 损坏：视为无覆盖（诊断层永不拖垮装配）。
      cache = {}
    }
    return cache
  }

  return {
    async get() {
      const [overrides, current] = await Promise.all([load(), Promise.resolve(deps.current())])
      // 冷项与运行值不同 = 有待重启才生效的修改。
      // 用 sameColdValue 而不是 !==：数组按内容比，否则 publicAuthorities
      // 每次都会因引用不同而永远显示「待重启」。
      const restartPending = [...COLD_SET].some(key =>
        Object.hasOwn(overrides, key) && !sameColdValue(overrides[key as ConfigColdKey], current[key as ConfigReadableKey]))
      return { ...current, ...overrides, restartPending }
    },
    async patch(input) {
      const overrides = await load()
      const next: Partial<Record<ConfigWritableKey | ConfigColdKey, unknown>> = { ...overrides }
      for (const [key, value] of Object.entries(input)) {
        if (!ALL_WRITABLE.includes(key)) {
          throw new Error(`config: ${key} is read-only or unknown`)
        }
        next[key as ConfigWritableKey | ConfigColdKey] = coerce(key, value)
      }
      await withFileLock(expandHome(deps.path), async () => {
        await writeFileAtomic(expandHome(deps.path), `${JSON.stringify(next, null, 2)}\n`, {
          mode: 0o600,
          dirMode: 0o700,
        })
      })
      cache = next
      for (const listener of [...listeners]) listener(next)
      return this.get()
    },
    async overrides() {
      return { ...await load() }
    },
    onPatched(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },  }
}
