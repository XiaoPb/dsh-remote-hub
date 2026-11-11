/**
 * Durable device table: the host's trust roster.
 *
 * 落盘只有 `{ version: 1, devices }`，其中每个 `DeviceRecord` 只含 `tokenHash`
 * （`sha256` hex），**永不含明文令牌**。文件权限 `0600`、父目录 `0700`，写入走
 * `@deepseek-ai/dsh-atomic-write` 的 `writeFileAtomic`（临时文件 + 同目录 rename），
 * 所以写一半被 kill 不会留下半截 JSON；所有读改写用 `withFileLock` 串行化，
 * 两个进程交叉写不丢条目。
 *
 * **fail-closed**：文件存在但 JSON 不可解析、`version` 不是 1、字段不合法时
 * **抛错**，绝不静默清空（静默清空 = 所有设备需重新配对，看起来像"插件坏了"，
 *  worse: 攻击者只要写坏文件就能把吊销记录抹掉）。
 *
 * @module dsh-remote-hub/host/devices
 */
import { mkdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'

import { DEVICE_TABLE_VERSION, LIMITS, isRoleName } from '@core/index.js'
import type { DeviceRecord, DeviceTable, RoleName } from '@core/index.js'

/** `~/.dsh/...` → 绝对路径。其它写法原样 resolve。 */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return resolve(homedir(), path.slice(2))
  return resolve(path)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 严格校验一条设备记录。任何凭据形状不对（例如有人塞了明文 `token` 字段）都
 * 拒绝加载 —— 这同时也是「明文令牌不落盘」的加载期断言。
 * @param value - 候选记录。
 * @returns 合法的 `DeviceRecord`。
 * @throws 当字段缺失/类型不对/含明文凭据时。
 */
export function parseDeviceRecord(value: unknown): DeviceRecord {
  if (!isRecord(value)) throw new Error('devices: record is not an object')
  const { deviceId, label, role, tokenHash, createdAt, lastSeenAt, revokedAt } = value
  if (typeof deviceId !== 'string' || deviceId === '') throw new Error('devices: invalid deviceId')
  if (typeof label !== 'string') throw new Error('devices: invalid label')
  if (!isRoleName(role)) throw new Error(`devices: invalid role ${JSON.stringify(role)}`)
  if (typeof tokenHash !== 'string' || !/^[0-9a-f]{64}$/u.test(tokenHash)) {
    throw new Error('devices: tokenHash must be sha256 hex (no plaintext token may be persisted)')
  }
  if (Object.hasOwn(value, 'token')) {
    throw new Error('devices: plaintext `token` field is forbidden in the device table')
  }
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) {
    throw new Error('devices: invalid createdAt')
  }
  if (lastSeenAt !== null && (typeof lastSeenAt !== 'string' || Number.isNaN(Date.parse(lastSeenAt)))) {
    throw new Error('devices: invalid lastSeenAt')
  }
  if (revokedAt !== null && (typeof revokedAt !== 'string' || Number.isNaN(Date.parse(revokedAt)))) {
    throw new Error('devices: invalid revokedAt')
  }
  return {
    deviceId,
    label,
    role: role as RoleName,
    tokenHash,
    createdAt,
    lastSeenAt: lastSeenAt as string | null,
    revokedAt: revokedAt as string | null,
  }
}

/**
 * 严格校验整张表。
 * @param value - JSON.parse 的结果。
 * @returns 合法的 `DeviceTable`。
 * @throws 未知 `version` / 结构不合法时（**不回退为空表**）。
 */
export function parseDeviceTable(value: unknown): DeviceTable {
  if (!isRecord(value)) throw new Error('devices: table is not an object')
  if (value.version !== DEVICE_TABLE_VERSION) {
    throw new Error(
      `devices: unknown device table version ${JSON.stringify(value.version)}; `
      + `expected ${DEVICE_TABLE_VERSION}. Refusing to start (fail-closed) — do not silently clear the roster.`,
    )
  }
  if (!Array.isArray(value.devices)) throw new Error('devices: `devices` must be an array')
  return {
    version: DEVICE_TABLE_VERSION,
    devices: value.devices.map(parseDeviceRecord),
  }
}

