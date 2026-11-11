# 03 · LiveShare 官方先例实现级摘要

> 证据基线：只读源码检出 `E:\Code\DSH\plugins\deepseek-harness`（v0.2.2-rc.1）。下文所有 `path:line` 均为本次实际读取过的位置；未读到的内容不写。
> 路径均相对该检出根；`LS` = `packages/experimental/liveshare`，`LSP` = `packages/experimental/liveshare-protocol`。
> 结论先行：`dsh-remote-hub` 设计文档中"必须全部手写"的六件事（非 owner 主体、按角色绑定资源、中继/隧道、凭据持久化、reload/吊销传播、原子写），官方已在 `LS` 中逐件实现，且多数能力由可发布的公共包提供而非 `LS` 自身。

---

## 1. Viewer 主体与访问策略

### 1.1 声明新的主体种类（`PrincipalMap` 合并）

- `LS/src/host/viewer-principal.ts:16` — `declare module '@deepseek-ai/dsh-typert-protocol' { interface PrincipalMap { 'share-viewer': ShareViewerPrincipal } }`
- `LS/src/host/viewer-principal.ts:24` — `export interface ShareViewerPrincipal { readonly kind: 'share-viewer'; readonly shareId: string; readonly actor: { providerId; tenantId; subjectId; displayName? } }`
- 工作方式：主体只携带"哪个分享 + 中继断言的身份三元组"，**不含任何凭据**（:7 的注释明确说明它会被写进 Session 日志的 `source.principal`）。构造器 `shareViewerPrincipal(shareId, actor)`（:46）逐字段拷贝，因此中继 actor 上多出的 credential/avatar 字段落不进持久值。
- 相等性用 `isShareViewer`（:78）与 `identityKeyOf` 比较：同一 subject 在两个 provider/tenant 下是两个人。

### 1.2 注册策略

- `LS/src/host/share-host.ts:289` — `ctx.inject(['remoteAccess'], (scope) => { scope.remoteAccess.registerPolicy('share-viewer', createViewerAccessPolicy(accessFacts)) })`
- `packages/api/remote-access/src/index.ts:153` — `registerPolicy<K extends Exclude<keyof PrincipalMap,'owner'>>(kind: K, policy: RemoteAccessPolicy<PrincipalMap[K]>): () => void`
- 工作方式：策略挂在**调用者 fiber** 上，注册即 `invalidate()`、dispose 即再 `invalidate()`（:157-164）；**同一 kind 重复注册直接抛错**（:155），所以第三方插件不能复用 `share-viewer` 这个名字。
- 变更传播：`share-host.ts:233` `accessChanged()` → `ctx.get('remoteAccess')?.invalidate()`；已打开的访问快照会被重算（`remote-access/src/index.ts:175-181`）。

### 1.3 角色 → 资源绑定（六条角色，按资源种类划分）

| 角色常量 | 资源种类 | 动作 | 位置 |
|---|---|---|---|
| `VIEWER_GLOBAL_ROLE` = `liveshare:viewer-global` | `global` | `session/list`、`session/control`、`commands/list`、`llm/listProviders` 等 8 项 | `viewer-access-policy.ts:97` |
| `VIEWER_SESSION_READ_ROLE` = `liveshare:viewer-session-read` | `session` | `session/page`、`session/follow`、`session/events`、`session/observe*`、`fileUploads/upload` 等 + `event:api-session/*` 五条 | `viewer-access-policy.ts:119` |
| `VIEWER_FORK_ROLE` = `liveshare:viewer-fork` | `session` | `session/fork` | `:156` |
| `VIEWER_SOURCE_WRITE_ROLE` = `liveshare:viewer-source-write` | `session` | `session/prompt`、`session/cancel` | `:163` |
| `VIEWER_CHILD_ROLE` = `liveshare:viewer-child` | `session` | `session/prompt`、`session/cancel`、`session/rename` | `:177` |
| `VIEWER_WORKSPACE_ROLE` = `liveshare:viewer-workspace` | `workspace` | `workspace/follow` | `:184` |

- `bindings(viewer)`（`viewer-access-policy.ts:447`）每次调用现算：先 `servingShare()`（:284）判定 `share-not-found / share-stopped / share-expired / viewer-not-authorized`，**任一不成立就返回空绑定数组**（:448-449）——即默认拒绝。
- 绑定三元组是 `{ role, resource, condition? }`；`RemoteAccessBinding` 的形态见 `packages/api/remote-access/src/types.ts:60`，`condition` 同步求值（:53），允许"同一角色 + 每资源不同条件"。
- 条件示例：源的写权 `condition: () => answer(sourceWriteRefusal(mode, facts.sourceConfined(shareId)))`（:468-471）；子会话写权按 `childWriteRefusal(...)`（:491-493）。
- 工作区绑定只为"含读者可见 Session 的 Workspace"生成（:497-502）。

### 1.4 能力分层（view 档 vs bounded-write 档）

