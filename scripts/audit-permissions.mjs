/**
 * 权限覆盖率审计：把**官方 Typert 注册表里的每一个 endpoint** 与能力矩阵对账。
 *
 * 为什么需要它：能力矩阵是一张手工维护的 allow-list。漏登记一个 endpoint 不会报错，
 * 只会在远端调用时被 `decide()` 以 `no-allow` 拒绝 —— 用户看到的是「未授权」弹窗，
 * 而我们直到有人撞见才知道。本脚本把这种遗漏变成 **CI 里的一条断言**。
 *
 * 对账口径（每个官方 endpoint 归入且只归入一类）：
 *   - `granted:<role...>` —— 至少被一个角色授予（ro / ctl / full）；
 *   - `redline`           —— 命中 `isNeverDelegated()`（有意不开放）；
 *   - `unregistered`      —— 既没授权也没进红线，**这类就是潜在漏洞**，除非在
 *                            {@link INTENTIONAL_GAPS} 里逐条登记了理由。
 *
 * 用法：
 *   node scripts/audit-permissions.mjs            # 人类可读报告
 *   node scripts/audit-permissions.mjs --check    # CI 模式：有未登记遗漏则退出 1
 *   node scripts/audit-permissions.mjs --json     # 机器可读
 *
 * @module scripts/audit-permissions
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve2(dirname(fileURLToPath(import.meta.url)), '..')
const CHECK = process.argv.includes('--check')
const JSON_OUT = process.argv.includes('--json')

/** `..` 的简写，避免依赖 `path.resolve` 的字符串拼接语义差异。 */
function resolve2(base, rel) {
  return join(base, rel).replace(/[\\/]+$/u, '')
}

/**
 * **有意不开放**的官方 endpoint：每条都必须写清楚为什么。
 *
 * 这里的判定是：如果某个 endpoint 既不在任何角色矩阵、又不在红线、也不在这张表里，
 * CI 直接失败 —— 逼着我们显式决定，而不是让它悄悄落在无人区。
 *
 * @type {Readonly<Record<string, string>>}
 */
const INTENTIONAL_GAPS = Object.freeze({
  // ── Gateway / 宿主内部面：远端设备永远不该直接调 ──────────────────────────
  'toolResults/*': '工具结果回传通道，Gateway 内部使用',
  'productAnalytics/*': '宿主产品遥测上报，非远端功能',
  'pluginRegistryProbe/*': '插件注册表探测（宿主 proxy-manager 内部，会访问外网）',

  // ── 依赖宿主桌面/账号态，且没有云端等价物 ────────────────────────────────
  'session/openWorkspacePath': '会在宿主桌面打开路径 = 操控宿主 UI，与 directoryPicker/pick 同类',
  'session/initializeDefaultModel': '登录后挑默认模型，属于账号登录流程（account/* 本身是红线）',

  // ── 故意不开放：降级路径 ─────────────────────────────────────────────────
  'session/page': '官方已 @deprecated（接任者是 session/events），任何角色都不授予',

  // ── 尚未评审 / 依赖宿主能力，暂不开放（放开前需要单独设计） ─────────────
  'officeToPdf/render': 'Office 转 PDF：需要在宿主读 Office 文件并起渲染进程，尚未评审',
  'officeToPdf/generation': 'Office 转 PDF 的缓存世代探测，随 render 一起',
  'sessionFeedback/record': '会话质量反馈写回，属于宿主侧产品的反馈闭环，尚未评审',
})

