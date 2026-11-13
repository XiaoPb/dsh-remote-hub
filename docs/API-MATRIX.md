# 接口权限分布（角色 × endpoint）

> **⚠️ 安全声明**：`full` 配对 = 远程代码执行 + 可写宿主配置与 API Key；0.3.1 起这些写入
> **直接生效、不再有 owner 审批**。只给完全可信设备发放 `full`，其余用 `control`。
> 详见仓库根目录 `README.md` 的「安全声明」与 `docs/DEPLOY.md` §0.0。
>
> 本文件由 `scripts/render-api-matrix.mjs` **从构建产物自动生成**，请勿手改。
> 修改权限后执行 `node scripts/render-api-matrix.mjs` 重新生成；CI 用
> `--check` 模式断言文档与代码完全一致。

真源是 `core/src/capabilities.ts` 的 `ROLE_MATRIX` 与
`core/src/capabilities-redlines.ts` 的 `isNeverDelegated()`。host 的
`remoteAccess.registerPolicy('remote-device', …)` 与 client 的 UI 门控读的是
**同一份表**，所以 UI 不会显示一个后端必然拒绝的入口。

## 0. 角色语义

| 角色 | 中文 | 能做什么 | 不能做什么 | 授权数量 |
| --- | --- | --- | --- | ---: |
| `read-only` | 只读 | 看列表、历史、状态、文件内容、任务面板、只读目录 | 任何写入、执行、上传 | 62 |
| `control` | 控制 | 只读 + 驱动会话（prompt / cancel / create / fork / rename / 队列）、审批与提问 | 碰文件系统与终端 | 94 |
| `full` | 完全 | 控制 + 上传文件、工作区文件读写、终端、`job/kill` | **不等于 DSH owner**：凭据、账号、插件安装、动态执行仍然全部拒绝 | 128 |

**未知 endpoint 一律拒绝（fail-closed）**。三档角色严格包含：`read-only ⊆ control ⊆ full`。

## 1. 判定依据图例

| 标签 | 含义 |
| --- | --- |
| 共享只读目录 | `SHARED_READ_ENDPOINTS`：所有角色都有的只读元数据/目录 |
| 只读业务 | 只读角色矩阵里的会话/工作区/文件只读方法 |
| 会话驱动 | `control` 起才有的写动作（驱动会话、审批） |
| 文件/终端 | `full` 起才有的文件上传与终端动作 |
| Full 专属管理面 | `FULL_ADMIN_ENDPOINTS`：仅 `full` 有的管理写动作（插件安装等） |
| 红线（逐条枚举） | `NEVER_DELEGATED_ENDPOINTS`：逐条点名，**所有角色**拒绝 |
| 红线（整组禁用） | `NEVER_DELEGATED_BLANKET`：整条 namespace 关闭，无豁免 |
| 红线（前缀） | `NEVER_DELEGATED_NAMESPACES`：整条关闭，但共享只读目录可豁免 |
| 红线（Gateway 内部面） | `$events` / `$events/result`，非 owner 由 `interactions:'none'` 挡住 |

## 2. 已授权接口（128 个）

按资源种类分组。资源种类决定 binding 挂法：没有参数指明资源时是 `global`，
由 `sessionId` / `workspaceFileScopeId` / `agentId` 解析出来的是 `session`。

### 2.1 global 资源（90 个）

