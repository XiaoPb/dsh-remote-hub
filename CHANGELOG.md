# 更新日志

本文件记录 `@xiaopb/dsh-remote-hub` 与伴生包 `@xiaopb/dsh-remote-paths` 的公开变更。
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)；`0.x` 期间的次版本号可能包含不兼容变更。

## [0.3.4] - 2026-11-14

**修复局域网配对 403 错误：私有地址 Origin 现在自动放行。**

### 问题

局域网模式（`network: 'lan'`）下，主控端浏览器（如 `http://127.0.0.1:13091`）向被控端守卫
（如 `http://192.168.0.17:8443`）发起跨域配对请求时，`Origin` 头是私有地址但与 `Host` 不同源，
被 fence 的第三段（Origin 检查）拦截为 403 "Origin does not match Host authority"。

之前需要在被控端手动配置 `allowedOrigins` 白名单才能通过，但这要求用户预先知道所有可能的端口。

### 修复

- **`allowPrivateOrigin`**：`checkSource()` 新增选项，当值为 `true` 且 Origin 是私有地址
  （RFC 1918 / 链路本地 / ULA）时，即使与 Host 不同源也放行。
- **自动启用**：`network === 'lan'` 时，`guard.ts` 自动传入 `allowPrivateOrigin: true`，
  无需手动配置。
- 公网 Origin 仍然拒绝（`isPrivateHostname()` 对公网地址返回 `false`）。
- **移除 `allowedOrigins` workaround**：之前的手动白名单配置不再需要。

### 测试

- `test/fence.test.mjs` 新增专项测试，覆盖 `127.0.0.1`、`localhost`、`10.x`、`172.16-31.x`、
  `192.168.x` 等私有地址 Origin。
- 端到端验证：testhub（`127.0.0.1:13091`）成功配对到 Debian（`192.168.0.17:8443`），
  无需 `allowedOrigins` 配置。

## [0.3.2] - 2026-11-13

**权限全面复核：补上 19 个漏登记的官方 endpoint，并把「漏登记」变成 CI 断言。**

### 修复

- `llm/discoverModels` 补进能力矩阵（三档共享只读）。它是官方**只读**远端适配器，
  按 `settingsNs` 让目标主机去问 Provider 有哪些模型；此前不在矩阵也不在 endpoint 表，
  远端「发现模型」被 `decide()` 以 `no-allow` 拒绝，界面弹出「远端权限不足」。
- 按官方注册表复核后补齐另外 18 个此前**未登记**的 endpoint：

  | 角色 | 补齐的 endpoint |
  | --- | --- |
  | 三档只读 | `agentPresets/read`、`commands/execute`、`schedule/view`、`schedule/deliveryLimits`、`session/canOpenWorkspacePath`、`skills/list`(global)、`messageFeedback/list` |
  | control 起 | `agentPresets/select`、`schedule/{create,edit,run}`、`messageFeedback/put`、`subagents/{prompt,interruptByParent}` |
  | full 起 | `schedule/deleteInactive`、`messageFeedback/delete` |

### 新增门禁

- `scripts/audit-permissions.mjs`：把**官方 Typert 注册表里的全部 150 个 endpoint**
  与能力矩阵逐条对账。每个 endpoint 必须显式归入「已授权 / 红线 / 未实现（写明理由）」
  之一，否则 CI 失败。脚本同时检测「矩阵里登记了官方不存在的 endpoint」。
  已接入 `ci.yml` 与 `release.yml`，本地可用 `npm run audit:permissions`。
- 当前状态：已授权 120、红线 25、未实现 5（`officeToPdf/*`、`sessionFeedback/record`
  等，均写明理由）、未登记遗漏 **0**。

### 说明

- 未实现的 5 类在 `scripts/audit-permissions.mjs` 的 `INTENTIONAL_GAPS` 里逐条写明原因，
  不是「忘记」，而是「尚未评审」——放开前需要单独设计。
- `docs/API-MATRIX.md` 随矩阵重新生成。
## [0.3.1] - 2026-11-13

**插件权限：`full` 完全放开、不再审批；其他角色也能完整读取插件。**

### 变更（不兼容 / 安全边界调整）

