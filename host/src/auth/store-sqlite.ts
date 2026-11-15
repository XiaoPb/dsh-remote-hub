/**
 * SQLite 持久化层（`node:sqlite`，Node 内置，零原生依赖）。
 *
 * 结构见 `tasks/schema.md`。服务层仍以内存模型（`AuthStoreData`）工作：
 * 这里负责「启动装载 + mutate 后单事务整表回写」；审计与限流是直写表。
 *
 * 设计取舍：
 * - **短连接**：每次读写打开-关闭一条连接。认证写入频率极低（节流 1s），
 *   换来的是不会留下长期文件句柄（测试里 `rm` 目录、Windows 锁、备份都省心）。
 * - 小表整表回写（几十~几百行）比逐行 diff 简单，且事务保证不会半更新。
 * - `audit_events` / `login_throttle` 不走内存快照，避免每次写重放历史。
 * - 旧 `auth.json` 一次性导入后改名为 `auth.json.imported`，保留回滚退路。
 *
 * @module dsh-remote-hub/host/auth/store-sqlite
 */
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { chmod, mkdir, readdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type {
  AuthStore,
  AuthStoreData,
  AccountRecord,
  ClientRecord,
  SessionRecord,
  MfaChallengeRecord,
} from './store.js'

/** schema 版本；结构变更必须 +1 并提供迁移。 */
export const SCHEMA_VERSION = 1

/** 审计保留：最多 50000 条、90 天（先到者生效）。 */
export const AUDIT_KEEP = 50_000
export const AUDIT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000

/** 自动备份保留份数。 */
export const BACKUP_KEEP = 3

/** v1 单账号迁移用的管理员 id。 */
export const DEFAULT_ACCOUNT_ID = 'acc_admin'

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  totp_secret TEXT,
  totp_verified INTEGER NOT NULL DEFAULT 0,
  totp_created_at INTEGER,
  backup_codes TEXT,
  role_ceiling TEXT NOT NULL DEFAULT 'control',
  is_admin INTEGER NOT NULL DEFAULT 0,
  disabled_at INTEGER,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_admin ON accounts(is_admin) WHERE is_admin = 1;
CREATE TABLE IF NOT EXISTS clients (
  client_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  key_id TEXT NOT NULL,
  label TEXT NOT NULL,
  client_type TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  role_ceiling TEXT NOT NULL,
  active_role TEXT NOT NULL,
  lease_hash TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 1,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  displaced_at INTEGER,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_fingerprint ON clients(account_id, fingerprint);
CREATE INDEX IF NOT EXISTS idx_clients_account ON clients(account_id);
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_mfa_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS mfa_challenges (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_challenges_account ON mfa_challenges(account_id);
CREATE TABLE IF NOT EXISTS nonces (
  nonce TEXT PRIMARY KEY,
  client_id TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nonces_expiry ON nonces(expires_at);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  account_id TEXT,
  client_id TEXT,
  source TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_events(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_account ON audit_events(account_id, at DESC);
CREATE TABLE IF NOT EXISTS login_throttle (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  blocked_until INTEGER
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

/** 一条审计事件。 */
export interface AuditEvent {
  at: number
  kind: string
  accountId?: string | null
  clientId?: string | null
  source?: string | null
  detail?: string | null
}

/** 逻辑路径（`auth.json`）→ 数据库路径。 */
export function sqlitePathFor(path: string): string {
  return path.endsWith('.json') ? `${path.slice(0, -5)}.db` : `${path}.db`
}

/** 打开库并保证 schema/版本/权限就绪。 */
export function openAuthDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(DDL)
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
      | { value?: string }
      | undefined
    if (row?.value === undefined) {
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
        .run('install_id', createHash('sha256').update(file).digest('hex').slice(0, 16))
    } else if (Number(row.value) !== SCHEMA_VERSION) {
      throw new Error(`auth store: schema version ${row.value} is not supported (expected ${SCHEMA_VERSION})`)
    }
    return db
  } catch (error) {
    // 关键：失败路径必须关闭连接，否则 Windows 上文件被锁住（测试 rm 会 EBUSY）。
    try { db.close() } catch { /* 忽略 */ }
    throw error
  }
}

/** 短连接：打开 → 执行 → 关闭（异常也关）。 */
async function withDb<T>(file: string, fn: (db: DatabaseSync) => T | Promise<T>): Promise<T> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 }).catch(() => { /* 已存在 */ })
  const db = openAuthDatabase(file)
  try {
    const result = await fn(db)
    return result
  } finally {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch { /* 忽略 */ }
    try { db.close() } catch { /* 忽略 */ }
  }
}

/** 整表装载到内存模型（P1 仍按单管理员映射）。 */
export function loadStoreData(db: DatabaseSync): AuthStoreData {
  const accounts = db.prepare('SELECT * FROM accounts ORDER BY is_admin DESC, created_at').all() as Array<Record<string, unknown>>
  const admin = accounts.find(row => Number(row.is_admin) === 1) ?? accounts[0]
  const clients = db.prepare('SELECT * FROM clients ORDER BY created_at').all() as Array<Record<string, unknown>>
  const sessions = db.prepare('SELECT * FROM sessions').all() as Array<Record<string, unknown>>
  const challenges = db.prepare('SELECT * FROM mfa_challenges').all() as Array<Record<string, unknown>>
  const nonces = db.prepare('SELECT nonce, expires_at FROM nonces').all() as Array<{ nonce: string; expires_at: number }>
  const settings = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>
  const policy = settings.find(row => row.key === 'password_policy')?.value
  return {
    version: 1,
    account: admin === undefined ? null : rowToAccount(admin),
    clients: clients.map(rowToClient),
    sessions: sessions.map(rowToSession),
    challenges: challenges.map(rowToChallenge),
    nonces: Object.fromEntries(nonces.map(row => [row.nonce, Number(row.expires_at)])),
    ...(policy === 'strong' || policy === 'basic' ? { settings: { passwordPolicy: policy } } : {}),
  } as AuthStoreData
}

/** 单事务整表回写。 */
export function saveStoreData(db: DatabaseSync, data: AuthStoreData): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('DELETE FROM nonces')
    db.exec('DELETE FROM mfa_challenges')
    db.exec('DELETE FROM sessions')
    db.exec('DELETE FROM clients')
    db.exec('DELETE FROM accounts')
    db.exec('DELETE FROM settings')

    if (data.account !== null) upsertAccount(db, data.account)
    for (const client of data.clients) upsertClient(db, client)
    for (const session of data.sessions) upsertSession(db, session)
    for (const challenge of data.challenges) upsertChallenge(db, challenge)
    for (const [nonce, expiresAt] of Object.entries(data.nonces)) {
      if (Number(expiresAt) <= Date.now()) continue
      db.prepare('INSERT OR REPLACE INTO nonces (nonce, expires_at) VALUES (?, ?)').run(nonce, Number(expiresAt))
    }
    if (data.settings?.passwordPolicy !== undefined) {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('password_policy', data.settings.passwordPolicy)
    }
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw error
  }
}