| endpoint | 资源 | 形式 | 只读 | 控制 | 完全 | 判定依据 |
| --- | --- | --- | :---: | :---: | :---: | --- |
| `agentPresets/list` | global | 一元 | ✓ | ✓ | ✓ | 只读业务 |
| `agentPresets/read` | global | 一元 | ✓ | ✓ | ✓ | 只读业务 |
| `agentPresets/select` | global | 一元 | — | ✓ | ✓ | 会话驱动 |
| `commands/execute` | global | 一元 | ✓ | ✓ | ✓ | 只读业务 |
| `credentials/describe` | global | 一元 | ✓ | ✓ | ✓ | 共享只读目录 |
| `credentials/set` | global | 一元 | — | — | ✓ | Full 专属管理面 |
| `credentials/unset` | global | 一元 | — | — | ✓ | Full 专属管理面 |
| `directoryPicker/createDirectory` | global | 一元 | — | — | ✓ | Full 专属管理面 |
| `directoryPicker/list` | global | 一元 | — | — | ✓ | Full 专属管理面 |
| `dynamicCordisRunner/define` | global | 一元 | — | — | ✓ | Full 专属管理面 |
| `dynamicCordisRunner/getDefinition` | global | 一元 | — | — | ✓ | Full 专属管理面 |
| `dynamicCordisRunner/list` | global | 一元 | ✓ | ✓ | ✓ | 共享只读目录 |
| `dynamicCordisRunner/queryRunning` | global | 一元 | — | — | ✓ | Full 专属管理面 |
| `dynamicCordisRunner/run` | global | 一元 | — | — | ✓ | Full 专属管理面 |
| `dynamicCordisRunner/stop` | global | 一元 | — | — | ✓ | Full 专属管理面 |
| `dynamicCordisRunner/syncInspectManifest` | global | 一元 | ✓ | ✓ | ✓ | 共享只读目录 |
| `dynamicCordisRunner/undefine` | global | 一元 | — | — | ✓ | Full 专属管理面 |
| `goals/clear` | global | 一元 | — | — | ✓ | 文件/终端 |
| `goals/complete` | global | 一元 | — | ✓ | ✓ | 会话驱动 |
| `goals/create` | global | 一元 | — | ✓ | ✓ | 会话驱动 |
| `goals/edit` | global | 一元 | — | ✓ | ✓ | 会话驱动 |
| `goals/get` | global | 一元 | ✓ | ✓ | ✓ | 只读业务 |
| `goals/pause` | global | 一元 | — | ✓ | ✓ | 会话驱动 |
| `goals/resume` | global | 一元 | — | ✓ | ✓ | 会话驱动 |
| `hub/answerApproval` | global | hub 自有 | — | ✓ | ✓ | 会话驱动 |
| `hub/devices` | global | hub 自有 | — | ✓ | ✓ | 会话驱动 |
| `hub/revoke` | global | hub 自有 | — | — | ✓ | 文件/终端 |
| `hub/stream.cancel` | global | hub 自有 | ✓ | ✓ | ✓ | 只读业务 |
| `hub/stream.next` | global | hub 自有 | ✓ | ✓ | ✓ | 只读业务 |
| `hub/stream.open` | global | hub 自有 | ✓ | ✓ | ✓ | 只读业务 |
| `job/follow` | global | stream | ✓ | ✓ | ✓ | 只读业务 |
| `job/kill` | global | 一元 | — | — | ✓ | 文件/终端 |
| `job/list` | global | stream | ✓ | ✓ | ✓ | 只读业务 |
| `llm/discoverModels` | global | 一元 | ✓ | ✓ | ✓ | 只读业务 |
| `llm/listConfigurableProviders` | global | 一元 | ✓ | ✓ | ✓ | 只读业务 |
| `llm/listProviders` | global | 一元 | ✓ | ✓ | ✓ | 只读业务 |
| `messageFeedback/delete` | global | 一元 | — | — | ✓ | 文件/终端 |
| `messageFeedback/put` | global | 一元 | — | ✓ | ✓ | 会话驱动 |
| `permissionPresets/catalog` | global | 一元 | ✓ | ✓ | ✓ | 只读业务 |
| `pluginInventory/list` | global | 一元 | ✓ | ✓ | ✓ | 共享只读目录 |
| `pluginManager/cancelInstall` | global | 一元 | — | — | ✓ | Full 专属管理面 |
| `pluginManager/inspect` | global | 一元 | ✓ | ✓ | ✓ | 共享只读目录 |
| `pluginManager/installBundle` | global | 一元 | — | — | ✓ | Full 专属管理面 |
| `pluginManager/listBundles` | global | 一元 | ✓ | ✓ | ✓ | 共享只读目录 |
| `pluginManager/listPlugins` | global | 一元 | ✓ | ✓ | ✓ | 共享只读目录 |
| `pluginManager/listVersionExemptions` | global | 一元 | ✓ | ✓ | ✓ | 共享只读目录 |
| `pluginManager/listVersions` | global | 一元 | ✓ | ✓ | ✓ | 共享只读目录 |
| `pluginManager/readBundleDetail` | global | 一元 | ✓ | ✓ | ✓ | 共享只读目录 |
| `pluginManager/registries` | global | 一元 | ✓ | ✓ | ✓ | 共享只读目录 |
| `pluginManager/removeBundle` | global | 一元 | — | — | ✓ | Full 专属管理面 |
| `pluginManager/setBundleEnabled` | global | 一元 | — | — | ✓ | Full 专属管理面 |
| `pluginManager/setPluginEnabled` | global | 一元 | — | — | ✓ | Full 专属管理面 |
| `pluginManager/setVersionExemption` | global | 一元 | — | — | ✓ | Full 专属管理面 |
| `pluginManager/updateBundle` | global | 一元 | — | — | ✓ | Full 专属管理面 |
| `pluginManager/waitForInstall` | global | 一元 | — | — | ✓ | Full 专属管理面 |
| `pluginMarket/listIndexes` | global | 一元 | ✓ | ✓ | ✓ | 共享只读目录 |
| `pluginMarket/readEntryDetail` | global | 一元 | ✓ | ✓ | ✓ | 共享只读目录 |
| `pluginMarket/search` | global | 一元 | ✓ | ✓ | ✓ | 共享只读目录 |
| `pluginMarket/setIndexes` | global | 一元 | — | — | ✓ | Full 专属管理面 |
| `schedule/catalog` | global | 一元 | ✓ | ✓ | ✓ | 共享只读目录 |
| `schedule/create` | global | 一元 | — | ✓ | ✓ | 会话驱动 |
| `schedule/deleteInactive` | global | 一元 | — | — | ✓ | 文件/终端 |
| `schedule/deliveryLimits` | global | 一元 | ✓ | ✓ | ✓ | 只读业务 |
| `schedule/edit` | global | 一元 | — | ✓ | ✓ | 会话驱动 |
| `schedule/history` | global | 一元 | ✓ | ✓ | ✓ | 共享只读目录 |
| `schedule/list` | global | 一元 | ✓ | ✓ | ✓ | 共享只读目录 |
| `schedule/run` | global | 一元 | — | ✓ | ✓ | 会话驱动 |
| `schedule/view` | global | 一元 | ✓ | ✓ | ✓ | 只读业务 |
| `session/canOpenWorkspacePath` | global | 一元 | ✓ | ✓ | ✓ | 只读业务 |
| `session/control` | global | stream | ✓ | ✓ | ✓ | 只读业务 |
| `session/create` | global | 一元 | — | ✓ | ✓ | 会话驱动 |
| `session/list` | global | 一元 | ✓ | ✓ | ✓ | 只读业务 |
| `session/modelCatalog` | global | 一元 | ✓ | ✓ | ✓ | 只读业务 |
| `session/search` | global | 一元 | ✓ | ✓ | ✓ | 只读业务 |
| `session/workspacePathApplications` | global | 一元 | ✓ | ✓ | ✓ | 只读业务 |
| `settings/describe` | global | 一元 | ✓ | ✓ | ✓ | 共享只读目录 |
| `settings/mutate` | global | 一元 | — | — | ✓ | Full 专属管理面 |
| `settings/replace` | global | 一元 | — | — | ✓ | Full 专属管理面 |
| `settings/update` | global | 一元 | — | — | ✓ | Full 专属管理面 |
| `workspace/archiveSession` | global | 一元 | — | ✓ | ✓ | 会话驱动 |
| `workspace/create` | global | 一元 | — | ✓ | ✓ | 会话驱动 |
| `workspace/delete` | global | 一元 | — | — | ✓ | Full 专属管理面 |
| `workspace/follow` | global | stream | ✓ | ✓ | ✓ | 只读业务 |
| `workspace/initializeDefault` | global | 一元 | — | ✓ | ✓ | 会话驱动 |
| `workspace/insertBefore` | global | 一元 | — | ✓ | ✓ | 会话驱动 |
| `workspace/insertSessionBefore` | global | 一元 | — | ✓ | ✓ | 会话驱动 |
| `workspace/pinSession` | global | 一元 | — | ✓ | ✓ | 会话驱动 |
| `workspace/rename` | global | 一元 | — | ✓ | ✓ | 会话驱动 |
| `workspace/unarchiveSession` | global | 一元 | — | ✓ | ✓ | 会话驱动 |
| `workspace/unpinSession` | global | 一元 | — | ✓ | ✓ | 会话驱动 |