- 档位类型只有两个值：`ViewerSessionMode = 'view' | 'write'`（`LS/src/host/fork-policy.ts:23`），语义是"驱动循环但不写" vs "还可改授予工作区内的文件"，两者**都驱动共享 Session**（:18-22）。
- 工具上限是数据结构而非配置：`READ_ONLY_FORK_CEILING`（:141）列出允许工具 + `deniedCapabilities`（含 `bash`、`pwsh`、`cua`、`plugin_manager`、`write`、`edit`、`subagent` 等）；`WRITE_FORK_CEILING`（:170）在只读上限上仅放开 `write`/`edit`。
- 单次工具调用判定：`forkToolDecision(ceiling, request)`（`LS/src/host/fork-ceiling.ts:44`）——无上限装 → `fork-ceiling-uninstalled`；Session 不是该子 → `fork-child-mismatch`；工具不在名单 → `fork-tool-not-permitted`。
- 插件能力是**追加**的、不能覆盖核心角色：`POLICY_DECIDED_ACTIONS`（`viewer-access-policy.ts:213`）由 `reader-*` 分类表与转发事件集派生，并在模块加载时用 `assertSameViewerActions`（`LS/src/endpoint-classification.ts:290`）断言与角色动作集**完全相等**（`viewer-access-policy.ts:217`）；暴露的插件端点作为新绑定追加在最后（:511-523），因此 `session/prompt` 之类不会被"插件全开"绕过条件。
- 只读拒绝码统一为 `liveshare/read-only`（`LS/src/viewer-channel.ts:96`）。

### 1.4b 快照（客户端如何知道"我能做什么"）

- `snapshotFor(principal)`：owner 只得到 `{ type:'baseline', owner:true }`；非 owner 得到 `grants` 列表（`packages/api/remote-access/src/index.ts:253`）。
- `grantsFor(principal)`（:355-376）：按 `bindings` 首次出现顺序、每资源取一次；对每个动作**不带 args 再求值一次 condition**，只保留 allow 的、排序后发出；`event:*` 动作**不进快照**（:369）。
- 推送通道：`@Remote({ mode: 'stream' }) follow(signal)`（:269-299）——先 baseline，之后每次 `invalidate()` 只发差异 `upsert`/`remove`（:288-294）。
- 首帧注入：`webserver/index-inject` 把快照塞进 index（:138-142），页面首渲染就有权限表，不必等流。
- 唯一的"绕过策略"端点：`remoteAccess/follow` 被 `decide()` 无条件放行（:44、:202），分类表中标记为 `always-allowed`（`LS/src/endpoint-classification.ts:79`）。

### 1.5 生命周期（Peer / 流 / 调用 / 子限制的统一回收）

- `LS/src/host/viewer-lifecycle.ts:253` — `createViewerLifecycle(deps: ViewerReadDeps): ViewerLifecycle`；内部持有 `streams`、`calls`、`opening`、`enforcement`、`peers` 五张表（:254-287）。
- 流空闲回收：`VIEWER_STREAM_IDLE_TTL_MS = 120_000`（:32），扫查周期 30s（:34），定时器 `unref()`（:346）——"页面会消失"用轮询空闲表达（:319-326 注释）。
- `cancelPendingCalls`（:415）、`recheckAdmission`（:419）、`closeShare`（:438）、`closeViewerStreams`（:463）、`close`（:484）五个粒度；`closeShare` 会连带释放该分享子会话的 enforcement（:456-460）。
- 门面组装：`LS/src/host/viewer-read.ts:216` `createViewerReadService()`，把 `lifecycle`/`fork`/`dispatch` 三者用晚绑定互解循环依赖（:221-222）。

---

## 2. Peer 创建与请求分派

### 2.1 非 owner Peer

- `LS/src/host/viewer-lifecycle.ts:294` — `const peer = connection.createPeer({ principal: shareViewerPrincipal(shareId, actor) })`
- 复用键：`(shareId, identityKey(actor))`（:288-297），**每个分享每个身份一个 Peer**，该身份的所有页面/标签页共享它；Peer 被 dispose 后下一次请求重建（:281-286 注释）。
- Peer 本体：`packages/client/connection/src/peer.ts:38`；`principal` 创建时固定、线上字段无法设置（`packages/typert/protocol/src/types.ts:468-483`）。
- 依赖面只有两个成员：`viewer-read.ts:28` `type ViewerReadConnection = Pick<HostConnectionHandle,'createSharedFetchHandler'|'createPeer'>`——第三方无需整包依赖 Connection 服务。

### 2.2 以该 Peer 身份走 gateway

- 一元调用：`LS/src/host/viewer-dispatch.ts:152-160`
  `const handler = deps.connection?.createSharedFetchHandler('/api')` → `handler.fetch(new Request('http://liveshare.internal' + path, {...}), peer)`。
- 唯一路由选择点：`packages/client/connection/src/rpc-host.ts:207-232`——先查精确 fetch 路由（**非 owner 直接 403**，:221），否则交给 `/api` 的 RPC interceptor（`packages/api/gateway/src/index.ts:249-253` 注册）。
- 因此"官方 gateway 不给非 owner 的操作"表现为 `403/404`，`viewer-dispatch.ts:170-178` 把它翻译成 `owner-route-not-shared` 并附带提示："把方法注册成 Typert Remote，LiveShare 才能授权"。
- 流：`viewer-dispatch.ts:396-402` `deps.gateway.wireStream.open(endpoint, payload, emptyViewerUplink(), peer, controller.signal)`；契约见 `packages/api/gateway/src/types.ts:92-109`，`typertGateway.wireStream` 实例见 `packages/api/gateway/src/index.ts:224`。上行恒为空：`viewer-dispatch.ts:654`（`emptyViewerUplink`）。

### 2.3 `interactions` 与 `$events`