/** 追加一条审计并按「50000 条 / 90 天」裁剪。 */
export async function appendAuditEvent(file: string, event: AuditEvent): Promise<void> {
  await withDb(file, (db) => {
    db.prepare(`
      INSERT INTO audit_events (at, kind, account_id, client_id, source, detail)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.at,
      event.kind,
      event.accountId ?? null,
      event.clientId ?? null,
      event.source ?? null,
      event.detail === undefined || event.detail === null ? null : event.detail.slice(0, 1024),
    )
    db.prepare('DELETE FROM audit_events WHERE at < ?').run(event.at - AUDIT_MAX_AGE_MS)
    const row = db.prepare('SELECT MAX(id) AS maxId FROM audit_events').get() as { maxId?: number } | undefined
    const maxId = Number(row?.maxId ?? 0)
    if (maxId > AUDIT_KEEP) {
      db.prepare('DELETE FROM audit_events WHERE id <= ?').run(maxId - AUDIT_KEEP)
    }
  })
}

/** 读取最近的审计事件（设置页/诊断用）。 */
export async function readAuditTail(file: string, limit = 50): Promise<unknown[]> {
  return withDb(file, db =>
    db.prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT ?').all(Math.max(1, Math.min(limit, 500))),
  )
}

/** UPSERT 登录限流计数（服务层在内存里累计，定时调用本函数落库）。 */
export async function bumpThrottle(
  file: string,
  key: string,
  input: { failures: number; windowStart: number; blockedUntil?: number | null },
): Promise<void> {
  await withDb(file, (db) => {
    db.prepare(`
      INSERT INTO login_throttle (key, failures, window_start, blocked_until)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        failures = excluded.failures,
        window_start = excluded.window_start,
        blocked_until = excluded.blocked_until
    `).run(key, input.failures, input.windowStart, input.blockedUntil ?? null)
  })
}

/** 读取一条限流记录（启动时恢复）。 */
export async function readThrottle(
  file: string,
  key: string,
): Promise<{ failures: number; windowStart: number; blockedUntil: number | null } | null> {
  return withDb(file, (db) => {
    const row = db.prepare('SELECT * FROM login_throttle WHERE key = ?').get(key) as
      | { failures: number; window_start: number; blocked_until: number | null }
      | undefined
    if (row === undefined) return null
    return {
      failures: Number(row.failures),
      windowStart: Number(row.window_start),
      blockedUntil: row.blocked_until === null ? null : Number(row.blocked_until),
    }
  })
}

/** 旧的 `auth.json` 一次性导入。 */
export async function importLegacyJson(file: string, jsonPath: string): Promise<boolean> {
  if (!existsSync(jsonPath)) return false
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as Record<string, unknown>
  } catch {
    throw new Error(`auth store: ${jsonPath} is not valid JSON; refusing to start (fail-closed)`)
  }
  if (parsed.version !== 1) {
    throw new Error(`auth store: unsupported legacy version ${JSON.stringify(parsed.version)}`)
  }
  const account = parsed.account as AccountRecord | null | undefined
  const data: AuthStoreData = {
    version: 1,
    account: account === undefined || account === null
      ? null
      : { ...account, accountId: DEFAULT_ACCOUNT_ID, isAdmin: true, roleCeiling: 'full' },
    clients: Array.isArray(parsed.clients)
      ? (parsed.clients as ClientRecord[]).map(client => ({ ...client, accountId: DEFAULT_ACCOUNT_ID }))
      : [],
    sessions: Array.isArray(parsed.sessions)
      ? (parsed.sessions as SessionRecord[]).map(session => ({ ...session, accountId: DEFAULT_ACCOUNT_ID }))
      : [],
    challenges: Array.isArray(parsed.challenges)
      ? (parsed.challenges as MfaChallengeRecord[]).map(challenge => ({ ...challenge, accountId: DEFAULT_ACCOUNT_ID }))
      : [],
    nonces: typeof parsed.nonces === 'object' && parsed.nonces !== null
      ? parsed.nonces as Record<string, number>
      : {},
    ...(typeof parsed.settings === 'object' && parsed.settings !== null
      ? { settings: parsed.settings as AuthStoreData['settings'] }
      : {}),
  } as AuthStoreData
  const imported = await withDb(file, (db) => {
    const existing = db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n?: number } | undefined
    if (Number(existing?.n ?? 0) > 0) return false
    saveStoreData(db, data)
    return true
  })
  if (!imported) return false
  await appendAuditEvent(file, { at: Date.now(), kind: 'import', detail: JSON.stringify({ from: 'auth.json' }) })
  renameSync(jsonPath, `${jsonPath}.imported`)
  return true
}

/** 启动备份：`VACUUM INTO`，保留最近 `BACKUP_KEEP` 份。 */
export async function backupDatabase(file: string, dir: string): Promise<string | null> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
    const target = join(dir, `auth-${stamp}.db`)
    await withDb(file, (db) => {
      db.exec(`VACUUM INTO '${target.replace(/'/gu, "''")}'`)
    })
    await chmod(target, 0o600).catch(() => { /* Windows */ })
    const rows = (await readdir(dir)).filter(name => name.startsWith('auth-') && name.endsWith('.db')).sort()
    for (const stale of rows.slice(0, Math.max(0, rows.length - BACKUP_KEEP))) {
      await rm(join(dir, stale), { force: true }).catch(() => { /* 忽略 */ })
    }
    return target
  } catch {
    return null
  }
}

