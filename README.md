# dsh-remote-hub

DSH 双向远程控制插件 —— **DHS 插件部分已实现（v0.2）**。

一个插件、两个 Cordis 入口：`host` 半边把本机「暴露」出去（QR/短码配对、设备令牌、
官方 `decide()` 里的角色策略、回环守卫、三方法长轮询、审批 waterfall 桥接、隧道监督），
`client` 半边去「控制」别的机器；两侧共用 `core/` 里的同一套契约常量与能力矩阵。

> 状态：**DSH 插件部分（M0 / M1 / M2 / M4 / M5）已实现并全绿**。
> `pnpm typecheck && pnpm build` 通过；`lib/index.js`（ESM host）、`lib/client.js`
> （CJS closure factory）、`lib/types/**/*.d.ts` 均产出；12 个验收脚本 + 6 个测试文件
> 全部通过；CI 骨架在 `.github/workflows/ci.yml`。
>
> **Android 部分按本次交付需求不实现**（ROADMAP 的 M3 任务标注为「不实现」）。
> `android/` 仅保留脚手架；v0.1 遗留的 `EventSocket.kt`（WebSocket 代码）已删除，
> 以满足 G-1「仓库无 WS 代码路径」。协议契约仍由 `scripts/contract-check.mjs`
> 导出为 `out/contract.json`，供未来移动端消费。
>
> 设计依据：**[docs/DESIGN.md](./docs/DESIGN.md)（v0.2）** —— 架构 / 协议 / 安全 / Android。
> v0.2 的变更决议与证据在
> [docs/verification/04-design-deltas.md](./docs/verification/04-design-deltas.md)（`D-1`…`D-15`）；
> 本文每条与 v0.1 不同的说法都标注了对应的 `D-<n>`。部署与巡检见
> [docs/DEPLOY.md](./docs/DEPLOY.md)，M0 探针结论见
> [docs/notes/M0-probe.md](./docs/notes/M0-probe.md)。
>
> 三份文档现在是同一版：DESIGN v0.2、ROADMAP v0.2、README（本文）。若发现冲突，
> 优先级是 `04-design-deltas.md` > `DESIGN.md` > `ROADMAP.md` > 本文。

## 为什么是「一个包、两个入口」

`host/` 与 `client/` 保留物理边界，是为了将来真的需要拆包时不必搬家；但当前是**一个 npm 包**
（`package.json` 的 `exports` 同时提供 `.` 与 `./client`，构建产物 `lib/index.js` 与
`lib/client.js`）。理由：配对票据格式、设备令牌格式、能力矩阵（official endpoint 的
allow-list）必须只有一份实现，拆成两个包后「各写一份、悄悄漂移」是最典型的事故来源。

> v0.2 注：v0.1 在这里还列了「协议 envelope」——**那条论据已作废**。信封不再自造，
> 改用 `@deepseek-ai/dsh-client-connection` 公开导出的官方 schema（D-1/D-2）。
> 现在必须共享的是「设备/配对类型 + 能力矩阵 + 守卫路由」，仍然一份。

## 目录

