/**
 * 首次登录前巡检：确认默认管理员**还没落库**。
 *
 * 期望：`auth.db` 里 0 个账号、0 个会话；`pending-admin.json` 与 `initial-password`
 * 存在且口令一致（明文只在这里）。
 *
 * 用法：`node scripts/inspect-pre-login.mjs [hubDir]`
 *
 * @module scripts/inspect-pre-login
 */
import { existsSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const dir = process.argv[2]
  ?? 'E:\\dsh-box-data\\dsh-box-files\\data\\sandboxes\\testhub\\home\\remote-hub'

const report = { dir, accounts: 0, sessions: 0, pendingFile: false, initialFile: false, plaintextMatches: null }

if (existsSync(`${dir}\\auth.db`)) {
  const db = new DatabaseSync(`${dir}\\auth.db`)
  try {
    report.accounts = db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n
    report.sessions = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n
  } finally {
    db.close()
  }
}

const pendingPath = `${dir}\\pending-admin.json`
const initialPath = `${dir}\\initial-password`
report.pendingFile = existsSync(pendingPath)
report.initialFile = existsSync(initialPath)
if (report.pendingFile && report.initialFile) {
  const pending = JSON.parse(readFileSync(pendingPath, 'utf8'))
  const initial = readFileSync(initialPath, 'utf8').trim()
  report.username = pending.username
  report.plaintextMatches = initial === pending.password
}

console.log(JSON.stringify(report, null, 2))
if (report.accounts !== 0) process.exitCode = 1
