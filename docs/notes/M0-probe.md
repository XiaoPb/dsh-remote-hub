# M0 探针与基线结论

> ROADMAP T0.4 / T0.8 的产出。日期：2026-11-11。
> 权威源码：`E:/Code/DSH/plugins/deepseek-harness`，commit
> `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`（0.2.2-rc.1）。

## 1. 探针回答了什么问题

v0.1 的 R-1 是「第三方插件能否注入 `connection` / `typertGateway` 并调 `createPeer`」。
[01-harness-facts.md §2 第 1 条](../verification/01-harness-facts.md) 已在**源码层**确认：
服务层没有包名 allow-list（`rpc-host.ts:92` 的 `super(ctx,'connection')`、
`gateway/src/index.ts:243` 的 `super(ctx,'typertGateway')`，注入按 key 解析）。

所以探针只剩一个问题：**该 profile 装没装这两个服务 + 我的 kind 有没有 policy**。
`host/src/plugin.ts` 的 `probeServices(ctx)` 把这个结论函数化了，返回：

```
connection: ok | missing
typertGateway: ok | missing
remoteAccess: ok | missing
claimable-endpoints: N      # ctx.typert.local.list() 的长度
session-list-ok: true | false
```

失败点只可能落在三者之一（与 01 §6 一致）：

1. **服务不存在** → 在 `cordis.patch.yml` / profile roster 补装对应包；本插件的
   `inject = ['connection', 'typertGateway', 'remoteAccess']` 会让它在加载期就暴露。
2. **endpoint 未被认领** → `host/src/services/index.ts` 的两个
   `TypertRemoteService`（`hubStreams` / `hubDevices`）在 guard 之前构造，Gateway 的
   `collectSrcClaims()` 会认领 `hub/*`；官方 endpoint 由 `typert.local` 严格描述符提供。
3. **policy 未注册** → `registerDevicePolicy(ctx, …)` 排在 `createDispatcher()` 之前，
   而 dispatcher 只在第一次请求时惰性 `createPeer`（D-13）。

## 2. 本次核对到的关键 API（全部来自 0.2.2-rc.1 源码 / 已安装类型包）

| 面 | 真实形状 | 依据 |
|---|---|---|
| `connection.createPeer` | `{ principal, interactions?: 'answer' \| 'none' }` → `PeerScope` | `client/connection/src/rpc.ts:225,247`、`peer.ts:38-47` |
| `connection.createSharedFetchHandler('/api')` | `.fetch(request, peer)` → `Response`；信封解析 / exact-Fetch-403 / 未认领-404 都由它做 | `rpc-host.ts:206-274` |
| RPC 信封 | `{ type:'client-request', rpcId, method, payload:{ args } }`；响应 `{ type:'server-response', rpcId, result }` | `rpc-schema.ts:24-47`、`gateway/src/client/index.ts:458` |
| `remoteAccess.registerPolicy` | `(kind, policy) => () => void`；`decide()` 对无 policy 的 kind 返回 `no-allow` | `api/remote-access/src/index.ts:153,199-204` |
| `RemoteAccessBinding` | `{ role: { name, resource(种类), actions }, resource: { kind, id? } }`；`global` 无 id | `remote-access/src/types.ts:29-67` |
| 资源种类 | `sessionId` / `workspaceFileScopeId` / `agentId` → `session`；`workspaceId` → `workspace`；无 → `global` | `session-controller/src/index.ts:191`、`workspace-files/src/index.ts:203-206`、`typert/registry` 的 `resources.register` |
| `typertGateway.stream` | `{ namespace, method, args, peer, signal }` → `AsyncIterable<unknown>` | `api/gateway/src/types.ts:154-198` |
| 审批 waterfall | `ctx.on('approval/request', async (req, next) => …)`；**不**调服务的 `request()` | `user-approval/src/index.ts:242-259`、`sdk/server/src/server.ts:123-140` |
| 官方 `@Remote` | 标准 TC39 装饰器；marker 存在原型上，由 `remoteMethods(service)` 读取 | `typert/protocol/src/index.ts:282-300` |
| `client-request` schema | `@deepseek-ai/dsh-client-connection` 包根确实导出 `clientRequestSchema` / `serverResponseSchema` | 实测 `import('@deepseek-ai/dsh-client-connection')` |

## 3. 与 DESIGN/ROADMAP 口径差异（T0.8 的「需同步条目」）

