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

/** 页面可改的字段白名单（运行时可变、立即热生效）。 */
export const CONFIG_WRITABLE_KEYS = [
  'singleController',
  'bridgeApprovals',
  'defaultRole',
  'maxPairAttempts',
] as const

export type ConfigWritableKey = (typeof CONFIG_WRITABLE_KEYS)[number]

/** 页面可展示（只读）的字段：含热项 + 冷项（冷项标注「重启后生效」）。 */
export const CONFIG_READONLY_KEYS = [
  'network',
  'guardPort',
  'pairQrTtlMs',
  'pairCodeTtlMs',
  'tunnelKind',
] as const

export type ConfigReadableKey = ConfigWritableKey | (typeof CONFIG_READONLY_KEYS)[number]

export type ConfigSnapshot = Partial<Record<ConfigReadableKey, unknown>>

/** 运行时配置存取接口（guard ConfigStore 的实现）。 */
export interface RuntimeConfigStore {
  get(): Promise<ConfigSnapshot>
  patch(input: Record<string, unknown>): Promise<ConfigSnapshot>
  /** 覆盖值（装配时 merge 进 Config；键与 CONFIG_WRITABLE_KEYS 同）。 */
  overrides(): Promise<Partial<Record<ConfigWritableKey, unknown>>>
  /** patch 事件订阅（plugin.ts 用于刷新守卫内存态）。 */
  onPatched(listener: (overrides: Partial<Record<ConfigWritableKey, unknown>>) => void): () => void
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

const BOOLEAN_KEYS: readonly ConfigWritableKey[] = ['singleController', 'bridgeApprovals']

/** 校验并收敛一个白名单字段；非法抛错。 */
function coerce(key: ConfigWritableKey, value: unknown): unknown {
  if (BOOLEAN_KEYS.includes(key)) {
    if (typeof value !== 'boolean') throw new Error(`config: ${key} must be boolean`)
    return value
  }
  if (key === 'defaultRole') {
    if (!isRoleName(value as RoleName)) throw new Error(`config: ${key} must be a known role`)
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
  const listeners = new Set<(overrides: Partial<Record<ConfigWritableKey, unknown>>) => void>()
  let cache: Partial<Record<ConfigWritableKey, unknown>> | undefined

  async function load(): Promise<Partial<Record<ConfigWritableKey, unknown>>> {
    if (cache !== undefined) return cache
    try {
      const raw = await readFile(expandHome(deps.path), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      const clean: Partial<Record<ConfigWritableKey, unknown>> = {}
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        for (const key of CONFIG_WRITABLE_KEYS) {
          if (Object.hasOwn(parsed, key)) clean[key] = coerce(key, (parsed as Record<string, unknown>)[key])
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
      return { ...current, ...overrides }
    },
    async patch(input) {
      const overrides = await load()
      const next: Partial<Record<ConfigWritableKey, unknown>> = { ...overrides }
      for (const [key, value] of Object.entries(input)) {
        if (!(CONFIG_WRITABLE_KEYS as readonly string[]).includes(key)) {
          throw new Error(`config: ${key} is read-only or unknown (restart required for cold fields)`)
        }
        next[key as ConfigWritableKey] = coerce(key as ConfigWritableKey, value)
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
    },
  }
}
