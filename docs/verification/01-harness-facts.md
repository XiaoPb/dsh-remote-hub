# 01 · DESIGN.md §13 事实与假设核对（对 DSH 0.2.2-rc.1 源码）

## 0. 审计范围与复现方式

| 项 | 值 |
|---|---|
| 被审计文档 | `docs/DESIGN.md`（§13.1 F1–F21、§13.2 A1–A15、§14、§8.6） |
| 权威源码 | `E:\Code\DSH\plugins\deepseek-harness` |
| Commit | `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`（2026-11-04，"Merge PR #7873 … release-dsh-0.2.2-rc.1-to-master"） |
| 检出内版本 | 根 `package.json` = `0.2.2-rc.1`；`packages/api/*` 全部 `0.2.2-rc.1` |
| 审计日期 | 2026-11-11 |
| 判定口径 | 只有我本人打开过并读到符号/行号的行才给「成立」；纯外部/时间相关事实一律「无法验证」 |

复现（PowerShell，均只读）：

```pwsh
$r = 'E:\Code\DSH\plugins\deepseek-harness'
git -C $r log -1 --format='%H %ad %s'
Get-Content "$r\package.json" | Select-String '"version"'
Select-String -Path "$r\packages\api\gateway\src\index.ts" -Pattern 'prepareInvocation|remoteAccess.decide'
Select-String -Path "$r\packages\client\connection\src\rpc-host.ts" -Pattern "super\(ctx, 'connection'\)|createPeer\("
Select-String -Path "$r\packages\interaction\user-approval\src\index.ts" -Pattern "super\(ctx, 'approval'\)|scopeTarget"
Get-ChildItem "$r\packages" -Recurse -Filter package.json | ForEach-Object { (Get-Content $_ -Raw | ConvertFrom-Json).name } | Sort-Object -Unique
```

