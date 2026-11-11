# 04 · v0.1 → v0.2 设计变更决议（权威输入）

> 本文是 DESIGN v0.2 / ROADMAP v0.2 / README 的共同事实输入。
> 每条决议都由 `01`/`02`/`03` 三份验证文档中的**具体证据**推出；不允许"感觉更好"式改动。
> 编号 `D-<n>` 在其它文档中被直接引用。

证据文件：
- `01-harness-facts.md` —— 对 DSH 0.2.2-rc.1 源码的逐条核对（F1–F21 / A1–A15）
- `02-web-research.md` —— 生态先例、官方文档、隧道、Android 栈、传输、配对 UX
- `03-liveshare-precedent.md` —— 官方唯一条非 owner 远程先例的实现级摘要

---

## 第一部分：推翻 v0.1 的决议（必须改，否则实现即错）

### D-1 「hub 自有方法词表 + 翻译层」整个取消

- **v0.1 主张**：`core/protocol.ts` 定义 10 个 hub 方法（`sessions.list` …），`host/src/services/index.ts` 一个地方翻译成官方 endpoint（ADR-8）。
- **推翻理由**
  1. 官方 endpoint 实际有 **60+ 个**，v0.1 只映射 10 个，且漏掉 `terminal/attach`、`goals/*`、`job/*`、`workspace/follow` 这些"远程控制"的主干能力（01 §5 全表）。
  2. 翻译层是纯增量风险：每加一个能力要改三处（`core`、`services`、Kotlin 镜像），而 D-2 让守卫可以直接转发官方 endpoint。
  3. 官方信封（`client-request` / `server-response`）已由 `@deepseek-ai/dsh-client-connection` **公开导出 schema**（`packages/client/connection/src/rpc-schema.ts:24-47`，`exports` 含 `.`），是受支持的面，不需要自造。
- **新决议**：守卫说 **DSH 自己的 `/api` RPC 信封**；`core/` 只保留四样东西：`GUARD_ROUTES`、能力矩阵（官方 endpoint 的 allow-list）、配对/设备类型、错误码映射。删除 `REMOTE_METHODS`、`REMOTE_EVENTS`、`RpcRequest`、ADR-8。
- **代价**：hub 协议不再是"稳定对外 API"，而是"随 DSH 版本走的适配层"——这本来就是事实，v0.1 假装不是。

### D-2 守卫的一元派发用 `createSharedFetchHandler('/api').fetch(request, peer)`，不是自己调 `invoke()`

- **v0.1 主张**：守卫直接 `ctx.typertGateway.invoke({ peer, namespace, method, args })`（ADR-2 选项 B）。
- **推翻理由**
  1. 官方先例就是这么做的：`LS/src/host/viewer-dispatch.ts:152-160` → `deps.connection.createSharedFetchHandler('/api')` → `handler.fetch(new Request(...), peer)`。
  2. `invoke()` 只接受**已解码的具名参数**，而线上是 `{namespace, method, args}` 的 JSON；用 `sharedFetch` 才能复用 Connection 的信封解析、二进制附件投影（`ConnectionRpcHandlerResult` 的 `attachments`）、`/api/<ns>/<method>` 路径解析（`rpc-host.ts:361-370`）。
  3. `sharedFetch` 自动给出可诊断的 403/404：非 owner 打 exact Fetch 路由恒 403（`rpc-host.ts:218-222`），未认领 endpoint 恒 404——这正是我们需要的行为，不用自己写。
- **保留 `invoke()` 的位置**：只有守卫自己的 `hub/*` 管理方法（见 D-6 之外的内部调用）和 M0 探针需要它。
- **注意面**：`createSharedFetchHandler` 要求先自己造出 `Request`；`Request.url` 必须是 `http://<任何内部主机名>/api/<ns>/<method>`，官方先例用 `http://liveshare.internal`（`viewer-dispatch.ts:152`）。我们沿用同样手法，并在设计中写明"这个主机名不参与任何判定"。

### D-3 非 owner 的流只能"长轮询"，不能开 `/api/remote.mux`