/** 创建 SQLite 存储句柄。 */
export async function createSqliteAuthStore(logicalPath: string): Promise<AuthStore> {
  const file = sqlitePathFor(logicalPath)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 }).catch(() => { /* 已存在 */ })
  await importLegacyJson(file, logicalPath)
  const data = await withDb(file, db => loadStoreData(db))
  await chmod(file, 0o600).catch(() => { /* Windows 语义有限 */ })
  let chain: Promise<void> = Promise.resolve()
  let dirty = false
  let timer: NodeJS.Timeout | undefined
  let closed = false
  let lastThrottleFlush = 0

  const save = async (): Promise<void> => {
    await withDb(file, (db) => { saveStoreData(db, data) })
    dirty = false
  }

  function schedule(): void {
    if (closed || timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      if (!dirty) return
      chain = chain.then(save).catch(() => { /* 下次仍会尝试 */ })
    }, 1_000)
    timer.unref?.()
  }

  const store: AuthStore = {
    path: logicalPath,
    data,
    async mutate(fn, options) {
      fn(data)
      if (options?.deferred === true) {
        dirty = true
        schedule()
        return
      }
      chain = chain.then(save)
      await chain
    },
    async flush() {
      if (closed) return
      chain = chain.then(save)
      await chain
    },
    async dispose() {
      closed = true
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      if (dirty) chain = chain.then(save)
      await chain.catch(() => { /* dispose 失败不掩盖根因 */ })
    },
    appendAudit(event) {
      // 审计直写不阻塞主流程；失败只影响审计，不影响认证。
      void appendAuditEvent(file, event).catch(() => { /* 忽略 */ })
    },
    readAudit(limit) {
      return readAuditTail(file, limit)
    },
    bumpThrottle(key, input) {
      // 短时限流在内存里累计，落库按 5s 节流：失败风暴时不会每次开连接。
      throttles.set(key, {
        failures: input.failures,
        windowStart: input.windowStart,
        blockedUntil: input.blockedUntil ?? null,
      })
      const now = Date.now()
      if (now - lastThrottleFlush < 5_000) return
      lastThrottleFlush = now
      void bumpThrottle(file, key, input).catch(() => { /* 忽略 */ })
    },
    readThrottle(key) {
      return throttles.get(key) ?? null
    },
  }

  // 启动时把持久化的限流计数读回内存（重启不清零）。
  const throttles = new Map<string, { failures: number; windowStart: number; blockedUntil: number | null }>()

  await store.flush()
  void backupDatabase(file, join(dirname(file), 'backup'))
  return store
}