- `LS` **不传 `interactions`**，因此取默认 `'answer'`（`packages/client/connection/src/peer.ts:19`、`:40`）。
- 好处：非 owner 可以开 `$events` 流——`packages/api/gateway/src/index.ts:534-539` 只校验 `peer.interactions === 'answer'`（`requireInteractions`，:1242）。
- 边界：`answers: peer.principal.kind === 'owner'`（`index.ts:584`），而 `$events/result` **只允许 owner Peer**（:502-504，否则 `gateway/invocation-unavailable`）。所以 viewer 能看到通知、能收到 ready 帧，但**不能替 owner 回答任何 waterfall（审批/提问）**。
- 事件过滤：`broadcastRemoteEvent`（:615-637）对 `!client.answers` 的客户端用 `remoteAccess.decide({ action: 'event:'+帧名, resources })` 逐条过滤（:633）；资源解析失败则该条谁都不发（:632）。
- 回证：`LS/tests/viewer-event-authority.spec.ts:85-103` 证明 reader 只收到 source 与自身 fork 的 `api-session/*`；`:170-174` 证明 reader 调 `$events/result` 得到 `gateway/invocation-unavailable`，owner 同一调用成功。

### 2.4 官方 gateway 不提供的读写面，`LS` 如何补

| 需求 | `LS` 的做法 | 位置 |
|---|---|---|
| 读 owner 渲染后的 index / shell 资源 / 客户端插件 bundle | 自定义 `asset` 操作，走 `webServer.readResource(new Request(target), peer)` 与 `clientModules.fetchBundle`，以 base64 回传 | `LS/src/host/viewer-assets.ts:29`、`:34`、`:45` |
| 页面资源白名单 | `isViewerAssetPath`：只允许 `''`、`index.html`、`assets/*`、`plugins/*` 与三个顶层文件；`*.map` 一律拒 | `viewer-dispatch.ts:694`、`:703`、`:727` |
| 流（只读、轮询化） | 自定义 `stream-open` / `stream-next` / `stream-cancel` 三操作 + 短持有预算 | `LS/src/viewer-channel.ts:28-48`、`viewer-dispatch.ts:361`、`:448` |
| 断流/端序语义 | `read-budgets.ts:16` `STREAM_POLL_HOLD_MS=10_000`、`:26` `STREAM_BATCH_MAX=64`、`:34` `STREAM_BATCH_WINDOW_MS=4`、`:43` `STREAM_POLL_SLACK_MS=2_000`、`:49` `VIEWER_READ_TIMEOUT_MS=25_000`（预算必须单向递增，:2-8 注释） |
| fork（需要异步状态，同步策略读不到） | 在 dispatch 前单独分类并交给 `fork().answerFork(...)` | `viewer-dispatch.ts:334`、`LS/src/host/viewer-fork.ts:150` |
| fork 幂等 | `forkRequestKey(actor, shareId, source, operationId)` + `reserveOperation` / `recordOperation` 持久化 | `viewer-fork.ts:306`、`:176-178`、`LS/src/host/fork-registry.ts:160`、`:176` |
| 客户端如何说话 | `installViewerCarrier` 在页面里替换 `globalThis.fetch`、装 `__DSH_TRANSPORT__`，把 Connection 调用转成 `POST {base}/__share/rpc` | `LSP/src/viewer-carrier.ts:43`、`:52`、`:293-294` |
| 可重试 vs 终态 | carrier 只把 408/429/502/503/504 与 `stream-not-found`/`gateway/cancelled` 当可重试 | `viewer-carrier.ts:45`、`:49`、`:111-115` |

---

## 3. 传输、信任边界与鉴权

### 3.1 信任边界：谁断言身份

- **中继断言、主机执行**：`LSP/src/tunnel-protocol.ts:152-159` — `ShareRpcFrame.actor` 的注释是"owner 唯一可据以行动的身份；浏览器从不提供它；它走在不透明 body 之外"。
- 主机侧只读这个字段：`LS/src/owner-gateway/worker.ts:297-306` 把 `actor: frame.actor` 原样放进 IPC 事件；`LS/src/host/tunnel-supervision.ts:357` 把它交给 `viewerRead().answer(shareId, request, event.actor, signal)`。
- 请求体本身不被任何人解读：`tunnel-supervision.ts:343` 只做 `parseViewerRequest(event.body)` 的形状校验；中继"原样转发"是设计前提（`LS/src/host/viewer-read.ts:4`）。
- 中继侧 ACL 复核：`LS/src/host/relay-authority.ts:44` `requesterStillAdmitted(share, requester)`——空 ACL + `open` 等于对全组织开放，否则按 subjectId 或身份键匹配（:48-50）。

### 3.2 主机本地 HTTP 面：只有 owner 登录路由

- 三条同源路由：`/api/liveshare.ownerCredential`（`LS/src/host/owner-http-routes.ts:138`）、`ownerLoginStart`（:182）、`ownerLoginRedeem`（:225）、`ownerLoginCancel`（:273）。管理面全部走 `liveshareShares` Remote（`LS/src/host/share-remote.ts:42`、`:56`）。
- 它们注册在 `connection.fetch.register(...)` 上，因此仍经过 `/api` 的 Host/Origin 围栏与浏览器鉴权：`packages/client/connection/src/index.ts:141-160`（先 `connection.admit(req)` 再 `bridge(...)`）。

### 3.3 凭据铸造 / 校验 / 过期 / 重放

