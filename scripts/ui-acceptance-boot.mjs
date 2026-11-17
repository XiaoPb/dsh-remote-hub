/**
 * 启动一个干净的 Edge（CDP）并打开测试沙箱的「登录与账号」页。
 *
 * 为什么用独立 user-data-dir：浏览器信任（私钥/租约）存在 IndexedDB 里，
 * 复用旧 profile 会让「未登录态」和「已受信态」互相污染，验收无法复现。
 *
 * 用法：`node scripts/ui-acceptance-boot.mjs`
 * 前置：沙箱已启动，且启动行 `dsh web: http://...?token=...` 已写进
 *       `dev/ui-acceptance/sandbox.log`。
 *
 * @module scripts/ui-acceptance-boot
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './_shared.mjs'
import { findPage, openPage, sleep } from './ui-acceptance-cdp.mjs'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const OUT = join(ROOT, 'dev', 'ui-acceptance')
const PROFILE = join(OUT, 'edge-profile')
const PORT = Number(process.env.CDP_PORT ?? 9333)

mkdirSync(OUT, { recursive: true })

/**
 * 从沙箱启动日志里读 `?token=`。
 * @returns {string} token。
 */
function readToken() {
  const log = readFileSync(join(OUT, 'sandbox.log'), 'utf8')
  const match = /token=([A-Za-z0-9_-]+)/u.exec(log)
  if (match === null) throw new Error('sandbox.log has no dsh web token line')
  return match[1]
}

/**
 * 关掉上一次启动的 Edge（按 pid 文件 + 命令行 profile 匹配双重保险），
 * 等 profile 目录真正可删（Edge 退出后仍会短暂持有 SQLite 句柄）。
 * @returns {Promise<void>}
 */
export async function stopBrowser() {
  const pidFile = join(OUT, 'edge.pid')
  const pids = new Set()
  try {
    for (const line of readFileSync(pidFile, 'utf8').split(/\s+/u)) {
      if (/^\d+$/u.test(line)) pids.add(Number(line))
    }
  } catch {
    // 没有 pid 文件
  }
  // 兜底：命令行里带我们 profile 路径的 msedge 进程。
  // ⚠️ CIM 的 `-like` 通配符里 `\\` 会被当成两个反斜杠，必须用 -match + 转义正则。
  try {
    const { execFileSync } = await import('node:child_process')
    const pattern = PROFILE.replaceAll('\\', '\\\\')
    const list = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -match '${pattern}' } | ForEach-Object { $_.ProcessId }`],
    { encoding: 'utf8', timeout: 30_000 })
    for (const line of list.split(/\s+/u)) if (/^\d+$/u.test(line)) pids.add(Number(line))
  } catch {
    // 忽略
  }
  // 再兜底：CDP 端口上的浏览器（避免残留实例继续开标签）
  if (pids.size === 0) {
    try {
      const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()
      const owner = /msedge\.exe[:/](\d+)/iu.exec(String(version['Browser'] ?? ''))
      if (owner !== null) pids.add(Number(owner[1]))
    } catch {
      // 端口没人监听
    }
  }
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ }
  }
  // 等 CDP 端口真的释放（否则新实例会拿到同一个端口的旧目标）
  const portFree = Date.now()
  while (Date.now() - portFree < 20_000) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) })
      await sleep(500)
    } catch {
      break
    }
  }
  if (pids.size > 0) await sleep(1500)
  // 等目录可删（最多 30s）
  const started = Date.now()
  while (Date.now() - started < 30_000) {
    try {
      rmSync(PROFILE, { recursive: true, force: true })
      return
    } catch {
      await sleep(600)
    }
  }
}

/**
 * 启动 Edge 并等 CDP 起来。
 * @param {string} url - 首个页面 URL。
 * @param {{fresh?: boolean}} [options] - `fresh:false` 复用已有 profile（保留登录态）。
 * @returns {Promise<{proc: import('node:child_process').ChildProcess, token: string}>}
 */
export async function launchBrowser(url, { fresh = true } = {}) {
  if (!existsSync(EDGE)) throw new Error(`Edge not found at ${EDGE}`)
  if (fresh) {
    await stopBrowser()
    mkdirSync(PROFILE, { recursive: true })
  }
  const flags = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msEdgeSidebarV2,msImplicitSignin',
    '--new-window',
    '--window-size=1280,1000',
    url,
  ]
  const proc = spawn(EDGE, flags, { detached: true, stdio: 'ignore' })
  proc.unref()

  const started = Date.now()
  while (Date.now() - started < 40_000) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (response.ok) return { proc, token: readToken() }
    } catch {
      // 还没起来
    }
    await sleep(400)
  }
  throw new Error('Edge CDP did not come up in 40s')
}

/**
 * 关掉除保留项以外的所有 page 目标，避免多标签互相干扰（只留一个干净页面）。
 * @param {string} keepId - 保留的目标 id（可为空：全部关掉，由调用方新开）。
 * @returns {Promise<number>} 关掉的数量。
 */
export async function closeExtraPages(keepId) {
  const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  const list = await response.json()
  let closed = 0
  for (const item of list) {
    if (item.type !== 'page' || item.id === keepId) continue
    try {
      await fetch(`http://127.0.0.1:${PORT}/json/close/${item.id}`)
      closed += 1
    } catch {
      // 忽略
    }
  }
  return closed
}