// ── 行 ↔ 记录 ────────────────────────────────────────────────────────────

function upsertAccount(db: DatabaseSync, account: AccountRecord): void {
  db.prepare(`
    INSERT OR REPLACE INTO accounts
      (account_id, username, password_hash, totp_secret, totp_verified, totp_created_at,
       backup_codes, role_ceiling, is_admin, disabled_at, must_change_password,
       created_at, updated_at, last_login_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    account.accountId ?? DEFAULT_ACCOUNT_ID,
    account.username,
    account.passwordHash,
    account.totp?.secret ?? null,
    account.totp?.verified === true ? 1 : 0,
    account.totp?.createdAt ?? null,
    account.backupCodes === undefined ? null : JSON.stringify(account.backupCodes),
    account.roleCeiling ?? 'full',
    account.isAdmin === false ? 0 : 1,
    account.disabledAt ?? null,
    account.mustChangePassword === true ? 1 : 0,
    account.createdAt,
    account.updatedAt,
    account.lastLoginAt ?? null,
  )
}

function upsertClient(db: DatabaseSync, client: ClientRecord): void {
  db.prepare(`
    INSERT OR REPLACE INTO clients
      (client_id, account_id, key_id, label, client_type, public_key, fingerprint,
       role_ceiling, active_role, lease_hash, lease_generation, lease_expires_at,
       created_at, last_seen_at, displaced_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    client.clientId,
    client.accountId ?? DEFAULT_ACCOUNT_ID,
    client.keyId,
    client.label,
    client.clientType,
    JSON.stringify(client.publicKey),
    client.fingerprint,
    client.roleCeiling,
    client.activeRole,
    client.leaseHash ?? null,
    client.leaseGeneration,
    client.leaseExpiresAt ?? null,
    client.createdAt,
    client.lastSeenAt ?? null,
    client.displacedAt ?? null,
    client.revokedAt ?? null,
  )
}

function upsertSession(db: DatabaseSync, session: SessionRecord): void {
  db.prepare(`
    INSERT OR REPLACE INTO sessions
      (sid, account_id, secret_hash, created_at, expires_at, last_seen_at, last_mfa_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    session.sid,
    session.accountId ?? DEFAULT_ACCOUNT_ID,
    session.secretHash,
    session.createdAt,
    session.expiresAt,
    session.lastSeenAt,
    session.lastMfaAt ?? null,
    session.revokedAt ?? null,
  )
}

function upsertChallenge(db: DatabaseSync, challenge: MfaChallengeRecord): void {
  db.prepare(`
    INSERT OR REPLACE INTO mfa_challenges
      (token_hash, account_id, created_at, expires_at, consumed_at, attempts)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    challenge.tokenHash,
    challenge.accountId ?? DEFAULT_ACCOUNT_ID,
    challenge.createdAt,
    challenge.expiresAt,
    challenge.consumedAt ?? null,
    challenge.attempts ?? 0,
  )
}

function rowToAccount(row: Record<string, unknown>): AccountRecord {
  return {
    accountId: String(row.account_id),
    username: String(row.username),
    passwordHash: String(row.password_hash),
    ...(row.totp_secret === null || row.totp_secret === undefined
      ? {}
      : {
        totp: {
          secret: String(row.totp_secret),
          verified: Number(row.totp_verified) === 1,
          createdAt: Number(row.totp_created_at ?? 0),
        },
      }),
    ...(row.backup_codes === null || row.backup_codes === undefined
      ? {}
      : { backupCodes: JSON.parse(String(row.backup_codes)) as AccountRecord['backupCodes'] }),
    roleCeiling: String(row.role_ceiling) as AccountRecord['roleCeiling'],
    isAdmin: Number(row.is_admin) === 1,
    disabledAt: row.disabled_at === null || row.disabled_at === undefined ? null : Number(row.disabled_at),
    mustChangePassword: Number(row.must_change_password) === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastLoginAt: row.last_login_at === null || row.last_login_at === undefined ? null : Number(row.last_login_at),
  }
}

function rowToClient(row: Record<string, unknown>): ClientRecord {
  return {
    clientId: String(row.client_id),
    accountId: String(row.account_id),
    keyId: String(row.key_id),
    label: String(row.label),
    clientType: String(row.client_type) as ClientRecord['clientType'],
    publicKey: JSON.parse(String(row.public_key)) as ClientRecord['publicKey'],
    fingerprint: String(row.fingerprint),
    roleCeiling: String(row.role_ceiling) as ClientRecord['roleCeiling'],
    activeRole: String(row.active_role) as ClientRecord['activeRole'],
    leaseHash: row.lease_hash === null || row.lease_hash === undefined ? null : String(row.lease_hash),
    leaseGeneration: Number(row.lease_generation),
    leaseExpiresAt: row.lease_expires_at === null || row.lease_expires_at === undefined ? null : Number(row.lease_expires_at),
    createdAt: Number(row.created_at),
    lastSeenAt: row.last_seen_at === null || row.last_seen_at === undefined ? null : Number(row.last_seen_at),
    displacedAt: row.displaced_at === null || row.displaced_at === undefined ? null : Number(row.displaced_at),
    revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : Number(row.revoked_at),
  }
}

function rowToSession(row: Record<string, unknown>): SessionRecord {
  return {
    sid: String(row.sid),
    accountId: String(row.account_id),
    secretHash: String(row.secret_hash),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    lastSeenAt: Number(row.last_seen_at),
    lastMfaAt: row.last_mfa_at === null || row.last_mfa_at === undefined ? null : Number(row.last_mfa_at),
    revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : Number(row.revoked_at),
  }
}

function rowToChallenge(row: Record<string, unknown>): MfaChallengeRecord {
  return {
    tokenHash: String(row.token_hash),
    accountId: String(row.account_id),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    consumedAt: row.consumed_at === null || row.consumed_at === undefined ? null : Number(row.consumed_at),
    attempts: Number(row.attempts ?? 0),
  }
}