| 机制 | 实现 | 位置 |
|---|---|---|
| 分享管理令牌 `gatewayToken` | `base64Url(randomBytes(32))`，随分享持久化，作 `Authorization: Bearer` 调中继 | `LS/src/host/owner-share-operations.ts:283`；使用处 `relay-authority.ts:160`、`tunnel-supervision.ts:488`、worker 握手 `owner-gateway/worker.ts:160` |
| owner 凭据签发（PKCE） | `verifier = base64url(randomBytes(32))`、`challenge = sha256(verifier)`；浏览器只拿 challenge | `LS/src/host/owner-authorization.ts:101-105` |
| 事务绑定与一次性 | `state = base64url(randomBytes(16))` 作键（:103）；`complete()` 校验 origin / relay / instanceKey 后 `pending.delete(state)`（:136-141） | `owner-authorization.ts:124` |
| 事务 TTL | `DEFAULT_TTL_MS = 5 * 60 * 1000`（:62），`sweep()` 清理（:165） | 同上 |
| 重放 | 中继回 `code-replayed` → 主机回 `owner-login-replayed` | `owner-http-routes.ts:264` |
| 凭据过期语义 | `ownerCredentialState(stored, relay, now)`：`unverified` / `verified` / `expired`；**签名过期只是下界**，真正 horizon 由中继回包的 `ownerCredentialExpiresAt` 覆盖 | `LS/src/host/owner-credential-file.ts:131`、`tunnel-supervision.ts:716-732` |
| 凭据按地址绑定 | 换中继不发送旧 token：`credentialForRelay` 先比较归一化地址 | `tunnel-supervision.ts:665-673` |
| 中继权威版本化 | `applyRelayAccess` 丢弃 `previous.version >= state.version`；每次读取用 generation + token + relay 三重栅栏 | `relay-authority.ts:291-297`、`:339-350` |

### 3.4 逐请求签名：**没有**

- 全仓无 `createHmac` / `timingSafeEqual` 用于 LiveShare 请求帧（该两者只出现在浏览器 cookie：`packages/client/connection/src/browser-auth.ts:110`、`:142`）。LiveShare 侧的密码学只有 `createHash`（PKCE）与 `randomBytes`：`owner-authorization.ts:12`、`owner-share-operations.ts:10`、`owner-persistence.ts:9`。
- 协议里为"逐请求凭据"**预留了字段但明确未实现**：`LSP/src/tunnel-protocol.ts:173-179` `actor.credential?` ——"Absent today: the Relay asserts the triple itself. The protocol does not verify it."
- 结论：身份信任完全建立在"中继 WebSocket 是独占的、由主机主动发起"这一信道假设上，而非消息级签名。

### 3.5 转发头伪造与 DNS rebinding

- 代码中**不读任何 `x-forwarded-*`**（全仓 grep 仅命中一处被忽略的测试用头：`packages/client/connection/tests/node-half.host.spec.ts:258`）。身份不来自头，因此不存在"信任转发头"的攻击面。
- rebinding 防线一：监听地址必须是具体 IP 字面量，通配地址直接抛错：`packages/host/webserver/src/index.ts:359-366`（错误文案即"绑定所有接口等于把 RCE 暴露到网络"）。
- rebinding 防线二：`isTrustedApiRequest` 的 Host 围栏对**每个**请求生效，且没有"带标记就放行"的捷径；随后 `sec-fetch-site: cross-site` 拒绝、`Origin` 存在时必须同源、`null` 源拒绝：`packages/client/connection/src/api-request-trust.ts:121`、`:134-140`、`:143`、`:148-150`。
- 配置项本身也在加载期校验，防"看起来是 host 其实是带路径/账号的 URL"：`api-request-trust.ts:53` `assertTrustedAuthority`。
- TLS 协议由监听器配置决定、不来自请求头：`webserver/src/index.ts:420-422`。

---

## 4. 隧道

### 4.1 "隧道"到底是什么

- **没有任何第三方隧道 provider**（`cloudflared`/`tailscale`/`ngrok`/`frp` 全仓 0 命中）。所谓 tunnel = 一个**被 `spawn` 出来的子进程**，它自己向 Relay 开 WebSocket：`LS/src/host/tunnel-worker.ts:84-91`（`stdio: ['ignore','pipe','pipe','ipc']`）+ `LS/src/owner-gateway/registration-url.ts:26-28`（`${basePath}/__tunnel_gateway__`，https→wss）。
- 一个进程多路复用全部分享：`LS/src/owner-gateway/worker.ts:63` `runGatewayWorker()`，`shares: Map<shareId, GatewayState>`（:64）。
- 入口：`LS/src/owner-gateway/cli.ts:3-6`，且**强制要求 IPC 通道**（`process.send === undefined` 直接抛错）。

### 4.2 子进程监管