- **v0.1 主张**：守卫自己起 WebSocket（`/remote/events`），WS 直接承载事件帧（ADR-6、§8.5）。
- **推翻理由**
  1. `/api/remote.mux` 的升级走 `connection.admitConnection()`，只认 browserAuth → **恒为 owner Peer**（`rpc-host.ts:129-137`、`188-206`）。非 owner 拿不到这条 socket。
  2. 官方先例对非 owner viewer 的做法是**三条一元方法**：`stream-open` / `stream-next` / `stream-cancel`，带短持有预算（`LS/src/viewer-channel.ts:28-48`、`read-budgets.ts:16,26,34,43,49`）。
  3. 我们自己实现的 `@Remote({mode:'stream'})` 方法，其下行必须由**我们**用 `typertGateway.stream()`/`wireStream.open()` 拉取再交给轮询方法分发（`gateway/src/types.ts:92-109`）。
- **新决议**：
  - 流 = 守卫自有的三个一元 endpoint（本文用 `hub/stream.open|next|cancel` 记名），实现为**本插件自己的** `TypertRemoteService`，因此同样过 `decide()`。
  - **v1 不起任何 WebSocket**。删除 `/remote/events`、删除 `ws` 依赖、删除 WS 心跳/重连/半开检测的整套设计。
  - 吊销的下行推送改为"下一次轮询的终态错误"（`device-revoked`），预算内 ≤ `streamHoldMs`（默认 4s，见 D-4）。
- **收益**：删掉整个 WS 栈（v0.1 的 M5 大半）、删掉 A14 风险、删掉隧道对 WS 的支持要求（`02 §C.1` 的 CF WS 空闲超时问题一并消失）。

### D-4 长轮询的持有/批量预算显式化（照抄官方数值量级）

- 决议：`streamHoldMs = 4000`（官方 viewer 用 10_000，我们取更短以把"吊销可见延迟"压到 G7 的 ≤5s）、`streamBatchMax = 64`、`streamBatchWindowMs = 4`、`streamPollSlackMs = 2000`、`hubReadTimeoutMs = 25000`。
- 预算必须**单向递增**（`read-budgets.ts:2-8` 的设计前提），否则客户端可以用旧 cursor 反复拉取。

### D-5 审批桥接只能是 waterfall 监听器，不能调 `approval.request()`

- **v0.1 主张**：Host 用 `ctx.approval` 服务"受理"审批再交回结果（§8.6.1、A12）。
- **推翻理由**
  1. `ApprovalService.request()` 要求 **turn 已打开**否则直接抛错（`interaction/user-approval/src/index.ts:244-250`），且会自己 append `approval/asked`+`approval/decided` 审计对（`:252-259`）——重复调用会把审计写两遍。
  2. 官方 SDK 的桥接形状是 `ctx.on('approval/request', async (req, next) => …)`（`packages/sdk/server/src/server.ts:123-140`），并且**只允许返回三值** `allowed-once | rejected | cancelled`（`sdk/protocol/src/types.ts:236`）；`unavailable` 只能由"没人应答"产生。
  3. 非 owner Peer 永远拿不到可作答 waterfall（`gateway/src/index.ts:584`、`:502-504`），所以远端审批**必须**走我们自己的通道。
- **新决议**：守卫注册一个 root-scope 的 `approval/request` 监听器；用"该 agent 的 session 是否在本设备可见集合内"决定是否接管，**不接管就 `next()`**（把决定权还给本机 owner UI）。接管后把请求投给轮询流，等设备回答或超时/撤销，返回三值之一。
- **新增红线**：桥接**不得**吞掉本机 owner 的审批；`next()` 的调用条件必须是显式的可见性判定，不能是"总是接管"。

### D-6 文件传输：上传走 `fileUploads/upload`，下载走 `workspaceFiles/readBytes`

