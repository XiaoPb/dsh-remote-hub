/**
 * 生成 `docs/API-MATRIX.md`：全部相关接口 × 角色权限分布表。
 *
 * 为什么用脚本生成而不是手写：权限矩阵是安全契约，手写表格必然漂移。
 * 这里**只从构建产物 `lib/index.js` 读真值**（`ENDPOINT_TABLE` / `ROLE_MATRIX` /
 * `isNeverDelegated()` / `SHARED_READ_ENDPOINTS` / `FULL_ADMIN_ENDPOINTS`），
 * 因此文档里不会出现任何「文案上说得通、代码里不成立」的条目。
 *
 * 用法：
 *   node scripts/render-api-matrix.mjs           # 写入 docs/API-MATRIX.md
 *   node scripts/render-api-matrix.mjs --check   # 只比对，不一致则退出 1（CI 门禁）
 *
 * @module scripts/render-api-matrix
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs', 'API-MATRIX.md')
const CHECK = process.argv.includes('--check')

const root = join(ROOT, 'lib', 'index.js')
let mod
try {
  mod = await import(`file:///${root.replace(/\\/gu, '/')}`)
} catch (error) {
  process.stdout.write(`run pnpm build first\n`)
  process.stderr.write(`${String(error)}\n`)
  process.exit(1)
}

const ROLES = ['read-only', 'control', 'full']
const ROLE_ZH = { 'read-only': '只读', 'control': '控制', full: '完全' }
const matrix = role => new Set(mod.allActionsFor(role))

const allow = {
  'read-only': matrix('read-only'),
  control: matrix('control'),
  full: matrix('full'),
}
const sharedRead = new Set(mod.SHARED_READ_ENDPOINTS)
const fullAdmin = new Set(mod.FULL_ADMIN_ENDPOINTS)

/** `✓` / `—` 单元格。 */
const cell = (role, endpoint) => (allow[role].has(endpoint) ? '✓' : '—')

/**
 * 给一个 endpoint 归类，用于「判定依据」列。
 * @param {string} endpoint - 官方 endpoint。
 * @returns {string} 归类标签。
 */
function classify(endpoint) {
  if (mod.isNeverDelegated(endpoint)) {
    const namespace = `${endpoint.slice(0, endpoint.lastIndexOf('/') + 1)}`
    if (mod.NEVER_DELEGATED_ENDPOINTS.includes(endpoint)) return '红线（逐条枚举）'
    if (mod.NEVER_DELEGATED_INTERNALS.includes(endpoint)) return '红线（Gateway 内部面）'
    if ((mod.NEVER_DELEGATED_BLANKET ?? []).includes(namespace)) return `红线（整组禁用 \`${namespace}*\`）`
    return `红线（前缀 \`${namespace}*\`）`
  }
  if (sharedRead.has(endpoint)) return '共享只读目录'
  if (fullAdmin.has(endpoint)) return 'Full 专属管理面'
  if (allow['read-only'].has(endpoint)) return '只读业务'
  if (allow.control.has(endpoint)) return '会话驱动'
  if (allow.full.has(endpoint)) return '文件/终端'
  return '未授予任何角色'
}

/** 官方 endpoint 的事实（资源种类 / 是否 stream / 是否 hub 自有）。 */
const fact = endpoint => mod.ENDPOINT_TABLE[endpoint] ?? {}

/**
 * 渲染一张按资源种类分组的表。
 * @param {string[]} endpoints - 本组的 endpoint 列表。
 * @param {'global'|'session'|'workspace'} kind - 资源种类。
 * @returns {string} Markdown 片段。
 */
function renderGroup(endpoints, kind) {
  const lines = [
    '| endpoint | 资源 | 形式 | 只读 | 控制 | 完全 | 判定依据 |',
    '| --- | --- | --- | :---: | :---: | :---: | --- |',
  ]
  for (const endpoint of endpoints) {
    const info = fact(endpoint)
    const form = info.stream === true ? 'stream' : (info.hub === true ? 'hub 自有' : '一元')
    lines.push(
      `| \`${endpoint}\` | ${kind} | ${form} | ${cell('read-only', endpoint)} | ${cell('control', endpoint)} | ${cell('full', endpoint)} | ${classify(endpoint)} |`,
    )
  }
  return `${lines.join('\n')}\n`
}

const allEndpoints = Object.keys(mod.ENDPOINT_TABLE).sort()
const inMatrix = new Set([...allow['read-only'], ...allow.control, ...allow.full])
const granted = allEndpoints.filter(e => inMatrix.has(e))
const notGranted = allEndpoints.filter(e => !inMatrix.has(e))

const byKind = kind => granted.filter(e => fact(e).kind === kind)