- 类：`tunnel-worker.ts:48` `export class TunnelWorker`；`start()`（:76）先建私有日志目录 `mkdtempSync` + `createWriteStream(..., { flags:'a', mode: 0o600 })`（:82-83）。
- 重启：`onExit()`（:256）清 `ready`、取消全部挂起请求、对每个注册项发 `share-error`，然后 `scheduleRestart()`（:280）——延迟取自 `retryBackoff`，并在重启前 `replayRegistrations()` 把"当前意图"重放（:293、:318-325）。
- 退避参数：`INITIAL_RETRY_BACKOFF = { delayMs: 500, attempt: 0 }`、`RETRY_BACKOFF_MAX_MS = 10_000`、`RETRY_STABLE_MS = 30_000`（`LS/src/owner-gateway/retry-backoff.ts:19`、`:22`、`:29`）；连接撑过 30s 即视为健康、退避归零（:44）。
- 无分享则不起：`if (this.registrations.size > 0) this.scheduleRestart()`（`tunnel-worker.ts:276`）。
- 停止序列：`send({type:'shutdown'})` → 1s SIGTERM → 2s SIGKILL（:186-194）。
- 健康检查在**每个分享的 socket** 上：心跳 25s、容忍 2 次未答 pong（`worker.ts:27`、`:36`、`:177-193`），收到任意消息即清零（:201-204）。
- 传输设置显式下传：`NODE_EXTRA_CA_CERTS`、`SSL_CERT_FILE/DIR`、`HTTP(S)_PROXY` 等 12 个（`tunnel-worker.ts:353-377`）；`NODE_ENV` 与 `LIVESHARE_TUNNEL_MODE=gateway` 单独注入（:86-88）。

### 4.3 明确拒绝做的事

| 拒绝 | 位置 |
|---|---|
| 握手被 401/403/410/426 拒绝时**停止**该注册（不再重连，状态码即诊断） | `owner-gateway/relay-refusal.ts:13`、`worker.ts:232-241` |
| 不支持/不可解析的帧"回答"而非静默丢弃（400 / 501），避免对端一直等 | `LSP/src/tunnel-protocol.ts:381-414`、`worker.ts:211-219` |
| 没有 actor 的 `share-rpc` 帧直接判为非法并丢弃 | `tunnel-protocol.ts:344-346` |
| 绑定通配地址 | `packages/host/webserver/src/index.ts:359-366` |
| 未验证 owner 身份就发布分享（含"中继不支持身份绑定"） | `LS/src/host/owner-share-operations.ts:257-269` |
| 提供 source map | `viewer-dispatch.ts:707` |
| 读者 `session/fork` 打到非本源 Session | `LS/src/host/fork-policy.ts:207-213` |

### 4.4 可原样复用的部分

`owner-gateway/retry-backoff.ts`（46 行，纯函数）、`owner-gateway/relay-refusal.ts`（45 行）、`owner-gateway/pending-rpc.ts`（78 行，token + socket + id 三重相关）、`owner-gateway/registration-url.ts`（62 行，握手参数一处生成）、`host/relay-url.ts`（34 行，URL 归一化 + 拒绝带凭据/非 http(s)）、`host/base64-url.ts`（21 行）、`host/relay-fetch.ts`（102 行，自带 dispatcher、不替换全局）+ `host/relay-h2-idle.ts`（86 行，只吞 Relay 作用域内的 h2 idle 错误）。

---

## 5. 持久化

### 5.1 主状态文件（含 `gatewayToken` 明文）

- `LS/src/host/owner-persistence.ts:155` `writeOwnerState(file, relayUrl, instanceId, shares, pendingRemovals): Promise<void>`
- 原子写 + 权限：`writeFileAtomic(file, content, { mode: 0o600, dirMode: 0o700 })`（:192），来自 `@deepseek-ai/dsh-atomic-write`（:12）。
- 单文件写串行化：`ownerStateWrites: Map<file, Promise>` 链式排队，"最新内容最后落地"（:191-194、:198）。
- 读：`loadOwnerState`（:89）；文件存在但不可解析时**抛错**而不是清空（:95-99）。
- 实例身份：`newInstanceId()` = `base64Url(randomBytes(9))`（:213），存文件、进每次注册（`tunnel-supervision.ts:600`）。

### 5.2 凭据文件（**不打散、不哈希**）

- 原文引用：`saveOwnerCredential`（`LS/src/host/owner-credential-file.ts:59-64`）：
  `mkdirSync(dirname(file), { recursive: true })` → `writeFileSync(temporary, JSON.stringify(value,null,2), { mode: 0o600 })` → `renameSync(temporary, file)`。
- 即：**明文凭据 + 显式 0600 + 同目录 rename**；没有 KDF、没有 digest、没有分片、没有密钥环。
- 读：`loadOwnerCredential`（:26）——文件缺失是首次运行的正常态；损坏等同"没有凭据"（:48-51），此时要求 owner 重新验证。
- 撤销：`clearOwnerCredential(file)` = `rmSync(file, { force: true })`（:146）。**没有**密钥轮换、没有撤销列表、没有 generation/epoch 概念。
- 不做签名校验：`decodeOwnerCredential`（:74）只 base64url 解 payload 读 `expiresAt/displayName/subjectId/avatarUrl`，注释明说"这些字段从不授权任何东西，只有中继能验证签名"（:66-72）。

### 5.3 fork 登记（真正需要跨进程一致的文件）

- `LS/src/host/fork-registry.ts:19` — `import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'`
- `commit(delta)`（:370）：`mkdirSync(dirname)` → `withFileLock(this.file, async () => { 重新读取 → 应用本进程批次 → writeFileAtomic(..., { mode: 0o600 }) })`（:373-398）。
- 设计理由写在文件头（:9-14）：同一 DSH home 可能被多个 Host 进程服务，所以每次变更是**锁内 read-modify-write**；另一个进程写入的条目不会被本进程的旧副本覆盖。
- 失败不丢数据：`persist()` 把批次放入 `chain`，失败时 `retain(delta)` 把改动放回 pending，下一次变更重写（:346-359、:410-425）。
- 不可读文件拒绝改写：`readRegistry` 对存在但无法解析的文件抛 `notARegistry(file)`（:446-450、:469）。
- 撤销是**软删**：`revokeShare(shareId, now)` 只写 `revokedAt`，条目保留以保持审计与历史（:264-282）。

