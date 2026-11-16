/**
 * 查一个已登记客户端的实际角色上限（enroll 后到底写进去了什么）。
 *
 * @module scripts/inspect-client-role
 */
import { DatabaseSync } from 'node:sqlite'

const dir = process.argv[2]
  ?? 'E:\\dsh-box-data\\dsh-box-files\\data\\sandboxes\\testhub\\home\\remote-hub'
const db = new DatabaseSync(`${dir}\\auth.db`)
try {
  const clients = db.prepare('SELECT client_id, label, role_ceiling, active_role, revoked_at FROM clients').all()
  console.log(JSON.stringify(clients, null, 2))
} catch (error) {
  console.log('query failed:', String(error).slice(0, 200))
} finally {
  db.close()
}