- **v0.1 主张**：`files.upload` → `fileUploads/upload`；`files.download` → `workspaceFiles/readBytes`；`results.preview` → `workspaceFiles/read`。
- **修正**
  1. exact Fetch 路由（`POST /api/session/uploadFileBinary`）**绕过 Gateway 访问判定、对非 owner 恒 403**（`rpc-host.ts:218-222`），所以绝不能走它；只能走 `fileUploads/upload` 这个 Remote 方法（01 §5 末条）。
  2. `workspaceFiles/read()` 遇 NUL 抛 `workspace-file/not-text`（`workspace-files/src/index.ts:243-245`），且返回的是**行窗口**不是整文件（`offset/limit/lines/eof`）。
- **新决议**：`results.preview` 拆两条腿——文本用 `workspaceFiles/read`（带 offset/limit），**二进制/图片必须用 `readBytes`**（带 range；`maxFileBytes` 默认 32 MiB）。

### D-7 `dsh.compatibility` 是空转的，真正的门是 `engines.dsh`

- **证据**：`dsh.compatibility` / `dshReleases` 在全检出 **0 命中**，`DshManifest` 类型里没有这两个字段（`packages/util/package-manifest/src/types.ts:32-41`）；真正的判定是 `engines.dsh`，缺失时回退查 `@deepseek-ai/dsh*` peers，且用 `semver.satisfies(..., { includePrerelease: true })`（`packages/boot/app-boot/src/plugin-compatibility.ts:51-73`）。
- **现状危害**：v0.1 只声明 `engines.node` 与 `@deepseek-ai/cordis` peer → `unmetRequirements` 返回 `{}` → **任何 DSH 版本都被放行**。而 `dsh.compatibility.dsh = ">=0.2.1-rc.2"` 在 DSH 自己的算法下会错误收下整个 0.3.x，在普通 semver 语义下又会把 0.2.2-rc.1 判成不兼容（01 §3 矩阵）。
- **新决议**：`"engines": { "dsh": ">=0.2.1-rc.2 <0.3.0-0", "node": ">=24.9.0" }`；`dsh.manifestVersion: 1`；`dsh.compatibility` 保留为同范围的人读镜像（+ `dshReleases` 补 `0.2.2-rc.1`）。
- 依据：Node 下限跟随 DSH 本体 `>=24.9.0`（`package.json` 的 `engines`），而不是 `ws` 的宽松下限（02 §E.2）。

### D-8 client 半边不能依赖 `@deepseek-ai/dsh-client-runtime`

- **证据**：0.2.2-rc.1 检出 410 个包里**没有**这个包（01 表 F21）；现行写法是各包自行 `import type { Context as ClientContext } from '@deepseek-ai/cordis'`（如 `packages/client/locale/src/client/index.ts:7`）。`SlotRegistry` 现在在 `packages/client/ui-renderer/src/client/registry.ts:120`。
- **新决议**：删除该 devDependency 与 `ClientContext` 的导入；client 侧一律用 `@deepseek-ai/cordis` 的 `Context`。v0.1 的 `typecheck` 一直对着 0.1.x 的旧形状通过，这条必须在 M0 内修掉。

### D-9 守卫必须自己实现来源围栏，且不能用 `isTrustedApiRequest`

- **证据**：`isTrustedApiRequest` 只在 `api-request-trust.ts:121` 导出，**没有**从包根 re-export（`connection/src/index.ts` 只导出 `assertTrustedAuthority`），而 `./src/*` 在发布产物里不存在（`files` 只含 `lib/`）。可用的公开面是 `ctx.connection.requestRejection(request)` / `admit(request)`（`rpc-host.ts:124-137`），但它们用的是 **DSH 自己的** `trustedHosts` 与 `webServer` 绑定地址。
- **新决议**：守卫实现自己的三段围栏，语义对齐官方：
  1. `Host` ∈ 允许集合（回环字面量恒允许；隧道公开 authority 由 `publicAuthorities: string[]` 显式声明，canonical 校验照 `assertTrustedAuthority` 的判据）；
  2. `Sec-Fetch-Site: cross-site` 一律拒；
  3. 有 `Origin` 时必须与 `Host` 同 authority，`Origin: null` 拒。
- 语义来源逐条对应 `api-request-trust.ts:121-151`；**不引用、不复制其实现**（不可达），在文档中写明"这是同语义的独立实现，升级 DSH 时需重核"。