- **取消 owner 逐次审批**：`APPROVAL_REQUIRED_ENDPOINTS` 清空。
  以下 13 个接口现在只要配对角色是 `full` 就**直接生效**，不再弹批准卡，也不再有超时拒绝：
  - 插件：`pluginManager/{installBundle,updateBundle,removeBundle,cancelInstall,setBundleEnabled,setPluginEnabled,setVersionExemption}`、`pluginMarket/setIndexes`
  - 配置与凭据：`settings/{update,replace,mutate}`、`credentials/{set,unset}`

  > **安全代价（务必知晓）**：`full` 配对 = 远程代码执行 + 可写宿主配置与 API Key。
  > 只给可信设备发放 `full`；不确定时用 `control`。
- **插件清单改为三档共享只读**：`pluginInventory/list` 从红线移入 `SHARED_READ_ENDPOINTS`，
  `read-only` / `control` / `full` 都能读取已装插件清单；`pluginInventory/` 改为「前缀红线 + 具名豁免」，
  未登记方法仍默认拒绝。

### 保持不变

- **密钥掩码与审计照旧**：写入类 endpoint 的载荷在落审计/诊断前仍经过 `core/src/redact.ts`，
  明文 API Key 不会出现在日志里。审批机制代码保留在 `host/src/sensitive-approval.ts`，
  需要恢复时往 `APPROVAL_REQUIRED_ENDPOINTS` 加回条目即可。
- `account/*`（官方登录态）、`dynamicCordisRunner/*`、`directoryPicker/pick`、
  `settings/openSettingsDocument`、`remoteAccess/follow` 仍是红线。
## [0.3.0] - 2026-11-13

**云端路径 UI 内置进本插件；`full` 开放云端目录浏览与新建目录。**

### 变更（不兼容）

- **`@xiaopb/dsh-remote-paths` 不再作为独立包发布**。云端目录浏览 / 新建目录 / 「云端文件」菜单
  已内置到 `@xiaopb/dsh-remote-hub`，只需安装这一个包。
  - 源码移到 `client/src/paths/`，随主 `lib/client.js` 一起编译；
  - 由 `client/src/index.ts → applyCloudPaths()` 在主插件装配时注册，等
    `slots` / `commandUi` / `sessions` / `conversation` 就绪后生效；
  - 仓库不再有 `companions/` workspace，`pnpm-workspace.yaml` 只保留根包。
- **为什么不能做成同一包的第二条 roster**：DSH 的 `dsh.client` 声明按**包**生效
  （`resolveMeta` 只认包名根 specifier，且固定读 `exports["./client"]`），
  子路径 roster 的 specifier 会被 `exactPackageSpecifier()` 判为 undefined，
  客户端 bundle 根本不会被加载。因此只能并入主 bundle，按载体激活与否在运行期决定是否注册。

### 新增

- `directoryPicker/list`、`directoryPicker/createDirectory` 开放给 `full`（云端路径 UI 使用），
  `workspaceFiles/list` 三档共享不变。
- `directoryPicker/` 改为**前缀红线 + 具名豁免**：宿主原生弹框 `directoryPicker/pick`
  与任何未登记的 picker 方法仍然默认拒绝。

### 保持不变

- 本机模式下云端路径 UI **不注册任何槽位**，原生目录选择与 dsh-hardssh 流程不受影响。
- `account/*`（官方登录态）仍是红线。

## [0.2.6] - 2026-11-13

**Full 可以写配置、配置 Provider API Key、安装插件；官方登录态仍不可控。**

### 新增

- **Provider / API Key / 模型配置（远端）**：`full` 现在可以
  - `credentials/describe`（三档共享只读，只返回「是否已设置/来源/是否可写」，**从不返回密钥值**）
  - `credentials/set` / `credentials/unset`（仅 `full`）
  - `settings/update` / `settings/replace` / `settings/mutate`（仅 `full`）
  远端设置页因此能渲染 API Key 行、保存 Key、选择 Provider 与模型。
- **插件管理（远端）**：`full` 可以安装 / 升级 / 卸载 / 启停插件与 bundle，
  以及配置市场源（`pluginMarket/setIndexes`）；插件/市场的只读目录三档共享。