/**
 * 连上沙箱页面并等 DSH shell 就绪。
 *
 * ⚠️ 一个浏览器里可能同时有多个沙箱标签（每跑一次脚本就多一个），
 * 只挑「第一个」会连到 `about:blank` 残留标签 → 所有查询都返回空。
 * 这里**优先挑已经加载出 DSH shell 的那个**（标题为 DeepSeek Harness），
 * 其次挑带 token 的 URL；都没有才自己导航。
 * @param {string} [url] - 期望的页面 URL（缺省用当前的沙箱 token）。
 * @returns {Promise<object>} page 驱动。
 */
export async function attachFirstPage(url) {
  const targetUrl = url ?? `http://127.0.0.1:13091/?token=${readToken()}`
  const started = Date.now()
  let chosen
  while (Date.now() - started < 30_000) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const pages = list.filter(item => item.type === 'page')
    // 1) 已经渲染出 shell 的；2) 至少 URL 指向沙箱的；3) 别的
    chosen = pages.find(item => item.title === 'DeepSeek Harness' && item.url.startsWith('http://127.0.0.1:13091'))
      ?? pages.find(item => item.url.startsWith('http://127.0.0.1:13091/?token='))
      ?? pages.find(item => item.url.startsWith('http://127.0.0.1:13091'))
    if (chosen !== undefined && (chosen.title === 'DeepSeek Harness' || Date.now() - started > 20_000)) break
    if (chosen === undefined && pages.length > 0) { chosen = pages[0]; break }
    await sleep(500)
  }
  if (chosen === undefined) throw new Error('no page target available')
  const page = await openPage(chosen.webSocketDebuggerUrl)
  const href = await page.eval('location.href')
  if (!String(href).startsWith('http://127.0.0.1:13091')) await page.navigate(targetUrl)
  return page
}

if (import.meta.url === `file:///${process.argv[1]?.replaceAll('\\', '/')}`) {
  const token = readToken()
  const url = `http://127.0.0.1:13091/?token=${token}`
  const { proc } = await launchBrowser(url)
  writeFileSync(join(OUT, 'edge.pid'), String(proc.pid ?? ''), 'utf8')
  const page = await attachFirstPage()
  await page.waitFor('document.readyState === "complete"', { timeout: 30_000 })
  // 新建 profile → DSH 首启可能弹引导；记录标题/URL 供后续脚本判断。
  const info = await page.eval('({ url: location.href.split("?")[0], title: document.title, ready: document.readyState })')
  process.stdout.write(`${JSON.stringify(info)}\n`)
  page.close()
}
