/**
 * 登录页**生成脚本**的语法自检。
 *
 * 为什么需要这条测试：`host/src/auth/web-session.ts` 里的登录页 JS 是以
 * 模板字符串拼出来的。只要里面出现反斜杠（哪怕在注释里），模板就会把它
 * 当转义吃掉，生成的脚本随即语法错误——而整段脚本不执行意味着
 * `preventDefault()` 也没跑，表单退回原生 POST，用户看到的是裸 JSON。
 *
 * 源码看起来完全正常，只有把**生成出来的文本**再解析一遍才能发现。
 * 这个 bug 真实发生过（用户报告「失败弹到 json 文件」）。
 *
 * @module test/login-page-syntax.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { existsSync } from 'node:fs'

const root = fileURLToPath(new URL('..', import.meta.url))
const libPath = join(root, 'lib', 'auth.js')
if (!existsSync(libPath)) throw new Error('先跑 npm run build（缺少 lib/auth.js）')

const mod = await import(pathToFileURL(libPath).href)

/**
 * 生成登录页 HTML。
 *
 * @returns {string} 页面 HTML。
 */
function renderPage() {
  const session = mod.createWebSession({
    service: {},
    sessionTtlMs: 60_000,
    guardOrigin: 'http://127.0.0.1:8443',
  })
  return session.renderLoginPage()
}

test('生成的内联脚本语法合法', () => {
  const html = renderPage()
  const match = /<script>([\s\S]*?)<\/script>/u.exec(html)
  assert.ok(match !== null, '登录页必须有内联脚本')

  const dir = join(root, '.build')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'login-page-syntax-check.js')
  writeFileSync(file, `(function(){\n${match[1]}\n})`, 'utf8')

  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  assert.equal(
    result.status,
    0,
    `生成的登录页脚本语法错误（模板字符串吃掉了反斜杠？）:\n${result.stderr.split('\n').slice(0, 8).join('\n')}`,
  )
})

test('open-redirect 守卫不依赖模板里的反斜杠转义', () => {
  const html = renderPage()
  // 反斜杠在生成脚本里只可能来自 charCodeAt 判定；字面量 `'\'` 一定是坏的。
  assert.ok(!html.includes("'\\'"), '不能出现未闭合的单反斜杠字面量')
  // 真实故障特征：被吃剩的字符类残骸。
  assert.ok(!html.includes('[/\\]'), '正则字符类里的反斜杠丢了')
})

test('登录成功后有跳转逻辑', () => {
  const html = renderPage()
  assert.ok(html.includes('location.replace(safe)'), '登录后必须离开登录页')
  assert.ok(html.includes('charCodeAt(0) === 92'), '用 charCodeAt 判反斜杠（92）')
})