```
dsh-remote-hub/
├── package.json            # 单包；dsh.bundle.patch + dsh.client 声明（engines.dsh 待补，D-7）
├── cordis.patch.yml        # 往 web profile roster 插入一行
├── tsdown.config.ts        # 双产物：host→lib/index.js，client→lib/client.js
├── tsconfig.base.json      # 共享编译选项 + @core/* 路径别名
├── tsconfig.host.json      # node 侧（含 types: node）
├── tsconfig.client.json    # browser 侧（DOM lib + jsx）
├── tsconfig.json           # IDE 用（两侧一起看）
│
├── core/src/               # ★ 共享契约层：两侧都 import，禁止各写一份
│   ├── protocol.ts         #   守卫路由 GUARD_ROUTES、能力矩阵（官方 endpoint 的
│   │                       #   allow-list，D-11）、设备/配对类型、错误码映射（D-1）。
│   │                       #   ⚠️ REMOTE_METHODS / REMOTE_EVENTS 已 @deprecated（D-1），
│   │                       #   不再充当「唯一枚举源」；删代码是 M0/M2 的事
│   ├── device.ts           #   设备记录 / 已签发令牌 / 守卫侧 principal 视图（D-12）
│   ├── roles.ts            #   官方 endpoint allow-list，按 global / session / workspace
│   │                       #   三种资源种类分层（D-11）；ROLE_ACTIONS 将被「三个资源
│   │                       #   种类各自的 role」取代，已标 @deprecated
│   ├── index.ts
│   └── ✗ envelope.ts       #   **整个文件删除**（D-1/D-2）：守卫不再自造信封，改用 DSH
│                           #   自己的 /api RPC 信封。现状只加了 @deprecated 头注释，
│                           #   删文件（含 index.ts 的 export *）是 M0 的代码任务
│
├── host/src/               # 被控端（node 进程，跑在 DSH 宿主里）
│   ├── index.ts            #   Cordis 入口：inject + apply(ctx, config)
│   ├── plugin.ts           #   装配顺序：config→devices→token→pairing→policy→streams→guard→tunnel
│   ├── config.ts           #   配置项与默认值（回环 / 8443 / 短码 TTL…；预算与公开
│   │                       #   authority 新增项以 TODO(M0.x) 标注，值未改）
│   ├── devices.ts          #   持久化设备表（只存令牌哈希）
│   ├── token.ts            #   令牌生成 / SHA-256 哈希 / 常量时间校验 / 吊销
│   ├── pairing.ts          #   一次性配对票据（二维码为主，短码兜底，D-14）
│   ├── roles.ts            #   把 core 的能力矩阵接到官方 remoteAccess.registerPolicy()（D-11）
│   ├── principal.ts        #   ✗ 尚未创建（M2）：declare module 合并 'remote-device'（D-12）
│   ├── policy.ts           #   ✗ 尚未创建（M2）：registerPolicy + bindings()/explain()（D-13）
│   ├── fence.ts            #   ✗ 尚未创建（M1）：三段来源围栏 Host/Sec-Fetch-Site/Origin（D-9）
│   ├── dispatch.ts         #   ✗ 尚未创建（M1）：createPeer + sharedFetch 薄封装（D-2）
│   ├── streams.ts          #   ✗ 尚未创建（M2）：三方法长轮询 stream-open / stream-next /
│   │                       #   stream-cancel，带短持有预算（D-3/D-4）。是本插件自己的
│   │                       #   TypertRemoteService，因此同样过 decide()
│   ├── approval-bridge.ts  #   ✗ 尚未创建（M2）：ctx.on('approval/request') waterfall 监听器
│   │                       #   （D-5）。不是调 ctx.approval.request()，也不吞本机 owner
│   │                       #   的审批（不接管就 next()）
│   ├── guard.ts            #   只绑回环的 HTTP 守卫；三段来源围栏自己实现（D-9）；
│   │                       #   派发用 createSharedFetchHandler('/api').fetch(request, peer)
│   │                       #   （D-2），**不起 WebSocket**（D-3）
│   ├── files.ts            #   ✗ 尚未创建（M2）：上传 fileUploads/upload、预览 read/readBytes（D-6）
│   ├── tunnel.ts           #   cloudflared 等隧道的生命周期监督（只搬字节，不鉴权）
│   └── services/index.ts   #   只注册 hub/* 自有方法（设备管理、流、审批）。
│                           #   v0.1 的「hub 方法 → 官方 endpoint」翻译层（ADR-8）已被
│                           #   D-1 取消——不要再往这里加业务方法
│
├── client/src/             # 主控端（浏览器半边）
│   ├── index.ts            #   __ModuleLoader__ 入口
│   ├── plugin.ts           #   装配：transport → mount → access → UI
│   ├── transport.ts        #   一元调用 + 三方法长轮询 + 预算常量（D-3/D-4）
│   ├── mount.ts            #   ctx.remote.$mount(contribution)
│   ├── access.ts           #   权限快照（官方 snapshotFor 的 grants；UI 隐藏无权入口的依据）
│   └── ui/index.ts         #   面板：设备列表 / 会话 / 审批卡片
│
├── android/                # 独立 Gradle 工程（Kotlin + Compose），见其 README
│   ├── settings.gradle.kts / build.gradle.kts / gradle.properties
│   └── app/src/main/{AndroidManifest.xml, kotlin/dev/dsh/remote/**}
│
└── docs/
    ├── DESIGN.md           # 设计文档（正在重写为 v0.2）
    ├── ROADMAP.md          # 实施计划（含验收标准；M0 起按 v0.2 重排）
    └── verification/       # v0.2 的四份证据：01 源码事实 / 02 外部调研 /
                            # 03 LiveShare 先例 / 04 变更决议（D-1…D-15，**权威**）
```

## 构建与安装（脚手架已实测可构建）

```bash
pnpm install          # 会拉到 @deepseek-ai/* 的类型包
pnpm typecheck        # tsc -p tsconfig.host.json / tsconfig.client.json
pnpm build            # tsdown → lib/index.js + lib/client.js

dsh plugin --profile web add link:E:/Code/DSH/plugins/dsh-remote-hub
```

