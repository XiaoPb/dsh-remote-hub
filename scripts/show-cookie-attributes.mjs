/**
 * 打印守护进程实际下发的 Cookie 属性，用于核对文档里的安全声明。
 *
 * @module scripts/show-cookie-attributes
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

// 直接从产物里取构造逻辑，避免手写断言与实现脱节。
const script = `
import { createWebSession } from './lib/auth.js'
const mk = (origin) => createWebSession({ service: {}, sessionTtlMs: 6 * 3600 * 1000, guardOrigin: origin })
for (const origin of ['http://127.0.0.1:8443', 'https://dsh.example.com']) {
  const session = mk(origin)
  const cookie = session.buildSetCookie('token-value')
  console.log(origin)
  for (const part of cookie.split(';')) console.log('   ' + part.trim())
}
`

writeFileSync('.build/_cookie-probe.mjs', script, 'utf8')
const result = spawnSync(process.execPath, ['.build/_cookie-probe.mjs'], { encoding: 'utf8' })
process.stdout.write(result.stdout)
if (result.status !== 0) process.stderr.write(result.stderr)