### 2.2 session 资源（38 个）

| endpoint | 资源 | 形式 | 只读 | 控制 | 完全 | 判定依据 |
| --- | --- | --- | :---: | :---: | :---: | --- |
| `commands/list` | session | 一元 | ✓ | ✓ | ✓ | 只读业务 |
| `fileReferences/list` | session | 一元 | ✓ | ✓ | ✓ | 只读业务 |
| `fileUploads/upload` | session | 一元 | — | — | ✓ | 文件/终端 |
| `messageFeedback/list` | session | 一元 | ✓ | ✓ | ✓ | 只读业务 |
| `session/attachment` | session | 一元 | — | — | ✓ | 文件/终端 |
| `session/cancel` | session | 一元 | — | ✓ | ✓ | 会话驱动 |
| `session/events` | session | 一元 | ✓ | ✓ | ✓ | 只读业务 |
| `session/follow` | session | stream | ✓ | ✓ | ✓ | 只读业务 |
| `session/fork` | session | 一元 | — | ✓ | ✓ | 会话驱动 |
| `session/observeEvent` | session | stream | ✓ | ✓ | ✓ | 只读业务 |
| `session/observeProjections` | session | stream | ✓ | ✓ | ✓ | 只读业务 |
| `session/observeState` | session | stream | ✓ | ✓ | ✓ | 只读业务 |
| `session/projections` | session | 一元 | ✓ | ✓ | ✓ | 只读业务 |
| `session/prompt` | session | 一元 | — | ✓ | ✓ | 会话驱动 |
| `session/rename` | session | 一元 | — | ✓ | ✓ | 会话驱动 |
| `session/selectModel` | session | 一元 | — | ✓ | ✓ | 会话驱动 |
| `session/state` | session | 一元 | ✓ | ✓ | ✓ | 只读业务 |
| `session/updateQueue` | session | 一元 | — | ✓ | ✓ | 会话驱动 |
| `session/wait` | session | 一元 | ✓ | ✓ | ✓ | 只读业务 |
| `sessionReferenceResolver/candidates` | session | 一元 | ✓ | ✓ | ✓ | 只读业务 |
| `skills/list` | session | 一元 | ✓ | ✓ | ✓ | 只读业务 |
| `subagents/interruptByParent` | session | 一元 | — | ✓ | ✓ | 会话驱动 |
| `subagents/prompt` | session | 一元 | — | ✓ | ✓ | 会话驱动 |
| `terminal/attach` | session | stream | — | — | ✓ | 文件/终端 |
| `terminal/close` | session | 一元 | — | — | ✓ | 文件/终端 |
| `terminal/create` | session | 一元 | — | — | ✓ | 文件/终端 |
| `terminal/environment` | session | 一元 | ✓ | ✓ | ✓ | 只读业务 |
| `terminal/list` | session | 一元 | ✓ | ✓ | ✓ | 只读业务 |
| `terminal/rename` | session | 一元 | — | — | ✓ | 文件/终端 |
| `terminal/retain` | session | stream | ✓ | ✓ | ✓ | 只读业务 |
| `terminal/shells` | session | 一元 | ✓ | ✓ | ✓ | 只读业务 |
| `userQuestions/answer` | session | 一元 | — | ✓ | ✓ | 会话驱动 |
| `userQuestions/attachWait` | session | stream | — | ✓ | ✓ | 会话驱动 |
| `workspaceFiles/changes` | session | stream | ✓ | ✓ | ✓ | 只读业务 |
| `workspaceFiles/list` | session | 一元 | ✓ | ✓ | ✓ | 只读业务 |
| `workspaceFiles/read` | session | 一元 | ✓ | ✓ | ✓ | 只读业务 |
| `workspaceFiles/readBytes` | session | 一元 | ✓ | ✓ | ✓ | 只读业务 |
| `workspaceFiles/stat` | session | 一元 | ✓ | ✓ | ✓ | 只读业务 |