实测形态（**v0.2 基线，已复验**）：

- 依赖按 `@deepseek-ai/*@0.2.2-rc.1` + `@deepseek-ai/cordis@4.1.0` 安装（`pnpm-workspace.yaml`
  设 `nodeLinker: hoisted`）；`pnpm typecheck`、`pnpm build` 全绿。
- 构建流水线是 **`tsc` emit → `tsdown` 打包**：host 半边的 `@Remote` 是标准 TC39 装饰器，
  必须先经 tsc 降级成 `__esDecorate`，`remoteMethods()` 才读得到 marker；rolldown/oxc
  会把装饰器原样保留（不是合法 JS）。见 `tsdown.config.ts` 的文件头注释。
- 产物：`lib/index.js`（ESM，host 入口）、`lib/client.js`（CJS closure factory，带
  `__ModuleLoader__` banner）、`lib/types/host/src/index.d.ts` 与
  `lib/types/client/src/index.d.ts`（共 30 个 `.d.ts`）。
- 依赖树里**没有** `@deepseek-ai/dsh-client-runtime`（0.2.2-rc.1 不存在该包，D-8），
  也**没有** `ws`（D-3：v1 不起任何 WebSocket）。

> v0.1 的「实测通过」结论已作废：当时复用了 `dsh-solution-explorer/node_modules` 里
> **0.1.0-rc.8** 的 `@deepseek-ai/*` 类型，而基线是 0.2.2-rc.1。现在按正确基线重装并跑通，
> `client/src` 一律 `import type { Context } from '@deepseek-ai/cordis'`（T0.2 完成）。

`.d.ts` 生成已开启（T0.6 完成）：`tsconfig.types.json` 用 `emitDeclarationOnly`，
`package.json` 的 `exports` 里 `.` 与 `./client` 都指向对应声明文件。

## 八条不可协商的安全不变量

改动任何一行代码前先读这八条，它们比功能重要。

> 这八条是给"改代码的人"的速查版。**权威清单是 DESIGN §9.4 的 13 条红线（R1–R13）**——
> 更细的红线（如 R10「不把 `global` 授权当成所有资源都行」、R12「`registerPolicy` 先于
> `createPeer`」、R13「审批桥接不得吞掉本机 owner 的审批」）在那里；此处是它们的归类合并，
> 两者不一致时以 DESIGN 为准。

1. **守卫只绑回环字面量。** `guardHost` 永远是 `127.0.0.1` 这类具体字面量；绑 `0.0.0.0`
   是安全事故，不是配置项。依据不是「我们保守」，而是**官方同样拒绑通配**：`WebServer`
   在加载期就拒绝通配地址（含 IPv4-mapped 形式），并在文档里明确「栅栏与公告都不保护
   监听端口本身」（D-15）。

2. **令牌只在签发那一刻以明文存在一次。** 落盘只有 `sha256(token)`，比较用常量时间。
   ⚠️ 这一条比官方**更严**，且是故意的：官方 LiveShare 把 owner 凭据**明文**写入
   `0600` 文件（靠同目录 rename 保证原子性，不哈希、不分片），因为它绑定的是一条
   **单一短期中继**的 token；我们的**设备令牌是长期凭据**，所以必须走哈希 + 常量时间比较
   （D-15）。

3. **未配对即拒绝。** 除 `/remote/health`、配对票据的**签发**与**兑换**外一律 fail-closed。
   **签发**端点要求「socket 回环 **且** Host 头回环」双条件；**兑换**端点**不**加回环门控
   ——远程设备在隧道外，兑换必然经隧道，门控兑换端等于让远程设备永远配不上。兑换端的防线
   是一次性票据 + 尝试预算 + 限流（D-14/D-15）。

4. **角色由 host 在配对时指定，客户端不可自称。** 客户端既不请求角色，也不能靠声明获得
   角色；身份接着固定进 `PeerScope.principal`，创建后线上字段无法设置（principal 会被写进
   Session 日志的 `source.principal`，所以它**只放身份、不放凭据**：
   `{ kind: 'remote-device', deviceId, role }`，不带 tokenHash / label / 时间戳）。Android
   没有豁免（D-11/D-12）。

5. **授权判定发生在业务分派之前。** 准确顺序是：
   **endpoint 与参数字段检查 → Typert 类型校验 → 解析资源 → `decide()` → lookup / Context
   解析 → 业务调用**。注意：**不是**「参数解码之前」——参数此时已经解码并按 Typert 编译
   类型校验过了；官方包的 README 那句话照字面读是错的，以 Gateway 代码与
   `gateway/README.zh.md` 为准。被拒的调用不解析任何 lookup，也不激活 Agent（D-15）。