### D-10 Android 令牌存储换实现

- **证据**：`androidx.security:security-crypto` `1.1.0` 就是"全量弃用版"，官方文案 "Deprecated all APIs in favour of existing platform APIs and direct use of Android Keystore"，`EncryptedSharedPreferences` → "Use `android.content.SharedPreferences` instead"（02 §D.1）。
- **新决议**：`DeviceStore` 用 **Keystore 包裹的 AES-256-GCM**（`KeyGenParameterSpec`、`PURPOSE_ENCRYPT|DECRYPT`、`BLOCK_MODE_GCM`、不可导出密钥），密文+IV 存普通 `SharedPreferences`；`allowBackup="false"` 保持。`tink-android:1.24.0` 作为需要轮换时的备选，不默认引入。
- 同时锁定版本锚点：Kotlin 2.4.21 / AGP 9.5.1 / Compose BOM 2026.09.00 / kotlinx-serialization-json 1.12.0 / OkHttp 5.5.1（02 §D.2）。v0.1 的 A15 组合（AGP 8.7.3 / Kotlin 2.1.0 / BOM 2024.12.01）作废。

---

## 第二部分：v0.1 里被证据加强、需要显式写死的决议

### D-11 角色矩阵改为"官方 endpoint 的 allow-list"，并按资源种类分层

- `decide()` 的 action 是 `<namespace>/<method>`，资源种类官方已声明三个：`global`、`session`（`packages/core/session/src/types.ts:560-563`）、`workspace`（`packages/workspace/workspace/src/types.ts:19-22`）。
- 决议：三档角色 = 三组 `RemoteAccessRole`，**按资源种类拆分**：
  - `global` 级 role：跨会话的方法（`session/list`、`session/search`、`session/create`、`session/control`、`workspace/follow`、`job/list`、`goals/get`…）
  - `session` 级 role：需要具体会话的方法（`session/events`、`session/state`、`session/prompt`、`session/cancel`、`session/updateQueue`、`session/attachment`、`terminal/*`、`fileUploads/upload`…）
  - `workspace` 级 role：`workspaceFiles/*`
- **不提权原则**：`credentials/*`、`settings/update|replace|mutate`、`directoryPicker/*`（会在宿主桌面弹原生对话框）、`plugin-manager/*`、`plugin-market/*`、`remoteAccess/follow`（恒放行，必须自己再判）**永不下放**，写进红线。

### D-12 `remote-device` principal 的字段

- 照 `share-viewer` 的形状（`LS/src/host/viewer-principal.ts:16-35`）：**只放身份，不放凭据**，因为它会被写进 Session 日志的 `source.principal`（`typert/protocol/src/types.ts:450-453`）。
- 决议：`{ kind: 'remote-device', deviceId: string, role: RoleName }`。**不放 tokenHash、不放 label、不放时间戳**——需要时按 `deviceId` 回查设备表。

### D-13 `createPeer` 与 `registerPolicy` 必须同生共死

- `decide()` 对没有 policy 的 kind 一律 `no-allow` 拒绝（`remote-access/src/index.ts:203-204`），不是放行。
- 决议：装配顺序强制为 `registerPolicy` **先于** 第一个 `createPeer`；任一失败即整体抛错。并且 `interactions: 'none'`（D-3 决定不起 WS，`$events` 用不到；`'none'` 让 `$events` 直接拒，少一条面）。

### D-14 配对：二维码为主、数字短码为辅；短码位数上调

- **证据**：6 位十进制 ≈ 19.9 bit；RFC 8628 §5.1 明确"短码的安全性来自尝试预算而非长度"，并给出 34.5 bit + 5 次尝试 = 2⁻³² 的算例（02 §F）。生态上 Signal/Tailscale/全部同赛道 DSH 插件都以 QR 为主路径（02 §A.2、§F）。
- **决议**
  - **主路径**：Host 屏幕显示二维码，载荷是**高熵一次性配对票据**（32 字节随机，TTL 2 分钟，单次使用），不是短码。
  - **兜底路径**：8 位 Crockford Base32 短码（40 bit），TTL 10 分钟，5 次失败预算，达预算即烧码。
  - 两条路径都由**同一个回环双条件门控**的签发端发出；兑换端不做回环门控（v0.1 的 C1 结论保留）。
  - 二维码的 `allowBackup`/截图泄露风险写进残余风险：票据 TTL 2 分钟 + 单次使用是唯一缓解。