- **逐次 owner 审批（D-16）**：上面每一项写入，每次调用都会向本机 owner 投递审批卡，
  未获批准就是 `remote-access/denied`。
  - **超时无人应答 = 拒绝**（fail-closed），绝不静默放行；
  - 同一设备 + 同一载荷 60 秒内复用批准，避免一次保存触发多轮审批；**拒绝从不缓存**；
  - 审批与工具审批复用同一条 `hub/answerApproval` 回复通道与可见性约束。
- **密钥掩码**：`core/src/redact.ts` 统一脱敏，审批卡 / 审计 / 诊断里密钥显示为
  `sk-****abcd`；同时识别「字段名像密钥」与「值像凭据」两种情况，避免漏掩码。

### 变更（不兼容）

- `settings/{update,replace,mutate}`、`credentials/{set,unset}` 以及 `pluginManager/*`、
  `pluginMarket/setIndexes` 的写方法**不再属于红线**，改为 `full` 专属 + 逐次审批。
  安全模型从「不做」变为「能做，但每次都要 owner 点头」。
- 前缀红线新增 `credentials/`、`settings/`：**未登记的方法**（如 `credentials/rotate`）
  仍然默认拒绝；`settings/openSettingsDocument` 保持红线。
- `SHARED_READ_ENDPOINTS` 新增 `credentials/describe`、`pluginManager/listVersions`、
  `pluginManager/readBundleDetail`、`pluginMarket/readEntryDetail`。

### 保持不变

- `account/*`（官方登录态与余额）**仍不可控**，按需求保持红线。
- `directoryPicker/*`、`pluginInventory/*`、`dynamicCordisRunner/*`、`remoteAccess/follow`、`$events` 仍是红线。

### 修复

- 审批超时用的定时器曾 `unref()`，等待期间若事件循环无其他句柄会导致超时永不触发、
  请求静默挂死；已去掉 `unref()`。

### 工程与发布

- 新增 `test/sensitive-approval.test.mjs`（17 项，含「审批卡/审计不含明文密钥」「超时不放行」
  「拒绝不缓存」「别的设备不能代答」回归）；`test/full-administration.test.mjs` 覆盖新权限矩阵。
- `docs/API-MATRIX.md` 新增「需要 owner 逐次审批的接口」一节，CI 断言与代码一致。

## [0.2.5] - 2026-11-13

首个公开版本，同时作为 CI/CD 发布流水线的基线版本。

### 新增

- 双角色包结构：同一包两个 Cordis 入口，host 半边（配对、设备令牌、角色策略、回环守卫、隧道监督）与 client 半边（接管官方 `__DSH_TRANSPORT__`）。
- 扫码 / 8 位 Crockford 短码配对，TTL 均为 15 秒，单次使用，失败预算 5 次后烧码。
- `read-only` / `control` / `full` 三级角色，由 DSH Gateway 的 endpoint 与资源绑定强制；未知 endpoint 默认拒绝。
- 红线清单（凭据、设置写入、目录选择、插件管理、账号、`remoteAccess/follow`、`$events`）对全部角色不外放，CI 断言复核。
- 出站令牌由控制端本地 Host 持久化；浏览器载体只持有不透明 target ID。
- 断开保留配对记录，支持一键重连。
- 可选伴生包 `@xiaopb/dsh-remote-paths`：远端目录浏览与聊天 `+` 菜单云文件动作。
- `dsh-remote-hub-pair` CLI：无界面主机的配对出码入口。

### 工程与发布

- GitHub Actions CI：typecheck、构建、50 个测试文件、兼容矩阵、契约对账、来源围栏、红线断言。
- 发布流水线 `release.yml`：打 `v*` tag 触发，tag 与 `package.json` 版本强校验，npm 可信发布优先、`NPM_TOKEN` 兜底并轮询确认版本公开，产出 tarball + SHA-256 与 GitHub Release。
- 中英双语文档：`README.md` / `README.en.md`、部署、架构、设计契约、发布流程。

### 已知限制

- Android 延期。
- Desktop 四种组合未在隔离实例上验证。
- 凭据写入、账号登录与真实模型请求未纳入默认验收。
