/**
 * 浏览器/App 侧的**客户端密钥环**。
 *
 * 身份模型：每个客户端实例持有一把 ECDSA P-256 私钥（WebCrypto `CryptoKey`，
 * `extractable: false`），公钥在首次信任时登记到目标 Host。之后所有 Hub 请求都用
 * 这把私钥签名——**IP、User-Agent、canvas 指纹都不参与认证**。
 *
 * 持久化：
 * - 有 IndexedDB → 存 `CryptoKey` 本身（不可导出），页面重载/重启浏览器后仍在；
 * - 没有（Node 测试、隐私模式、存储被清）→ 退回**内存**，本会话有效；
 *   重新加载页面即需要重新信任（不会静默降级成别的凭据）。
 *
 * @module dsh-remote-hub/client/auth/keyring
 */
import type { ClientPublicKeyJwk } from '@core/auth.js'

/** 一个客户端身份。 */
export interface ClientIdentity {
  /** 不可导出的私钥。 */
  privateKey: CryptoKey
  /** 可公开的公钥 JWK（登记与指纹展示用）。 */
  publicKey: ClientPublicKeyJwk
}

/** 持久化后端。 */
export interface KeyringBackend {
  load(): Promise<ClientIdentity | null>
  save(identity: ClientIdentity): Promise<void>
  clear(): Promise<void>
}

const DB_NAME = 'dsh-remote-hub-auth'
const STORE_NAME = 'client-keys'
const RECORD_KEY = 'primary'

/** 是否支持 IndexedDB（Node / 隐私模式没有）。 */
function indexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null
}

/** 打开数据库（只建一个 object store）。 */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'))
  })
}

/** 把一次 IDB 操作包成 Promise。 */
function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'))
  })
}

/** IndexedDB 后端：存不可导出的 `CryptoKey`。 */
function indexedDbBackend(): KeyringBackend {
  return {
    async load() {
      const db = await openDatabase()
      try {
        const transaction = db.transaction(STORE_NAME, 'readonly')
        const record = await requestToPromise(transaction.objectStore(STORE_NAME).get(RECORD_KEY)) as
          | { privateKey?: CryptoKey; publicKey?: ClientPublicKeyJwk }
          | undefined
        if (record?.privateKey === undefined || record.publicKey === undefined) return null
        return { privateKey: record.privateKey, publicKey: record.publicKey }
      } finally {
        db.close()
      }
    },
    async save(identity) {
      const db = await openDatabase()
      try {
        const transaction = db.transaction(STORE_NAME, 'readwrite')
        await requestToPromise(transaction.objectStore(STORE_NAME).put(
          { privateKey: identity.privateKey, publicKey: identity.publicKey },
          RECORD_KEY,
        ))
      } finally {
        db.close()
      }
    },
    async clear() {
      if (!indexedDbAvailable()) return
      const db = await openDatabase()
      try {
        const transaction = db.transaction(STORE_NAME, 'readwrite')
        await requestToPromise(transaction.objectStore(STORE_NAME).delete(RECORD_KEY))
      } finally {
        db.close()
      }
    },
  }
}

/** 内存后端（无 IndexedDB 时）。 */
function memoryBackend(): KeyringBackend {
  let held: ClientIdentity | null = null
  return {
    async load() { return held },
    async save(identity) { held = identity },
    async clear() { held = null },
  }
}

/** 取 WebCrypto 的 subtle 实现（浏览器 `crypto.subtle` / Node `globalThis.crypto.subtle`）。 */
export function subtleCrypto(): SubtleCrypto {
  const cryptoObject = (globalThis as { crypto?: Crypto }).crypto
  if (cryptoObject?.subtle === undefined) {
    throw new Error('WebCrypto is unavailable in this runtime')
  }
  return cryptoObject.subtle
}

/**
 * 生成一把新的 ECDSA P-256 密钥。
 *
 * `extractable: false` 让私钥**无法**被导出成字节；即使脚本读到了 IndexedDB 里的
 * 记录，也只能拿到一个不可导出的句柄。
 * @returns 客户端身份。
 */
export async function generateClientIdentity(): Promise<ClientIdentity> {
  const subtle = subtleCrypto()
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  const produced = pair as CryptoKeyPair
  const exported = await subtle.exportKey('jwk', produced.publicKey) as JsonWebKey
  if (typeof exported.x !== 'string' || typeof exported.y !== 'string') {
    throw new Error('unexpected public key shape')
  }
  return {
    privateKey: produced.privateKey,
    publicKey: { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y },
  }
}

/**
 * 用客户端私钥签名。
 * @param privateKey - 不可导出的私钥。
 * @param payload - 规范化字符串（见 `buildProofPayload`）。
 * @returns base64 签名（P1363，64 字节）。
 */
export async function signPayload(privateKey: CryptoKey, payload: string): Promise<string> {
  const subtle = subtleCrypto()
  const signature = await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(payload),
  )
  return bytesToBase64(new Uint8Array(signature))
}

/** Base64 字母表（自己算，不依赖 Buffer / btoa 的可用性）。 */
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** 字节 → base64。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let output = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    output += BASE64_ALPHABET[first >> 2]
    output += BASE64_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)]
    output += second === undefined ? '=' : BASE64_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)]
    output += third === undefined ? '=' : BASE64_ALPHABET[third & 0x3f]
  }
  return output
}

/**
 * `sha256(text)` 的十六进制小写表示（与 host 侧摘要口径一致）。
 * @param text - 任意文本。
 * @returns 64 字符十六进制。
 */
export async function sha256Hex(text: string): Promise<string> {
  const subtle = subtleCrypto()
  const digest = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * 创建密钥环（自动选择 IndexedDB 或内存后端）。
 * @param backend - 覆盖用（测试）。
 * @returns 密钥环。
 */
export function createKeyring(backend?: KeyringBackend): {
  load(): Promise<ClientIdentity | null>
  loadOrCreate(): Promise<{ identity: ClientIdentity; created: boolean }>
  clear(): Promise<void>
} {
  const store = backend ?? (indexedDbAvailable() ? indexedDbBackend() : memoryBackend())
  return {
    load: () => store.load(),
    async loadOrCreate() {
      const existing = await store.load()
      if (existing !== null) return { identity: existing, created: false }
      const identity = await generateClientIdentity()
      await store.save(identity)
      return { identity, created: true }
    },
    clear: () => store.clear(),
  }
}
