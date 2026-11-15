import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'

export interface OutboundTargetRecord {
  id: string
  origin: string
  /**
   * 旧版：长期 bearer（账号认证模式不再接受）。
   *
   * 账号模式的目标没有可用 bearer——凭据是「客户端私钥 + 租约」，私钥在浏览器
   * IndexedDB 里，Host 档案只留 `account: true` + `accountId`（= 客户端 id）。
   */
  token?: string
  /** 账号认证模式的目标。 */
  account?: boolean
  /** 账号模式下的客户端 id（= 目标端 auth client 的 clientId）。 */
  accountId?: string
  deviceLabel?: string
  deviceId?: string
  role?: string
  pairedAt?: number
  lastConnectedAt: number
}

export interface OutboundTargetView {
  id: string
  origin: string
  deviceLabel?: string
  deviceId?: string
  role?: string
  pairedAt?: number
  lastConnectedAt: number
}

const VERSION = 1
const TOKEN_RE = /^[A-Za-z0-9_-]{16,}$/u

function normalizeOrigin(value: unknown): string {
  if (typeof value !== 'string') throw new Error('outbound-targets: origin must be a string')
  const url = new URL(value)
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password
    || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error('outbound-targets: origin must be a bare HTTP(S) origin')
  }
  return url.origin
}

function targetId(origin: string, token: string): string {
  return createHash('sha256').update(origin).update('\0').update(token).digest('hex')
}

function parseTarget(value: unknown): OutboundTargetRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('outbound-targets: target must be an object')
  const row = value as Record<string, unknown>
  const origin = normalizeOrigin(row.origin)
  const account = row.account === true
  const token = typeof row.token === 'string' ? row.token : undefined
  if (account) {
    if (typeof row.accountId !== 'string' || row.accountId === '') {
      throw new Error('outbound-targets: account target requires accountId')
    }
    if (token !== undefined) throw new Error('outbound-targets: account target must not carry a bearer token')
  } else if (token === undefined || !TOKEN_RE.test(token)) {
    throw new Error('outbound-targets: invalid bearer token')
  }
  const id = targetId(origin, token ?? `account:${String(row.accountId)}`)
  if (row.id !== undefined && row.id !== id) throw new Error('outbound-targets: target id does not match credential')
  for (const field of ['deviceLabel', 'deviceId', 'role'] as const) {
    if (row[field] !== undefined && typeof row[field] !== 'string') throw new Error(`outbound-targets: invalid ${field}`)
  }
  const lastConnectedAt = row.lastConnectedAt === undefined ? Date.now() : row.lastConnectedAt
  if (typeof lastConnectedAt !== 'number' || !Number.isFinite(lastConnectedAt)) throw new Error('outbound-targets: invalid timestamp')
  return {
    id,
    origin,
    ...(account
      ? { account: true, accountId: row.accountId as string }
      : { token: token as string }),
    ...(typeof row.deviceLabel === 'string' ? { deviceLabel: row.deviceLabel } : {}),
    ...(typeof row.deviceId === 'string' ? { deviceId: row.deviceId } : {}),
    ...(typeof row.role === 'string' ? { role: row.role } : {}),
    ...(typeof row.pairedAt === 'number' && Number.isFinite(row.pairedAt) ? { pairedAt: row.pairedAt } : {}),
    lastConnectedAt,
  }
}

function parseFile(value: unknown): OutboundTargetRecord[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('outbound-targets: file must be an object')
  const row = value as Record<string, unknown>
  if (row.version !== VERSION || !Array.isArray(row.targets)) throw new Error('outbound-targets: unsupported file format')
  return row.targets.map(parseTarget)
}

export function outboundTargetView(record: OutboundTargetRecord): OutboundTargetView {
  const { token: _secret, ...view } = record
  return view
}

export function createOutboundTargetStore(home: string) {
  const file = join(home, 'remote-hub', 'outbound-targets.json')
  const read = async (): Promise<OutboundTargetRecord[]> => {
    try {
      return parseFile(JSON.parse(await readFile(file, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
  const ensureDirectory = async (): Promise<void> => {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  }
  const write = async (targets: readonly OutboundTargetRecord[]): Promise<void> => {
    await ensureDirectory()
    await writeFileAtomic(file, `${JSON.stringify({ version: VERSION, targets }, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  }
  return {
    path: file,
    async list(): Promise<OutboundTargetView[]> {
      return (await read()).map(outboundTargetView)
    },
    async save(input: unknown): Promise<OutboundTargetView> {
      const record = parseTarget(input)
      await ensureDirectory()
      await withFileLock(file, async () => {
        const targets = await read()
        const existing = targets.find(target => target.id === record.id)
        if (existing !== undefined) {
          record.pairedAt = existing.pairedAt
          record.role = existing.role ?? record.role
          record.deviceId = existing.deviceId ?? record.deviceId
        }
        const next = [record, ...targets.filter(target => target.id !== record.id)].slice(0, 20)
        await write(next)
      })
      return outboundTargetView(record)
    },
    async get(id: string): Promise<OutboundTargetRecord | undefined> {
      if (!/^[0-9a-f]{64}$/u.test(id)) return undefined
      return (await read()).find(target => target.id === id)
    },
    async forget(id: string): Promise<boolean> {
      if (!/^[0-9a-f]{64}$/u.test(id)) return false
      await ensureDirectory()
      let removed = false
      await withFileLock(file, async () => {
        const targets = await read()
        const next = targets.filter(target => target.id !== id)
        removed = next.length !== targets.length
        if (removed) await write(next)
      })
      return removed
    },
  }
}