### 2.3 workspace 资源（0 个）

| endpoint | 资源 | 形式 | 只读 | 控制 | 完全 | 判定依据 |
| --- | --- | --- | :---: | :---: | :---: | --- |

## 3. 红线接口（所有角色均拒绝）

下面 10 条是 DESIGN §8.6.5 点名的红线，**`full` 也拿不到**。
`scripts/redlines.mjs` 每次 CI 都逐条断言「红线成立 且 不在 full 矩阵里」。

| endpoint | 拒绝原因 | 只读 | 控制 | 完全 |
| --- | --- | :---: | :---: | :---: |
| `settings/openSettingsDocument` | 在宿主打开设置文档 = 操控宿主 UI | — | — | — |
| `directoryPicker/pick` | 宿主桌面原生对话框/目录面 | — | — | — |
| `account/getState` | 账号凭据与登录态（官方登录态不可控） | — | — | — |
| `account/getProfile` | 账号凭据与登录态（官方登录态不可控） | — | — | — |
| `account/getBalance` | 账号凭据与登录态（官方登录态不可控） | — | — | — |
| `remoteAccess/follow` | 官方恒放行，下放等于送出能力清单 | — | — | — |
| `credentials/rotate` | 未登记的 credentials / settings 方法，前缀红线默认拒绝 | — | — | — |
| `credentials/reveal` | 未登记的 credentials / settings 方法，前缀红线默认拒绝 | — | — | — |
| `settings/import` | 未登记的 credentials / settings 方法，前缀红线默认拒绝 | — | — | — |
| `directoryPicker/pickDirectory` | 宿主桌面原生对话框/目录面 | — | — | — |