// 红线中『虽然不在 ENDPOINT_TABLE，但仍在红线清单里』的条目（例如 account/* 的未登记方法）。
const explicitRedlines = [
  'settings/openSettingsDocument',
  'directoryPicker/pick',
  'account/getState', 'account/getProfile', 'account/getBalance',
  'remoteAccess/follow',
  'credentials/rotate', 'credentials/reveal', 'settings/import', 'directoryPicker/pickDirectory',
]

/**
 * 每条红线为什么拒绝。
 * @param {string} endpoint - endpoint。
 * @returns {string} 原因。
 */
function redlineReason(endpoint) {
  if (endpoint === 'settings/openSettingsDocument') return '在宿主打开设置文档 = 操控宿主 UI'
  if (endpoint.startsWith('directoryPicker/')) return '宿主桌面原生对话框/目录面'
  if (endpoint.startsWith('pluginInventory/')) return '已装插件清单暴露攻击面'
  // 前缀红线 + 具名豁免：未登记的方法一律拒绝（credentials/ 、settings/ 都适用）
  if (endpoint.startsWith('credentials/') || endpoint.startsWith('settings/')) {
    return '未登记的 credentials / settings 方法，前缀红线默认拒绝'
  }
  if (endpoint.startsWith('account/')) return '账号凭据与登录态（官方登录态不可控）'
  return '官方恒放行，下放等于送出能力清单'
}

const countFor = role => allow[role].size

const doc = `# 接口权限分布（角色 × endpoint）

> **⚠️ 安全声明**：\`full\` 配对 = 远程代码执行 + 可写宿主配置与 API Key；0.3.1 起这些写入
> **直接生效、不再有 owner 审批**。只给完全可信设备发放 \`full\`，其余用 \`control\`。
> 详见仓库根目录 \`README.md\` 的「安全声明」与 \`docs/DEPLOY.md\` §0.0。
>
> 本文件由 \`scripts/render-api-matrix.mjs\` **从构建产物自动生成**，请勿手改。
> 修改权限后执行 \`node scripts/render-api-matrix.mjs\` 重新生成；CI 用
> \`--check\` 模式断言文档与代码完全一致。

真源是 \`core/src/capabilities.ts\` 的 \`ROLE_MATRIX\` 与
\`core/src/capabilities-redlines.ts\` 的 \`isNeverDelegated()\`。host 的
\`remoteAccess.registerPolicy('remote-device', …)\` 与 client 的 UI 门控读的是
**同一份表**，所以 UI 不会显示一个后端必然拒绝的入口。

## 0. 角色语义

| 角色 | 中文 | 能做什么 | 不能做什么 | 授权数量 |
| --- | --- | --- | --- | ---: |
| \`read-only\` | 只读 | 看列表、历史、状态、文件内容、任务面板、只读目录 | 任何写入、执行、上传 | ${countFor('read-only')} |
| \`control\` | 控制 | 只读 + 驱动会话（prompt / cancel / create / fork / rename / 队列）、审批与提问 | 碰文件系统与终端 | ${countFor('control')} |
| \`full\` | 完全 | 控制 + 上传文件、工作区文件读写、终端、\`job/kill\` | **不等于 DSH owner**：凭据、账号、插件安装、动态执行仍然全部拒绝 | ${countFor('full')} |

**未知 endpoint 一律拒绝（fail-closed）**。三档角色严格包含：\`read-only ⊆ control ⊆ full\`。

## 1. 判定依据图例

| 标签 | 含义 |
| --- | --- |
| 共享只读目录 | \`SHARED_READ_ENDPOINTS\`：所有角色都有的只读元数据/目录 |
| 只读业务 | 只读角色矩阵里的会话/工作区/文件只读方法 |
| 会话驱动 | \`control\` 起才有的写动作（驱动会话、审批） |
| 文件/终端 | \`full\` 起才有的文件上传与终端动作 |
| Full 专属管理面 | \`FULL_ADMIN_ENDPOINTS\`：仅 \`full\` 有的管理写动作（插件安装等） |
| 红线（逐条枚举） | \`NEVER_DELEGATED_ENDPOINTS\`：逐条点名，**所有角色**拒绝 |
| 红线（整组禁用） | \`NEVER_DELEGATED_BLANKET\`：整条 namespace 关闭，无豁免 |
| 红线（前缀） | \`NEVER_DELEGATED_NAMESPACES\`：整条关闭，但共享只读目录可豁免 |
| 红线（Gateway 内部面） | \`$events\` / \`$events/result\`，非 owner 由 \`interactions:'none'\` 挡住 |

## 2. 已授权接口（${granted.length} 个）

按资源种类分组。资源种类决定 binding 挂法：没有参数指明资源时是 \`global\`，
由 \`sessionId\` / \`workspaceFileScopeId\` / \`agentId\` 解析出来的是 \`session\`。

### 2.1 global 资源（${byKind('global').length} 个）

${renderGroup(byKind('global'), 'global')}
### 2.2 session 资源（${byKind('session').length} 个）

${renderGroup(byKind('session'), 'session')}
### 2.3 workspace 资源（${byKind('workspace').length} 个）

${renderGroup(byKind('workspace'), 'workspace')}
## 3. 红线接口（所有角色均拒绝）

下面 ${explicitRedlines.length} 条是 DESIGN §8.6.5 点名的红线，**\`full\` 也拿不到**。
\`scripts/redlines.mjs\` 每次 CI 都逐条断言「红线成立 且 不在 full 矩阵里」。

| endpoint | 拒绝原因 | 只读 | 控制 | 完全 |
| --- | --- | :---: | :---: | :---: |
${explicitRedlines.map(endpoint =>
  `| \`${endpoint}\` | ${redlineReason(endpoint)} | ${cell('read-only', endpoint)} | ${cell('control', endpoint)} | ${cell('full', endpoint)} |`).join('\n')}