### 5.4 原始 helper 提供的能力

`packages/util/atomic-write/src/index.ts:80` `writeFileAtomic(filename, content, options)`：`mode` **必填**（:50-62，强制权限决策显式化）；临时文件随机后缀 + `flag:'wx'`（拒跟随攻击者预置的符号链接）+ rename；Windows 对 `EACCES/EBUSY/EPERM` 有界重试（:19-44）。`withFileLock`（:238）用 `wx` 建 `<file>.lock`，记录 PID，死锁持有者可被接管（:150-178），`waitMs` 默认 2000（:197）。

---

## 6. 可复用构件清单

> "可发布/可导入"依据：`package.json` 的 `private` 字段与 `publishConfig.access`，以及 `exports` 是否含 `.`。**所有列出的包都不带 `private: true`，均 `publishConfig.access: "public"`。**

| 包 | 给你什么 | exports（可导入入口） | 第三方可用性 | 版本/pin |
|---|---|---|---|---|
| `@deepseek-ai/dsh-http-proxy` | 代理策略库（非插件）：`createRouteDispatcher`、`proxyRouteFor`、`proxyEnvironmentForChild`、`clearedProxyEnv` | `.`、`./src/*` | ✅ 纯库，仅 peer `@deepseek-ai/cordis` | `undici: 8.11.2`（精确）；`packages/util/http-proxy/package.json:16`、`:33` |
| `@deepseek-ai/dsh-atomic-write` | `writeFileAtomic`（原子替换 + 权限位）、`withFileLock`（跨进程写者锁、死持有者接管） | `.`、`./src/*` | ✅ 零依赖库 | `packages/util/atomic-write/package.json:16` |
| `@deepseek-ai/dsh-typert-protocol` | `PrincipalMap` 声明合并点、`PeerScope`、`RemoteAccessResource(Kind)`、`@Remote`、`RemoteError` | `.`、`./types`、`./remote-info`、`./src/*` | ✅ | 依赖 `zod ^4.4.3` |
| `@deepseek-ai/dsh-api-remote-access` | `remoteAccess.registerPolicy/decide/allows/snapshotFor/follow`、`RemoteAccessRole/Binding/Condition/Policy` 契约 | `.`、`./types`、`./client`、`./typert`、`./remote`、`./src/*` | ✅（Host 面是 Cordis 服务） | `zod 4.4.3` |
| `@deepseek-ai/dsh-api-gateway` | `typertGateway.wireStream.open/failure`、`$events`/`$events/result` 语义、`TypertGatewayError` | `.`、`./client`、`./types`、`./stream-protocol`、`./src/*` | ✅ | `ws ^8.21.3`、`@deepseek-ai/dsh-typert-protocol` |
| `@deepseek-ai/dsh-api-remotes` | 唯一事件源注册：`ctx.typertGateway.registerRemoteEvents(source, { home })` | `.`、`./client`、`./types`、`./src/*` | ✅（peer 含 `dsh-scope`） | — |
| `@deepseek-ai/dsh-client-connection` | `Peer`、`createPeer({principal, interactions})`、`createSharedFetchHandler('/api')`、`admit/isTrustedApiRequest`、`HostConnectionHandle` | `.`、`./client`、`./src/*` | ✅ | `zod 4.4.3`、peer `dsh-scope` |
| `@deepseek-ai/dsh-host-webserver` | 路由/升级路由注册、`readResource(req, peer)`、通配绑定拒绝、`protocol` 真值 | `.`、`./src/*` | ✅ | 无 ws/undici |
| `@deepseek-ai/dsh-scope` | `createScope`（Peer 的 `ctx` 与事件域隔离的基础） | `.`、`./src/*` | ✅（Liveshare 的 peerDependency） | — |
| `@deepseek-ai/dsh-typert-registry` | `ctx.typert.local.list()`——枚举"已注册 Remote 方法"从而生成可分享目录 | `.`、`./client`、`./types`、`./src/*` | ✅ | `zod 4.4.3` |
| `@deepseek-ai/dsh-experimental-liveshare-protocol` | 线框类型 + `identityKeyOf/identityFromKey/normalizeIdentity` + 帧解析器 + `ViewerState/VIEWER_STATE_REACH` | `.`（**仅 `lib/index.js` + `lib/types`**，无 `./src/*`） | ⚠️ 框架可参考，但其 frame 是**它自己 Relay** 的方言；`files` 白名单见 `package.json:20-23` | 依赖 `dsh-brand` |
| `@deepseek-ai/dsh-experimental-liveshare` | 上述 1–5 节的完整实现 | `.`、`./client`、`./typert`、`./remote`、`./types`、`./src/*`、`./cordis.patch.yml` | ⚠️ **不能作为库复用**：它是 `apply()` 插件，注册固定 kind `share-viewer`（重复注册抛错，`remote-access/src/index.ts:155`），并在 `agent/created`/`agent/pre-step` 上装全局 listener（`share-host.ts:437`、`:482`）。且 `files` 只含 `lib/index.js`、`lib/client.js`、`lib/owner-gateway/cli.js`、`lib/types/**`、`lib/typert*.js`——`exports` 里的 `./src/*` 在发布包中**指向不存在的文件** | `ws ^8.18.3`、`undici 8.11.2`、`zod 4.4.3` |
| `@deepseek-ai/dsh-deque` | O(1) 双端队列（事件队列用） | `.`、`./src/*` | ✅ | — |
| `@deepseek-ai/dsh-util-crypto` | `bytesToBase64`、`randomUUID` | `.`、`./src/*` | ✅ | — |
| `@deepseek-ai/dsh-brand` | `Branded<T>` 标称类型 | `.`、`./src/*` | ✅ | — |