| # | 待改点 | 文档小节 | 本次实现采用的口径 |
|---|---|---|---|
| 1 | `engines.dsh` 与新版本门 | DESIGN §13.1 / README「下一步」 | 已加 `>=0.2.1-rc.2 <0.3.0-0`，`dsh.compatibility` 同步为同范围、`dshReleases` 补 `0.2.2-rc.1`、加 `manifestVersion: 1` |
| 2 | 删除 `ws` | DESIGN §7.2.4 / README 八条不变量 | `package.json` 无 `ws`；`host/client/core` 无 `registerUpgrade` / `on('upgrade')` / `WebSocket`；Android 的 `EventSocket.kt` 已删 |
| 3 | 删除信封与词表 | DESIGN §7.1 / §8.4 | `core/src/envelope.ts`、`REMOTE_METHODS` / `REMOTE_EVENTS` 全删；改用官方 `client-request` 信封，`method` 就是 `<ns>/<method>` |
| 4 | 流改长轮询 | DESIGN §7.2.5 / §8.5 | `hub/stream.{open,next,cancel}` 三条**一元**方法，走 `POST /remote/rpc`；无独立 HTTP 路由 |
| 5 | 审批改 waterfall | DESIGN §9.6 | `createApprovalBridge` 注册 root-scope 监听器；不接管就 `next()`；三值；不调服务的 `request()` |
| 6 | 配对改 QR + 8 位短码 | DESIGN §7.2.1 / §8.2 | 32 字节票据 / 120s / 单次；8 位 Crockford / 600s / 5 次预算；**第 6 次**才 `rate-limited` 并 burn |
| 7 | 能力矩阵按资源种类分层 | DESIGN §7.2.3 / §8.6 | `core/src/capabilities.ts` 的 `ROLE_MATRIX` 按 `global/session/workspace` 分；`host/src/policy.ts` 逐类生成 binding |
| 8 | 三段来源围栏独立实现 | DESIGN §7.2.4 | `host/src/fence.ts` 同语义重写，不引 `isTrustedApiRequest`（未从包根导出） |

**一处需要显式记录的源码级修正**：DESIGN §8.6.2 把 `workspaceFiles/*` 标成
`workspace` 资源，但 0.2.2-rc.1 的 `workspace-files/src/index.ts:203-206` 把
`workspaceFileScope` lookup 声明为 `resource: 'session'`（wire 字段
`workspaceFileScopeId` 承载的是 `SessionId`）。因此矩阵里这些方法落在 **`session`**
资源上。以源码为准；`ENDPOINT_TABLE` 的 `kind` 列为证。

另一处：`session/page` 已 `@deprecated`（`session-controller/src/index.ts:526`），
接任者是 `session/events`。它仍在 `ENDPOINT_TABLE` 里以便与 Typert 注册表对账，
但**不进任何角色的矩阵**（ROADMAP T2.1 / A2-3）。

## 4. 构建基线（T0.2 / T0.6）

- 依赖按 `@deepseek-ai/*@0.2.2-rc.1` + `@deepseek-ai/cordis@4.1.0` 安装到本仓库自己的
  `node_modules/`（`pnpm-workspace.yaml` 用 `nodeLinker: hoisted`，因为 tsdown 0.22.14
  在 pnpm 11 的 isolated linker 下解析不到自己的 `ansis` / `rolldown` 依赖）。
- **不再**复用 `dsh-solution-explorer/node_modules`（那里是 0.1.0-rc.8，两个小版本前的形状）。
- `pnpm typecheck` = 两个 tsconfig（host / client）各自 `--noEmit`，全绿。
- `pnpm build` = `tsc` emit（host + client + `.d.ts`）→ `tsdown` 打包成
  `lib/index.js` / `lib/client.js`。**先 tsc 再 tsdown 是必须的**：rolldown/oxc 不会把
  标准装饰器降级，产物会保留非法的 `@Remote(...)` 语法；tsc 的 `__esDecorate` 才是
  `remoteMethods()` 读取 marker 的前提。
- `scripts/version-gate.mjs` 断言矩阵
  `0.2.1-rc.2=Y 0.2.1-rc.5=Y 0.2.2-rc.1=Y 0.3.0-rc.1=n`。

## 5. 未验证项（诚实清单）

- **没有在真实 `--profile web` 进程里跑过一次带 `session/list` 的往返**。本机 DSH CLI
  是 `0.2.1-rc.4`，`~/.dsh/profiles/web` 的 roster 与本仓库的源码基线不是同一版本；
  启动真实 profile 会改动用户环境，按「消耗真实远程资源，先确认再操作」未执行。
  `probeServices(ctx)` 已实现并导出，装到目标 profile 后可直接调用取证。
- 验收脚本是**纯函数 + 静态源码断言**，不依赖真实 DSH 运行时、不连 8443、不 new Context。
  这保证了 CI 可复现，但不能替代一次真机联调。
- 隧道 `cloudflared` 二进制未执行；`startTunnel` 的 argv 断言、退避与永久拒绝白名单是
  纯函数/单测覆盖的。
- Android（M3）按本次交付需求不实现；`out/contract.json` 已导出六键契约供将来消费。