整组禁用的 namespace（无豁免）：`account/*`。

## 3.1 需要 owner 逐次审批的接口（0.3.1 起已取消）

**当前没有任何接口需要 owner 逐次审批。** 只要配对角色是 `full`，
写配置、写 API Key、安装/卸载/启停插件都会**直接生效**。

> 安全代价：`full` 配对 = 远程代码执行 + 可写宿主配置与凭据。只给可信设备发放 `full`；
> 不确定时用 `control`（只读 + 驱动会话）。
>
> 审计与**密钥掩码**仍然生效：写入类 endpoint 的载荷在落审计/诊断前经过 `core/src/redact.ts`，
> 明文密钥不会出现在日志里。审批机制本身保留在 `host/src/sensitive-approval.ts`，
> 需要恢复时只需往 `APPROVAL_REQUIRED_ENDPOINTS` 加回条目。

## 4. 未授予任何角色的 endpoint（3 个）

这些方法登记在网络可见的 endpoint 表里（用于对账与未来的窄化设计），但任何角色都无法调用：

| endpoint | 资源 | 形式 | 归类 |
| --- | --- | --- | --- |
| `directoryPicker/pick` | global | 一元 | 红线（逐条枚举） |
| `session/openWorkspacePath` | global | 一元 | 未授予任何角色 |
| `session/page` | session | 一元 | 未授予任何角色 |

## 5. 边界说明

- **`full` 不是 owner**：插件生命周期、动态 Cordis 执行、任意设置、凭据管理、账号操作
  需要单独评审的 API 和/或 Host 审批，不在任何配对角色的矩阵里。
- **红线清单本身就是断言**：`assertMatrixIntegrity()` 在插件**加载期**跑，
  矩阵里只要混进一条红线，插件直接加载失败——不会等到某台设备在实机上 403。
- **前缀红线的副作用**：`pluginManager/*` / `pluginMarket/*` 是整条关闭的，
  新增的官方只读方法必须显式加入 `SHARED_READ_ENDPOINTS` 才会开放。
- **资源过滤**：矩阵只回答「这个角色能不能调这个方法」，具体到哪条会话/工作区，
  仍由 Gateway 的 resource binding 与可见资源跟踪共同限定。