// ── 1. 官方注册表 ────────────────────────────────────────────────────────
const registryFile = join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-api-remotes', 'lib', 'client.js')
const registrySource = readFileSync(registryFile, 'utf8')
const official = [...new Set(
  [...registrySource.matchAll(/"([a-zA-Z][A-Za-z0-9_]*)\/([A-Za-z0-9_.]+)":\s*\{\s*\n?\s*service/gu)]
    .map(match => `${match[1]}/${match[2]}`),
)].sort()

if (official.length === 0) {
  process.stderr.write(`could not read any endpoint from ${registryFile}\n`)
  process.exit(2)
}

// ── 2. 构建产物里的能力矩阵 ──────────────────────────────────────────────
const mod = await import(`file:///${join(ROOT, 'lib', 'index.js').replace(/\\/gu, '/')}`)
const ROLES = ['read-only', 'control', 'full']
const grantedBy = new Map()
for (const role of ROLES) {
  for (const endpoint of mod.allActionsFor(role)) {
    const set = grantedBy.get(endpoint) ?? new Set()
    set.add(role)
    grantedBy.set(endpoint, set)
  }
}

/** 某 endpoint 是否命中「有意不开放」清单（支持 `ns/*` 通配）。 */
function intentionalGap(endpoint) {
  if (INTENTIONAL_GAPS[endpoint] !== undefined) return INTENTIONAL_GAPS[endpoint]
  const wildcard = `${endpoint.slice(0, endpoint.indexOf('/'))}/*`
  return INTENTIONAL_GAPS[wildcard]
}

// ── 3. 分类 ──────────────────────────────────────────────────────────────
const rows = official.map(endpoint => {
  const roles = [...(grantedBy.get(endpoint) ?? [])]
  const redline = mod.isNeverDelegated(endpoint)
  const gap = intentionalGap(endpoint)
  let category
  if (roles.length > 0) category = 'granted'
  else if (redline) category = 'redline'
  else if (gap !== undefined) category = 'gap'
  else category = 'unregistered'
  return { endpoint, roles, redline, gap: gap ?? null, category }
})

const granted = rows.filter(row => row.category === 'granted')
const redlines = rows.filter(row => row.category === 'redline')
const gaps = rows.filter(row => row.category === 'gap')
const unregistered = rows.filter(row => row.category === 'unregistered')

// 矩阵里有、官方注册表里没有的条目（说明我们登记了不存在的 endpoint）。
// 排除本插件自有的 hub/* 面：它们由 Remote Hub 自己注册，不在官方注册表里。
const matrixOnly = [...grantedBy.keys()]
  .filter(endpoint => !official.includes(endpoint) && !endpoint.startsWith('hub/'))
  .sort()

// ── 4. 输出 ──────────────────────────────────────────────────────────────
if (JSON_OUT) {
  process.stdout.write(`${JSON.stringify({
    officialCount: official.length,
    granted: granted.map(row => ({ endpoint: row.endpoint, roles: row.roles })),
    redline: redlines.map(row => row.endpoint),
    intentionalGap: gaps.map(row => ({ endpoint: row.endpoint, reason: row.gap })),
    unregistered: unregistered.map(row => row.endpoint),
    matrixOnly,
  }, null, 2)}\n`)
} else {
  process.stdout.write(`官方注册 endpoint：${official.length}\n`)
  process.stdout.write(`  已授权        ${String(granted.length).padStart(3)}\n`)
  process.stdout.write(`  红线（有意）  ${String(redlines.length).padStart(3)}\n`)
  process.stdout.write(`  未实现（登记）${String(gaps.length).padStart(3)}\n`)
  process.stdout.write(`  未登记遗漏    ${String(unregistered.length).padStart(3)}\n`)
  process.stdout.write(`  矩阵多余条目  ${String(matrixOnly.length).padStart(3)}\n\n`)

  if (unregistered.length > 0) {
    process.stdout.write('!! 未登记遗漏（既未授权、也非红线、也无理由）：\n')
    for (const row of unregistered) process.stdout.write(`   - ${row.endpoint}\n`)
    process.stdout.write('\n')
  }
  if (matrixOnly.length > 0) {
    process.stdout.write('!! 矩阵里有、官方注册表没有（可能是拼写错误或已废弃）：\n')
    for (const endpoint of matrixOnly) process.stdout.write(`   - ${endpoint}\n`)
    process.stdout.write('\n')
  }
  const byNamespace = new Map()
  for (const row of rows) {
    const namespace = row.endpoint.slice(0, row.endpoint.indexOf('/'))
    const bucket = byNamespace.get(namespace) ?? { granted: 0, redline: 0, gap: 0, unregistered: 0 }
    bucket[row.category] += 1
    byNamespace.set(namespace, bucket)
  }
  process.stdout.write('按 namespace：\n')
  for (const [namespace, bucket] of [...byNamespace].sort(([a], [b]) => a.localeCompare(b))) {
    process.stdout.write(`  ${namespace.padEnd(24)} granted=${String(bucket.granted).padStart(2)} redline=${String(bucket.redline).padStart(2)} gap=${String(bucket.gap).padStart(2)} 遗漏=${bucket.unregistered}\n`)
  }
}

// ── 5. CI 断言 ───────────────────────────────────────────────────────────
if (CHECK) {
  const failures = []
  if (unregistered.length > 0) failures.push(`${unregistered.length} endpoint(s) unregistered: ${unregistered.map(row => row.endpoint).join(', ')}`)
  if (matrixOnly.length > 0) failures.push(`matrix names endpoints absent from the official registry: ${matrixOnly.join(', ')}`)
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`assertion failed: ${failure}\n`)
    process.stderr.write('每个官方 endpoint 必须显式归类：授予某个角色、进红线，或在 INTENTIONAL_GAPS 里写明理由。\n')
    process.exit(1)
  }
  process.stdout.write(`\npermission audit: ok（${official.length} 个官方 endpoint 全部显式归类）\n`)
}

// 安静地标记用到但未使用的导入（保持 lint 友好）。
void readdirSync