/** 设备表句柄。所有写操作都串行化并原子落盘。 */
export interface DeviceStore {
  /** 从磁盘重新加载并替换内存视图（跨进程同步用）。 */
  load(): Promise<DeviceTable>
  /** 当前内存视图（只读）。 */
  list(): readonly DeviceRecord[]
  get(deviceId: string): DeviceRecord | undefined
  /** 插入一条新记录；`deviceId` 重复时抛错。 */
  insert(record: DeviceRecord): Promise<void>
  /** 局部更新；未知 `deviceId` 抛错。 */
  update(
    deviceId: string,
    patch: Partial<Pick<DeviceRecord, 'label' | 'role' | 'lastSeenAt' | 'revokedAt'>>,
  ): Promise<void>
  /** 把内存视图刷回磁盘（合批的 `lastSeenAt` 心跳走这里）。 */
  flush(): Promise<void>
  /** 文件路径（测试与诊断用）。 */
  readonly path: string
}

/**
 * 创建设备表。
 *
 * 文件不存在时**在锁内**创建空表（避免两个进程同时初始化互相覆盖）；
 * 存在即严格解析，任何错误原样抛出。
 * @param filePath - `~/.dsh/remote-hub/devices.json` 之类的路径。
 * @returns 已加载的 `DeviceStore`。
 */
export async function createDeviceStore(filePath: string): Promise<DeviceStore> {
  const path = expandHome(filePath)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })

  const readTable = async (): Promise<DeviceTable> => {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: DEVICE_TABLE_VERSION, devices: [] }
      }
      throw error
    }
    const info = await stat(path).catch(() => undefined)
    if (info !== undefined && info.size > LIMITS.maxDeviceTableBytes) {
      throw new Error(
        `devices: device table ${path} is ${info.size} bytes, exceeding the ${LIMITS.maxDeviceTableBytes}-byte cap`,
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch {
      throw new Error(`devices: device table ${path} is not valid JSON; refusing to start (fail-closed)`)
    }
    return parseDeviceTable(parsed)
  }

  let table: DeviceTable = await withFileLock(path, async () => {
    const loaded = await readTable()
    // 第一次启动时把空表也原子落盘，后续进程看到一个格式明确的 0600 文件。
    try {
      await readFile(path, 'utf8')
    } catch {
      await writeFileAtomic(path, `${JSON.stringify(loaded, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    }
    return loaded
  })

  const persist = async (next: DeviceTable): Promise<void> => {
    const text = `${JSON.stringify(next, null, 2)}\n`
    if (Buffer.byteLength(text, 'utf8') > LIMITS.maxDeviceTableBytes) {
      throw new Error('devices: device table exceeds the configured size cap; refusing to write')
    }
    await writeFileAtomic(path, text, { mode: 0o600, dirMode: 0o700 })
    table = next
  }

  /** 所有读改写都必须包在锁里：先重新读盘，再基于最新内容提交。 */
  const mutate = async (
    change: (current: DeviceTable) => DeviceTable,
  ): Promise<void> => {
    await withFileLock(path, async () => {
      const current = await readTable()
      await persist(change(current))
    })
  }

  return {
    path,
    async load() {
      const loaded = await withFileLock(path, readTable)
      table = loaded
      return loaded
    },
    list() {
      return table.devices
    },
    get(deviceId) {
      return table.devices.find(device => device.deviceId === deviceId)
    },
    async insert(record) {
      const validated = parseDeviceRecord(record)
      await mutate(current => {
        if (current.devices.some(device => device.deviceId === validated.deviceId)) {
          throw new Error(`devices: duplicate deviceId ${JSON.stringify(validated.deviceId)}`)
        }
        return { version: DEVICE_TABLE_VERSION, devices: [...current.devices, validated] }
      })
    },
    async update(deviceId, patch) {
      await mutate(current => {
        const index = current.devices.findIndex(device => device.deviceId === deviceId)
        if (index < 0) throw new Error(`devices: unknown deviceId ${JSON.stringify(deviceId)}`)
        if (patch.role !== undefined && !isRoleName(patch.role)) {
          throw new Error(`devices: invalid role ${JSON.stringify(patch.role)}`)
        }
        const devices = [...current.devices]
        const previous = devices[index] as DeviceRecord
        devices[index] = { ...previous, ...patch }
        return { version: DEVICE_TABLE_VERSION, devices }
      })
    },
    async flush() {
      await mutate(() => table)
    },
  }
}
