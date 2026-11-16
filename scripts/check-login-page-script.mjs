/**
 * 语法自检：把登录页内联脚本抽出来，用 node 的真实解析器验证。
 *
 * 这一条能抓住「模板字符串把反斜杠吃掉」这类只在生成时暴露的错误——
 * 源码看起来完全正常，页面里的脚本却是坏的（真实故障：表单退回原生提交，
 * 用户看到裸 JSON）。
 *
 * @module scripts/check-login-page-script
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const lib = pathToFileURL('E:/Code/DSH/plugins/dsh-remote-hub/lib/auth.js').href
const mod = await import(lib)

const page = mod.createWebSession?.({
  service: {},
  sessionTtlMs: 60_000,
  guardOrigin: 'http://127.0.0.1:8443',
})?.page?.()

if (typeof page !== 'string') {
  console.log('无法直接构造页面，改为扫描产物里的模板字符串')
  process.exit(1)
}

const match = /<script>([\s\S]*?)<\/script>/u.exec(page)
if (match === null) {
  console.log('页面里没有内联脚本')
  process.exit(1)
}

writeFileSync('.build/login-script-check.js', `(function(){\n${match[1]}\n})`, 'utf8')
const result = spawnSync(process.execPath, ['--check', '.build/login-script-check.js'], { encoding: 'utf8' })
if (result.status === 0) {
  console.log('登录页脚本语法 OK')
  process.exit(0)
}
console.log('登录页脚本语法错误：')
console.log(result.stderr.split('\n').slice(0, 10).join('\n'))
process.exit(1)
