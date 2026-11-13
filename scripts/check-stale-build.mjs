/**
 * 核对「磁盘上的构建」是否比「正在运行的 DSH 进程」更新。
 *
 * 为什么需要：DSH 在进程启动时把 `lib/client.js`（client 半边）与 `lib/index.js`
 * （host 半边）读进内存。构建发生在这之后时，磁盘变新但**运行中的进程仍是旧代码**，
 * 页面表现为「改了没生效」，极易误判为代码 bug（2026-11-12 实锤：
 * 进程 00:15 启动、构建 00:41 完成，页面一直显示旧文案与旧 TTL）。
 *
 * 用法：
 *   node scripts/check-stale-build.mjs
 *
 * 退出码：
 *   0  构建与运行进程一致（或没有运行中的进程）
 *   1  检测到陈旧构建：需要重启 DSH
 *
 * @module dsh-remote-hub/scripts/check-stale-build
 */
import { readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** 读取 bundle 修改时间（毫秒）。 */
function bundleMtime(name) {
  try {
    return statSync(join(root, 'lib', name)).mtimeMs
  } catch {
    return undefined
  }
}

/** 枚举正在运行的 DSH 进程及其启动时间（Windows）。 */
function runningDsh() {
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-Command',
      "Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | " +
      'Sort-Object StartTime | Select-Object -First 1 -ExpandProperty StartTime | ' +
      'ForEach-Object { $_.ToString("o") }',
    ], { encoding: 'utf8', timeout: 20_000 }).trim()
    return out === '' ? undefined : Date.parse(out)
  } catch {
    return undefined
  }
}

const newest = Math.max(bundleMtime('client.js') ?? 0, bundleMtime('index.js') ?? 0)
const started = runningDsh()

if (newest === 0) {
  console.error('✗ lib/*.js 不存在：先运行 npm run build')
  process.exit(1)
}

if (started === undefined) {
  console.log('· 未检测到运行中的 DSH 进程，构建可直接生效')
  process.exit(0)
}

if (newest > started) {
  const lagMinutes = ((newest - started) / 60_000).toFixed(1)
  console.error(
    '✗ 检测到陈旧构建：磁盘上的 bundle 比正在运行的 DSH 进程新 '
    + `${lagMinutes} 分钟。\n`
    + `  bundle mtime : ${new Date(newest).toISOString()}\n`
    + `  process start: ${new Date(started).toISOString()}\n`
    + '  → 请**完全退出并重新打开 DSH**（刷新页面无效：进程在启动时已把 bundle 读进内存）。',
  )
  process.exit(1)
}

console.log(`✓ 构建与运行进程一致（bundle ${new Date(newest).toISOString()} ≤ 进程启动 ${new Date(started).toISOString()}）`)