> 下文所有路径都相对检出根 `E:\Code\DSH\plugins\deepseek-harness\`。§13 原文路径前缀不统一（F1/F3/F4 带 `packages/`，其余多不带），本文件一律补全为可 `Test-Path` 的完整相对路径；差异清单见 §4.2。

---

## 1. 逐条判定

| ID | 原断言（摘要） | 判定 | 证据（路径:行） | 修正后的准确表述 |
|---|---|---|---|---|
| F1 | `@deepseek-ai/dsh-api-remote-access` v0.2.2-rc.1 存在，默认导出 `RemoteAccessService`，ctx key `remoteAccess` | 成立 | `packages/api/remote-access/package.json:2,4`；`src/index.ts:36-41,125,135,423` | 准确。补一句：它是 `TypertRemoteService` 子类，故同时是一个 Remote 服务（namespace 默认取 service key，即 `remoteAccess`）。 |
| F2 | `registerPolicy(kind,policy)→()=>void`、`invalidate(principal?)`、`decide(request)`、`allows(resource)`、`snapshotFor(principal)`、`@Remote({mode:'stream'}) follow(signal)` | 成立 | `src/index.ts:153,175,199,235,253,269-270`；`README.zh.md:31-36` | 准确。`decide()` 文档明确标注 "Gateway-only"（`index.ts:184,199`）。 |
| F3 | `RemoteAccessRole<K> = {name, resource(种类), actions}`；`RemoteAccessBinding = {role, resource(含 id), condition?}` | 成立 | `packages/api/remote-access/src/types.ts:29-36,60-67` | 准确。`resource` 是 `RemoteAccessResourceOf<K>`，即 `{kind,id}`（`packages/typert/protocol/src/remote-access.ts:22-38`）；`global` 无 id。 |
| F4 | 拒绝码 `remote-access/denied`，details `{action,reason}`；reason ∈ `resource-invalid`/`no-allow`/`policy-failed`/condition 或 `explain()` 原因 | 成立 | `src/types.ts:107-122`；`packages/api/gateway/src/index.ts:812-824`；`README.zh.md:50-56` | 准确。补：`resource-invalid` 由 Gateway 在调 `decide()` **之前**产生（`gateway/src/index.ts:812-813`），不是 `decide()` 的返回值。 |
| F5 | `decide()` 时机 = endpoint+参数字段检查 → Typert 类型校验 → 解析资源 → decide → lookup/Context 解析 → 业务调用 | 成立 | `packages/api/gateway/src/index.ts:797-826`（`resolveDescriptor`:799、`assertExactArguments`:800、`validateArguments`:801、注释 "Access precedes lookup resolution":802、`callResources`+`decide`:805-819、`resolveReceiverContext`:827） | 准确。**但** `packages/api/remote-access/README.zh.md:12` 写的"在解析 lookup、**解码参数之前**询问本包"照字面读是错的：参数此时已解码并按 Typert 编译类型校验过。以 gateway README:33 与代码为准。 |
| F6 | `PrincipalMap` 可声明合并，内建只有 `owner`；`PeerScope.principal` 创建时固定，线上字段无法设置 | 成立 | `packages/typert/protocol/src/types.ts:455-458,468-483`（:473 `readonly principal`，注释 "no wire field can set it"）；`packages/client/connection/src/peer.ts:38-47`（:39） | 准确。合并语法是 `declare module '@deepseek-ai/dsh-typert-protocol' { interface PrincipalMap { … } }`（先例 `packages/experimental/liveshare/src/host/viewer-principal.ts:16-21`）。 |
| F7 | 官方 `liveshare` 已用同一机制：合并 `'share-viewer'` + `connection.createPeer({principal})` + `registerPolicy('share-viewer',…)` | 成立 | `packages/experimental/liveshare/src/host/viewer-principal.ts:16-21`；`viewer-lifecycle.ts:294`；`share-host.ts:290` | 准确。三处行号全对。 |
| F8 | `HostConnectionHandle` 提供 `createSharedFetchHandler` 与 `createPeer` | 成立 | `packages/client/connection/src/rpc.ts:206-247`（:225、:247）；`packages/experimental/liveshare/src/host/viewer-read.ts:28` | 准确。另：`createPeer(options:{principal; interactions?})`，`interactions` 缺省 `'answer'`（`peer.ts:40`）。 |
| F9 | HTTP `/api` 准入后恒为 owner Peer；`admit()` 只认 `browserAuth` | 成立 | `packages/client/connection/src/rpc-host.ts:92-94,129-137` | 准确。`admit()` = Host/Origin 围栏（`isTrusted`）→ `browserAuth.isAuthenticated` → 否则 `authenticateApi` 取已发布 Peer，再否则 401。 |
| F10 | 围栏 `isTrustedApiRequest(request, trustedHosts, bindHost, protocol)`：Host + `Sec-Fetch-Site` + `Origin`，且从不建立身份 | 成立 | `packages/client/connection/src/api-request-trust.ts:121-151`（Host:134-140，cross-site:143，Origin:148-150） | 准确。它只返回 boolean；身份来自 `browserAuth`，与本函数无关。 |
| F11 | Host 侧 `ctx.typertGateway`（invoke/stream/wireStream/registerRemoteEvents）；Client 侧 `ctx.remote`（$mount/$on/$host/$stream） | 成立 | `packages/api/gateway/src/types.ts:154-192,194-198`；`src/index.ts:224-228,352-355,424,453`；`src/client/index.ts:110,116,214,224` | 准确。补：`static inject = ['typert','remoteAccess']`（`gateway/src/index.ts:215`）——Gateway 没有 `remoteAccess` 就不启动。 |
| F12 | 一元走 `/api`（`connection.rpc.call('/api',…)`），流走 `/api/remote.mux`；心跳默认 2s、`streamInboxBytes` 默认 262144 | 成立 | `packages/api/gateway/src/client/index.ts:458`；`src/stream-protocol.ts:7`（`REMOTE_STREAM_MUX_PATH`）；`src/index.ts:149-150,216-221` | 准确。mux 路径是常量 `'/api/remote.mux'`；两个默认值分别是 `2_000` 与 `262_144`，可由 `Config` 覆盖。 |
| F13 | 官方 endpoint：`session/list` `session/create` `session/prompt` `session/cancel` `session/page` `session/fork` `session/follow` `session/control` `session/projections` `session/events` | 表述需修正 | `packages/api/session-controller/src/index.ts:179`（namespace）、`:281,306,467,519,531,542,448,609,620,630` | 10 个名字全部存在，但**不全**：还有 `search/selectModel/modelCatalog/openWorkspacePath/workspacePathApplications/rename/attachment/updateQueue/state/wait/observeEvent/observeProjections/observeState`。**`session/page` 已 `@deprecated`**（:526），替代者是 `session/events`（:542）。 |
| F14 | `fileUploads/upload`；`workspaceFiles/{read,readBytes,stat,list}` | 成立 | `packages/client/file-upload/src/index.ts:59,69,112`；`packages/api/workspace-files/src/index.ts:184,199-200,233,257,290,303` | 准确。补：`fileUploads` 另有一条 exact Fetch 路由 `POST /api/session/uploadFileBinary`（`file-upload/src/protocol.ts:2`），走 `connection.fetch.register`，**非 owner 一律 403**（`rpc-host.ts:221`）。 |
| F15 | `settings/describe`（另有 update/replace/mutate/openSettingsDocument） | 成立 | `packages/api/settings-controller/src/index.ts:86`（`namespace:'settings'`）、`:97,115,132,151,166` | 准确。同包还挂了 `credentials` namespace：`credentials/describe|set|unset`（`src/credentials.ts:70,82,99,112`）。 |
| F16 | 审批不是 Remote 方法；`ApprovalService`（ctx key `approval`）以 `'approval/request'` scoped waterfall 派发；非 owner Peer 从不收到可作答 waterfall | 成立 | `packages/interaction/user-approval/src/index.ts:25-29,167,176-178,242,306-310`（:308 `scopeTarget(req.agent, req.agent)`）；`packages/api/gateway/src/index.ts:584`（`answers = principal.kind==='owner'`）、`:502-504`；`packages/api/gateway/README.zh.md:49,51` | 准确。另外两点原文没写：① `request()` 在**没有打开的 turn** 时直接抛错（`index.ts:244-250`）；② `api/remotes` 把 `approval/request` 登记为**唯一两个** waterfall 之一（另一个是 `user-questions/request`，`packages/api/remotes/src/remote-events.ts:29,57`）。 |
| F17 | `@Remote`/`@RemoteScope` 由 `@deepseek-ai/dsh-typert-protocol` 导出；选项 `{name?, mode?:'stream', resources?}` | 成立 | `packages/typert/protocol/src/index.ts:282,291,297,300,369,376,380`；选项类型 `:149-171,178-181` | 准确。`mode` 只接受 `'stream'`；`resources` 在 `RemoteScopeOptions` 上（`RemoteMethodOptions` 继承并加 `mode`）。 |
| F18 | DSH Web 默认端口 `3080`；`WebServer` 拒绑通配地址；`webserver/index-inject` 签名 `(table, peer) => void` | 表述需修正 | 拒绑：`packages/host/webserver/src/index.ts:359-366`（:363 报错文本）；签名：`:34-45`（:44）；**真实默认端口**：`packages/bundle/web-app/cordis.patch.yml:186-188`（`host ?? '127.0.0.1'`、`port ?? 3080`） | `boot/cmdline/src/index.ts:14` 只是文档注释里的一句示例（`port: !!js ctx.webStartup.port ?? 3080`），**不是**默认值的定义处。默认值在 `web-app` 的 webserver 行，且 host 默认是 `127.0.0.1`。 |
| F19 | 非 owner 页面快照经 `REMOTE_ACCESS_SNAPSHOT_KEY`（`__DSH_REMOTE_ACCESS__`）注入 index；Client 提供 `source/whenAccess/whenResourceAccess/useRemoteAccess` | 成立 | `packages/api/remote-access/src/snapshot.ts:8`；`src/index.ts:138-142`；`src/client/mount.ts:43,55,66,79`；`README.zh.md:48,62-68` | 准确。注入发生在每次 index 渲染的 `webserver/index-inject`（`webserver/src/index.ts:719-727`）。 |
| F20 | 安装形态 `dsh.bundle.patch` + `cordis.patch.yml` 的 `insert:[{id,name}]`；client 半边是 `__ModuleLoader__.load({id,factory})`，`id` 必须等于包名 | 成立 | `packages/client/modules/src/client/manifest.ts:52-54`（`WebBootEntry`，注释 "Entry name == package name"）、`:10-11`；实例 `apps/web/tests/fixtures/plugins/fixture-live-client/client.js:2-4`；产物实例 `dsh-mobile-layout/lib/client.js:26-27`（`id: '@xiaopb/dsh-mobile-layout'` 等于包名） | 准确。补：入口是浏览器全局 `window.__ModuleLoader__`，`id` 同时是 loader 的包标识与模块表键。 |
| F21 | `ClientContext` 由 `@deepseek-ai/dsh-client-runtime/client` 导出（`export type ClientContext = Context`） | 已失效（源码已变） | 检出内 **410 个包中不存在** `@deepseek-ai/dsh-client-runtime`（`Get-ChildItem packages -Recurse -Filter package.json` 全量比对；`packages/client/runtime` 目录不存在；`pnpm-lock.yaml` 只出现 `link:../../packages/test-support/client-runtime`）。检出内 Client 包的写法是 `import type { Context as ClientContext } from '@deepseek-ai/cordis'`（`packages/client/locale/src/client/index.ts:7`、`packages/api/workspace-files/src/client/index.ts:8`）。`SlotRegistry` 现在在 `packages/client/ui-renderer/src/client/registry.ts:120`。 | 0.2.2-rc.1 的 client 面**不再有这个包**；`ClientContext` 不再是跨包公共类型，各包自行 `Context as ClientContext`。该类型只剩在 `dsh-solution-explorer/node_modules` 里安装的 0.1.0-rc.8 副本（`lib/types/client/index.d.ts:55`）——那是 2 个小版本前的形状，不能用于核对 0.2.2-rc.1。 |
| A1 | Android 无官方 SDK，协议须自行实现 | 成立 | 检出内 0 个 `*.kt/*.kts/*.gradle`；SDK 只有 TS（`packages/sdk/{client,protocol,server}`）与 Python（`python/sdk`、`python/sdk-runtime`）；registry 搜索 `scope:deepseek-ai android` 返回 `{"objects":[],"total":0}` | 准确。官方跨语言面是 stdio JSON-RPC（`packages/sdk/protocol/README.zh.md`），不是 HTTP/WS 移动 SDK。 |
| A2 | 第三方插件可注入 `connection` 并调 `createPeer` | 成立 | `packages/client/connection/src/rpc-host.ts:92`（`super(ctx,'connection')`）、`:140-142`（`createPeer`）；`rpc.ts:206-274`（接口全 public 成员）；注入机制按 key 而非包名（`docs/user/develop/framework/service.zh.md:21-32`）；`packages/bundle/web-app/cordis.patch.yml:239` 装了 client-connection | 静态层面成立：**没有任何包名 allow-list 门控**（grep `allowlist|serviceAccess|denyService|forbidden service` 的命中全是事件 allowlist、工具 allowlist、pnpm build allowlist 等无关语义）。前提是组合里装了 `connection`（web-app 装了；headless/SDK 组合要各自确认），且仍需 M0 探针在真实 profile 里跑一次（R-1 未关闭）。 |
| A3 | 第三方插件可注入 `typertGateway` 并以自定义 Peer 调 `invoke()` | 成立 | `packages/api/gateway/src/index.ts:215,243,424-426,793-876`；`types.ts:11-29,184` | 静态成立，两个硬前提必须写进设计：① 该 endpoint 必须被 Gateway 认领（严格描述符在 `ctx.typert.local`，或 SRC 标记发现，`index.ts:380-387,401-416,891-917`）；② 非 owner Peer 调用必然走 `decide()`，**该 kind 没注册 policy 就一律 `no-allow` 拒绝**（`remote-access/src/index.ts:203-204`）。精确签名：`invoke(request: InvokeRemoteRequest): Promise<unknown>`，`InvokeRemoteRequest = { namespace, method, args, uplink?, uplinkWindow?, peer: PeerScope, signal? }`。 |
| A4 | `PrincipalMap` 允许第三方包合并新 kind，且 Gateway 会为该 kind 询问策略 | 成立 | `packages/typert/protocol/src/types.ts:450-458`（注释 "Each driver declares its own entry"、"Merge-extensible"）；`packages/api/remote-access/src/index.ts:201,254` 与 `packages/api/gateway/src/index.ts:501,803` 的 `oxlint-disable` 注释原文："other packages merge non-owner kinds into PrincipalMap"；`gateway/src/index.ts:804-819` | 成立，且是官方明示支持的扩展点（那四条 lint 抑制注释就是证据）。`PeerScope.principal` 在 `new Peer()` 内固定（`peer.ts:39`），创建后不可变。 |
| A5 | `androidx.security:security-crypto` 在目标周期内仍可用 | 无法验证 | 检出内无 Android 依赖；插件侧当前写死 `1.1.0-alpha06`（`android/app/build.gradle.kts`） | 外部时间相关事实，本轮无法证伪。设计上按"可能被废弃"准备 `DeviceStore` 抽象即可。 |
| A6 | cloudflared 在目标平台可用且 `tunnel --url` 语义稳定 | 无法验证 | 检出内无 cloudflared/隧道二进制相关代码（`grep -r cloudflared` 0 命中） | 外部事实。检出可确认的只有：liveshare 的隧道是**自有 gateway worker 进程**（`packages/experimental/liveshare/src/host/tunnel-supervision.ts:67-79,322`），不是 cloudflared。 |
| A7 | 隧道不会注入任何被我们采信的"回环"头 | 无法验证 | 外部行为；但可确认 DSH 自己**完全不读**转发头：非测试源码 `x-forwarded` 0 命中（唯一命中在测试 `packages/client/connection/tests/node-half.host.spec.ts:258`，且只用于验证"带了也不认"），`isTrustedApiRequest` 只读 `host`/`sec-fetch-site`/`origin`（`packages/client/connection/src/api-request-trust.ts:134-150`） | 无法验证隧道实现，但"不采信任何转发头"与 DSH 既有做法一致，属正确默认。 |
| A8 | 浏览器半边可安全保存设备令牌（跨刷新） | 无法验证 | 浏览器存储行为，检出不可判；可复用的先例是 DSH 自己的浏览器凭据 cookie（`rpc-host.ts:133-136,193-195`，`authorizeIndex` 铸 cookie） | 无法验证。若要跨刷新，参考官方：cookie 由 Host 铸、`Secure` 随监听器协议决定，而非 localStorage。 |
| A9 | `clientPubKey` 在 v1 只做预留、不参与校验 | 无法验证 | 纯协议自定项，检出无对应约束；插件侧常量在 `core/src/protocol.ts:13`（`PROTOCOL_VERSION = 1`） | 无法验证（设计选择，非事实）。仅提醒：预留字段必须在校验层显式忽略，否则会被误当凭据。 |
| A10 | 远端浏览器主控端可接受"每次刷新需重新认证" | 无法验证 | UX 假设 | 无法验证。 |
| A11 | `results.preview` 映射到 `workspaceFiles/read` 足够表达"结果预览" | 表述需修正 | `packages/api/workspace-files/src/index.ts:233-247`：`read()` 在文本含 NUL 时抛 `workspace-file/not-text`（:243-245）；二进制要走 `readBytes()`（:257-281，返回原生字节） | 文本预览用 `read`，**图片/二进制必须用 `readBytes`**（`read` 会直接报错）。另外 `read` 的返回是"一个行窗口"（`offset/limit/lines/eof`），不是整文件。 |
| A12 | `ctx.approval` 的成员与 `ApprovalOutcome` 取值足够实现桥接 | 成立 | 成员：`request(req)`（`user-approval/src/index.ts:242`）、`setPolicy(agent,policy)`（:211）、`overrideOf(session)`（:279）、`config`（:176,152-160）、`static inject=['sessionProjections']`（:168）、`static Config`（:170-172）。取值：`'allowed-once' \| 'rejected' \| 'cancelled' \| 'unavailable'`（`types.ts:32`，`index.ts:56` 的 `OUTCOMES` 同源） | 足够，但**桥接形状必须改**：远端不能"调用 `service.request()`"，因为 `request()` 要求 turn 已打开（:244-250）且会自己 append 一对 `approval/asked`+`approval/decided`（:252-259），重复调用会把审计对写两遍。正确做法是注册 `ctx.on('approval/request', async (req,next)=>…)` 并返回 outcome——官方 SDK server 就是这么做的（`packages/sdk/server/src/server.ts:123-140`），`'unavailable'` 只作为"无人应答"的 fail-closed，**不能**由桥接主动返回（SDK 协议层明确只允许三值：`packages/sdk/protocol/src/types.ts:236`）。 |
| A13 | `sessions.read` = `session/page` + `session/state` 的组合 | 表述需修正 | `packages/api/session-controller/src/index.ts:526`（`@deprecated Use events`）、`:531-534`（page → 同一实现）、`:542-545`（events）、`:575-578`（state）、`:620-623`（projections） | 改成 `session/events`（page 的接任者）+ `session/state` +（需要投影时）`session/projections`。继续用 `page` 会立刻踩 deprecation。 |
| A14 | 守卫内嵌 WS 实现（`node:http` 的 `upgrade`）不依赖 DSH gateway WS 栈 | 成立 | `ws` 在仓库内被官方使用：`packages/api/gateway/package.json:66`（`^8.21.3`）、`packages/experimental/liveshare/package.json:68`（`^8.18.3`）、`apps/cli/package.json:168`、`apps/desktop/package.json:53`、`apps/web/package.json:65`；官方 WS 路由入口是 `webServer.registerUpgrade({path,handler})`（`packages/host/webserver/src/index.ts:460-466`，类型 `:77-82`），Gateway 自己就用它（`gateway/src/index.ts:273-309`） | `ws` 可用（插件仍需在自己的 `dependencies` 里声明，不能指望宿主 transitive）。但**不要手搓 `server.on('upgrade')`**：若守卫挂在 DSH 的 webServer 上，必须用 `registerUpgrade`（同一路径二次注册会抛错，`webserver/src/index.ts:461-463`）。守卫若起独立端口，则独立 `http.Server` + `ws` 亦可——这正是 ADR-3 的两种形态，需明确选一个。 |
| A15 | Compose BOM 2024.12.01 + Kotlin 2.1.0 + AGP 8.7.3 在 CI 上可构建 | 无法验证 | `android/build.gradle.kts` 确实声明 AGP 8.7.3 / Kotlin 2.1.0；`android/app/build.gradle.kts` 用 `compose-bom:2024.12.01`；但**没有 gradle wrapper**（`android/build.gradle.kts` 注释自述"scaffold ships without a wrapper on purpose"） | 无法验证。可确认的只有版本号确实这么写着；没有 wrapper 时 CI 连 `./gradlew` 都跑不起来，这条依赖必须先补 wrapper 才能进入验证。 |

统计（36 条 = F 21 + A 15）：成立 **24**、表述需修正 **4**（F13、F18、A11、A13）、已失效 **1**（F21）、无法验证 **7**（A5–A10、A15）。

---

## 2. 关键结论（影响架构决策）

1. **第三方确实能拿到 `ctx.connection` / `ctx.typertGateway`，服务层没有包名白名单。**
   `HostConnectionService` 与 `TypertGatewayService` 都是普通 Cordis 服务（`rpc-host.ts:92`、`gateway/src/index.ts:243`），`ctx.inject(['connection'])`/`['typertGateway']` 按 key 解析（`docs/user/develop/framework/service.zh.md:21-32`）。检索 `allowlist|allow-list|serviceAccess|denyService|forbidden service|capability gate` 全部 0 条服务级门控（命中的都是"事件 allowlist""工具 allowlist"等无关语义）。
   → 所以设计必须：**保留 ADR-2 的"Gateway 内派发"路线，但把 R-1 从"可能拿不到"降级为"已在源码层确认，只差 M0 探针"**，探针只验证"该 profile 装了 Connection + 我的 kind 有 policy"。

2. **`decide()` 对"没有 policy 的 kind"一律拒绝，而且是 `no-allow`，不是放行。**
   `remote-access/src/index.ts:203-204`：`policies.get(kind)` 为空即 `NO_ALLOW`；只有 owner 与 `remoteAccess/follow` 恒放行（:202）。
   → 设计必须：`registerPolicy('remote-device', …)` 与 `connection.createPeer({principal:{kind:'remote-device',…}})` **必须同生共死**；任何漏注册都是全量 403，不是"降级为只读"。

3. **审批桥接的唯一正确形状是 waterfall 监听器，不是调 `service.request()`。**
   `request()` 要求 turn 已打开（`user-approval/src/index.ts:244-250`）并自行 append 审计对（:252-259）；官方 SDK 桥接是 `ctx.on('approval/request', …)`（`packages/sdk/server/src/server.ts:123-140`）；非 owner Peer 的 `$events` 永远拿不到可作答 waterfall（`gateway/src/index.ts:584`，`gateway/README.zh.md:49`）。
   → 设计必须：把 `approvals.respond` 实现为"守卫把远端决定投给一个 `ctx.on('approval/request')` 监听器"，且只能返回 `allowed-once/rejected/cancelled` 三值（`sdk/protocol/src/types.ts:236`），`unavailable` 只能由"没人应答"产生。

4. **自定义 principal kind 是官方支持的扩展点，不是私有 hack。**
   四处 `oxlint-disable` 注释原文写着 "other packages merge non-owner kinds into PrincipalMap"（`remote-access/src/index.ts:201,254`、`gateway/src/index.ts:501,803`），liveshare 用 `declare module` 合了 `'share-viewer'`（`viewer-principal.ts:16-21`）。
   → 设计必须：按 `share-viewer` 的形状写 `remote-device`（只放身份，不放凭据，因为 `PeerScope.principal` 会被写进 Session 日志：`types.ts:450-453`），并接受"改动即需 `invalidate(principal)`"（`remote-access/src/index.ts:175`）。

5. **二进制/图片预览必须走 `workspaceFiles/readBytes`。**
   `read()` 遇 NUL 抛 `workspace-file/not-text`（`workspace-files/src/index.ts:243-245`），返回的是行窗口而非整文件。
   → 设计必须：`results.preview` 分两条腿——文本 `read`（带 `offset/limit`）、二进制 `readBytes`（带 `range`，`maxFileBytes` 默认 32 MiB，:188）。

6. **WS 别手搓 `upgrade`；`ws` 可用但必须自己声明。**
   官方入口 `webServer.registerUpgrade`（`webserver/src/index.ts:460-466`），Gateway 自己就用它（`gateway/src/index.ts:273-309`）；同一路径重复注册会抛错。`ws` 在 `gateway/package.json:66`、`liveshare/package.json:68` 有，但那是宿主的依赖。
   → 设计必须：守卫若挂宿主 webServer 就走 `registerUpgrade` + 自声明 `ws`；若独立端口则明说"不共享 DSH 的 `/api` 围栏"。

7. **打包兼容性声明目前是空转的，且范围写法在"非 includePrerelease"世界里会把 0.2.2-rc.1 排除。**
   `dsh.compatibility.dshReleases`、`dsh.compatibility.dsh` **没有任何读取者**（全检出 `dsh.compatibility` 0 命中；类型 `packages/util/package-manifest/src/types.ts:32-41` 的 `DshManifest` 只有 `manifestVersion/bundle/profile/client`）。真正的门是 `engines.dsh`，缺失时回退查 `@deepseek-ai/dsh*` peers（`packages/boot/app-boot/src/plugin-compatibility.ts:55-73`）；判定用 `semver.satisfies(runtime, range, { includePrerelease: true })`（:51-53）。
   → 设计必须：加 `"engines": { "dsh": ">=0.2.1-rc.2 <0.3.0-0" }`（在该判定下 0.2.1-rc.2 / 0.2.1-rc.5 / **0.2.2-rc.1** 全部 Y，0.3.0-rc.1 = n），并把 `dsh.compatibility` 同步成同一范围 + `dshReleases` 补 `"0.2.2-rc.1": "compatible"`（照 `dsh-mobile-layout/package.json:46-52`），另加 `"manifestVersion": 1`。实测矩阵见 §3。

8. **插件 client 半边依赖一个 0.2.2-rc.1 里已不存在的包。**
   `dsh-remote-hub/package.json:52` 固定 `@deepseek-ai/dsh-client-runtime: ^0.1.0-rc.6`，`client/src/*` 从 `@deepseek-ai/dsh-client-runtime/client` 取 `ClientContext`；但 0.2.2-rc.1 检出里没有这个包（410 个包全量比对无此名），其内容已分散（如 `SlotRegistry` → `packages/client/ui-renderer/src/client/registry.ts:120`）。
   → 设计必须：client 半边改用 `import type { Context } from '@deepseek-ai/cordis'`（检出内所有 Client 包的现行做法，如 `packages/client/locale/src/client/index.ts:7`），删除该 devDependency，否则 `typecheck` 永远对着 0.1.x 的旧形状通过。

---

## 3. 打包兼容性对照（`dsh-remote-hub/package.json`）

现状（`E:\Code\DSH\plugins\dsh-remote-hub\package.json`）：

| 行 | 内容 | 实际效果 |
|---|---|---|
| 18-24 | `dsh.client = { inject: [dsh-api-remotes, dsh-client-ui-slots], platform: "web" }` | 只驱动浏览器侧模块图的**加载顺序**：类型注释原文 "Informational package-name dependencies, **not Cordis service injection**"（`packages/util/package-manifest/src/types.ts:90-91`）。它**不构成**服务注入门控，也不能当 allow-list 用。 |
| 25-31 | `dsh.compatibility = { dsh: ">=0.2.1-rc.2", dshReleases: { "0.2.1-rc.2": "compatible", "0.2.1-rc.5": "compatible" } }` | **零作用**：无读取者；`DshManifest` 类型里没有这两个字段（`types.ts:32-41` 只有 `manifestVersion/bundle/profile/client`） |
| 39-41 | `engines = { node: ">=22.12.0" }` | 没有 `engines.dsh` → 回退查 peers |
| 42-49 | `peerDependencies = { "@deepseek-ai/cordis": "^4.0.1" }`（optional） | 没有任何 `@deepseek-ai/dsh*` peer → `unmetRequirements` 返回 `{}`，**任何 DSH 版本都被放行**（`plugin-compatibility.ts:62-73`） |

semver 实测（`semver@7.8.5`，`includePrerelease` 分列）：

| range | 0.2.1-rc.2 | 0.2.1-rc.5 | **0.2.2-rc.1** | 0.2.2 | 0.3.0-rc.1 |
|---|---|---|---|---|---|
| `>=0.2.1-rc.2`（现声明）plain | Y | Y | **n** | Y | n |
| `>=0.2.1-rc.2`（现声明）includePrerelease | Y | Y | Y | Y | **Y** |
| `>=0.2.1-rc.2 <0.3.0-0` plain | Y | Y | **n** | Y | n |
| `>=0.2.1-rc.2 <0.3.0-0` includePrerelease（**DSH 实际算法**） | Y | Y | **Y** | Y | n |
| `^0.2.1-rc.2` includePrerelease | Y | Y | Y | Y | n |

结论：**现声明在 DSH 自己的判定下"恰好收下" 0.2.2-rc.1，但同时错误地收下整个 0.3.x（含 0.3.0-rc.1），所以既不够窄也不可信**；而任何用普通 semver 语义读它的工具（含现成 CI 脚本）会把 0.2.2-rc.1 判成不兼容。

建议声明（与同作者的 `dsh-mobile-layout` 对齐，但收紧上界）：

```jsonc
"engines": { "node": ">=22.12.0", "dsh": ">=0.2.1-rc.2 <0.3.0-0" },
"dsh": {
  "manifestVersion": 1,
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "inject": ["@deepseek-ai/dsh-api-remotes", "@deepseek-ai/dsh-client-ui-slots"], "platform": "web" },
  "compatibility": {
    "dsh": ">=0.2.1-rc.2 <0.3.0-0",
    "dshReleases": { "0.2.1-rc.2": "compatible", "0.2.1-rc.5": "compatible", "0.2.2-rc.1": "compatible" }
  }
}
```

依据：`engines.dsh` 是唯一被读取的字段（`packages/boot/app-boot/src/plugin-compatibility.ts:55-61,87-102`；文档 `docs/user/develop/basic/publish.zh.md:66`、`docs/user/guide/plugin-market.zh.md:135-137`）；`dsh.compatibility` 无类型、无读取者，保留只为与生态里其他插件（`dsh-mobile-layout/package.json:46-52`）人读一致。

---

## 4. 文档中已过时/错误的引用路径清单

### 4.1 §14.2 里不存在的路径

| 文中路径 | 状态 | 正确路径 |
|---|---|---|
| `packages/api/remotes/lib/types/index.d.ts` | 不存在（检出无任何 `lib/` 构建产物，只有 `src/`） | `packages/api/remotes/src/index.ts`（+ `src/types.ts`） |
| `packages/api/remotes/lib/types/client/index.d.ts` | 不存在 | `packages/api/remotes/src/client/index.ts` |

§14.2 其余各行所引文件全部存在（逐条 `Test-Path` 已验）：`api/remote-access/{README.zh.md,src/index.ts,src/types.ts,src/client/*}`、`typert/protocol/src/{types.ts,remote-access.ts,index.ts}`、`api/gateway/{README.zh.md,src/types.ts,src/index.ts,src/remote-error-codes.ts}`、`api/remotes/README.zh.md`、`client/connection/src/{rpc-host,peer,api-request-trust,index,rpc}.ts`、`host/webserver/src/{index,injections}.ts`、`experimental/liveshare/src/host/{viewer-principal,viewer-lifecycle,viewer-access-policy,viewer-read,share-host}.ts`、`api/session-controller`、`api/settings-controller`、`api/workspace-files`、`client/file-upload`、`interaction/user-approval/src/index.ts`、`extensions/tool-cordis/src/api-catalog.ts`（`remoteAccess` 条目确在 **2505** 行，原文"2504 行起"差 1 行）。

### 4.2 §13 证据列的系统性缺陷：多数条目省略 `packages/` 前缀

F1、F3、F4 写了 `packages/`，其余 F 条大多没写；若照抄 `cd` 过去都会失败。需补 `packages/` 的：

`experimental/liveshare/src/host/viewer-read.ts`（F8）、`client/connection/src/rpc.ts`（F8）、`client/connection/src/{rpc-host.ts,api-request-trust.ts}`（F9、F10）、`api/gateway/README.zh.md`（F11、F12、F16）、`typert/protocol/src/types.ts`（F11）、`api/session-controller/src/index.ts`（F13）、`client/file-upload/src/index.ts`（F14）、`api/workspace-files/src/index.ts`（F14）、`api/settings-controller/src/index.ts`（F15）、`interaction/user-approval/src/index.ts`（F16）、`typert/protocol/src/index.ts`（F17）、`boot/cmdline/src/index.ts`（F18）、`host/webserver/src/index.ts`（F18）、`api/remote-access/README.zh.md`（F19）。

### 4.3 §14.3 类型源已过期

`E:/Code/DSH/plugins/dsh-solution-explorer/node_modules/` 下装的是 **0.1.0-rc.8**（`@deepseek-ai/dsh-api-remotes`、`dsh-api-gateway`、`dsh-typert-protocol`、`dsh-client-connection`、`dsh-client-runtime` 全部 0.1.0-rc.8），而被审计的检出是 **0.2.2-rc.1**。用它"核对线上形状"会得到两个版本前的形状。
另：`@deepseek-ai/dsh-typert-protocol` 在该 `node_modules` 顶层**不存在**，只有 `.pnpm/node_modules/` 下有一份——§14.3 写的正是 `.pnpm/...` 路径，所以该条本身没错，但顶层裸导入会失败。

---

## 5. §8.6 映射表遗漏的官方 endpoint（对远端控制有实际意义）

来源：`@Remote` 装饰器全量扫描（`packages/**/src`，排除 tests/lib）＋ 各服务 `super(ctx, key, {namespace})`。**namespace 缺省等于 service key**（`packages/typert/protocol/src/index.ts:242`），所以 `GoalService` 的端点是 `goals/*` 而不是 `goal/*`。

> 「方法定义」列的行号指向 **`@Remote` 装饰器所在行**（方法签名在其下一行）。

| 官方 endpoint | 服务/namespace 定义处 | 方法定义 | 为何与远端控制相关 |
|---|---|---|---|
| `terminal/create` | `packages/api/terminal-controller/src/index.ts:103`（namespace `terminal`） | :158 | 远端真正"开一个 shell"的入口；不经工具/审批链 |
| `terminal/attach` | 同上 | :215（`@Remote({mode:'stream'})`，双向 `RemoteStream<TerminalFrame,TerminalInput>`） | 唯一的上行输入通道，权限模型必须覆盖 |
| `terminal/retain` / `terminal/list` / `terminal/close` / `terminal/rename` / `terminal/shells` / `terminal/environment` | 同上 | :198 / :144 / :240 / :228 / :133 / :118 | 只读监控设备可给 `list`+`retain`，不给 `create`/`attach` |
| `job/list` `job/follow` `job/kill` | `packages/api/job-controller/src/index.ts:59`（namespace `job`） | :75 / :90 / :109 | 后台任务面板；`kill` 是写动作，必须 role 化 |
| `goals/get` `goals/edit` `goals/pause` `goals/resume` `goals/complete` `goals/clear` `goals/create` | `packages/goal/goal/src/index.ts:249`（service key `goals`，无 namespace 覆盖） | :278 / :330 / :353 / :365 / :392 / :434 / :645 | 目标循环是长任务的可见性核心；`goals/create` 是写 |
| `workspace/follow` | `packages/api/workspace-controller/src/index.ts:72`（namespace `workspace`） | :205（stream） | Workspace/会话归属的 baseline+增量，比 `session/list` 更省调用 |
| `workspace/{create,initializeDefault,rename,delete,insertBefore,insertSessionBefore,archiveSession,unarchiveSession,pinSession,unpinSession}` | 同上 | :90/:103/:119/:129/:139/:149/:159/:169/:179/:189 | 全是写；`archiveSession` 影响可见性 |
| `workspaceFiles/list` | `packages/api/workspace-files/src/index.ts:200`（service key `workspaceFiles`） | :303 | 目录浏览（§8.6 只列了 read/readBytes/stat） |
| `workspaceFiles/changes` | 同上 | :340（stream） | 远端"文件变了"的唯一推送源 |
| `session/attachment` | `packages/api/session-controller/src/index.ts:499` | :499 | §9.2 已隐含承认的跨会话读风险点，必须显式在 role 矩阵里处理 |
| `session/updateQueue` `session/rename` | 同上 | :509 / :436 | 队列编辑与改名都是写 |
| `session/state` `session/wait` `session/observeState` | 同上 | :575 / :597 / :586 | 只读监控可用 `state`/`observeState`，不必拉整页历史 |
| `session/observeEvent` `session/observeProjections` | 同上 | :553 / :564 | 比 `follow` 更细的订阅粒度 |
| `session/search` | 同上 | :295 | 已按 `allows()` 过滤（:298），只读设备可安全开放 |
| `userQuestions/attachWait` `userQuestions/answer` | `packages/interaction/user-questions/src/index.ts:86`（service key `userQuestions`） | :220 / :169 | 与审批并列的"人机交互"面；`answer` 是替 owner 决策，风险等级同审批 |
| `credentials/describe` `credentials/set` `credentials/unset` | `packages/api/settings-controller/src/credentials.ts:70`（namespace `credentials`） | :82 / :99 / :112 | **绝不能**下放给远端（明文凭据写入） |
| `directoryPicker/{pick,list,createDirectory}` | `packages/api/workspace-controller/src/directory-picker.ts:46`（namespace `directoryPicker`） | :54 / :71 / :87 | `pick` 会在 Host 桌面上弹原生对话框，远端调用等于远程操控宿主 UI |
| `pluginInventory/list` | `packages/host/plugin-inventory/src/index.ts:55` | :70 | 安全审计信息（装了什么插件） |
| `remoteAccess/follow` | `packages/api/remote-access/src/index.ts:269` | :269 | **恒放行**（`:202`）；本插件若要下放，必须自己再判 role |

另两条 §8.6 未提但决定事件面的事实：

- 转发事件允许清单在 `packages/api/remotes/src/remote-events.ts:27-59`，**只有两个 waterfall**：`approval/request`（:29）与 `user-questions/request`（:57）；其余全是 `emit`，非 owner 只有在 `decide({action:'event:<name>'})` 放行时整条收到（`packages/api/gateway/src/index.ts:615-636`）。
- exact Fetch 路由（如 `POST /api/session/uploadFileBinary`）**绕过 Gateway 访问判定**，对非 owner 直接 403（`packages/client/connection/src/rpc-host.ts:218-222`）。所以"文件上传"走 `fileUploads/upload`（Remote 调用）而不是那条 binary 路由，除非放弃非 owner 支持。

---

## 6. 未能验证、也不应假装验证的部分

- A5/A6/A7/A8/A15：外部依赖、外部行为或构建环境，检出内无对应代码，需在真机/CI 上取证据。
- A9/A10：产品/UX 决策，不是源码事实。
- A2/A3 的"运行时可用"：静态无门控已确认，但"该 profile 真的装了 Connection 与 Gateway"必须靠 M0 探针（`ctx.inject(['connection','typertGateway'])` + `createPeer` + `session/list`）在真实 profile 里跑一次。探针若失败，失败点会在"服务不存在/endpoint 未被认领/policy 未注册"三者之一，读本文件第 2 节第 1、2 条即可定位。