**pin 汇总（第三方需对齐）**：`ws` — gateway `^8.21.3`、liveshare `^8.18.3`、`@types/ws ^8.18.1`；`undici` — `8.11.2`（精确，出现在 `http-proxy` 与 `liveshare`）；`zod` — `4.4.3`（精确，多数包）与 `^4.4.3`（`typert-protocol`）。`@deepseek-ai/cordis` 一律是 **peerDependency**（`workspace:~`），第三方须自带 `^4.0.1`（本机 vendor 版本为 `4.1.0`，`publishConfig.public`）。

---

## 7. 缺口：LiveShare 模型装不下 device-token / 多设备 / Android

1. **没有"设备"这一实体。** 主体是 `{shareId, {providerId, tenantId, subjectId}}`（`viewer-principal.ts:24-35`），没有任何 `deviceId`/`tokenHash`/`createdAt`/`revokedAt`。持久化层只有 share 记录与 owner 凭据（`owner-persistence.ts:22-57`、`owner-credential-file.ts:9-19`），不存在设备表。
2. **授权是"每请求由中继断言"，不是"本地令牌。** `viewerAdmitted` 读中继最近一次下发的 `ShareAccessStateFrame`（`relay-authority.ts:262-266`），失效即 `invalidateRelayAccess`（:273-282）。这意味着离线/无中继时没有任何本地授权依据——与"本机签发设备令牌、离线也可校验"的模型相反。
3. **角色矩阵是"分享级"，不是"设备级"。** 档位只有 `view|write`（`fork-policy.ts:23`），fork 是独立布尔开关（:52-89），`read-only < control < full` 这种三档设备角色在模型里没有对应物。
4. **多设备共用同一 Peer 与同一组流。** Peer 键是 `(shareId, identityKey(actor))`（`viewer-lifecycle.ts:288`），两台同 subject 的手机会命中同一个 Peer；流的键是 `(shareId, 页面自编数字 id)`（`LS/src/host/viewer-lifecycle.ts:276` 的 `key()`），"两个页面编了相同 id"时**旧流的拥有者会被新开替换**（`LS/src/host/viewer-dispatch.ts:377-385` 明确 warn）。按身份吊销会同时杀掉该身份的全部设备（`viewer-lifecycle.ts:463-482` `closeViewerStreams`）。
5. **前端是"owner 的 Web shell"，Android 无法复用。** 页面通过 `asset` 读 owner 渲染出的 index，再由 `viewer-carrier.ts` 在浏览器里替换 `globalThis.fetch` 并安装 `__DSH_TRANSPORT__`（`viewer-carrier.ts:43`、`:293-294`）。这套载体是浏览器 JS 事实，原生客户端要么重写一套 carrier，要么依赖页面。
6. **审批/提问被显式排除在非 owner 之外。** `userQuestions/answer` 与 `userQuestions/attachWait` 都是 `owner-only`（`endpoint-classification.ts:214-215`），且 gateway 只允许 owner Peer 回答 `$events/result`（`gateway/src/index.ts:502-504`）。README 也写"interactive approvals and questions stay on the Host"（`LS/README.md:127`）。→ 设计文档 G5 里"Android 完成审批"在官方先例中**没有对应实现可抄**。
7. **绝对路径类文件面全部 owner-only。** `workspaceFiles/read|readBytes|stat` 标注"绝对路径能到达工作区外的文件，因此任何分享都不提供"（`endpoint-classification.ts:138-140`）。→ 手机端"看文件"必须自建受限读接口。
8. **中继不在本仓库。** README 明说中继的 OAuth/数据库/路由/部署"are not part of this package"（`LS/README.md:12`、`:129`）。官方给的是**主机侧 + 协议**，中继实现本身不是可依赖构件；`dsh-remote-hub` 若走自建 guard，反而比 LiveShare 少一个外部依赖，但也没有官方中继可复用。
9. **无逐请求签名、无 nonce、无消息级过期。** 见 §3.4。设备令牌模型若要求"每条请求可验证且不可重放"，LiveShare 的"独占 WSS 信道即信任"假设不能直接搬。
10. **流是轮询式的、绑页面而非绑连接。** `stream-next` 10s 持有（`read-budgets.ts:16`）、120s 空闲回收（`viewer-lifecycle.ts:32`）。对移动端弱网这是可用的（比长连接稳），但要自己实现序号/重连语义——`viewer-carrier.ts:232-289` 是唯一参考实现，且它是浏览器代码。
11. **无推送、无后台投递、无离线队列。** 全仓无 push 相关；`tunnel-supervision` 的"待删除行"重试（:505-540）是唯一带持久重试的投递机制，语义是"删除"而非"投递"。

---

## 8. 对 dsh-remote-hub 的可执行建议

