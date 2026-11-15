/**
 * 认证数据存储：账号、可信客户端、浏览器会话、重放 nonce。
 *
 * 落盘只有一个文件（默认 `~/.dsh/remote-hub/auth.json`），内容**只有**：
 * - 口令的 scrypt 派生值
 * - TOTP 密钥（需要明文才能算码，因此依赖文件权限 0600）
 * - 备用码的 sha256
 * - 客户端公钥的指纹与 JWK（公钥可以公开）
 * - 租约/会话的 sha256（不存明文）
 *
 * 写入策略：原子写（tmp + rename）+ 0600 + 串行化；nonce 采用「标记脏 + 最多每秒
 * 落盘一次」的节流，避免每个 RPC 都写文件。
 *
 * @module dsh-remote-hub/host/auth/store
 */
import { mkdir, readFile, rename, chmod, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'

import type { ClientType, ClientPublicKeyJwk } from '@core/auth.js'
import { AUTH_STORE_VERSION } from '@core/auth.js'
import type { RoleName } from '@core/roles.js'
import { isRoleName } from '@core/roles.js'

import { dshHome } from '../devices.js'
import { isClientPublicKeyJwk, sha256Hex } from './crypto.js'

/** 账号记录。 */
export interface AccountRecord {
  username: string
  /** `scrypt$N$r$p$salt$hash`。 */
  passwordHash: string
  /** TOTP 状态；`verified: false` 表示已生成但尚未确认绑定。 */
  totp?: { secret: string; verified: boolean; createdAt: number }
  /** 备用码 sha256；`usedAt` 非空即已消费。 */
  backupCodes?: { hash: string; usedAt?: number }[]
  createdAt: number
  updatedAt: number
  lastLoginAt: number | null
  /**
   * 首次登录必须改密（默认账号自动创建时置 true）。
   *
   * 改密成功后清除；缺省（旧存储）视为 false。
   */
  mustChangePassword?: boolean
}

/** 可信客户端记录。 */
export interface ClientRecord {
  clientId: string
  keyId: string
  label: string
  clientType: ClientType
  publicKey: ClientPublicKeyJwk
  fingerprint: string
  roleCeiling: RoleName
  activeRole: RoleName
  /** 当前租约的 sha256（明文只在签发响应里出现一次）。 */
  leaseHash: string | null
  /** 单调递增；轮换一次 +1。用于识别「旧租约被重放」。 */
  leaseGeneration: number
  /** epoch ms；无租约时 null。 */
  leaseExpiresAt: number | null
  createdAt: number
  lastSeenAt: number | null
  /** 被单控挤下线的时间（仍保留信任，只是当前不在控制）。 */
  displacedAt?: number | null
  revokedAt: number | null
}

/** 浏览器会话记录。 */
export interface SessionRecord {
  sid: string
  /** sha256(secret)；Cookie 里是 `<sid>.<secret>`。 */
  secretHash: string
  createdAt: number
  expiresAt: number
  lastSeenAt: number
  /** 最近一次完成 2FA 的时间（信任新客户端的时效判据）。 */
  lastMfaAt: number | null
  revokedAt: number | null
}

/** 一次性 MFA 挑战。 */
export interface MfaChallengeRecord {
  tokenHash: string
  createdAt: number
  expiresAt: number
  consumedAt: number | null
  /** 错误尝试次数（达上限即烧掉挑战，防止在 5 分钟内穷举 6 位码）。 */
  attempts?: number
}

/** 落盘形态。 */
export interface AuthStoreData {
  version: typeof AUTH_STORE_VERSION
  account: AccountRecord | null
  clients: ClientRecord[]
  sessions: SessionRecord[]
  challenges: MfaChallengeRecord[]
  /** nonce → 过期时间（epoch ms）。 */
  nonces: Record<string, number>
  /** 运行期设置（设置页可改，无需重启）。 */
  settings?: {
    /** 口令策略；缺省时用插件配置的默认值。 */
    passwordPolicy?: 'strong' | 'basic'
  }
}

/** 空存储。 */
export function emptyAuthStore(): AuthStoreData {
  return {
    version: AUTH_STORE_VERSION,
    account: null,
    clients: [],
    sessions: [],
    challenges: [],
    nonces: {},
  }
}

/**
 * 默认存储路径。
 *
 * 必须走 `dshHome()`（尊重 `DSH_HOME`），不能直接拼 `homedir()`：
 * dsh-box / 沙箱实例靠 `DSH_HOME` 隔离档案柜，拼死家目录会把 `auth.json`
 * 写进用户真实 `~/.dsh`——既污染主环境，也让隔离测试测不到隔离语义
 * （2026-11-15 沙箱实测复现）。
 * @returns 绝对路径。
 */
export function defaultAuthStorePath(): string {
  return join(dshHome(), 'remote-hub', 'auth.json')
}

/** 存储句柄。 */
export interface AuthStore {
  readonly path: string
  readonly data: AuthStoreData
  /**
   * 在一个同步回调里修改数据，然后原子落盘。
   * @param fn - 修改函数；抛错则不落盘。
   * @param options - `deferred` 为 true 时只标脏，由节流器稍后写。
   */
  mutate(fn: (data: AuthStoreData) => void, options?: { deferred?: boolean }): Promise<void>
  /** 强制落盘（节流器与 dispose 使用）。 */
  flush(): Promise<void>
  /** 停止节流器并落盘。 */
  dispose(): Promise<void>
}

/** 严格解析一条客户端记录（形状不对即抛，绝不静默丢弃）。 */
function parseClient(value: unknown): ClientRecord {
  if (typeof value !== 'object' || value === null) throw new Error('auth store: client is not an object')
  const row = value as Record<string, unknown>
  if (typeof row.clientId !== 'string' || row.clientId === '') throw new Error('auth store: invalid clientId')
  if (typeof row.keyId !== 'string' || row.keyId === '') throw new Error('auth store: invalid keyId')
  if (typeof row.label !== 'string') throw new Error('auth store: invalid label')
  if (row.clientType !== 'browser' && row.clientType !== 'app' && row.clientType !== 'dsh') {
    throw new Error('auth store: invalid clientType')
  }
  if (!isClientPublicKeyJwk(row.publicKey)) throw new Error('auth store: invalid client public key')
  if (typeof row.fingerprint !== 'string') throw new Error('auth store: invalid fingerprint')
  if (!isRoleName(row.roleCeiling)) throw new Error('auth store: invalid roleCeiling')
  if (!isRoleName(row.activeRole)) throw new Error('auth store: invalid activeRole')
  if (row.leaseHash !== null && (typeof row.leaseHash !== 'string' || !/^[0-9a-f]{64}$/u.test(row.leaseHash))) {
    throw new Error('auth store: leaseHash must be sha256 hex or null')
  }
  if (!Number.isSafeInteger(row.leaseGeneration) || (row.leaseGeneration as number) < 0) {
    throw new Error('auth store: invalid leaseGeneration')
  }
  if (row.leaseExpiresAt !== null && !Number.isFinite(row.leaseExpiresAt as number)) {
    throw new Error('auth store: invalid leaseExpiresAt')
  }
  if (!Number.isFinite(row.createdAt)) throw new Error('auth store: invalid createdAt')
  return {
    clientId: row.clientId,
    keyId: row.keyId,
    label: row.label,
    clientType: row.clientType,
    publicKey: row.publicKey,
    fingerprint: row.fingerprint,
    roleCeiling: row.roleCeiling,
    activeRole: row.activeRole,
    leaseHash: row.leaseHash as string | null,
    leaseGeneration: row.leaseGeneration as number,
    leaseExpiresAt: row.leaseExpiresAt as number | null,
    createdAt: row.createdAt as number,
    lastSeenAt: (row.lastSeenAt as number | null | undefined) ?? null,
    revokedAt: (row.revokedAt as number | null | undefined) ?? null,
  }
}

/**
 * 加载并校验存储。
 *
 * 任何形状问题都**抛错**（fail-closed）：认证数据损坏时宁可让服务不启动，
 * 也不能悄悄清空账号回到引导模式（那等于把机器交出去）。
 * @param path - 文件路径。
 * @returns 存储句柄。
 */
export async function createAuthStore(path: string = defaultAuthStorePath()): Promise<AuthStore> {
  let raw: string | null = null
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  let data: AuthStoreData
  if (raw === null) {
    data = emptyAuthStore()
  } else {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`auth store: ${path} is not valid JSON; refusing to start (fail-closed)`)
    }
    if (typeof parsed !== 'object' || parsed === null) throw new Error('auth store: root is not an object')
    const root = parsed as Record<string, unknown>
    if (root.version !== AUTH_STORE_VERSION) {
      throw new Error(`auth store: unsupported version ${JSON.stringify(root.version)} (expected ${AUTH_STORE_VERSION})`)
    }
    data = {
      version: AUTH_STORE_VERSION,
      account: root.account === null || root.account === undefined ? null : root.account as AccountRecord,
      clients: Array.isArray(root.clients) ? root.clients.map(parseClient) : [],
      sessions: Array.isArray(root.sessions) ? root.sessions as SessionRecord[] : [],
      challenges: Array.isArray(root.challenges) ? root.challenges as MfaChallengeRecord[] : [],
      nonces: typeof root.nonces === 'object' && root.nonces !== null
        ? root.nonces as Record<string, number>
        : {},
      ...(typeof root.settings === 'object' && root.settings !== null
        ? { settings: root.settings as AuthStoreData['settings'] }
        : {}),
    }
    if (data.account !== null) {
      const account = data.account as unknown as Record<string, unknown>
      if (typeof account.username !== 'string' || typeof account.passwordHash !== 'string') {
        throw new Error('auth store: invalid account record')
      }
    }
  }

  let chain: Promise<void> = Promise.resolve()
  let dirty = false
  let timer: NodeJS.Timeout | undefined
  let closed = false

  async function writeNow(): Promise<void> {
    const body = `${JSON.stringify(data, null, 2)}\n`
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, body, { mode: 0o600 })
    await rename(tmp, path)
    try {
      await chmod(path, 0o600)
    } catch {
      // best effort（Windows 上 chmod 语义有限）
    }
    dirty = false
  }

  function schedule(): void {
    if (closed || timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      if (!dirty) return
      chain = chain.then(writeNow).catch(() => { /* 下次仍会尝试 */ })
    }, 1_000)
    timer.unref?.()
  }

  const store: AuthStore = {
    path,
    data,
    async mutate(fn, options) {
      fn(data)
      if (options?.deferred === true) {
        dirty = true
        schedule()
        return
      }
      chain = chain.then(writeNow)
      await chain
    },
    async flush() {
      if (closed) return
      chain = chain.then(writeNow)
      await chain
    },
    async dispose() {
      closed = true
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      if (dirty) {
        chain = chain.then(writeNow)
      }
      await chain.catch(() => { /* dispose 失败不能掩盖根因 */ })
    },
  }

  // 首次启动即创建（0600），让权限从一开始就正确。
  if (raw === null) await store.flush()
  return store
}

/** 生成一个 keyId（公钥版本的稳定标识）。 */
export function newKeyId(publicKey: ClientPublicKeyJwk): string {
  return `key_${sha256Hex(JSON.stringify(publicKey)).slice(0, 24)}`
}

/**
 * 原子写一个 0600 私有文件（初始口令等一次性明文）。
 *
 * 与存储本体同一套手法：临时文件 + rename + chmod，目录 0700。
 * @param path - 目标路径。
 * @param body - 文件内容。
 */
export async function writePrivateFile(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, body, { mode: 0o600 })
  await rename(tmp, path)
  try {
    await chmod(path, 0o600)
  } catch {
    // Windows 上 chmod 语义有限：尽力而为。
  }
}

/** 生成一个 clientId。 */
export function newClientId(): string {
  return `cli_${randomBytes(12).toString('hex')}`
}

/** 生成一个 sessionId。 */
export function newSessionId(): string {
  return `sid_${randomBytes(12).toString('hex')}`
}