整组禁用的 namespace（无豁免）：${(mod.NEVER_DELEGATED_BLANKET ?? []).map(p => `\`${p}*\``).join('、')}。

## 3.1 需要 owner 逐次审批的接口（0.3.1 起已取消）

${(mod.APPROVAL_REQUIRED_ENDPOINTS ?? []).length === 0
  ? `**当前没有任何接口需要 owner 逐次审批。** 只要配对角色是 \`full\`，
写配置、写 API Key、安装/卸载/启停插件都会**直接生效**。

> 安全代价：\`full\` 配对 = 远程代码执行 + 可写宿主配置与凭据。只给可信设备发放 \`full\`；
> 不确定时用 \`control\`（只读 + 驱动会话）。
>
> 审计与**密钥掩码**仍然生效：写入类 endpoint 的载荷在落审计/诊断前经过 \`core/src/redact.ts\`，
> 明文密钥不会出现在日志里。审批机制本身保留在 \`host/src/sensitive-approval.ts\`，
> 需要恢复时只需往 \`APPROVAL_REQUIRED_ENDPOINTS\` 加回条目。`
  : `| endpoint | 审批 | 密钥掩码 |
| --- | :---: | :---: |
${mod.APPROVAL_REQUIRED_ENDPOINTS.map(endpoint =>
    `| \`${endpoint}\` | 必须 | ${(mod.SECRET_BEARING_ENDPOINTS ?? []).includes(endpoint) ? '是' : '—'} |`).join('\n')}`}

## 4. 未授予任何角色的 endpoint（${notGranted.length} 个）

这些方法登记在网络可见的 endpoint 表里（用于对账与未来的窄化设计），但任何角色都无法调用：

| endpoint | 资源 | 形式 | 归类 |
| --- | --- | --- | --- |
${notGranted.map(endpoint => {
  const info = fact(endpoint)
  return `| \`${endpoint}\` | ${info.kind ?? '-'} | ${info.stream === true ? 'stream' : (info.hub === true ? 'hub 自有' : '一元')} | ${classify(endpoint)} |`
}).join('\n')}

## 5. 边界说明

- **\`full\` 不是 owner**：插件生命周期、动态 Cordis 执行、任意设置、凭据管理、账号操作
  需要单独评审的 API 和/或 Host 审批，不在任何配对角色的矩阵里。
- **红线清单本身就是断言**：\`assertMatrixIntegrity()\` 在插件**加载期**跑，
  矩阵里只要混进一条红线，插件直接加载失败——不会等到某台设备在实机上 403。
- **前缀红线的副作用**：\`pluginManager/*\` / \`pluginMarket/*\` 是整条关闭的，
  新增的官方只读方法必须显式加入 \`SHARED_READ_ENDPOINTS\` 才会开放。
- **资源过滤**：矩阵只回答「这个角色能不能调这个方法」，具体到哪条会话/工作区，
  仍由 Gateway 的 resource binding 与可见资源跟踪共同限定。
`

if (CHECK) {
  let current = ''
  try {
    current = readFileSync(OUT, 'utf8')
  } catch {
    current = ''
  }
  if (current !== doc) {
    process.stderr.write('docs/API-MATRIX.md is out of date: run `node scripts/render-api-matrix.mjs`\n')
    process.exit(1)
  }
  process.stdout.write(`docs/API-MATRIX.md is up to date (${granted.length} granted, ${notGranted.length} not granted)\n`)
} else {
  writeFileSync(OUT, doc, 'utf8')
  process.stdout.write(`wrote docs/API-MATRIX.md (${granted.length} granted, ${notGranted.length} not granted)\n`)
}
