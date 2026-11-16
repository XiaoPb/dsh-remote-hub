/**
 * 方案 A 的安全不变量（守卫托管浏览器）。
 *
 * 这些断言锁住「浏览器能进，但不该进的地方一律进不去」：
 *   1. `/api/*` 未认证必须 401（守卫在读 body 之前就拒）；
 *   2. 浏览器 principal 是 `remote-device`，不是 `owner`；
 *   3. Cookie 属性（HttpOnly / SameSite=Strict / 按协议加 Secure）；
 *   4. 远程标记不含任何凭据；
 *   5. 静态面不需要自启动令牌（走 readResource + peer）。
 *
 * 前三条由运行时行为保证，这里以源码断言的形式固化契约，
 * 配合实机脚本（verify-guard-exposure / verify-web-session-flow）使用。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

const read = relative => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')

const guard = read('host/src/guard.ts')
const guardWeb = read('host/src/guard-web.ts')
const plugin = read('host/src/plugin.ts')
const webSession = read('host/src/auth/web-session.ts')

test('浏览器数据面在认证之前不读取请求体', () => {
  const start = guard.indexOf("path === '/api' || path.startsWith('/api/')")
  assert.ok(start > 0, '必须存在 /api 分支')
  const branch = guard.slice(start, start + 2_400)
  const authAt = branch.indexOf('readSession')
  const bodyAt = branch.indexOf('readJsonBody')
  assert.ok(authAt > 0, '必须先解析会话')
  assert.ok(bodyAt > authAt, '认证必须早于读 body（未认证时一个字节都不转发）')
  assert.match(branch, /auth-unauthorized/, '未认证回 auth-unauthorized')
})

test('浏览器身份是 remote-device，不是 owner', () => {
  assert.match(guard, /peerFor\(`web:\$\{accountId\}`, role\)/, '按会话身份建 Peer')
  assert.doesNotMatch(guard, /kind:\s*'owner'/, '绝不能以 owner 身份派发')
  // policy 对 web: 前缀采信 principal 上的 role（该 role 来自会话校验）。
  const policy = read('host/src/policy.ts')
  assert.match(policy, /startsWith\('web:'\)/, 'policy 应识别浏览器身份')
})

test('会话 Cookie 的属性由 web-session 统一给出', () => {
  assert.match(webSession, /HttpOnly/, 'Cookie 必须 HttpOnly')
  assert.match(webSession, /SameSite=Strict/, 'Cookie 必须 SameSite=Strict')
  assert.match(webSession, /Secure/, 'https 时必须加 Secure')
  // 令牌不得出现在登录页 HTML 里。
  const pageFn = webSession.slice(webSession.indexOf('renderLoginPage'))
  assert.doesNotMatch(pageFn.slice(0, 4_000), /sessionToken|dsh_hub_session=/, '登录页不得内联令牌')
})

test('远程标记只带模式，不带凭据', () => {
  const markupAt = guardWeb.indexOf('REMOTE_BROWSER_MARKUP')
  const line = guardWeb.slice(markupAt, markupAt + 400)
  assert.match(line, /mode/, '标记必须带 mode')
  assert.doesNotMatch(line, /token|lease|secret|password/i, '标记不得携带任何凭据')
  // 必须合并而不是赋值：Host 也往同一全局写配对令牌与设备表。
  assert.match(guardWeb, /Object\.assign/, '必须合并写，不能覆盖 Host 的注入')
})

test('静态面走进程内 readResource + peer，不依赖自启动令牌', () => {
  assert.match(plugin, /buildHostIndexReader\(/, 'index 走进程内读取')
  assert.match(plugin, /readResource/, '使用官方 readResource')
  assert.match(plugin, /readHostAsset/, '静态资源同样走进程内读取')
  // 守卫侧只允许把令牌拼到**上游** URL 上（withHostToken），
  // 绝不能出现在写给浏览器的字节里：index 与资源都由进程内读取给出。
  // 令牌只可能出现在**上游** URL 上（withHostToken）；
  // 浏览器拿到的 index/资源全部来自进程内读取，响应里没有它。
  assert.match(guardWeb, /function withHostToken/, '令牌只用于上游请求')
  // 响应只写 content-type / cache-control / etag / content-length 四类头。
  assert.doesNotMatch(guardWeb, /'set-cookie':\s*deps\.hostToken/, '上游令牌不得回写给浏览器')
})