1. **复用 `PrincipalMap` 的声明合并来新增 `hub-device` 主体，而不是自建并行身份体系**——因为官方先例就是这么做且共享 `gateway.decide()`：`LS/src/host/viewer-principal.ts:16`；主体只放 JSON 安全字段（同 :7 注释"会写进 Session 日志"）。
2. **复用 `remoteAccess.registerPolicy` 注册策略，而不是在 guard 里手写 if 判断**——因为注册即接管 Gateway 的每次 `decide()`、事件过滤与列表过滤，且 fiber dispose 自动撤销：`packages/api/remote-access/src/index.ts:153`、gateway 调用点 `packages/api/gateway/src/index.ts:814`。
3. **复用 `role → binding → condition` 三元组表达设备角色，而不是写路由白名单**——因为条件按"每资源"同步求值，能在同一角色下区分"本源可写/子会话只读"：`packages/api/remote-access/src/types.ts:60`、`LS/src/host/viewer-access-policy.ts:459-524`。
4. **复用 `connection.createPeer({ principal, interactions })` 造设备 Peer，而不是新开 HTTP 分支**——因为这是唯一能让调用带上固定主体并走 Gateway 校验的入口，且 `interactions` 决定能否开 `$events`：`packages/client/connection/src/peer.ts:14-19`、`LS/src/host/viewer-lifecycle.ts:294`。
5. **设备 Peer 请显式传 `interactions: 'none'`，而不是沿用默认 `'answer'`**——因为非 owner 即使用 `answer` 也**不能**回答 waterfall（`$events/result` 只认 owner，`packages/api/gateway/src/index.ts:502-504`），而 `'none'` 能让 `$events` 直接拒绝、省掉一条伪造面（`requireInteractions` :1242）。
6. **复用 `createSharedFetchHandler('/api')` + `peer` 做一元调用，而不是自己解析 `/api` 信封**——因为官方 viewer 分派就是这么做的，并能把"非 owner 不可达的精确路由"映射成可诊断错误：`LS/src/host/viewer-dispatch.ts:152-178`、`packages/client/connection/src/rpc-host.ts:218-223`。
7. **复用 `typertGateway.wireStream.open(endpoint, payload, uplink, peer, signal)` 开流，而不是自建流协议**——因为访问校验、参数校验、取消语义都在 gateway 内：`packages/api/gateway/src/types.ts:92-109`、`LS/src/host/viewer-dispatch.ts:396`。
8. **复用 `writeFileAtomic` + `withFileLock` 存设备表，而不是 `fs.writeFile`**——因为设备表是"多进程可能同时读改写"的文件，官方 fork 登记正是为此加了锁 + 原子替换：`packages/util/atomic-write/src/index.ts:80`、`:238`、`LS/src/host/fork-registry.ts:370-398`。
9. **设备令牌落盘必须显式 `{ mode: 0o600, dirMode: 0o700 }` 并做原子 rename，但不要学 LiveShare 存明文**——因为官方明文凭据只是"绑定单一中继的短期 token"，而你的设备令牌是长期凭据；官方也只在"文件缺失/损坏=未验证"这一 fail-closed 处理上值得照抄：`LS/src/host/owner-credential-file.ts:59-64`、`:26-52`。
10. **复用 `isTrustedApiRequest` 的 Host/Origin/sec-fetch-site 三重围栏，而不是自己判 `X-Forwarded-*`**——因为全仓先例明确不读转发头（身份不来自头），且该函数已处理 rebinding、`Origin: null`、跨站标记：`packages/client/connection/src/api-request-trust.ts:121-151`（"no marker shortcut" 见 :127-133）。
11. **guard 端口复用 `WebServer` 的"拒绝通配绑定"校验语义，而不是自建监听**——因为同一断言已把"绑定所有接口=RCE"写进配置边界，且它把 `protocol` 定为配置真值而非请求头：`packages/host/webserver/src/index.ts:359-366`、`:420-422`。若确实需要独立监听，请照抄这段校验而不是仅注释"loopback only"。
12. **隧道子进程监管直接照搬 `TunnelWorker` 的三件套（注册重放 / 退避 / token 相关），而不是新写 supervisor**——因为"崩溃后把 owner 的意图重新交给替代进程"这条正是自研最容易漏的：`LS/src/host/tunnel-worker.ts:280-296`、`:318-325`，退避常量 `retry-backoff.ts:19-29`，相关用 `pending-rpc.ts:16-78`。
13. **区分"永久拒绝"与"暂时失败"，照抄 `relay-refusal` 的 401/403/410/426 白名单**——因为对永久拒绝重连只会无限撞同一面墙：`LS/src/owner-gateway/relay-refusal.ts:13`、`worker.ts:232-241`。
14. **不要复用 `@deepseek-ai/dsh-experimental-liveshare` 作为库，也不要复用 kind `'share-viewer'`**——因为它是 `apply()` 插件、注册固定 kind（重复注册抛错）、并在全局挂 `agent/created`/`agent/pre-step` 监听：`remote-access/src/index.ts:155`、`LS/src/host/share-host.ts:289`、`:437`、`:482`。要抄就抄源码级模块（文件头契约清晰），并且**别信 `exports` 里的 `./src/*`**（发布包 `files` 不含 `src`，`LS/package.json` 的 `files` 段）。
15. **把"逐请求签名"作为自研净增量，而不要假装先例里有**——因为 LiveShare 明确把该字段留空："Absent today … the protocol does not verify it"（`LSP/src/tunnel-protocol.ts:173-179`）。这条同时是设备令牌模型相对 LiveShare 的正当性论据。