- **影响**：M3 增加 QR 生成（Host 侧只生成 payload 文本或最小 QR 渲染，不引图像库）与 Android 扫码（CameraX + ML Kit 或 ZXing）。

### D-15 v0.1 的正确结论要保留，但换掉论证

| v0.1 结论 | 状态 | 新论证 |
|---|---|---|
| 守卫只绑回环 | **保留** | 官方先例同样拒绑通配（`webserver/src/index.ts:359-366`），且明确"不保护监听端口本身"（02 §B.4） |
| 落盘只存 `sha256(token)` | **保留** | 官方 LiveShare 存**明文**凭据（`owner-credential-file.ts:59-64`），因为那是短期中继 token；我们的设备令牌是长期凭据，必须更严（03 §8 建议 9） |
| 签发端双条件回环门控、兑换端不门控 | **保留** | 远程设备在隧道外，兑换必然经隧道（v0.1 C1 仍然成立，无新反证） |
| `decide()` 在业务分派之前 | **保留，措辞已修正** | 准确顺序见 01 表 F5 |
| 隧道不承担鉴权、不采信转发头 | **保留，证据加强** | 全仓不读 `x-forwarded-*`（01 表 A7）；CF 官方承认 `True-Client-IP` 可伪造（02 §C.1） |
| ADR-5 不透明 bearer 令牌 | **保留** | 但补"令牌重放"的残余风险与吊销延迟的量化（改用轮询后 ≤ `streamHoldMs`） |

---

## 第三部分：风险登记册的重估

| v0.1 风险 | v0.1 概率 | v0.2 概率 | 依据 |
|---|---|---|---|
| R-1 拿不到 `createPeer`/`typertGateway` | 中·影响高 | **低·影响高**（降级为"待探针确认"） | 服务层无包名 allow-list（01 §2 第 1 条）；只剩"该 profile 装了没有" |
| ADR-2 失效 → 影子策略 | 中 | **低** | 同上；且 D-2 换成官方先例路径 |
| 非 owner 不能审批 → G5 失效 | 未识别 | **已确认存在**，靠 D-5 自建通道解决 | 01 表 F16 |
| 非 owner 不能用文件路由 | 未识别 | **已确认存在**，靠 D-6 绕开 | 01 §5 末条 |
| 流必须长轮询（原以为是 WS） | 未识别 | **已确认**，D-3 就地改为轮询（净减工作量） | 01 表 F12 + 03 §2.2 |
| 协议漂移（TS↔Kotlin） | 高 | **中**（信封只剩官方一种，且官方 schema 可导出为契约快照） | D-1 |
| `security-crypto` 弃用 | 中 | **已发生**，D-10 已解 | 02 §D.1 |
| 打包兼容门空转 | 未识别 | **已确认**，D-7 已解 | 01 §3 |
| client 半边依赖不存在的包 | 未识别 | **已确认**，D-8 已解 | 01 表 F21 |

---

## 第四部分：v0.2 明确"不做"的事（新增非目标）

1. **不做 WebSocket**（v1）。没有 `/remote/events`，没有 WS 心跳/重连/半开检测。
2. **不做 hub 自有方法词表**。守卫直接转发官方 endpoint。
3. **不做 `dsh.compatibility` 驱动的版本门**。只认 `engines.dsh`。
4. **不做"简化移动端点"**（v0.1 已排除，重申）。
5. **不做逐请求签名**（v1 仍是 bearer；`clientPubKey` 仍只预留）。**但**必须在文档中承认：这是相对官方先例的**净增量**，不是抄来的（03 §3.4）。
6. **不做云端中继**。LiveShare 也没有可复用的中继实现（03 §7.8）。
7. **不做 `/api/remote.mux` 复用或抢占**。