6. **`registerPolicy` 与 `createPeer` 同生共死。** `decide()` 对**没有注册 policy 的
   principal kind** 一律以 `no-allow` 拒绝 —— 不是「降级为只读」，而是全量 403。所以装配
   顺序强制「`registerPolicy` 先于第一个 `createPeer`」，任一失败即整体抛错（D-13）。

7. **隧道只搬字节、不承担鉴权、不采信任何转发头。** `CF-Connecting-IP` /
   `X-Forwarded-For` / `True-Client-IP` 只能进日志与限流辅助，绝不作身份；DSH 自己全仓不读
   `x-forwarded-*`，Cloudflare 也官方承认 `True-Client-IP` 可伪造。守卫自己实现
   Host / Origin / Sec-Fetch-Site 三段围栏（D-9），语义对齐 `isTrustedApiRequest` 但不引用
   它（那个函数没有从包根 re-export）（D-15）。

8. **以下 endpoint 永不下放给远端设备**（D-11 红线，写死在策略里、不进任何角色）：
   `credentials/*`、`settings` 的写方法（`update` / `replace` / `mutate`）、
   `directoryPicker/*`（会在宿主桌面弹原生对话框）、`pluginManager/*`、`pluginMarket/*`
   （**namespace 是 camelCase，不是文件名**）、`pluginInventory/*`、`account/*`、
   `remoteAccess/follow`（它被 `decide()` **恒放行**，必须自己再判）。
   完整表与 namespace 证据见 DESIGN §8.6.5；方法名清单以 `ctx.typert.local.list()` 实测为准。

## 当前状态与下一步

ROADMAP v0.2 的 **M0 / M1 / M2 / M4 / M5 已全部完成**（勾选见
[docs/ROADMAP.md](./docs/ROADMAP.md) §2）；**M3（Android）按本次交付需求不实现**。
DESIGN v0.2 的 `D-1`…`D-15` 每条都有对应源码落点：

| 决议 | 落点 |
|---|---|
| D-1 / D-2（删信封、走官方 `/api`） | `core/src/protocol.ts` / `host/src/dispatch.ts` / `host/src/guard.ts` |
| D-3 / D-4（长轮询、预算、单增 cursor） | `core/src/protocol.ts` / `host/src/streams.ts` / `client/src/transport.ts` |
| D-5（审批 waterfall，不吞 owner） | `host/src/approval-bridge.ts` |
| D-6（上传/预览两条腿） | `host/src/files.ts` |
| D-7 / D-8（版本门、删 client-runtime） | `package.json` / 全部 `client/src/*.ts` |
| D-9（三段来源围栏） | `host/src/fence.ts` |
| D-10（Android 栈锚点） | 本次不实现，见 `android/README.md` |
| D-11（能力矩阵按资源种类分层 + 红线） | `core/src/capabilities.ts` / `core/src/capabilities-redlines.ts` / `host/src/policy.ts` |
| D-12 / D-13（principal 只放身份、policy 先于 peer） | `host/src/principal.ts` / `host/src/plugin.ts` |
| D-14 / D-15（QR+短码、回环门控结论） | `host/src/pairing.ts` / `host/src/guard.ts` |

**已验证**：`pnpm typecheck && pnpm build` 全绿；12 个验收脚本 + 6 个测试文件全绿；
`scripts/version-gate.mjs` 四项矩阵全绿；`out/contract.json` 六键、无方法词表。
探针结论见 [docs/notes/M0-probe.md](./docs/notes/M0-probe.md)。

**后续可选**：真实 `--profile web` 上的一次端到端联调（本仓库的验收是纯函数 +
静态源码断言，不依赖真实 DSH 运行时，见 `docs/notes/M0-probe.md` 的「未验证项」）；
以及按需求重新开启 M3 Android 时，用 `out/contract.json` 作为 Kotlin 侧的契约源。

## 与生态里同类插件的区别

先说结论：**「能不能用手机控制 DSH」不是空白，「每个设备一把可吊销的钥匙、角色在 DSH 的
`decide()` 里生效」才是空白。**

- 生态里十余个远程插件，**没有一个**使用官方 `@deepseek-ai/dsh-api-remote-access`
  （唯一有血缘的是 `@qlzt/dsh-api-remote-access`，那是官方包被 fork 后的重发布）。
  绝大多数做法是「**代理整个 Web GUI**」，从而直接继承 DSH 的一条事实：
  **认证后的浏览器 = `owner`**。登录门禁、MFA、签名 Cookie、可信 Origin 都在解决
  「人怎么进来」，没有解决「进来的是哪台设备、能做什么」。
