/**
 * 浏览器直连模式下的远程目录接管（方案 A 第 6 片）。
 *
 * 要点：`cloudPathContext()` 非 null 时 `paths/index.tsx` 的 `apply()` 才会注册
 * `directoryFlow` 槽位——那正是「创建工作区时弹远程目录而不是本地文件夹」的开关。
 *
 * 三种形态必须互不干扰：
 *   本机   → null（原生目录框）
 *   控制端 → 载体传输（不回归）
 *   浏览器 → 守卫标记 + 同源 fetch
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const built = `${root}.build/client/client/src/paths/context.js`
const source = pathToFileURL(existsSync(built) ? built : `${root}client/src/paths/context.ts`).href

const {
  cloudPathContext,
  REMOTE_BROWSER_MODE,
} = await import(source)

test('browser-direct mode activates the remote directory flow', () => {
  const context = cloudPathContext({
    __DSH_REMOTE_HUB__: { mode: REMOTE_BROWSER_MODE },
    location: { origin: 'https://hub.example.com' },
  })
  assert.notEqual(context, null, '非 null 才会注册 directoryFlow 槽位')
  assert.equal(context.origin, 'https://hub.example.com')
  assert.equal(typeof context.fetch, 'function')
})

test('local mode still returns null so the native picker is used', () => {
  assert.equal(cloudPathContext({ location: { origin: 'http://127.0.0.1:3080' } }), null)
  // 有标记但拿不到 origin 时也必须保守地退化成本机模式。
  assert.equal(cloudPathContext({ __DSH_REMOTE_HUB__: { mode: REMOTE_BROWSER_MODE } }), null)
  assert.equal(cloudPathContext({
    __DSH_REMOTE_HUB__: { mode: REMOTE_BROWSER_MODE },
    location: { origin: '' },
  }), null)
})

test('the carrier takeover mode keeps using its own transport', () => {
  const transportFetch = async () => new Response('{}')
  const context = cloudPathContext({
    __DSH_REMOTE_HUB_CARRIER__: { active: true },
    __DSH_TRANSPORT__: { fetch: transportFetch, streamBaseUrl: 'https://guard.example' },
    // 即便同时带了浏览器标记，控制端传输也必须优先（它带签名）。
    __DSH_REMOTE_HUB__: { mode: REMOTE_BROWSER_MODE },
    location: { origin: 'https://hub.example.com' },
  })
  assert.equal(context.origin, 'https://guard.example')
  assert.equal(context.fetch, transportFetch)
})

test('a carrier that is not fully active falls back to the browser mode', () => {
  const context = cloudPathContext({
    __DSH_REMOTE_HUB_CARRIER__: { active: false },
    __DSH_TRANSPORT__: { fetch: async () => new Response('{}'), streamBaseUrl: 'https://guard.example' },
    __DSH_REMOTE_HUB__: { mode: REMOTE_BROWSER_MODE },
    location: { origin: 'https://hub.example.com' },
  })
  assert.notEqual(context, null)
  assert.equal(context.origin, 'https://hub.example.com')
})

test('the remote browser marker carries no credential', () => {
  const text = readFileSync(`${root}client/src/paths/context.ts`, 'utf8')
  // 标记只放模式字符串；令牌靠 HttpOnly Cookie，绝不能出现在页面全局里。
  assert.doesNotMatch(text, /__DSH_REMOTE_HUB__\s*[^:]*:\s*\{[^}]*token/u)
})