- 因此本插件的差异点只有两句：
  1. **每设备一把可吊销的钥匙**——设备表 + 每设备 Bearer 令牌（落盘只有哈希），吊销即时生效；
  2. **角色在 DSH 的 `decide()` 里生效**——三档角色落成 `remoteAccess.registerPolicy()` 的
     role/binding，在 lookup 与 Agent 激活之前就被拒，而不是在代理层做 URL 白名单。
- 正面承认重叠：隧道 + 扫码 + 「手机 App」的用户故事至少已被三个包讲过；`@linxin666/*`
  在该赛道有 11 万/月的量级。我们不比「有没有 App」。

**npm 名冲突（必须知道的发布约束）：** `dsh-remote-hub` 这个名字在 npm 上**已被占用**
（`0.4.9`，维护者 `liaoguogang`，仓库 `liaoguogang-hub/dsh-remote-public`，近月下载 4127，
功能是「电脑侧插件 + 原生 Android（Kotlin/Compose）+ 自动开隧道（ngrok / cloudflared quick
tunnel）+ 30 天 Cookie + 二维码里放 10 分钟一次性配对码」）。所以：

- 发布名必须留在 **`@xiaopb/` scope 内**（即 `@xiaopb/dsh-remote-hub`，当前 `package.json`
  的 `private: true` 未发布）；
- README 里必须写清与它的区别是「**每设备令牌 + 角色在 `decide()` 生效**」（它是一条 30 天
  Cookie），否则会被当成重复造轮子。

## 已知限制

诚实清单。以下每条都是源码或官方文档确认过的**能力边界**，不是待办：

1. **非 owner Peer 永远拿不到可作答的 waterfall。** 官方明确「回答转发的 waterfall 仅限
   owner」（`answers = principal.kind === 'owner'`，`$events/result` 只认 owner Peer）。
   所以「在手机上点允许」**不是**官方能力：远端审批必须由本插件自建通道
   （守卫注册 root-scope 的 `ctx.on('approval/request')` 监听器，用「该 agent 的 session
   是否在本设备可见集合内」决定接管与否，**不接管就 `next()`** 把决定权还给本机 owner UI）;
   并且只允许返回 `allowed-once | rejected | cancelled` 三值，`unavailable` 只能由「没人
   应答」产生（D-5）。红线：桥接**不得**吞掉本机 owner 的审批。

2. **非 owner 打 exact Fetch 路由恒 403。** 例如 `POST /api/session/uploadFileBinary`
   （它绕过 Gateway 的访问判定）。所以文件上传只能走 `fileUploads/upload` 这个 Remote
   方法，二进制预览只能走 `workspaceFiles/readBytes`（`workspaceFiles/read()` 遇 NUL 抛
   `workspace-file/not-text`，返回的是行窗口而不是整文件）（D-6）。

3. **非 owner 不能开 `/api/remote.mux`。** 它的升级走 `connection.admitConnection()`，只认
   `browserAuth` → 恒为 owner Peer。所以 v1 的流是**长轮询**（`stream-open` / `stream-next` /
   `stream-cancel`），不是 WebSocket，也就没有 WS 空闲超时/半开检测那一整套问题；代价是吊销
   可见延迟上界 = `streamHoldMs`（默认 4s），且每次轮询都要吃一次隧道的 `connectTimeout` /
   `keepAliveTimeout`（D-3/D-4）。

4. **v1 的 bearer 令牌可被重放，没有逐请求签名。** 这既是限制也是净增量空间：官方先例
   （LiveShare）同样没有逐请求签名——它的协议里为 `actor.credential?` 留了字段但明确
   「the protocol does not verify it」，身份信任完全建立在「中继 WebSocket 独占、由主机主动
   发起」这条信道假设上。我们的模型是「长期令牌 + 吊销」，所以必须自己承认：**令牌泄露 =
   在吊销前可重放**。缓解是落盘哈希 + 吊销延迟量化 + 每条请求的审计（D-15、03 §3.4）。

5. **Android 没有官方 SDK，协议类型由本仓库自持。** 官方跨语言面是 stdio JSON-RPC；
   Maven 上没有 `com.deepseek*`，npm 上 `@deepseek-ai/dsh-android` / `dsh-kotlin` 全部 404。
   所以 `android/` 必须自建协议客户端，且没有可对齐的 Kotlin 类型——版本只能由我们维护与
   冻结（A1、02 §D.3）。附带一条已发生的事实：`androidx.security:security-crypto` 的
   `1.1.0` 就是「全量弃用版」，令牌存储改为 Keystore 包裹的 AES-256-GCM（D-10）。
