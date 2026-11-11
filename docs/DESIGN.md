# DSH Remote Hub 设计文档

## 1. 文档信息

| 项 | 值 |
|---|---|
| 文档版本 | **v0.2** |
| 状态 | **设计草案**（Design Draft，未冻结）；取代 v0.1 |
| 最后更新 | 2026-11-11 |
| 适用仓库 | `E:/Code/DSH/plugins/dsh-remote-hub`（单包，npm 名 `@xiaopb/dsh-remote-hub`） |
| 对应计划 | [ROADMAP.md](./ROADMAP.md)（v0.2） |
| 目标 DSH 版本 | `>=0.2.1-rc.2 <0.3.0-0`（`engines.dsh`）；审计基线 **0.2.2-rc.1** |
| 原始需求来源 | [DeepSeek 分享对话](https://chat.deepseek.com/share/9ivjv3m4scoxlacoew)：一个插件同时支持「暴露自身」与「控制他人」，并覆盖 Android 实现 |

### 1.1 v0.2 是重写，不是修补

v0.1 是一份**基于假设**的设计：它假设守卫要自己定义协议词表、自己实现信封、自己起 WebSocket、自己翻译方法名、并且假设第三方向 DSH 取 `createPeer` 可能失败。v0.2 把其中每一条都拿去对源码与公开文档核了一遍，结果有**九条被推翻**。

v0.2 的证据链在三份独立文件里，逐条可核，本文只引用结论：

| 文件 | 内容 | 规模 |
|---|---|---|
| [verification/01-harness-facts.md](./verification/01-harness-facts.md) | 对 DSH 0.2.2-rc.1 源码逐条核对 v0.1 的 21 条事实与 15 条假设 | 216 行 |
| [verification/02-web-research.md](./verification/02-web-research.md) | 生态先例（npm 实测）、官方文档、隧道实践、Android 栈现状、传输选型、配对 UX 标准 | 250 行 |
| [verification/03-liveshare-precedent.md](./verification/03-liveshare-precedent.md) | 官方唯一非 owner 远程先例（LiveShare）的实现级摘要与 15 条可执行建议 | 277 行 |
| [verification/04-design-deltas.md](./verification/04-design-deltas.md) | **D-1…D-15 变更决议**，本文与 ROADMAP 的共同权威输入 | 本文每条 `(D-n)` 的出处 |

核对结论的分布（01 §1 统计，36 条）：

| 判定 | 条数 | 说明 |
|---|---|---|
| 成立 | 24 | 包含"第三方能拿到 `connection`/`typertGateway`"这个原本被列为最高风险的前提 |
| 表述需修正 | 4 | F13（endpoint 清单漏 13 个、`session/page` 已废弃）、F18（默认端口定义处写错）、A11（`read` 不能读二进制）、A13（`reads` 该基于 `session/events`） |
| 已失效 | 1 | F21：`@deepseek-ai/dsh-client-runtime` 在 0.2.2-rc.1 里**不存在** |
| 无法验证 | 7 | 外部依赖/UX 假设，已在新版计划里降级为"真机取证项" |

本文的书写约定保持不变，并加强一条：**凡涉及 DSH 官方 API、服务键、endpoint 名、方法签名的陈述，都必须带 `path:line`；查不到就写 `⚠️ 待验证`。** v0.1 违反了这条的地方（尤其是"路径省略 `packages/` 前缀"）已在 §15.4 列出。

---

## 2. 背景与问题陈述

DSH（DeepSeek Harness）是 Cordis 内核的 AI 编码宿主。它的 Web GUI 默认只服务本机，而这条边界是**硬编码**的：

- `WebServer` 的 Config schema 在加载期拒绝通配地址：`host 0.0.0.0 is an unspecified (wildcard) address, which is not supported: binding every interface would expose remote code execution to the network`（`packages/host/webserver/src/index.ts:359-366`）。默认值是 `127.0.0.1:3080`（`packages/bundle/web-app/cordis.patch.yml:186-188`——**不是** v0.1 写的 `boot/cmdline`）。
- 浏览器请求 `/api` 先过 `isTrustedApiRequest` 的 Host/Origin 围栏，再经 `browserAuth`；**认证通过后恒为 `owner` Peer**（`packages/client/connection/src/rpc-host.ts:92-94`：`this.browserPeer = new Peer(ctx, { principal: { kind: 'owner' } })`）。
- 官方对"把端口暴露出去"的立场是**明确推给部署者**：`--public-url` 只做公告"并不等于接纳"，而"无论是公告 URL 还是栅栏都不保护监听端口本身，因此请把端口限制在可信代理或网络内"（[public-deployments 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/public-deployments.zh.md)，02 §B.4）。

由此产生三个真实缺口：

1. **离开工位就失去控制权。** 长任务跑到一半需要审批（`approval/request`）、需要补一句 prompt，人必须回到那台机器前。
2. **移动端没有入口。** 官方没有 Android/Kotlin SDK——Maven Central 检索 `deepseek` 无 `com.deepseek*`，npm 上 `@deepseek-ai/dsh-android` 等 5 个候选名全部 404（02 §D.3）。
3. **多机编排靠人肉。** 在 A 机上想驱动 B 机上的 DSH 会话，只能 SSH 过去再操作 GUI。

`dsh-remote-hub` 的目标是给 DSH 加一层**设备颗粒度的安全接入层**：同一套能力既能「被远程控制」（host 半边），也能「控制别的机器」（client 半边 + Android），两侧共用一份协议事实。

> **关键边界（v0.2 收紧）**：DSH 的 `@deepseek-ai/dsh-api-gateway` + `@deepseek-ai/dsh-api-remote-access` 已经提供了"非 owner Peer 的方法级授权"。本插件**不重造这套**，而是：给出**设备身份**（配对 + 令牌）、给出**外部可达的入口**（回环守卫 + 隧道）、给出**能力的取舍表**（哪些官方 endpoint 给哪档角色）、并补上官方**明确不给非 owner** 的那几块（审批应答、二进制传输）。凡官方已有且非 owner 可用的，一律复用。

### 2.1 生态现状：空白在哪

v0.1 假设"手机控制 DSH"是空白。**这个假设是错的**，必须修正认知（02 §A）：

| 包 | 版本·日期 | 下载/月 | 做法 |
|---|---|---|---|
| `dsh-remote-hub`（**名字已被占用**） | 0.4.9 · 2026-11-05 | 4127 | Android App + ngrok/cloudflared + 10 分钟一次性配对码 + 30 天 Cookie |
| `@linxin666/dsh-remote-web-ui` | 0.4.16 · 2026-11-07 | **110079** | 扫码配对共享同一个 Web GUI（已声明弃用，迁往 `-bridge`） |
| `@mrrisega/dsh-remote` | 0.8.1 · 2026-11-10 | 9101 | 手机浏览器全功能控制，自带 SaaS |
| `dsh-remote-mobile` | 1.10.3 · 2026-11-03 | 5238 | 局域网/Tailscale、扫码、RSA + 防爆破 |
| `@xgone/dsh-remote` | 0.3.7-next.2 | 2929 | 登录门禁 + TOTP + 三级角色 `admin/user/guest` + 签名 Cookie |
| `@duke-dsh-plugins/dsh-remote-control` | 1.3.1 · 2026-11-10 | 2287 | HarmonyOS App + 自建 WS 哑中继 + E2E 加密 + 扫码 |
| `dsh-web-startup-auth` | 0.1.14 | 2621 | **替换官方 startup 以允许 `--host 0.0.0.0`** |
| `@lemoncat7/dsh-remote-settings-compat` | 0.6.7 | 1361 | 可信 Origin + 独立密码网关（3081 → 3080） |
| `dsh-plugin-remote` | 0.5.12 | 274 | 登录门禁 + 反向代理 + IP 白名单 |

**决定性的负面结果**：逐条核了上表与另外几个包的 `dependencies`，**没有任何一个依赖 `@deepseek-ai/dsh-api-remote-access`**。唯一的血缘关系是 `@qlzt/dsh-api-remote-access`——那是官方包的 gitee fork 重发布（无配对/隧道/移动端代码）。

也就是说：**生态普遍在"代理整个 Web GUI"，从而继承"认证后即 owner"这一事实。** 所以本插件的差异点只有两句话，且必须在 README 第一段就说清楚：

1. **每台设备一把可独立吊销的钥匙**（不是共享口令、不是 30 天 Cookie）。
2. **角色在 DSH 自己的 `decide()` 里生效**（不是守卫里的影子白名单）。

这两条才是空白。不写清楚就会被当成第 12 个重复造轮子的远程插件。

---

## 3. 目标与非目标

### 3.1 目标

| # | 目标 | 可验证的判据 |
|---|---|---|
| G1 | 同一插件同时提供 host 与 client 两种角色 | `exports["."]` 与 `exports["./client"]` 同时存在且各自可构建、可加载 |
| G2 | 设备通过**二维码票据（主）或一次性短码（辅）**建立长期信任 | QR 票据 TTL 120s、单次使用；短码 40 bit、TTL 10 分钟、5 次预算即烧码；签发端双条件回环门控对非回环来源 100% 拒绝 |
| G3 | 令牌泄露不产生可用凭据（落盘层面） | 设备表文件内不存在任何可直接用于认证的明文；`grep -F <token> devices.json` 为空 |
| G4 | 三档角色的差异在**官方 `decide()`** 里生效 | 只读设备调 `session/prompt` 得到 `remote-access/denied`，且该次调用未进入业务方法、未激活 Session |
| G5 | Android 端可完成配对、会话列表、发消息、**审批应答** | instrumentation 覆盖四条主链路；审批链路的反向断言见 §9.6 |
| G6 | 隧道只暴露守卫，不暴露 DSH 本体 | 隧道目标端口 = `guardPort`；`:3080` 不在任何外部可达面 |
| G7 | 吊销生效延迟有量化上界 | 吊销后 ≤ `streamHoldMs + 请求往返`（默认 ≤ 6s）两端进行中的流全部失效 |

### 3.2 非目标（Non-goals）

- **v1 不做 WebSocket，且 `ws` 是显式删除项。** 非 owner Peer 开不了 `/api/remote.mux`：`admitConnection()`（`rpc-host.ts:145-162`）只把请求交给 `admit()`（`:129-137`），而 `admit()` 只认 `browserAuth` → 拿到的永远是 owner Peer。所以流一律长轮询（D-3）。**推论**：`package.json` 的 `dependencies` 里**没有 `ws`** —— 这是决定，不是遗漏；`ws` 在 DSH 自己是依赖（`gateway/package.json:66` 有 `^8.21.3`），但那不构成我们引入它的理由，也绝不能指望宿主的传递依赖（F25/ADR-6）。同理删除 `GUARD_ROUTES.events` 与 `android/.../net/EventSocket.kt`。
- **不做 hub 自有方法词表。** 守卫转发**官方 endpoint**，不做名字翻译层（D-1）。
- **不做通用 RDP / 桌面串流 / 屏幕镜像。** 传的是会话文本、审批卡片与文件，不是像素。
- **不做公网无鉴权暴露。** 默认 `0.0.0.0`、默认关闭令牌校验、默认信任隧道头——一律不接受。
- **不替代官方 gateway / remote-access。** 不重写 `TypertGatewayService`、不自定义 `@Remote` 同名装饰器、不绕开 `ctx.remoteAccess.decide()`。
- **不做多租户。** 一个 Host 实例 = 一个 owner 的机器。需要隔离就起独立 Host 与独立 `DSH_HOME`。
- **不做云端中继。** 官方 LiveShare 的中继实现不在开源仓库里（03 §7.8），没有可复用的东西；v1 只用现成隧道。
- **不做逐请求签名。** v1 仍是 bearer。**这是相对官方先例的净增量空间，不是抄来的**——LiveShare 明确把 `actor.credential` 字段留空（03 §3.4）。
- **不在 v1 提供推送通知、离线写入、`/api/remote.mux` 复用。**

---

## 4. 术语表

| 术语 | 定义 | 落点 |
|---|---|---|
| **Host（被控端）** | 装着 DSH、被远程操作的那台机器 | `host/src/**` → `lib/index.js` |
| **Client（主控端）** | 发起操作的一方。两种形态：浏览器半边、Android App | `client/src/**`、`android/**` |
| **设备（Device）** | 一条被 Host 信任的持久身份，载体 `DeviceRecord` | `core/src/device.ts` |
| **角色（Role）** | 绑定在设备上的**官方 endpoint allow-list**，按资源种类分层。配对时由 Host 指定 | `core/src/roles.ts` |
| **配对票据（Pairing Ticket）** | QR 路径的高熵一次性凭据（32 字节随机，TTL 120s，单次使用） | `host/src/pairing.ts` |
| **配对码（Pair Code）** | 兜底路径的人工可读短码（8 位 Crockford Base32 = 40 bit，TTL 10 分钟，5 次预算） | `host/src/pairing.ts` |
| **守卫（Guard）** | 只绑回环的 HTTP 监听，是隧道的**唯一**目标。负责令牌校验、设备→Peer 映射、来源围栏、官方 endpoint 派发 | `host/src/guard.ts` |
| **隧道（Tunnel）** | 把守卫暴露到外部网络的搬运层。**从不承担鉴权** | `host/src/tunnel.ts` |
| **Peer** | DSH 连接层的「被准入方」，携带**创建时固定**的 `principal`（`typert/protocol/src/types.ts:468-483`） | DSH `PeerScope` |
| **Principal** | `PeerScope.principal`。DSH 内建只有 `{kind:'owner'}`；本插件合并 `'remote-device'`（D-12） | DSH `PrincipalMap`（声明合并） |
| **能力矩阵（Capability Matrix）** | 本插件的**唯一真源**：官方 endpoint × 角色 × 资源种类 | `core/src/roles.ts` |
| **流（Stream）** | 长轮询三方法（`hub/stream.open` / `hub/stream.next` / `hub/stream.cancel`，均走 `POST /remote/rpc`）。**不是** WebSocket | `host/src/streams.ts` |
| **预算（Budget）** | 长轮询每轮的持有/批量/游标上限，单向递增 | §8.5 |

> 命名冲突提示：`core/src/device.ts` 里的 `Principal` 是本插件守卫侧的身份视图（`{deviceId, role}`），**不是** DSH 的 `Principal`。两者在 §7.4 显式映射，不要互相赋值。

---

## 5. 使用场景

### 场景 A：手机审批 + 发消息（`control` 角色）

长任务跑到一半，DSH 弹出一个 shell 命令审批。人在地铁上：

1. 手机上正在跑的 `hub/stream.next` 在预算内返回一帧 `approval`（含**完整原始工具调用**，不是摘要）。
2. 用户逐字核对命令 → 点「允许」。
3. App 调 `hub/answerApproval`；Host 侧把决定交给 §9.6 的 waterfall 监听器 → 任务继续。
4. 用户顺手补一句"顺便把测试也跑了" → `session/prompt`。

**设计要点**：审批卡片必须显示原始参数。摘要化会让"批准了 A 实际执行了 B"成为可能。

### 场景 B：平板只读监控（`read-only` 角色）

把一台旧平板当状态屏挂墙上：

1. 配对时被指定 `read-only`。
2. 轮询 `session/events` 的增量 + `session/state`，实时渲染当前轮次输出。
3. 界面里**没有**输入框、没有审批按钮——不是禁用，是根本不渲染（§7.5 的列表过滤 + 快照）。
4. 平板丢失的损失上限：泄露会话内容，不能驱动任何动作。

### 场景 C：跨机编排（client 半边）

在 A 机（有键盘有屏）驱动 B 机（算力机）上的 DSH：

1. A 机浏览器半边的 `RemoteTarget { origin, deviceId }` 指向 B 机守卫 origin（经隧道）。
2. A 机用自己那张设备令牌访问 B 机守卫；**B 机的设备表与能力矩阵是唯一裁决者**。
3. A 机可同时挂多个 target（B、C、D），设备列表与角色各自独立。

### 场景 D：吊销（运维动作）

设备丢失时，Host 本机执行 `revoke(deviceId)`：

1. 设备表写入 `revokedAt`（原子写落盘）。
2. 守卫关闭该设备所有活跃 Peer（`peer.dispose()`），并让进行中的轮询在预算内以终态错误结束。
3. 该设备下一次请求得到 `device-revoked`（HTTP 401）；Android 收到该终态后**清空本地令牌并停止重连**。

> v0.1 在这里依赖一条 WS 推送。v0.2 没有 WS，所以延迟上界由 `streamHoldMs` 决定（G7）。这不是降级——它把"吊销可见延迟"从一个无法量化的推送时延，变成一个可断言的常量。

---

## 6. 总体架构

### 6.1 结构图

```
┌─────────────────────────── 外部网络 ───────────────────────────┐
│                                                                │
│   Android App (Kotlin)          Browser (client 半边)          │
│   OkHttp RpcTransport            fetch（长轮询）               │
│        │  Bearer <deviceToken>        │  Bearer <deviceToken>  │
└────────┼──────────────────────────────┼────────────────────────┘
         │   TLS（隧道终止）             │
         ▼                              ▼
   ┌─────────────────────────────────────────────┐
   │  隧道：cloudflared / Tailscale（纯搬运）      │
   │  只允许指向 guard origin，绝不指向 :3080      │
   └───────────────────┬─────────────────────────┘
                       │  http://127.0.0.1:8443
                       ▼
╔════════════════════════════════════════════════════════════════╗
║ Host 进程（DSH 宿主，Cordis 内核）                              ║
║                                                                ║
║  ┌──────────────────────────────────────────────────────────┐  ║
║  │ 守卫 guard.ts   只绑 127.0.0.1:8443                       │  ║
║  │  ① 令牌校验（SHA-256 + 常量时间）                          │  ║
║  │  ② 自身实现的三段来源围栏（Host / Sec-Fetch-Site / Origin）│  ║
║  │  ③ 短码与票据签发端双条件 loopback 门控（§8.2.1）           │  ║
║  │  ④ POST /remote/rpc → 构造 Request → sharedFetch(peer)    │  ║
║  │  ⑤ POST /remote/rpc method=hub/stream.next → 长轮询       │  ║
║  │  ⑥ dispose 时 peer.dispose() + 关闭监听 + 断活跃 socket    │  ║
║  └──────────────────────────┬───────────────────────────────┘  ║
║                             │ 进程内，非 HTTP                    ║
║         ┌───────────────────┴────────────────────┐             ║
║         ▼                                        ▼             ║
║  ┌──────────────────────┐              ┌──────────────────────┐ ║
║  │ connection            │              │ typertGateway        │ ║
║  │ createPeer(principal) │              │ sharedFetch('/api')  │ ║
║  │ createSharedFetchHandler            │ stream()             │ ║
║  └──────────┬───────────┘              └──────────┬───────────┘ ║
║             │                                     │             ║
║             ▼                                     ▼             ║
║  ┌────────────────────────────────────────────────────────────┐ ║
║  │ remoteAccess.decide()  ← 能力矩阵注册的 policy 在此裁决      │ ║
║  └────────────────────────────┬───────────────────────────────┘ ║
║                               ▼                                 ║
║  ┌────────────────────────────────────────────────────────────┐ ║
║  │ 官方业务服务：sessionController / workspaceFiles / terminal  │ ║
║  │              settings / goals / job / userQuestions         │ ║
║  └────────────────────────────────────────────────────────────┘ ║
║                                                                ║
║  ┌────────────────────────────────────────────────────────────┐ ║
║  │ approval-bridge.ts  ctx.on('approval/request', …)           │ ║
║  │ （唯一能拿到审批的合法形状；见 §9.6）                        │ ║
║  └────────────────────────────────────────────────────────────┘ ║
╚════════════════════════════════════════════════════════════════╝
```

### 6.2 三条通道，必须分清（v0.2 从两条变三条）

| # | 通道 | 谁用 | 鉴权 | 是否经 Gateway |
|---|---|---|---|---|
| ① | **同源 `/api`** | 本机浏览器 GUI | `browserAuth` → **owner** | 是 |
| ② | **守卫 → `sharedFetch('/api')`** | 远端设备（经隧道） | 设备令牌 → **`remote-device`** | 是（`decide()` 生效） |
| ③ | **守卫 → 本插件自有 Remote 服务（`hub/*`）** | 远端设备 | 设备令牌 → **`remote-device`** | 是 |

三条通道**都**最终落到同一个 `decide()`。这是 G4 的实现基础，也是 ADR-2 的唯一正确形态。

**为什么 ② 不能省成 ③**：官方业务有 60+ endpoint，逐个包一层 `hub/*` 就是 v0.1 的翻译层（已被 D-1 否决）。②让守卫直接转发官方 endpoint，③只承载"官方没有的东西"（流的三方法、审批应答、设备管理）。

### 6.3 一次远端 prompt 的完整数据流

```
设备                      守卫 :8443                     DSH 内核
 │                          │                              │
 │ POST /remote/rpc         │                              │
 │ Authorization: Bearer t  │                              │
 ├─────────────────────────►│                              │
 │                          │ ① 长度/字符集快速拒绝          │
 │                          │ ② hash(t) + timingSafeEqual   │
 │                          │   → DeviceRecord(d1, control) │
 │                          │ ③ 三段来源围栏                │
 │                          │ ④ 取该 deviceId 的 Peer       │
 │                          │   （role 变更则重建）          │
 │                          │ ⑤ new Request(              │
 │                          │     'http://hub.internal/api/session/prompt')│
 │                          │   sharedFetch.fetch(req,peer)│
 │                          ├─────────────────────────────►│
 │                          │                              │ resolveDescriptor
 │                          │                              │ assertExactArguments
 │                          │                              │ validateArguments
 │                          │                              │ callResources
 │                          │                              │ remoteAccess.decide ──┐
 │                          │                              │   ↳ 能力矩阵 policy   │
 │                          │                              │ resolveReceiverContext│
 │                          │                              │ 业务方法              │
 │                          │◄─────────────────────────────┤                      │
 │◄─────────────────────────┤ 200 {ok:true,value:…}        │                      │
```

### 6.4 端口与信任边界

| 端口 | 谁监听 | 外部可达 | 说明 |
|---|---|---|---|
| `3080`（默认） | DSH `webServer` | **否**（永不） | 本机 GUI。绑定非回环地址在加载期即抛错 |
| `8443`（默认） | 本插件守卫 | 仅经隧道 | 只绑 `127.0.0.1`；`guardHost` 校验必须是回环字面量 |
| 其它 | 隧道子进程 | — | 出站连接，无入站监听 |

**不变式**：`upstreamUrl`（指向 `:3080`）**只用于静态资源透传**，绝不参与任何 API 派发。守卫对 `/api/*` 显式 404（它在自己的端口上没有这条路由），对 `/remote/*` 之外的一切请求 404。

### 6.5 仓库结构与物理边界

```
dsh-remote-hub/
├── core/src/
│   ├── protocol.ts      # GUARD_ROUTES、错误码映射、PROTOCOL_VERSION
│   ├── capabilities.ts  # ★ 能力矩阵：官方 endpoint × 资源种类 × 角色（唯一真源）
│   ├── device.ts        # DeviceRecord / DeviceTable / IssuedDeviceToken / Principal
│   ├── roles.ts         # RoleName + 从 capabilities 派生的角色动作集合
│   └── index.ts
│   # 已删除（v0.2 / D-1）：envelope.ts（不再自造信封）
│
├── host/src/
│   ├── index.ts            # Cordis 入口
│   ├── plugin.ts           # 装配顺序
│   ├── config.ts           # schemastery Config
│   ├── devices.ts          # 设备表（原子写 + 文件锁）
│   ├── token.ts            # 生成 / 哈希 / 常量时间校验 / 吊销
│   ├── pairing.ts          # QR 票据 + 短码，一次性 + TTL + 预算
│   ├── policy.ts           # registerPolicy('remote-device', …) ← 不是 roles.ts
│   ├── principal.ts        # declare module 合并 'remote-device'
│   ├── fence.ts            # ★ 三段来源围栏（Host / Sec-Fetch-Site / Origin，D-9）
│   ├── guard.ts            # 回环监听 + 路由 + 令牌校验 + 派发
│   ├── dispatch.ts         # createPeer + sharedFetch 薄封装
│   ├── streams.ts          # ★ 长轮询三方法 + 预算 + cursor
│   ├── approval-bridge.ts  # ★ ctx.on('approval/request') waterfall 监听器
│   ├── files.ts            # ★ 上传（fileUploads/upload）与预览两条腿（D-6）
│   ├── tunnel.ts           # 隧道子进程监督
│   └── services/index.ts   # ★ 注册 hub/* 自有方法（设备管理、流、审批）
│
├── client/src/          # 浏览器半边
│   ├── index.ts / plugin.ts / transport.ts（长轮询）/ mount.ts / access.ts
│   └── ui/index.ts
│
├── android/             # 独立 Gradle 工程（Kotlin + Compose）
└── docs/
    ├── DESIGN.md        # 本文
    ├── ROADMAP.md
    └── verification/01..04
```

**新增的文件**都是 v0.2 独有的：`core/src/capabilities.ts`（D-11，唯一真源）、`host/src/streams.ts`（D-3）、`host/src/approval-bridge.ts`（D-5）、`host/src/policy.ts`（从 `host/src/roles.ts` 拆出，因为 `registerPolicy` 是 effect-scoped 的，与纯数据矩阵不同生命周期）、`host/src/principal.ts`（D-12）、`host/src/dispatch.ts`（D-2）、`host/src/fence.ts`（D-9）、`host/src/files.ts`（D-6）。

> **文件命名是契约**：`docs/ROADMAP.md` 用同一组路径引用这些文件。实现时以本表为准；两边不一致时改 ROADMAP（本表是权威）。

---

## 7. 组件设计

### 7.1 `core/` —— 共享事实层（大幅缩小）

**职责**：持有**唯一的线上事实**——守卫路由、能力矩阵、设备与配对类型、错误码映射、协议版本。

v0.1 曾把"方法名与事件名的唯一枚举源"也放在这里。**v0.2 删除该职责**（D-1），理由：

1. 官方 endpoint 有 60+ 个（01 §5 全表），维护一份平行的 hub 词表意味着每加一个能力要改三处（`core`、`services`、Kotlin 镜像）。
2. 官方信封 schema **是公开导出的**：`clientRequestSchema` / `serverResponseSchema` / `rpcResultSchema` 在 `packages/client/connection/src/rpc-schema.ts:24-47`，且 `@deepseek-ai/dsh-client-connection` 的 `exports` 含 `"."`。自造信封没有任何收益。
3. 翻译层是净风险：官方改一个 endpoint 名，我们要么编译期没发现，要么得维护双向表。

**关键约束**

- `capabilities.ts` 是**唯一**的"哪个角色能调哪个 endpoint"真源，被 host 的 `registerPolicy` 与 client/Android 的 UI 隐藏逻辑共同读取。
- `capabilities.ts` 的键必须是**官方 endpoint 字面量**（`'session/prompt'`），并有编译期断言：所有键都出现在 `@deepseek-ai/dsh-typert-protocol` 的 `RemoteEndpoint` 联合里（若该联合不可用，退化为运行期与 `ctx.typert.local` 对账的测试）。
- 禁止在 host/client 本地重新声明 endpoint 字符串。

**失败模式**

| 失败 | 后果 | 处置 |
|---|---|---|
| 能力矩阵漏了某个官方 endpoint | 该 endpoint 对所有非 owner `no-allow` 拒绝 | 这是**安全的**默认。测试用 `ctx.typert.local.list()` 枚举全部 endpoint 并与矩阵对账，输出"未列入"清单 |
| 能力矩阵多写了不存在的 endpoint | 无效条目，永不匹配 | 启动期与 registry 对账，多出来的记 warn |
| 矩阵与 Kotlin 镜像漂移 | 手机显示能点、后端 403 | 契约测试（能力矩阵导出为 JSON 快照，Kotlin 读同一份） |

### 7.2 `host/` —— 六条功能分支

装配顺序（`host/src/plugin.ts`，对应 ROADMAP T1.11）：

```
config → devices → token → pairing → policy(registerPolicy) → streams → guard → tunnel
```

**`policy` 必须在 `guard` 之前，且必须先于第一个 `createPeer`。** 理由（D-13）：`decide()` 对没有 policy 的 kind 一律返回 `no-allow`（`packages/api/remote-access/src/index.ts:203-204`），漏注册不是"降级为只读"，而是**全量 403**。

任一步失败**必须抛错**（fail loud）。

#### 7.2.1 `pairing.ts` —— 配对（v0.2 改为双路径）

- **职责**：签发/校验**QR 票据**与**短码**；把角色绑定到设备。
- **主路径（QR 票据）**
  - `issueTicket(role)` → 32 字节 `randomBytes(32).toString('base64url')`，`{ ticket, expiresAt: now+120_000, role }`。
  - 载荷渲染为二维码；Host 屏幕显示；**不经隧道传输**。
  - `redeemTicket(ticket, clientLabel)` → 常量时间比较 + 单次使用（redeem 即 burn）。
- **兜底路径（短码）**
  - `issueCode(role)` → 8 位 Crockford Base32（去掉 `I/L/O/U` 防误读）= 40 bit。
  - TTL 10 分钟；`maxPairAttempts = 5`；**成功或预算耗尽都必须 burn**。
- **两条路径共同约束**
  - 签发端（`POST /remote/pair/ticket`、`POST /remote/pair/code`）受**双条件回环门控**。
  - 兑换端（`POST /remote/pair`）**不**受回环门控——远程设备在隧道外，加了就永远配不上（v0.1 的 C1 结论，无新反证）。
  - 短码/票据**绝不经隧道、绝不写日志、绝不回显进错误体**。
  - 新签发作废旧的（同一角色的旧码/旧票据立即失效）。
- **为什么短码从 6 位升到 8 位 base32**（D-14）：6 位十进制 ≈ 19.9 bit。RFC 8628 §5.1 明确短码的安全性来自**尝试预算**而非长度，并给出"34.5 bit + 5 次尝试 = 2⁻³²"的算例（02 §F）。40 bit 让我们在同一预算下安全余量从"勉强"变成"充裕"，代价只是多输两个字符。
- **残余风险（必须写进文档）**：二维码可能被截图/被摄像头外的第二只手机拍到。缓解只有 TTL 120s + 单次使用；**不假装能防**。

#### 7.2.2 `token.ts` —— 令牌

与 v0.1 一致（这部分经核对仍成立，01 表 F-系列无相关修正）：

- 32 字节 `crypto.randomBytes(32).toString('base64url')`（43 字符）。
- 落盘只存 `hex(sha256(token))`。
- 校验：**先对两边都做哈希使长度恒等**，再 `crypto.timingSafeEqual`；不短路、不按长度提前返回。
- 吊销：`revokedAt` 非空即永久失效；校验路径在路由**之前**检查。

> 与官方先例的差异是刻意的：LiveShare 把凭据**明文**存盘（`owner-credential-file.ts:59-64`），因为那是绑定单一中继的短期 token。我们的设备令牌是**长期**凭据，所以必须存哈希（03 §8 建议 9）。这条要在代码注释里写明，否则后人会"照抄先例"改成明文。

#### 7.2.3 `policy.ts` + `principal.ts` —— 接入官方访问控制

- **`principal.ts`（D-12）**

  ```ts
  declare module '@deepseek-ai/dsh-typert-protocol' {
    interface PrincipalMap {
      'remote-device': {
        readonly kind: 'remote-device'
        readonly deviceId: string
        readonly role: RoleName
      }
    }
  }
  ```

  **只放身份，不放凭据。** `PeerScope.principal` 会被写进 Session 日志的 `source.principal`（`typert/protocol/src/types.ts:450-453`），所以绝不放 `tokenHash` / `label` / 时间戳。

- **`policy.ts`**
  - `ctx.remoteAccess.registerPolicy('remote-device', policy)`；注册属于调用方 fiber，dispose 自动撤销，且**同一 kind 重复注册会抛错**（`remote-access/src/index.ts:153-164`）。
  - `bindings(device)` 同步返回 `RemoteAccessBinding[]`：按 `capabilities.ts` 里该 role 的条目，为**每个相关资源种类**生成一条 binding。
  - `bindings()` **不得做 I/O、不得 await**——它每次 `decide()`、每次 `allows()`、每次快照计算都会被调用（`remote-access/src/index.ts:60-66` 的契约原文），抛错会导致 `policy-failed` 拒绝。
  - `explain(request)` 只用于给拒绝命名（`'no-allow'` 之外的原因），**不改变判定**。
  - 角色变更 / 吊销后调用 `ctx.remoteAccess.invalidate(principal)`，让已打开的访问快照重算。

**关键实现选择：资源绑定粒度**

v0.1 让所有 binding 都指向 `'global'`。v0.2 必须按资源种类分层（D-11），因为官方三个资源种类是独立授权的：

| 资源种类 | 声明处 | 本插件的绑定策略 |
|---|---|---|
| `global` | 内建 | 跨会话方法（`session/list`、`session/search`、`session/create`、`session/control`、`workspace/follow`、`job/list`、`goals/get`…） |
| `session` | `packages/core/session/src/types.ts:560-563` | 需要具体会话的方法（`session/events`、`session/state`、`session/prompt`、`session/cancel`、`terminal/*`、`fileUploads/upload`…）。**逐会话来一条 binding**，或一条带 `condition` 的 binding |
| `workspace` | `packages/workspace/workspace/src/types.ts:19-22` | `workspaceFiles/*` |

**为什么不能全用 `global`**：官方资源解析规则是"方法未指明资源 → 只有 `global` 放行"（`gateway/README.zh.md`）。而 `session/prompt` 的 `sessionId` 会被解析成 `session` 资源——如果只在 `global` 上授权，`decide()` 会因为在 `session` 资源上没有 binding 而拒绝。v0.1 的"三档角色全 `global`"**在实机上会全部失效**，这是 v0.1 的第二个致命错误（第一个是 ADR-8 翻译层）。

#### 7.2.4 `guard.ts` —— 守卫

- **职责**：唯一外部入口。令牌校验 → 来源围栏 → 设备→Peer → 路由 → 派发。
- **只绑 `config.guardHost`**（schema 校验必须是回环字面量，判据照 `webserver/src/index.ts:359-366` 的语义自己写，不引官方实现）。
- **路由（`GUARD_ROUTES`，全部 fail-closed）**

  | 路由 | 方法 | 鉴权 |
  |---|---|---|
  | `/remote/health` | GET | 无（返回最小事实：`{ok, protocolVersion}`，**不回显设备数、不暴露版本以外的配置**） |
  | `/remote/pair/ticket` | POST/GET | 双条件回环门控 |
  | `/remote/pair/code` | POST/GET | 双条件回环门控 |
  | `/remote/pair` | POST | 一次性票据/短码 + 预算 + 限流 |
  | `/remote/rpc` | POST | Bearer 令牌 |
  | 其它一切 | * | **404**（含 `/api/*`，也含任何 `/remote/stream/*` 形态的路径——那是不存在的路由） |

  > **为什么流没有自己的 HTTP 路由**：三条 stream 方法是**本插件自己的 `TypertRemoteService`**
  > （`hub/stream.open` / `hub/stream.next` / `hub/stream.cancel`），它们的调用也走
  > `POST /remote/rpc`（`method` 字段 = `hub/stream/next`），因此**同样过官方 `decide()`**。
  > 给它们单开三个 HTTP 路由会绕开 Gateway 的参数校验与访问判定，等于自造一条权限旁路——
  > 这正是红线 R9 禁止的形状。守卫只有四个业务路由（`health` + `pair×3`）加一个入口（`rpc`）。

- **派发（D-2）**：

  ```ts
  const handler = ctx.connection.createSharedFetchHandler('/api')
  const response = await handler.fetch(
    new Request(`http://hub.internal/api/${namespace}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    peer,   // ← 由令牌推导，客户端无法自称
  )
  ```

  `hub.internal` 这个主机名**不参与任何判定**（官方先例用 `http://liveshare.internal`，`viewer-dispatch.ts:152`）。它不是网络请求，`sharedFetch` 直接走进程内分派。

  这条路径自动带来三个我们本来要自己写的东西：
  1. 非 owner 打 exact Fetch 路由 → **403**（`rpc-host.ts:218-222`）；
  2. 未认领的 endpoint → **404**；
  3. 二进制附件投影（`ConnectionRpcHandlerResult.attachments`）。

- **来源围栏（D-9，自己实现，三段）**

  ```ts
  function sourceFence(req: IncomingMessage, cfg: Config): 'ok' | 'reject' {
    const host = req.headers.host            // 必须存在
    if (!host) return 'reject'
    // ① Host ∈ 允许集合：回环字面量恒允许；隧道公开 authority 由 publicAuthorities 显式声明
    if (!isAllowedAuthority(host, cfg)) return 'reject'
    // ② 跨站请求一律拒
    if (req.headers['sec-fetch-site'] === 'cross-site') return 'reject'
    // ③ Origin 存在时必须与 Host 同 authority；Origin: null 拒
    const origin = req.headers.origin
    if (origin !== undefined) {
      if (origin === 'null') return 'reject'
      if (new URL(origin).host !== host) return 'reject'
    }
    return 'ok'
  }
  ```

  语义逐条对齐 `api-request-trust.ts:121-151`，但**不能复用**：`isTrustedApiRequest` 没有从包根导出（`connection/src/index.ts` 只导出 `assertTrustedAuthority`），而 `./src/*` 不在发布产物里（`files` 只含 `lib/`）。这是同语义的独立实现，**升级 DSH 时必须重核**（写进 ROADMAP 的升级检查清单）。

  `publicAuthorities` 的 canonical 校验必须照 `assertTrustedAuthority` 的判据（`api-request-trust.ts:53`）：必须是裸 authority、大小写与 URL 解析一致、拒绝带路径/账号/百分号编码/非括号 IPv6/前导零端口。

- **为什么 `publicAuthorities` 是必需配置而 v0.1 没有**：v0.1 只允许回环 Host，那意味着**经隧道来的请求会被自己的围栏拒掉**——除非把 `Host` 头改写回回环。而"改写 Host"正是 v0.1 红线 R8 禁止的采信行为。这是 v0.1 的第三个内部矛盾（D-9 的直接后果）：**围栏必须知道隧道公开 authority**，否则远程设备根本进不来。

- **`dispose()`**：关闭监听 → `await peer.dispose()`（每个设备一个）→ 断所有活跃 socket。顺序不能反：先断 socket 再 dispose Peer 会让进行中的调用拿到 `gateway/peer-disposed` 而不是干净的连接关闭。

| 失败 | 检出方式 | 处置 |
|---|---|---|
| 端口被占（EADDRINUSE） | listen 回调错误 | 抛错，插件加载失败；**不静默换端口** |
| `ctx.connection` 缺失 | `ctx.get()` undefined | 抛错 |
| `ctx.typertGateway` 缺失 | 同上 | 抛错 |
| 令牌校验拖慢 | p99 延迟 | 哈希是 CPU-bound；设备数 >1000 时考虑缓存已验证哈希（**不得**缓存明文） |

#### 7.2.5 `streams.ts` —— 长轮询（v0.2 新增，替代整个 WS 栈）

- **职责**：把"官方 stream 方法的下行"翻译成三个**本插件自己的 Remote 方法**（namespace `hub`），并用预算约束持有时间。
- **为什么不能直接用官方 stream**：`@Remote({mode:'stream'})` 的下行在浏览器侧走 `/api/remote.mux` WebSocket，而那条 socket 的 Peer 由 `admitConnection()`（`rpc-host.ts:145-162`）经 `admit()`（`:129-137`）从 `browserAuth` 得来 → **恒为 owner**。非 owner 拿不到。官方 LiveShare 对非 owner viewer 也正是用"轮询三方法"（`packages/experimental/liveshare/src/viewer-channel.ts:29,40,46`）。
- **接口**（`namespace: 'hub'`，方法名 `stream.open` / `stream.next` / `stream.cancel` → endpoint 为 `hub/stream.open` 等。段内允许 `.`：`ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/`，`rpc-host.ts:38`）
  - `hub/stream.open({ endpoint, args }) → { streamId, cursor, snapshot? }`
    - `endpoint` 必须**同时在能力矩阵里**且是官方 `@Remote({mode:'stream'})` 方法。
    - 内部：`ctx.typertGateway.stream({ namespace, method, args, peer, signal })`，把 iterable 挂到一个 `Map<streamId, StreamState>`。
  - `hub/stream.next({ streamId, cursor, holdMs }) → { items, nextCursor, done?, terminal? }`
    - 最多持有 `min(holdMs, streamHoldMs)`；批量上限 `streamBatchMax`；批量窗口 `streamBatchWindowMs`。
    - `terminal` 是一个**终态错误**（`device-revoked` / `stream-cancelled` / `internal`），客户端收到后必须停止重连。
  - `hub/stream.cancel({ streamId }) → { ok }`
- **预算常量（D-4）**

  | 常量 | 值 | 理由 |
  |---|---|---|
  | `streamHoldMs` | 4_000 | 官方 viewer 用 10s；我们取 4s 以把吊销可见延迟压到 G7 的 ≤5s |
  | `streamBatchMax` | 64 | 同官方 `STREAM_BATCH_MAX` |
  | `streamBatchWindowMs` | 4 | 同官方 `STREAM_BATCH_WINDOW_MS` |
  | `streamPollSlackMs` | 2_000 | 同官方 `STREAM_POLL_SLACK_MS` |
  | `hubReadTimeoutMs` | 25_000 | 同官方 `VIEWER_READ_TIMEOUT_MS` |
  | `streamIdleTtlMs` | 120_000 | 同官方 `VIEWER_STREAM_IDLE_TTL_MS`：没人轮询的流 120s 后回收 |

- **预算必须单向递增**：`cursor` 是单调游标，服务端拒绝任何 `cursor < 已发出游标` 的请求（照 `packages/experimental/liveshare/src/read-budgets.ts:2-8` 的设计前提）。否则客户端可以用旧 cursor 反复拉同一批数据，把"轮询"变成"无限重放"。
- **归属**：`StreamState` 绑定 `(deviceId, streamId)`；`peer.dispose()` 或吊销时全部取消。跨设备猜 `streamId` 无效——`streamId` 由 `randomUUID()` 生成且绑定 Peer。

#### 7.2.6 `approval-bridge.ts` —— 审批（v0.2 新增，形状被推翻重写）

见 §9.6（这是安全模型的组成部分，不重复）。一句话：**注册 `ctx.on('approval/request')` 监听器，不接管就 `next()`**。

#### 7.2.7 `devices.ts` / `config.ts` / `services/` / `tunnel.ts`

| 组件 | 职责 | 关键约束 |
|---|---|---|
| `devices.ts` | 持久化 `{version:1, devices}`；`insert/update/flush` | 用 `@deepseek-ai/dsh-atomic-write` 的 `writeFileAtomic(file, content, { mode: 0o600, dirMode: 0o700 })` + `withFileLock`（官方 fork 登记就是这么做的，`packages/experimental/liveshare/src/host/fork-registry.ts:374,397`）；未知 `version` **fail closed**；`lastSeenAt` 合批写 |
| `config.ts` | schemastery `Config` | `guardHost` 校验回环；`publicAuthorities` canonical 校验；`streamHoldMs` 上界 ≤ 25s（超过 `hubReadTimeoutMs` 会让每轮都超时）。完整字段表见 §9.8 与该文件的 `DEFAULT_CONFIG`；`docs/ROADMAP.md` T0.5 列出 M0 必须落地的字段集（`publicAuthorities` / `streamHoldMs` / `streamBatchMax` / `streamBatchWindowMs` / `streamPollSlackMs` / `hubReadTimeoutMs` / `pairQrTtlMs` / `pairCodeTtlMs` / `maxPairAttempts`）。**两个 TTL 必须分开**：QR 票据 120s、短码 600s（D-14）——把它们压成一个标量会让二维码要么活得过久、要么短码来不及输 |
| `services/index.ts` | **只有 `hub/*` 自有方法** | v0.1 的"十个业务方法"全部删除（D-1）。这里只剩：设备管理（`hub/devices`、`hub/revoke`）、流三方法、`hub/answerApproval`；每个都用 `TypertRemoteService` 注册，因此同样过 `decide()` |
| `tunnel.ts` | 隧道子进程生命周期 | 默认 `kind:'none'`；origin 参数**断言必须等于 guard origin**（指向别处直接抛错）；崩溃按 `on-failure` 重启，退避照官方 `retry-backoff.ts`（500ms 起、上限 10s、稳定 30s 归零）；永久拒绝（401/403/410/426 语义）不重连 |

### 7.3 `client/` —— 浏览器半边

- **职责**：设备/会话/审批的 UI；权限快照；长轮询传输。
- **`ClientContext` 的来源（D-8）**：`import type { Context as ClientContext } from '@deepseek-ai/cordis'`。v0.1 写的 `@deepseek-ai/dsh-client-runtime/client` 在 0.2.2-rc.1 里**不存在**（410 个包全量比对，01 表 F21）。

**两种工作模式**

| 模式 | 目标 | 通道 | 说明 |
|---|---|---|---|
| **同源**（默认） | 本机 GUI 自己 | 官方 `ctx.remote.$mount()` | 管理本机设备表、看本机会话。权限恒为 owner |
| **远端**（跨机） | 另一台 Host 的守卫 | `transport.ts`（长轮询） | 需要 `RemoteTarget.origin`；受那台机器约束 |

**关键约束**

- UI 渲染项**必须**经 `AccessStore.can(endpoint)` 门控；权限来源只能是快照，不能是本地硬编码角色。
- `transport.ts`：每请求带 `Authorization: Bearer <deviceToken>`；令牌只在内存（**不进 URL**）。v0.1 曾有 `?token=` 的 WS 回退——**v0.2 删除**，因为不再有 WS，而一元 POST 永远能设 Header。
- 流走长轮询，**不得**用一元 RPC 反复调业务方法来伪装流（那会让 `decide()` 与 `allows()` 的调用量随 token 数爆炸）。
- 401/403 一律视为"设备已吊销" → 停止重试、清凭据、提示重新配对。
- `mount.ts` 只在同源模式使用。

### 7.4 Peer 与 Principal 的映射

#### 7.4.1 为什么需要这一层

`PrincipalMap` 是可声明合并的，内建只有 `owner`（`typert/protocol/src/types.ts:455-458`），且源码里有四处 `oxlint-disable` 注释原文写着 *"other packages merge non-owner kinds into PrincipalMap"*（`gateway/src/index.ts:501,803`、`remote-access/src/index.ts:201,254`）——**这是官方明示支持的扩展点，不是私有 hack**。

#### 7.4.2 映射规则

```
core/device.ts Principal { deviceId, role }
        │  守卫在令牌校验通过后构造
        ▼
PrincipalMap['remote-device'] { kind, deviceId, role }        ← 只放身份（D-12）
        │  ctx.connection.createPeer({ principal, interactions: 'none' })
        ▼
PeerScope（principal 创建时固定，线上字段无法设置）
        │  守卫每次派发时传给 sharedFetch.fetch(request, peer)
        ▼
ctx.remoteAccess.decide({ principal, action, resources, args })
```

**关键约束**

- **`interactions: 'none'`（D-13）**。默认是 `'answer'`（`peer.ts:40`）。v0.1 没有指定，那意味着设备 Peer 可以开 `$events` 流。但非 owner **永远不能**回答 waterfall（`gateway/src/index.ts:584`、`:502-504`），所以 `'answer'` 只白白多开一条可发帧的信道。`'none'` 让 `$events` 直接以 `gateway/interactions-forbidden` 拒绝（`index.ts:1242`）。
- 一个设备对应一个长期存活的 Peer（按 `deviceId` 归并）；设备吊销或角色变更时 `dispose()` 重建。
- **`registerPolicy` 先于 `createPeer`**（D-13）。

### 7.5 隧道

- **职责**：把 `http://127.0.0.1:8443` 变成外部可达的 HTTPS origin。
- **关键约束**
  - 只指向 guard origin。**任何人把隧道指向 `:3080` 都是配置事故**——那会让本机 GUI 直接暴露，`browserAuth` 是唯一防线，而官方自己说"URL 与栅栏都不保护监听端口本身"。
  - 隧道是**不可信传输**：不解析、不信任它带来的任何"身份头"。`CF-Connecting-IP` 只在"Cloudflare 边缘 → 源站"方向由 CF 注入，`X-Forwarded-For` 若原请求自带则被**追加**，`True-Client-IP` 官方自己承认"can be spoofed"（02 §C.1）。三者一律**只进日志、只作限流辅助信号**。
  - 隧道认证（Cloudflare Access / tailnet ACL）可以是**额外**一层，不得成为唯一一层。
- **provider 取舍（v0.2 新增，因为 v0.1 把 quick tunnel 当默认）**

  | provider | 谁能拿到 URL | 关键限制 | 本设计的定位 |
  |---|---|---|---|
  | Cloudflare **命名隧道** | 你指定的人/IdP | 需要安装与凭据管理 | **推荐**的默认路径 |
  | Cloudflare **Quick Tunnel**（`trycloudflare.com`） | **任何拿到 URL 的人** | 官方标"for testing and development"；**每隧道最多 200 在途请求，超出 429**；**不支持 SSE**；主机名每次都变 | 仅临时演示，**不得作为文档默认** |
  | Tailscale **Serve** | 仅 tailnet 内 | 需要设备装 Tailscale | **安全姿态最好**，文档化支持 |
  | Tailscale **Funnel** | **任何人** | 只能 443/8443/10000、只走 TLS、**不可配带宽上限**、TLS 在本机终止 | 文档化支持，但要显式写明"任何人有 URL" |
- **失败模式**：隧道崩溃 → 外部不可达，本机零影响（fail-closed 的正确形态）。`restart: 'on-failure'` 负责自愈。

---

## 8. 协议设计

### 8.1 版本与握手

```ts
export const PROTOCOL_VERSION = 1   // core/src/protocol.ts
```

**v0.2 的重大简化**：因为信封就是 DSH 自己的 `/api` RPC 信封（D-1/D-2），版本协商只剩**守卫自有面**需要：

- 自定义头 `X-Hub-Protocol: 1`，请求与响应都带。覆盖范围：三条 `hub/*` stream 方法 + 配对端点。
- 不匹配 → `protocol-version-mismatch`，HTTP 400。
- **不做隐式降级**。
- `PROTOCOL_VERSION` 的**唯一**两个消费者：这个头，以及 Android/Kotlin 的线格式契约快照。它**不是** DSH 版本（那由 `engines.dsh` 约束，ADR-10），也**不是**设备表磁盘版本（独立 `version: 1`）。

**为什么不在信封里加版本字段**：信封结构属于官方（`client-request` / `server-response`，`ClientRequest`/`ServerResponse` 在 `client/connection/src/rpc.ts:80-92` 导出），我们无权扩字段；扩了会让 `clientRequestSchema` 的严格校验拒掉。

### 8.2 配对握手（v0.2 双路径）

```
  Host 本机（操作者）            Host 守卫 (:8443)              设备（手机/浏览器）

  ① 本机 UI 点「添加设备」，选角色
        │
        ├──► pairing.issueTicket('control')   ── QR 主路径
        │     返回 { ticket: <43 字符>, expiresAt: now+120s }
        │     屏幕渲染二维码
        │
        │     ── 或 ──  pairing.issueCode('control')  ── 短码兜底
        │     返回 { code: "7K3M9XQ2", expiresAt: now+10min }
        │
  ② 用户扫码 / 手输短码
        │                                        ③ POST /remote/pair
        │                                           { ticket | code, clientLabel }
        │◄───────────────────────────────────────────┤
        │                                           │
        │  ④ ❗ 兑换端**不做**回环门控（远程设备必须能进）
        │     只靠：一次性 + TTL + 5 次预算 + 按来源限流
        │                                           │
        │  ⑤ 常量时间比较
        │     ├ 过期 → pair-expired
        │     ├ 不匹配 → pair-invalid（failedAttempts++）
        │     │   达 maxPairAttempts → burn → rate-limited
        │     └ 成功 → **立即 burn**
        │                                           │
        │  ⑥ token.issue({label, role})
        │     ├ token = 32B random base64url（明文仅此一次）
        │     └ 落盘 { deviceId, tokenHash, role, createdAt }
        │                                           │
        │  ⑦ 200 { deviceId, token, role }          │
        ├───────────────────────────────────────────►│
        │                                           │
        │                     ⑧ 令牌存入 Keystore 包裹的 AES-GCM
        │                                           │
        │  ⑨ 之后每请求：Authorization: Bearer <token>
        │◄───────────────────────────────────────────┤
```

#### 8.2.1 哪个端点该被回环门控（v0.1 的 C1，结论保留）

源方案与脚手架原话是"配对端点只接受回环来源"。但**远程设备本身就在隧道外面**——如果兑换端也要求回环，远程 Android 永远无法配对。

| 端点 | 谁调用 | 门控 |
|---|---|---|
| `POST/GET /remote/pair/ticket`（签发票据） | Host 本机 UI | **双条件 loopback** |
| `POST/GET /remote/pair/code`（签发短码） | Host 本机 UI | **双条件 loopback** |
| `POST /remote/pair`（兑换） | 设备（可经隧道） | 一次性 + TTL + 预算 + 限流 |

安全性质：票据/短码**从不**经隧道传输（人读屏、人扫码/手输）；签发端即便请求从本机发出，经隧道来的也拿不到码（隧道终止的请求 socket 可能是回环，但 `Host` 头是公开 authority，双条件第二个不满足）。

#### 8.2.2 为什么需要 QR（v0.2 新增）

v0.1 只有 6 位数字码。核对结果（02 §F）：

- **Signal** 的设备链接是**纯 QR**，无数字码路径。
- **Tailscale** 用 auth key + device approval + QR。
- **Syncthing** 是设备 ID + 双向接受，无短码。
- **KDE Connect** 是双端确认提示。
- RFC 8628 明确短码的安全性"来自限流与其它缓解"，而非长度。

生态里 6 个同赛道 DSH 插件全部以 QR 为主路径。继续只给 6 位数字码，会被合理地质疑为 2026 年的设计。

### 8.3 令牌载体

| 场景 | 载体 | 必选 |
|---|---|---|
| 一元 RPC（`POST /remote/rpc`） | `Authorization: Bearer <deviceToken>` | 是 |
| 流三方法（`hub/stream.{open,next,cancel}`，走 `/remote/rpc`） | 同上 | 是 |
| 签发（`/remote/pair/{ticket,code}`） | 无令牌；靠双条件回环 | — |
| 兑换（`POST /remote/pair`） | 无令牌；靠一次性票据/短码 + 预算 + 限流 | — |
| 健康检查（`GET /remote/health`） | 无 | — |

**v0.2 删除 `?token=` 回退**：那是为"无法设 Header 的 WS 升级"准备的。没有 WS，就没有这个借口的场景；所有请求都是 `fetch`/OkHttp POST，都能设 Header。少一条载体 = 少一个"Header 路径更严、query 路径更松"的实现分叉点。

### 8.4 一元 RPC 信封（就是 DSH 的）

请求体是 `@deepseek-ai/dsh-client-connection` 公开的 `ClientRequest`（`rpc-schema.ts:31-38`）：

```jsonc
// POST /remote/rpc?endpoint=session/prompt
{
  "type": "client-request",
  "rpcId": "7f3c1e9a-…",          // 客户端生成，响应回显
  "method": "session/prompt",
  "payload": { "sessionId": "…", "content": […] }
}
```

响应体是 `ServerResponse`（`rpc-schema.ts:41-50`）：

```jsonc
{
  "type": "server-response",
  "rpcId": "7f3c1e9a-…",
  "result": {
    "ok": false,
    "error": {
      "code": "remote-access/denied",
      "message": "remote access: session/prompt: access denied (no-allow)",
      "details": { "action": "session/prompt", "reason": "no-allow" }
    }
  }
}
```

约束：

- **没有 `principal` 字段**——身份由守卫从令牌推导，`PeerScope.principal` 在创建时固定（`typert/protocol/src/types.ts:473`）。
- `rpcId` 必须回显；Host 不得改写（否则客户端无法配对请求）。
- 单请求体上限 = `maxRequestBodyBytes`（官方默认 300 MiB，是给图片留的；我们把守卫的入口上限设得更小，见 §9.8）。
- `payload` 的字段校验由 Gateway 做（`assertExactArguments` + `validateArguments`，`gateway/src/index.ts:800-801`），**守卫不重复实现**。这是 D-1 的直接收益：参数校验只有一份实现。

**endpoint 从哪来**：只用信封里的 `method` 字段，**不要再加一个 query 参数**。Connection 的信封已经是 `{type, rpcId, method, payload}`（`ClientRequest`，`client/connection/src/rpc.ts:80-85`），`method` 就是 `<namespace>/<method>`；守卫把它拼进 `http://hub.internal/api/${method}` 交给 `sharedFetch`，路径解析在 `endpointFromPath`（`rpc-host.ts:361-370`）里完成。多一个 `?endpoint=` 就是第二个真相，早晚与 `method` 不一致。ROADMAP T1.1 的验收按这个字段名写。

### 8.5 长轮询帧（v0.2 新增）

三条方法都是**本插件自己的 Remote 方法**，所以它们的线上形状是**官方信封**（§8.4），
`method` 分别是 `hub/stream.open` / `hub/stream.next` / `hub/stream.cancel`，**不是**三个新 HTTP 路由。

```jsonc
// POST /remote/rpc
{ "type":"client-request", "rpcId":"…", "method":"hub/stream.open",
  "payload": { "endpoint": "session/events", "args": { "sessionId": "…" } } }
// → { "ok": true, "value": { "streamId": "9a2f…", "cursor": 0, "snapshot": { … } } }

// POST /remote/rpc   ← 同一个入口，只是 method 不同
{ "type":"client-request", "rpcId":"…", "method":"hub/stream.next",
  "payload": { "streamId": "9a2f…", "cursor": 0, "holdMs": 4000 } }
// → { "ok": true, "value": { "items":[ … ], "nextCursor": 3, "done": false } }
// → { "ok": true, "value": { "items":[  ], "nextCursor": 3, "done": false } }        // 预算内无数据
// → { "ok": true, "value": { "items":[  ], "nextCursor": 3, "terminal": { "code":"device-revoked" } } }

{ "type":"client-request", "rpcId":"…", "method":"hub/stream.cancel",
  "payload": { "streamId": "9a2f…" } }
// → { "ok": true, "value": { "ok": true } }
```

- **为什么不用三个 HTTP 路由**：路由级端点绕开 Gateway 的参数校验与 `decide()`，等于给这些方法开一条没有角色判定的旁路（红线 R9）。做成 Remote 方法后，`decide()` 会以 action `hub/stream/next` 询问能力矩阵，与官方 endpoint 走完全相同的裁决路径。
- **`payload.endpoint` 必须同时满足**：在能力矩阵里、对该角色可见、且是官方 `@Remote({mode:'stream'})` 方法。三条任一不满足 → `hub/stream-open-denied`（**不泄露是哪一条不满足**，只给统一错误，避免成为 endpoint 探测器）。
- `cursor` 是**单调整数**，不是字节偏移。服务端持有 `emitted`；`cursor > emitted` 或 `cursor < acceptedFloor` → `hub/cursor-invalid`。
- **缺口允许**：`items` 之间的"序号缺口"由上游 stream 决定，客户端必须能跳着接（不假设连续）。
- `terminal` 一旦收到即终态；客户端**必须**停止该 `streamId` 的轮询（继续轮询得到同一个 `terminal`，不再持有）。
- 空闲回收：`streamIdleTtlMs`（120s）内无 `next` → 取消上游 stream 并释放。没有定时器扫描的话，用"下一次任何 stream 方法调用时顺带清理过期条目"的惰性策略（避免 `unref` 定时器在测试里泄漏）。
- **`decide()` 的 action 名**：`hub/stream/open`（即 `<namespace>/<method>` = `hub/stream` + `open`）。能力矩阵必须为三档角色各列这三条，且 `read-only` 也必须有（监控设备要能看流）。

### 8.6 能力矩阵（替代 v0.1 的方法/事件映射表）

**这是 v0.2 的核心新增。** 完整矩阵在 `core/src/capabilities.ts`，本文给分层原则与不可下放清单。

#### 8.6.1 三档角色

| 角色 | 语义 | 判据 |
|---|---|---|
| `read-only` | 只能看 | 只含 `list`/`search`/`get`/`page`/`events`/`state`/`projections`/`follow`/`stat`/`read`/`readBytes`/`describe` 这类无副作用方法 |
| `control` | 能驱动会话，不能碰文件系统与凭据 | `read-only` + `prompt`/`cancel`/`create`/`fork`/`rename`/`updateQueue`/审批/提问 |
| `full` | 还能传文件、开终端 | `control` + `fileUploads/upload`/`workspaceFiles/*`/`terminal/*`/`job/kill` |

#### 8.6.2 只读档可用的官方 endpoint（节选，全表见 `capabilities.ts`）

| endpoint | 资源 | 备注 |
|---|---|---|
| `session/list` | `global` | 官方已逐项 `allows()` 过滤（`session-controller/src/index.ts:284`） |
| `session/search` | `global` | 同上（`:298`）；**只读设备可安全开放** |
| `session/events` | `session` | v0.1 的 `session/page` **已 `@deprecated`**（`session-controller/src/index.ts:526`），接任者是 `events`（`:542`）。这是 A13 的修正 |
| `session/state` | `session` | 比拉整页历史省 |
| `session/projections` | `session` | |
| `session/observe{Event,Projections,State}` | `session` | 更细的订阅粒度 |
| `session/follow` | `session` | 但注意它是 stream 模式，要走 §7.2.5 的 `hub/stream.open` |
| `workspace/follow` | `global` | Workspace/会话归属的 baseline+增量 |
| `workspaceFiles/stat` `read` | `workspace` | `read` 只读文本；**遇 NUL 抛 `workspace-file/not-text`** |
| `workspaceFiles/readBytes` | `workspace` | 二进制/图片**必须**用它（A11 修正） |
| `workspaceFiles/list` `changes` | `workspace` | v0.1 漏了这两个 |
| `job/list` `job/follow` | `global` | 后台任务面板 |
| `goals/get` | `global` | 注意 namespace 是 **`goals`** 不是 `goal` |
| `settings/describe` | `global` | 只读描述；写方法永不下放 |

#### 8.6.3 `control` 档新增

| endpoint | 资源 |
|---|---|
| `session/create` `prompt` `cancel` `fork` `rename` `updateQueue` | `global` / `session` |
| `session/selectModel` `modelCatalog` `workspacePathApplications` | `global` |
| `userQuestions/answer` `attachWait` | `session` — **与审批同风险等级**（替 owner 决策），见 §9.6 |
| `goals/{edit,pause,resume,complete,create}` | `global` |
| `workspace/{create,rename,insertBefore,archiveSession,pinSession}` 等 | `global` |

#### 8.6.4 `full` 档新增

| endpoint | 资源 | 备注 |
|---|---|---|
| `fileUploads/upload` | `session` | **唯一**可行的上传路径（exact Fetch 路由对非 owner 恒 403） |
| `terminal/{create,attach,retain,list,shells,close,rename,environment}` | `session` | `attach` 是双向 `RemoteStream<TerminalFrame,TerminalInput>`，**给予它等于把 shell 交出去** |
| `job/kill` | `global` | |
| `session/attachment` | `session` | ⚠️ 官方已知限制：在任一 session 资源上授予即可**跨会话**读图片（见 §9.2） |

#### 8.6.5 永不下放清单（红线，v0.2 新增）

| endpoint / 前缀 | 原因 |
|---|---|
| `credentials/*`（`describe`/`set`/`unset`） | 明文凭据写入（`settings-controller/src/credentials.ts:70-112`） |
| `settings/{update,replace,mutate,openSettingsDocument}` | 改宿主配置；`describe` 可给，写不可 |
| `directoryPicker/*` | `pick` 会在 **Host 桌面上弹原生对话框**（`workspace-controller/src/directory-picker.ts:54`），等于远程操控宿主 UI |
| `pluginManager/*`、`pluginMarket/*` | 安装/卸载/升级代码 —— 等于远程代码执行。**namespace 是 camelCase**：`super(ctx, 'pluginManager')`（`boot/plugin-manager/src/index.ts:358`）、`super(ctx, 'pluginMarket')`（`boot/plugin-market/src/index.ts:135`），endpoint 前缀因此是 `pluginManager/` 与 `pluginMarket/`（v0.2 草案曾误写成 `plugin-manager/*`，文件名不是 namespace） |
| `pluginInventory/list` | 已装插件清单会暴露攻击面；官方 LiveShare 把它整条归为 `owner-only`（`packages/experimental/liveshare/src/endpoint-classification.ts:208`） |
| `account/*`（`getState`/`getProfile`/`getBalance`/`signIn`/`signOut` 等） | 账号凭据与登录态（`api/account-controller/src/index.ts:13-91`） |
| `remoteAccess/follow` | **恒放行**（`remote-access/src/index.ts:202`）。若要下放，必须在自己的 policy 里再判一次，不能依赖它 |
| `$events` / `$events/result` | Gateway 自有；非 owner 也不该拿（`interactions:'none'` 已挡住） |

> 这张表要有一条**自动化断言**：`capabilities.ts` 的键集合与上表前缀的交集为空。
>
> **命名以 Typert 注册表为准，不得凭记忆填。** 开工时用 `ctx.typert.local.list()` 枚举当前装配里**真实存在**的 endpoint，
> 再与上表对账：表里有、注册表里没有的条目记为"冗余红线"（无害，但说明我们猜错了 namespace）；注册表里有、表里没覆盖的
> 记 warn 并要求人工判定。这条对账就是 ROADMAP T2.2 里 `redline-namespace-check` 的来源。
> `pluginManager` / `pluginMarket` / `account` 三组已按此方式核对过 namespace（见上表行内证据），但其**方法名清单**仍以
> `ctx.typert.local.list()` 的实测为准。

#### 8.6.6 事件面（v0.2 大幅收缩）

v0.1 定义了 4 个自有事件（`session.delta` / `approval.requested` / `approval.resolved` / `device.revoked`）。v0.2 的处理：

| v0.1 事件 | v0.2 落点 |
|---|---|
| `session.delta` | 官方 `session/events` 或 `session/follow` 的帧，经 `hub/stream.next` 投递。**不再有自定义事件名** |
| `approval.requested` | `hub/stream.next` 的一帧 `{ kind: 'approval', … }`（本插件自有流的帧类型，不是 Cordis 事件名） |
| `approval.resolved` | 同上：`{ kind: 'approval-resolved', … }` |
| `device.revoked` | `hub/stream.next` 的 `terminal.code = 'device-revoked'`，或任一请求的 401 |

**为什么**：官方转发事件允许清单在 `packages/api/remotes/src/remote-events.ts:27-59`，只有两个 waterfall（`approval/request`、`user-questions/request`），其余是 `emit`，且非 owner 只在 `decide({action:'event:<name>'})` 放行时整条收到。非 owner **根本开不了** `$events`（`interactions:'none'`），所以"自定义事件名"在 v0.2 里没有任何承载通道。硬要保留就只能靠轮询伪装，那就违反了 ADR-6 的初衷。

### 8.7 错误码表

`core/src/protocol.ts` 的 `ERROR_CODES`。**v0.2 的关键变化：官方错误码原样透传，不再包装成 hub 错误码。**

| 值 | 来源 | 语义 | HTTP | 客户端应做什么 |
|---|---|---|---|---|
| `remote-access/denied` | **官方** | `decide()` 拒绝（含 `details.action` + `details.reason`） | 403 | 隐藏该入口；**不要**当网络错误重试 |
| `session/not-found` | **官方** | 会话不存在（`core/session/src/types.ts:566-568`） | 404 | 刷新列表 |
| `gateway/*`（`input-invalid` / `method-unavailable` / `peer-disposed` / `cancelled` / `uplink-overflow` / `service-unavailable` / `definition-unavailable`） | **官方** | Gateway 层的各类失败 | 400 / 404 / 409 / 500 | 按码区分：`input-invalid` 修客户端；`peer-disposed` 重新配对 |
| `workspace-file/not-text` | **官方** | 用 `read` 读了二进制 | 422 | 改用 `readBytes` |
| `bad-request` | 本插件 | 信封或守卫层结构非法 | 400 | 修客户端；不要重试 |
| `unauthorized` | 本插件 | 无令牌 / 令牌不存在 | 401 | 停止重试，进入配对流程 |
| `device-revoked` | 本插件 | 设备已吊销 | 401 | **清空本地令牌**，停止重连 |
| `pair-invalid` | 本插件 | 票据/短码不匹配 | 403 | 允许重输，注意剩余预算 |
| `pair-expired` | 本插件 | 票据/短码过期 | 403 | 让 Host 重新出码 |
| `protocol-version-mismatch` | 本插件 | `X-Hub-Protocol` 不符 | 400 | 提示升级，不重试 |
| `rate-limited` | 本插件 | 超预算（配对爆破 / 请求洪泛） | 429 | 退避后重试 |
| `hub/stream-open-denied` | 本插件 | 流目标不被允许 | 403 | 隐藏入口（**错误体不含具体原因**） |
| `hub/cursor-invalid` | 本插件 | 游标非法（回退或超越） | 409 | 重新 `hub/stream.open` |
| `internal` | 本插件 | 守卫未预期错误 | 500 | 退避重试，带 `rpcId` 上报 |

**渲染规则**：`remote-access/denied` 必须被 UI 渲染成"不该显示的入口"，而不是"网络失败"。`hub/stream-open-denied` 同理。

### 8.8 版本兼容策略

| 变更类型 | 升 `PROTOCOL_VERSION` | 兼容窗口 |
|---|---|---|
| 能力矩阵新增一个官方 endpoint | 否 | 旧客户端不认识即可不调用；未知 endpoint 由服务端拒 |
| 新增一个 `hub/*` 方法 | 否 | 由 `X-Hub-Protocol` 之外的**方法存在性**判定 |
| 新增官方错误码透传 | 否 | 未知错误码映射到 `internal` 展示 |
| 改流的帧形状（`items` / `terminal`） | **是** | 主版本内不兼容 |
| 改配对流程（票据/短码） | **是** | 同上 |
| 官方 endpoint 改名 | 否（但会破） | 由 DSH 升级检查清单 + 契约测试兜底 |

窗口规则：`v1` 设备表 `version: 1` 与 `PROTOCOL_VERSION = 1` **独立演进**。前者是磁盘格式，后者是线上协议。

**新增：DSH 升级检查清单（v0.2 新增）**

DSH 小版本升级时必须重核这七处（与 ROADMAP §6.3 的发布检查清单互为镜像，两处必须同时改）：

1. `isTrustedApiRequest` 的判据（我们照它独立实现，§7.2.4 / D-9）。
2. `PrincipalMap` / `PeerScope` 的形状与 `interactions` 默认值（`typert/protocol/src/types.ts:455-483`、`peer.ts:40`）。
3. `sharedFetch` 对非 owner 的 exact-Fetch-403 行为（`rpc-host.ts:218-222`）。
4. `approval/request` 的 waterfall 签名与 `ScopeTarget` 语义（`user-approval/src/index.ts:308`）。
5. 能力矩阵里每个 endpoint 是否仍然存在（对账测试）。
6. **枚举对账**：`ctx.typert.local.list()` 输出的 endpoint 全集 vs `GUARD_ROUTES` ∪ `capabilities.ts` ∪ `NEVER_DELEGATED`，三方必须覆盖全集且互不重叠（重叠只允许 `NEVER_DELEGATED` 内部一致）。新增的官方 endpoint 必须在本次升级中归入**某一侧**，不允许"默认没人管"。
7. **本插件自有面**：`hub/*` 方法与 `channel`/`endpoint` 段字符集（`ENDPOINT_SEGMENT_PATTERN`，`rpc-host.ts:38`）是否仍然允许 `.`——`hub/stream.next` 依赖它。

---

## 9. 安全模型

### 9.1 信任边界

```
[不可信] 公网 ──TLS──► [不可信] 隧道 ──HTTP──► [半可信] 守卫 :8443 ──进程内──► [可信] DSH 内核
                                                     │
                                                     └─ 设备表（本机文件系统，只存哈希，0600）
```

- 跨过守卫边界的**唯一**凭据是设备令牌。
- 隧道的任何头部都不构成凭据。
- 守卫之后的一切都在同一进程内，按 Cordis 服务注入获取能力；**不再有第二道鉴权**，所以守卫与 `decide()` 的判定合起来必须是完备的。

### 9.2 威胁模型（STRIDE）

| 类别 | 威胁 | 具体攻击 | 缓解 | 残余风险 |
|---|---|---|---|---|
| **S**poofing | 冒充已配对设备 | 偷令牌文件 / 中间人抓 Bearer | 令牌只在签发时明文一次；落盘仅哈希；隧道强制 TLS；吊销即时生效 | 设备被 root 后可读 Keystore 外的内存 |
| **S**poofing | 冒充 owner 走 `/api` | 把隧道指向 `:3080` | 隧道只许指向守卫；守卫 `/remote/*` 独立鉴权 | 运维误配（靠红线 + `startTunnel` 的 argv 断言） |
| **S**poofing | 伪造 `Host` 骗过围栏 | 经隧道发 `Host: 127.0.0.1` | 围栏要求 `Host` ∈ {回环字面量} ∪ `publicAuthorities`；**但经隧道的请求 `Host` 是公开 authority**，所以回环字面量只在"真的来自本机 socket"时才有意义 → 见下方补强 | ⚠️ **见 §9.3 第 1 条** |
| **T**ampering | 篡改设备表 | 把别人的 `tokenHash` 换进来 | 表内只有哈希，改哈希等于换一个自己不知道的令牌；原子写 + 文件锁防截断 | 本机同用户可写文件即可改角色 |
| **T**ampering | 篡改令牌比较逻辑 | 时序侧信道推出前缀 | 双方先哈希使长度恒等 + `timingSafeEqual` + 不短路 | 无 |
| **R**epudiation | 否认做过审批 | 远端批准了危险命令 | 每次远端审批写审计（deviceId/callId/outcome/时间） | 日志本身可被本机用户删除 |
| **I**nformation disclosure | 设备表泄露 | 备份/同步目录泄露 `devices.json` | 只存 `sha256(token)`；32B 随机值使彩虹表无效；`mode 0o600` | 设备标签会泄露（"小明的 iPad"） |
| **I**nformation disclosure | 快照泄露越权入口 | 只读设备看到写入口 | 能力矩阵 + `decide()` + UI 门控**读同一份表** | 快照判定不带 `args`，按参数细化的条件可能不一致 |
| **I**nformation disclosure | 跨会话读附件 | 用 A 会话的 `sessionId` 读别处图片 | 官方已知限制：`session/attachment` 在任一 session 资源上授予即可跨会话读（`remote-access/README.zh.md`）→ **`session/attachment` 只给 `full`，且文档明示这是整个附件存储的读权限** | 多租户需独立 Host + 独立 `DSH_HOME` |
| **I**nformation disclosure | `$events` ready 帧泄露宿主路径 | 非 owner 拿到 `host.home` | `interactions:'none'` 让非 owner 开不了 `$events` | 会话 cwd 本身就用绝对路径（官方明确不单独隐藏 `home`） |
| **D**enial of service | 配对爆破 | 40 bit 短码 | 10 分钟 TTL + 5 次预算烧码 + 按来源限流 + 签发端回环门控（短码不经网络） | 可见 Host 屏幕者可直读；本机同用户进程等价于已有本机权限 |
| **D**enial of service | 令牌洪泛 | 大量随机令牌 | 哈希前做长度/字符集快速拒绝；按来源限流 | 单机 CPU 饱和（不导致越权） |
| **D**enial of service | 长轮询占满连接 | 大量 `stream/next` 各持有 4s | `streamBatchMax` + 每设备并发 stream 上限 + `streamIdleTtlMs` 回收 | 单设备可自伤；换设备即重新计数 |
| **E**levation of privilege | 只读设备执行写操作 | 直接 POST `session/prompt` | Gateway 的 `decide()` 在业务方法前拒绝；能力矩阵只列只读动作 | 无（前提是 principal 正确，见 §7.4） |
| **E**levation of privilege | 客户端自称角色 | 信封里塞 `role:'full'` | 信封无 `principal` 字段；守卫只从令牌推导 | 无 |
| **E**levation of privilege | 隧道头伪造 | `cf-connecting-ip: 127.0.0.1` | 来源判定不看任何转发头（§9.3 第 1 条） | 无 |

### 9.3 逐类攻击的缓解清单（实现检查项）

1. **`Host` 头伪造 + 回环短路（v0.2 新增，最重要的补强）**
   v0.1 的围栏是"`socket.remoteAddress` 是回环 **且** `Host` 命名回环"。v0.2 加了一条 `publicAuthorities` 通路，于是产生一个新风险：**如果隧道在本机终止（cloudflared 就是这么做的），`socket.remoteAddress` 恒为 `127.0.0.1`**，那么"回环 socket + 回环 Host"这个组合可以被一个经隧道来的请求伪造出来（只要它发 `Host: 127.0.0.1`）。
   
   **因此**：
   - 签发端点的门控必须是**双条件**且 `Host` 必须在**回环字面量白名单**内（不是"看起来像回环"）；
   - 并且签发端**额外**要求一个不经网络的常量：`pairIssueToken`（进程内随机，只写进本机页面的 `__DSH_REMOTE_HUB__` 注入行）。**仅凭"能连到 8443"不足以签发配对码**——这条把"隧道在本机终止"的整个攻击面消掉。这一条是 v0.2 新增，v0.1 没有。
   
   > 实现提示：`webserver/index-inject` 可以把值注入 index 页（官方 `REMOTE_ACCESS_SNAPSHOT_KEY` 就是这么做的，`remote-access/src/index.ts:138-142`），Host 本机 UI 从那里读。

2. **DNS rebinding 打守卫**：围栏必须校验 `Host` 在允许集合内，否则浏览器可被诱导访问 `http://evil.example:8443`（判据照 `api-request-trust.ts:121-151`）。

3. **跨站请求**：拒绝 `Sec-Fetch-Site: cross-site`；带 `Origin` 时必须与 `Host` 同 authority；`Origin: null` 拒。

4. **令牌重放**：v1 令牌是 bearer（长期有效）。缓解是"缩短爆炸半径"——吊销即时、角色最小化、审计。**不引入每请求签名**（ADR-5）。

5. **时序攻击**：令牌比较、票据/短码比较都走常量时间；位数不足时用填充比较而不是提前返回。

6. **哈希泄露后的暴力**：32 字节随机 → 不可能；不提供"用户自选令牌"入口。

7. **二维码肩窥/截图**：TTL 120s + 单次使用。**不假装能防截图。**

8. **流游标回退重放**：`cursor` 单向递增，服务端拒绝回退（§8.5）。

9. **能力矩阵成为 endpoint 探测器**：`hub/stream-open-denied` 不给具体原因（不区分"不存在"、"角色不足"、"不是 stream 方法"）。

### 9.4 安全红线（不可协商）

| # | 红线 | 违反示例 |
|---|---|---|
| R1 | 守卫只绑回环字面量 | `guardHost: '0.0.0.0'` |
| R2 | 除 health/pair 外 fail-closed | "先放开，之后再补鉴权" |
| R3 | 落盘不存明文令牌 | 为了"重连方便"把 token 写进 `devices.json` |
| R4 | 票据/短码**签发**端点：双条件回环 **+ `pairIssueToken`**；兑换端不得加回环门控 | 只查 socket 地址不查 Host；或把门控加到兑换端 |
| R5 | 角色由 Host 绑定，客户端不可自称 | 信封接受 `role` 字段 |
| R6 | 角色差异必须在官方 `decide()` 生效 | 只在 UI 隐藏按钮，后端不校验 |
| R7 | 不给 Android 任何豁免分支 | `if (platform == 'android') skipPolicy()` |
| R8 | 隧道不承担鉴权、不采信隧道头 | `trustProxyHeaders: true` |
| R9 | 不存在绕过守卫的"简化端点" | 为移动端另开 `/mobile/*` 且不走令牌 |
| R10 | 不把 `global` 级授权当成"所有资源都行" | 只在 `global` 上授权 `session/prompt`（实机会全拒） |
| R11 | 永不下放清单（§8.6.5）为空交集 | 把 `credentials/set` 放进 `full` |
| R12 | `registerPolicy` 先于 `createPeer` | 先建 Peer 后注册 → 全量 403 |
| R13 | 审批桥接不得吞掉本机 owner 的审批 | 无条件接管所有 `approval/request` |

> v0.1 的 R6 措辞（"授权判定发生在参数解码之前"）已修正。官方实际顺序是「endpoint + 参数字段检查 → Typert 类型校验 → 解析资源 → `decide()` → lookup/Context 解析 → 业务调用」（`gateway/src/index.ts:797-827`）。红线要求的是"业务方法不可达"，**不是**"参数未解码"。注意官方 `remote-access/README.zh.md:12` 自己的措辞"在解析 lookup、解码参数之前询问本包"**照字面读是错的**；以代码与 `gateway/README.zh.md:33` 为准。

### 9.5 令牌与设备生命周期

| 事件 | 守卫动作 | 设备侧观察 |
|---|---|---|
| 签发 | 生成 Peer（按需，首次请求时） | 收到 43 字符令牌一次 |
| 角色变更 | `invalidate(principal)` + `peer.dispose()` + 重建 | 下一次请求用新角色；进行中的 stream 收到 `terminal` |
| 吊销 | `revokedAt` 落盘 → `dispose()` 全部 Peer | 进行中的 `stream/next` ≤ `streamHoldMs` 内返回 `terminal: device-revoked`；下一次请求 401 |
| 设备表损坏 | 启动期 fail-closed（`version` 未知即抛） | 全部设备需重新配对 |
| 插件卸载 | `dispose()`：关监听 → dispose Peers → 断 socket | 连接被关闭 |

### 9.6 审批与提问：为什么必须自建通道（v0.2 重新论证）

**已验证事实**（01 表 F16）：

- 审批不是 Remote 方法。`ApprovalService`（ctx key `approval`）以 `'approval/request'` **scoped waterfall** 派发（`interaction/user-approval/src/index.ts:308`：`scopeTarget(req.agent, req.agent)`）。
- 非 owner Peer **永远拿不到可作答的 waterfall**：`answers = peer.principal.kind === 'owner'`（`gateway/src/index.ts:584`），且 `$events/result` 只允许 owner（`:502-504`）。
- 官方 LiveShare 的做法就是"交互审批与提问保留在 Host"（03 §7.6）。

**所以远端审批必须由本插件自建通道。这本身是一个提权动作**（非 owner 在替 owner 做决定），因此：

- 只有 `control` / `full` 角色可调用 `hub/answerApproval`。
- 审批卡片必须显示**完整原始参数**。
- 每次远端审批都写一条审计（`deviceId`、`callId`、outcome、时间）。

**正确实现形状（D-5，v0.1 的错误）**

```ts
// ✅ 正确：waterfall 监听器
ctx.on('approval/request', async (req, next) => {
  if (!visibleToAnyRemoteDevice(req.agent.session.id)) return next()   // ← 关键：不接管就还回去
  const outcome = await bridge.ask(req)          // 投给轮询流，等设备回答
  return outcome   // 只能是 'allowed-once' | 'rejected' | 'cancelled'
})
```

```ts
// ❌ 错误：调 service.request()
const outcome = await ctx.approval.request({ ... })
// 原因 1：request() 要求 turn 已打开，否则直接抛
//        （user-approval/src/index.ts:244-250）
// 原因 2：request() 自己 append approval/asked + approval/decided，
//        重复调用会把审计对写两遍（:252-259）
```

**用户提问（`userQuestions`）同理**：`userQuestions/answer` 是 Remote 方法但被归为 `owner-only`（`packages/experimental/liveshare/src/endpoint-classification.ts:214-215` 的先例），官方只允许 owner 回答。v1 的处理：**只允许 `control`/`full` 通过 `hub/answerQuestion` 回答**，审计与审批同级；或者 v1 **不做**（见 ROADMAP 待决问题）。

**`unavailable` 的归属**：`'unavailable'` 只能由"没人应答"产生（`OUTCOMES` 里它是 fail-closed 值，`user-approval/src/index.ts:56`；SDK 协议层只允许三值，`sdk/protocol/src/types.ts:236`）。桥接**不得**主动返回 `unavailable` 来表达"我不想答"——那是 `next()`。

### 9.7 审计

| 事件 | 字段 | 落点 |
|---|---|---|
| 设备配对 | `deviceId, label, role, path(ticket/code), at, sourceAuthority` | 结构化日志 |
| 远端审批 | `deviceId, callId, toolName, outcome, at` | 结构化日志 + 可选 Session 事件 |
| 远端提问应答 | 同上 | 同上 |
| 越权尝试（`remote-access/denied`） | `deviceId, action, reason, at` | 结构化日志（**这是最有价值的信号**） |
| 流越界（`hub/stream-open-denied` / `hub/cursor-invalid`） | `deviceId, streamId?, at` | 结构化日志 |
| 吊销 | `deviceId, by, at` | 设备表 `revokedAt` + 日志 |

**日志不得包含**：明文令牌、票据、短码、`Authorization` 头。

### 9.8 资源上限（v0.2 新增）

v0.1 只说了"单帧 1 MiB"。v0.2 需要给出完整的资源上限，因为长轮询改变了流量形态：

| 项 | 值 | 理由 |
|---|---|---|
| `/remote/rpc` 请求体上限 | 8 MiB | 官方默认 300 MiB 是给图片留的；守卫入口不该那么大（上传走 `fileUploads/upload` 的 base64，仍受此限） |
| `/remote/rpc`（`hub/stream.next`）的响应体上限 | 4 MiB | 一批 64 帧的合理上界；超限则截断该批并置 `truncated: true` |
| 每设备并发 stream 数 | 4 | 手机一个、平板一个、留两个余量 |
| 每设备并发 `/remote/rpc` | 8 | |
| `streamHoldMs` 上界 | 25s（= `hubReadTimeoutMs`） | 超过则每轮必超时 |
| 设备表文件大小上限 | 4 MiB | 防止被写入巨量垃圾 |

**完整配置字段表（`host/src/config.ts` 的 `DEFAULT_CONFIG`；ROADMAP T0.5 是落地任务）**

| 字段 | 默认值 | 说明 |
|---|---|---|
| `guardHost` | `'127.0.0.1'` | 只接受**回环字面量**；通配在加载期抛错（判据照 `webserver/src/index.ts:359-366`） |
| `guardPort` | `8443` | 被占用时**抛错**，不静默换端口 |
| `upstreamUrl` | `'http://127.0.0.1:3080'` | **只用于静态资源透传**，绝不参与 API 派发 |
| `publicAuthorities` | `[]` | 隧道公开 authority 白名单（`host[:port]`，canonical 校验）。空数组 = 只接受回环 `Host`，此时经隧道的请求全部被围栏拒（D-9） |
| `defaultRole` | `'control'` | 操作者未指定时的兜底角色 |
| `pairQrTtlMs` | `120_000` | QR 票据 TTL（2 分钟） |
| `pairCodeTtlMs` | `600_000` | 短码 TTL（10 分钟） |
| `maxPairAttempts` | `5` | 达预算即烧码/烧票据 |
| `streamHoldMs` | `4_000` | 长轮询单次持有上限（G7 的吊销延迟上界由它决定） |
| `streamBatchMax` | `64` | 单批最大帧数 |
| `streamBatchWindowMs` | `4` | 批量聚合窗口 |
| `streamPollSlackMs` | `2_000` | 客户端超时余量 |
| `hubReadTimeoutMs` | `25_000` | 服务端读超时兜底 |
| `streamIdleTtlMs` | `120_000` | 无人轮询的流回收 |
| `deviceTablePath` | `~/.dsh/remote-hub/devices.json` | 只存 `sha256(token)`，`mode 0o600` |
| `tunnel` | `{ kind: 'none', restart: 'on-failure' }` | 默认零暴露（ADR-4） |

> v0.1 的 `pairCodeLength`（标量 6）**被删除**：它无法表达"两条路径两种 TTL + 两种长度"。v0.2 用 `pairQrTtlMs` / `pairCodeTtlMs` 两个 TTL，长度在 `pairing.ts` 里作为常量（QR 票据 32 字节、短码 8 位）。

---

## 10. Android 设计

### 10.1 定位与约束

- **独立 Gradle 工程**，不依赖 TS 运行时：`android/` 自成一体。
- **没有官方 Android/Kotlin SDK**（02 §D.3 双向 404 确认）。协议层必须自行实现，v1 **不追求"零协议实现"**。
- 权限只申请 `INTERNET` 与 `ACCESS_NETWORK_STATE`；`usesCleartextTraffic="false"`，`allowBackup="false"`。
- 版本锚点（02 §D.2，v0.1 的 A15 组合作废）：**Kotlin 2.4.21 / AGP 9.5.1 / Compose BOM 2026.09.00 / kotlinx-serialization-json 1.12.0 / OkHttp 5.5.1**。
- **`minSdk 26` 保留**（Android 8.0）——Keystore 的 AES-GCM 在 23+ 就有，26 让 TLS 1.3 与 GCM 支持更一致。

### 10.2 模块划分

```
dev.dsh.remote
├── MainActivity.kt                 单 Activity + Compose 导航
├── net/
│   ├── RpcTransport.kt             一元 RPC（OkHttp）；单例 OkHttpClient
│   └── StreamPoller.kt             ★ 长轮询三方法（替代 EventSocket）
├── security/
│   └── DeviceStore.kt              ★ Keystore 包裹的 AES-256-GCM + SharedPreferences
├── protocol/                       core/capabilities 的 Kotlin 镜像
│   ├── Protocol.kt                 PROTOCOL_VERSION / GUARD_ROUTES / 错误码
│   ├── Capabilities.kt             ★ 能力矩阵（从 JSON 快照生成，不手抄）
│   └── Frames.kt                   信封（官方形状）+ 流帧
├── pairing/
│   └── QrScanner.kt                ★ CameraX + ML Kit / ZXing
└── ui/
    ├── PairingScreen.kt            ★ 扫码 + 短码兜底输入
    ├── SessionList.kt
    ├── SessionDetail.kt            只读正文 / 可写输入框
    ├── ApprovalSheet.kt            完整原始参数
    └── DeviceInfo.kt               角色徽章 + 解除配对
```

**`EventSocket.kt` 已删除**（v0.1 的 WS 实现），由 `StreamPoller.kt` 取代。

### 10.3 协议层

| 关注点 | 决定 |
|---|---|
| HTTP | 一个 `OkHttpClient` 单例（连接池 + TLS 会话复用，移动网络差别显著） |
| JSON | `kotlinx.serialization`，`ignoreUnknownKeys = true`（新字段不炸旧版本） |
| 一元调用 | `POST {origin}/remote/rpc`，Header `Authorization: Bearer` + `X-Hub-Protocol: 1`，超时 15s |
| 流 | `POST /remote/rpc` + `method: hub/stream.next`；`next` 超时 = `holdMs + 5s` 余量 |
| 重试 | 传输失败指数退避 + 抖动，上限 60s；**`terminal` 到达时停止** |
| 401 | 视为吊销：清 `DeviceStore`、跳配对页、**不再自动重连** |
| 408/429/5xx | 可重试（照官方 carrier 的可重试集合：408/429/502/503/504，03 §2.4） |
| 响应体上限 | `hub/stream.next` 4 MiB，超限即断并上报 |

### 10.4 令牌存储（v0.2 换实现）

**已发生的事实**（02 §D.1）：`androidx.security:security-crypto` 的 `1.1.0` 就是"全量弃用版"，官方文案 "Deprecated all APIs in favour of existing platform APIs and direct use of Android Keystore"，`EncryptedSharedPreferences` 的替代建议是 "Use `android.content.SharedPreferences` instead"。

因此：

- **实现**：`KeyGenParameterSpec`（`setUserAuthenticationRequired(false)`、`PURPOSE_ENCRYPT|DECRYPT`、`BLOCK_MODE_GCM`、`ENCRYPTION_PADDING_NONE`）生成**不可导出**的 AES-256 密钥；密文 + IV 存普通 `SharedPreferences`。
- **只存** `{ deviceId, token, role, origin, protocolVersion }`；不存票据、不存会话内容。
- **`clear()` 触发点**：401、`terminal.code === 'device-revoked'`、用户点"解除配对"、解密失败。
- **`allowBackup="false"` 必须有**：Keystore 密钥不随备份迁移，恢复后解密必失败——所以不让它进备份，比"恢复了但解不开"更好。
- **备选**：需要密钥轮换时用 `com.google.crypto.tink:tink-android:1.24.0`。**不默认引入**（多一层依赖，收益只在轮换）。
- **绝不**退回明文 `SharedPreferences`。

### 10.5 UI 页面与权限一致性

每个页面在渲染前读 `AccessSnapshot` → `Capabilities`：

| 页面 | `read-only` | `control` | `full` |
|---|---|---|---|
| 配对 | ✅ | ✅ | ✅ |
| 会话列表 | ✅ | ✅ | ✅ |
| 会话详情（正文） | ✅ | ✅ | ✅ |
| 输入框 / 发送 | ❌ 不渲染 | ✅ | ✅ |
| 审批卡片 | ❌ | ✅ | ✅ |
| 文件下载 | ❌ | ❌ | ✅ |
| 终端 | ❌ | ❌ | ✅ |
| 设备信息 / 解除配对 | ✅ | ✅ | ✅ |

"不渲染"而非"置灰"：置灰会误导用户以为"可能可以"，且暴露了不存在的入口。与浏览器半边用**同一份能力矩阵**（§7.1），因此不可能一边显示一边报 403。

### 10.6 离线与重连

| 场景 | 行为 |
|---|---|
| 断网 | 轮询失败 → 退避；UI 顶部显示"离线"；已缓存会话正文可读 |
| 切后台 | **暂停轮询**（这是长轮询相对 WS 的天然优势：后台不占连接）；回到前台立即续轮询 |
| 服务端重启 | 轮询失败 → 退避 → 重新 `hub/stream.open` + 用本地 cursor 求增量；缺口允许 |
| 令牌被吊销 | 401 或 `terminal.code === 'device-revoked'` → 清凭据 → 配对页 |
| 协议版本不符 | 提示"请升级 App"，不重试 |
| 隧道换主机名 | `origin` 变了 → 必须重新配对（令牌绑 origin，见下） |

**令牌绑 origin**（v0.2 新增）：`DeviceStore` 里存 `origin`，每次请求前比对；不一致则要求重新配对。理由：Cloudflare Quick Tunnel 的主机名每次都变，而令牌是发给"某个 Host"的——不绑 origin 会让"把 A 机的令牌拿去打 B 机"变成一个只靠 401 兜底的隐性依赖。

v1 **不做**离线写入队列：本地排队的 prompt 在重连后批量提交会造成"用户以为没发出去、其实发了两遍"。

### 10.7 与桌面 Client 的行为一致性

| 面 | 一致性来源 |
|---|---|
| endpoint 名 / 错误码 | 同一份 `core/src/capabilities.ts` + `protocol.ts`，Android 镜像 + 契约测试 |
| 能力矩阵 | 同一份，Android **从 JSON 快照生成**而不是手抄（避免 v0.1 的"手抄漂移"） |
| 权限快照语义 | 都是"Host 说能做什么"，客户端不推断 |
| 审批卡片内容 | 都必须显示完整原始参数 |
| 401 处理 | 都是"清凭据 + 停止重试"，不是"退避重试" |
| 流语义 | 都是长轮询三方法 + 单向 cursor + `terminal` 终态 |

不一致的地方（有意为之）：浏览器半边还能用官方 `ctx.remote.$mount()` 的同源模式，Android 只有 Hub 通道。

---

## 11. 关键设计决策记录（ADR）

### ADR-1（保留）：单包双入口 vs 拆两个 npm 包

- **决定**：**单包**，`exports` 暴露 `.` 与 `./client`，`core/` 用 `@core/*` 别名编进两个产物。
- **理由**：配对、令牌格式、能力矩阵必须只有一份实现。拆包后"各写一份、悄悄漂移"是最典型的事故来源。
- **后果**：✅ 协议只有一份；✅ 安装只需一条 `dsh plugin add`；⚠️ 两个 face 的 tsconfig 必须显式分离。

### ADR-2（**重写**）：守卫进程内派发 vs 反向代理到 `:3080/api`

- **背景**：v0.1 的表述是"守卫转发到 `127.0.0.1:3080`"，后来又改成"进程内调 `typertGateway.invoke()`"。两者都不对。
- **已验证事实**
  1. `/api` 准入后**恒为 owner Peer**（`rpc-host.ts:92-94`）→ 反向代理会让所有设备在 DSH 眼里都是 owner，三档角色**完全失效**。
  2. `invoke()` 只接受**已解码的具名参数**（`gateway/src/types.ts:11-29`），而线上是 JSON；自己解码等于重写 `assertExactArguments` + `validateArguments` + 资源解析。
  3. 官方先例用 `createSharedFetchHandler('/api').fetch(request, peer)`（`viewer-dispatch.ts:152-160`）。
- **决定**：**进程内派发，且走 `sharedFetch`**。守卫保留独立的 HTTP 监听与信任边界，但请求处理是进程内 `fetch(Request, peer)`，不是 HTTP 转发。
- **后果**
  - ✅ 角色真正在接入层生效，`remote-access/denied` 由官方 Gateway 抛出（G4/R6）。
  - ✅ 参数校验、lookup 解析、取消、二进制附件投影全部复用官方实现——**一份实现，不是两份**。
  - ✅ 非 owner 打 exact Fetch 路由自动 403、未认领 endpoint 自动 404，这两条我们不用自己写。
  - ⚠️ 依赖 `ctx.connection` 与 `ctx.typertGateway` 对第三方可用。**已确认服务层无包名白名单**（01 §2 第 1 条），只剩"该 profile 装了没有"，由 M0 探针收口。
  - ⚠️ `config.upstreamUrl` 语义降级为**静态资源透传**，`/api/*` 必须在守卫处 404。

### ADR-3（保留，理由加强）：独立守卫 vs 让 DSH 直接对外

- **决定**：守卫独立监听 `:8443`。
- **理由（v0.2 加强）**：官方明确把"端口保护"整体推给部署者（"URL 与栅栏都不保护监听端口本身"，02 §B.4）；`0.0.0.0` 在加载期即被拒。生态里 `dsh-web-startup-auth` 甚至**替换官方 startup 去允许 `0.0.0.0`**——这正是我们要避免的路线。
- **后果**：✅ 设备粒度鉴权、角色强制、审计、吊销；✅ 未配对流量在守卫处 fail-closed；⚠️ 多一跳、多一个并发面。

### ADR-4（**重写**）：隧道选型

- **背景**：需要一个把 loopback 服务暴露出去的方式。
- **v0.1 的错误**：把 Cloudflare **Quick Tunnel** 当默认，且用 `tunnel --url` 这种带速记的 argv。
- **已验证事实**（02 §C.1）
  - Quick Tunnel 官方标注 "for testing and development"、无 SLA、**每隧道 ≤200 在途请求（超出 429）**、**不支持 SSE**、主机名每次都变。
  - 命名隧道需要一个已配置的 Cloudflare 账户与凭据。
  - Tailscale **Serve** 只在 tailnet 内（安全姿态最好）；**Funnel** 对"任何拿到 URL 的人"开放、只支持 443/8443/10000、只走 TLS、**不可配带宽上限**、TLS 在本机终止。
- **决定**
  - **默认 `kind: 'none'`（零暴露）。**
  - **文档推荐路径**：Cloudflare 命名隧道 或 Tailscale Serve。
  - **Quick Tunnel 明确标注为"仅临时演示"**，且在提交 issue/文档时不得作为示例默认值。
  - 隧道目标**断言**必须等于 `guardOrigin`（指向非 `guardPort` 直接抛错）。
- **后果**：✅ 默认零暴露；⚠️ cloudflared 需要安装与凭据管理，`restart: 'on-failure'` 只管进程不管凭据过期；⚠️ `publicUrl` 允许为 null。

### ADR-5（保留，补净增量）：不透明令牌 vs 客户端证书

- **决定**：**A：32 字节随机 bearer + 服务端存 SHA-256**。
- **理由**：实现简单、无证书链/CRL/OCSP 运维负担、跨平台（浏览器 fetch 带 Header，OkHttp 同理）、服务端零秘密。
- **后果**
  - ✅ 设备表泄露不产生凭据。
  - ⚠️ bearer 可被中间人重放 → 强制 TLS + 依赖吊销。
  - ⚠️ 浏览器无法安全长期保存令牌 → 远端浏览器的令牌只放内存，刷新即需重配对。
- **v0.2 新增的诚实说明**：**官方 LiveShare 连逐请求签名都没有**——协议里 `actor.credential` 字段明确留空（"Absent today … the protocol does not verify it"，03 §3.4）。所以"逐请求签名"是本插件的**净增量空间**，不是"照先例不需要"。v2 若做，用已预留的 `clientPubKey`：设备持私钥、请求签名、服务端存公钥。

### ADR-6（**重写**）：长轮询 vs WebSocket

- **背景**：会话增量与审批是事件性质，需要下行推送。
- **v0.1 的结论是 WebSocket**，理由是"减少延迟 + `seq` 天然支持续传"。
- **推翻理由**
  1. 非 owner **开不了** `/api/remote.mux`（`admitConnection` 只认 browserAuth → owner）。
  2. 自己起 WS 意味着要做心跳、重连、退避、半开检测、`closeAllConnections()` 不覆盖 upgrade socket 的显式跟踪（官方 webserver README 专门警告这条）——**全部是自己写、全部没有官方测试覆盖**。
  3. 隧道对 WS 的支持是"能用但有坑"：CF 会因边缘换版断连、空闲超时会静默关闭、WAF 只看 101 那一次。
  4. 官方先例（LiveShare）对非 owner viewer 用的就是**轮询三方法**。
- **决定**：**长轮询三方法**（`hub/stream.open` / `hub/stream.next` / `hub/stream.cancel`），预算常量见 §7.2.5。
- **后果**
  - ✅ 删除整个 WS 栈：无心跳、无重连状态机、无半开检测、无 upgrade socket 跟踪。
  - ✅ **`ws` 不进入 `dependencies`**——这是本次决定的一部分（非目标 §3.2），验收方式是 `package.json` 里没有它。
  - ✅ 隧道只需支持普通 HTTP POST（Quick Tunnel 的"不支持 SSE"也不再是问题）。
  - ✅ 移动端切后台天然省电（不轮询就不占连接）。
  - ✅ 吊销延迟变成可断言常量（G7）。
  - ⚠️ 审批延迟从"一次推送"变成"一次持有窗口"，最坏 `streamHoldMs`。**我们取 4s 而非官方的 10s 就是为了这个**。若产品要求 p95 < 500ms，需要重新评估（见 ROADMAP 待决问题）。
  - ⚠️ 每次轮询都有 HTTP 开销。预算里 `streamBatchMax=64` + `streamBatchWindowMs=4` 就是为了让"有数据时一次多拿"，避免逐帧往返。

### ADR-7（保留）：Android 自行实现协议 vs 暴露"移动端桥接端点"

- **决定**：**A：Kotlin 实现**；若将来做 B，那些端点**仍必须**过守卫令牌与 `decide()`（红线 R9）。
- **v0.2 加强**：因为信封换成了官方形状，Kotlin 侧只需实现**一种**信封（`client-request`/`server-response`）+ 三个流方法，比 v0.1 的"自有信封 + 4 个事件名"更少。
- **后果**：⚠️ 协议演进要同步改两处（TS + Kotlin），靠 `PROTOCOL_VERSION` + 契约测试兜底；✅ 但能力矩阵从 JSON 快照生成，不再手抄。

### ADR-8（**删除**）：hub 方法名 vs 官方 endpoint 名的映射层

- **v0.1 决定**：保留 hub 自有词表，在 `services/index.ts` 翻译。
- **v0.2 决定**：**删除该 ADR**。守卫直接转发官方 endpoint（D-1）。理由：官方 endpoint 60+，翻译层是纯增量的三处维护成本；信封与参数校验已由官方公开提供；官方改名时我们"编译期不会发现"这一点，靠升级检查清单 + 对账测试兜底，比一个永远不全的映射表更可靠。
- **遗留**：`approvals.respond` / `results.preview` / `files.download` 这三个 v0.1 的"自有方法"不再存在——它们分别落到 `hub/answerApproval`（必须自有，§9.6）、`workspaceFiles/{read,readBytes}`（官方）、`workspaceFiles/readBytes`（官方）。

### ADR-9（**新增**）：配对用二维码票据 + 短码兜底

- **背景**：v0.1 只有 6 位数字码；生态与标准都不支持这么裸的形态。
- **选项**
  - A. 6 位数字码（v0.1）
  - B. 8 位 Crockford Base32 短码（40 bit）
  - C. QR 票据（32 字节，TTL 120s，单次）
  - D. C + B 并存（QR 主、短码兜底）
- **决定**：**D**。
- **理由**
  - 02 §F：Signal 纯 QR、Tailscale auth key + approval + QR、六个同赛道 DSH 插件全部 QR 为主。RFC 8628 §5.1 明确短码安全性来自**尝试预算**而非长度。6 位 19.9 bit 在任何可行预算下都达不到 2⁻³²。
  - 但**纯 QR 不可接受**：扫码需要摄像头权限 + 用户会拒绝；短码是必要的兜底（"摄像头坏了"、"在另一台电脑上"）。
- **后果**
  - ✅ 主路径无击键、无肩窥、无暴力面。
  - ✅ 兜底路径在 5 次预算下 40 bit 是绰绰有余的。
  - ⚠️ 需要 QR 渲染（Host 侧）+ 扫码（Android 侧），M3 增加工作量。
  - ⚠️ QR 可能被截图 → TTL 120s + 单次使用是唯一缓解，**必须写进文档**。

### ADR-10（**新增**）：`engines.dsh` 是唯一起作用的兼容门

- **背景**：v0.1 用 `dsh.compatibility` / `dshReleases` 表达兼容，且只声明 `engines.node` + `@deepseek-ai/cordis` peer。（D-7）
- **已验证事实**（01 §3）：`dsh.compatibility` **零读取者**，`DshManifest` 类型里没有这两个字段；真正判定的是 `engines.dsh`（缺失时回退查 `@deepseek-ai/dsh*` peers），用 `semver.satisfies(..., {includePrerelease:true})`（`plugin-compatibility.ts:51-73`）。**现状 = 任何 DSH 版本都被放行。**
- **决定**：`"engines": { "dsh": ">=0.2.1-rc.2 <0.3.0-0", "node": ">=24.9.0" }`；`dsh.manifestVersion: 1`；`dsh.compatibility` 保留为同范围的人读镜像。
- **理由**：`>=0.2.1-rc.2` 在 DSH 算法下会错误收下整个 0.3.x；在普通 semver 语义下又会把 0.2.2-rc.1 判成不兼容（01 §3 矩阵）。`<0.3.0-0` 收窄上界。
- **Node 下限跟随 DSH**：`>=24.9.0`（DSH 根 `package.json` 的 `engines`），不是 `ws` 的宽松下限。
- **落地**：ROADMAP T0.1 是这条的验收任务（四项门 + `scripts/version-gate.mjs` 矩阵）。

### ADR-11（**新增**）：能力矩阵按资源种类分层，而不是全挂 `global`

- 见 §7.2.3 的论证。核心：官方资源解析规则是"方法未指明资源 → 只有 `global` 放行"，而 `session/prompt` 的 `sessionId` 会被解析成 `session` 资源。**v0.1 的"三档角色全 `global`"在实机上会全部失效。**

---

## 12. 风险登记册（v0.2 重估）

| ID | 风险 | v0.1 | v0.2 | 缓解 | 触发后的 Plan B |
|---|---|---|---|---|---|
| R-1 | 第三方拿不到 `ctx.connection` / `ctx.typertGateway` | 中·高 | **低·高** | 源码层已确认无包名白名单（01 §2）；M0 探针只验证 profile 是否装了服务 | 若探针失败，失败点必在"服务不存在/endpoint 未认领/policy 未注册"三者之一（01 §6 末段），按点位修 |
| R-2 | 守卫与 DSH 同进程，守卫崩溃牵连 GUI | 低·中 | 低·中 | 守卫不抛未捕获异常；错误隔离在请求级；`dispose` 幂等 | 拆 sidecar（此时必须解决 ADR-2 的身份问题） |
| R-3 | 审批桥接被滥用（非 owner 替 owner 做决定） | 中·高 | 中·高 | 仅 `control`/`full`；完整参数；逐次审计；**`next()` 必须由可见性判定驱动**（R13） | 关闭远端审批，只保留"通知 + 本机批准" |
| R-4 | 隧道凭据过期/地址变更导致外部不可达 | 高·中 | 高·中 | `/remote/health` 巡检；`publicUrl` 允许 null；**Android 令牌绑 origin**（§10.6） | 手动切 Tailscale |
| R-5 | Android 令牌存储不可用 | 中·中 | **已发生** | D-10：Keystore 包裹 AES-256-GCM（`security-crypto` 已全量弃用） | 引 `tink-android:1.24.0` |
| R-6 | 设备表损坏导致全员掉线 | 低·中 | 低·中 | `writeFileAtomic` + `withFileLock` + 启动期 schema 校验；`version` 未知即 fail-closed | 提供导出/导入命令；最坏重新配对 |
| R-7 | 协议漂移（TS ↔ Kotlin） | 高·中 | **中·中** | 信封只剩官方一种（D-1）；能力矩阵从 JSON 快照**生成**（不手抄） | 契约测试红即阻断合并 |
| R-8 | 只读设备通过未列入矩阵的新 endpoint 越权 | 中·高 | **低·高** | `decide()` 默认拒绝（无 policy = `no-allow`）；矩阵与 registry 对账测试输出"未列入"清单 | 加"未知 action 一律 deny"的兜底断言（已是默认行为） |
| R-9 | 守卫被当作通用反代 | 低·高 | 低·高 | 路由白名单 `GUARD_ROUTES`；`/api/*` 显式 404；`startTunnel` 断言 origin | 启动时断言 `upstreamUrl` 不参与 API 派发 |
| R-10 | 多设备并发 + `lastSeenAt` 频繁写盘 | 中·低 | 中·低 | 合批写 + 内存态优先 | 降级为"仅启动/退出时写" |
| R-11 | **v0.1 的 C1 矛盾（配对端点门控）** | 未识别 | **已解决** | 签发端门控 + 兑换端不门控（§8.2.1），无新反证 | — |
| R-12 | **非 owner 不能审批** | 未识别 | **已确认，已解决** | §9.6 自建 waterfall 通道 | 降级为"只通知" |
| R-13 | **非 owner 不能用 exact Fetch 路由** | 未识别 | **已确认，已解决** | D-6：上传走 `fileUploads/upload` | 放弃非 owner 的文件传输 |
| R-14 | **流必须是长轮询** | 未识别 | **已确认，已按此设计** | D-3 | 若产品要求低延迟，见待决问题 |
| R-15 | **长轮询延迟**（新增） | — | 中·中 | `streamHoldMs=4s` + `streamBatchMax=64` | 缩短 hold（更耗电/更多请求）或引入 WS sidecar（成本大幅上升） |
| R-16 | **`pairIssueToken` 依赖 index 注入**（新增） | — | 低·中 | 与官方 `REMOTE_ACCESS_SNAPSHOT_KEY` 同机制（`remote-access/src/index.ts:138-142`） | 回退为"配对必须本机 UI 完成"（不让用户从浏览器发起签发） |

---

## 13. 已验证事实 vs 待验证假设（v0.2 重写）

### 13.1 已验证事实（v0.2 修订后的准确表述）

> 完整证据与逐条判定见 [verification/01-harness-facts.md](./verification/01-harness-facts.md)。下表只列**会改变设计**的那些，并标注 v0.2 的修正。

| # | 事实 | 证据位置 | v0.2 修正 |
|---|---|---|---|
| F1 | `RemoteAccessService`（ctx key `remoteAccess`），`TypertRemoteService` 子类 | `packages/api/remote-access/src/index.ts:125,135` | 补：它是 Remote 服务，namespace 默认取 service key |
| F2 | `registerPolicy/invalidate/decide/allows/snapshotFor/follow` | 同文件 `:153,175,199,235,253,270` | `decide()` 在 `:199` 起，且标注 "Gateway-only"；`follow` 在 `:270`（`@Remote({mode:'stream'})` 装饰器在 `:269`） |
| F3 | `RemoteAccessRole = {name, resource(种类), actions}`；`Binding = {role, resource({kind,id}), condition?}` | `api/remote-access/src/types.ts:29-36,60-67` | 无 |
| F4 | `remote-access/denied` + `details {action, reason}`；reason ∈ `resource-invalid`/`no-allow`/`policy-failed`/条件原因 | `types.ts:107-122`；`gateway/src/index.ts:812-824` | **修正**：`resource-invalid` 由 Gateway 在调 `decide()` **之前**产生，不是 `decide()` 返回值 |
| F5 | `decide()` 时机 = endpoint+参数字段检查 → Typert 校验 → 解析资源 → decide → lookup/Context → 业务 | `gateway/src/index.ts:797-827` | **修正**：`remote-access/README.zh.md:12` 的"解码参数之前"照字面读是错的 |
| F6 | `PrincipalMap` 可合并，内建只有 `owner`；`PeerScope.principal` 创建时固定 | `typert/protocol/src/types.ts:455-458,468-483` | 无 |
| F7 | LiveShare 用同一机制（`share-viewer`） | `experimental/liveshare/src/host/{viewer-principal.ts:16-21, viewer-lifecycle.ts:294, share-host.ts:290}` | 无 |
| F8 | `HostConnectionHandle` 提供 `createSharedFetchHandler` 与 `createPeer` | `client/connection/src/rpc.ts:206-247` | 补：`interactions` 缺省 `'answer'`（`peer.ts:40`），我们**显式传 `'none'`** |
| F9 | `/api` 准入后恒为 owner Peer | `client/connection/src/rpc-host.ts:92-94,129-137` | 无 |
| F10 | `isTrustedApiRequest(request, trustedHosts, bindHost, protocol)` | `client/connection/src/api-request-trust.ts:121-151` | **修正**：它**没有**从包根导出，`./src/*` 不在发布产物 → 守卫必须自己实现（D-9） |
| F11 | Host `ctx.typertGateway`；Client `ctx.remote` | `api/gateway/src/types.ts:154-198`；`src/index.ts:224-228,352-355,424,453` | 补：`static inject = ['typert','remoteAccess']`（`:215`），没 `remoteAccess` 就不启动 |
| F12 | 一元走 `/api`；流走 `/api/remote.mux` WS；心跳 2s；`streamInboxBytes` 262144 | `gateway/src/client/index.ts:458`；`stream-protocol.ts:7`；`index.ts:149-150,216-221` | **新增推论**：mux 的 Peer 由 `admitConnection` 决定 → 恒 owner → 非 owner 不可用（D-3） |
| F13 | 官方 session endpoint 清单 | `api/session-controller/src/index.ts:179,281,306,467,519,531,542,448,609,620,630` | **修正**：v0.1 只列 10 个，实际还有 `search/selectModel/modelCatalog/openWorkspacePath/workspacePathApplications/rename/attachment/updateQueue/state/wait/observe*/`；**`session/page` 已 `@deprecated`（:526），接任者 `session/events`（:542）** |
| F14 | `fileUploads/upload`；`workspaceFiles/{read,readBytes,stat,list}` | `client/file-upload/src/index.ts:69,112`；`api/workspace-files/src/index.ts:200,233,257,290,303` | **修正**：另有 exact Fetch 路由 `POST /api/session/uploadFileBinary`，**非 owner 恒 403**（`rpc-host.ts:218-222`）→ 上传只能走 `fileUploads/upload` |
| F15 | `settings/describe` | `api/settings-controller/src/index.ts:86,97,115,132,151,166` | 补：同包挂 `credentials/{describe,set,unset}`（`src/credentials.ts:70,82,99,112`）——**绝不下放** |
| F16 | 审批不是 Remote 方法；`approval/request` scoped waterfall；非 owner 从不收到可作答 waterfall | `interaction/user-approval/src/index.ts:176-178,242,306-310`；`gateway/src/index.ts:502-504,584` | **新增**：① `request()` 要求 turn 已打开（`:244-250`）；② `api/remotes` 里只有**两个** waterfall（`approval/request`、`user-questions/request`，`remote-events.ts:29,57`） |
| F17 | `@Remote`/`@RemoteScope` 选项 `{name?, mode?, resources?}` | `typert/protocol/src/index.ts:149-171,282-380` | 无 |
| F18 | DSH Web 默认 `3080`；`WebServer` 拒绑通配 | **`packages/bundle/web-app/cordis.patch.yml:186-188`**；`host/webserver/src/index.ts:359-366` | **修正**：默认值定义处**不是** `boot/cmdline`（那只是文档注释示例）；且 host 默认 `127.0.0.1` |
| F19 | 快照经 `__DSH_REMOTE_ACCESS__` 注入 index；Client 提供 `source/whenAccess/...` | `api/remote-access/src/{snapshot.ts:8, index.ts:138-142, client/mount.ts:43,55,66,79}` | 无 |
| F20 | 安装形态 `dsh.bundle.patch` + `cordis.patch.yml`；client 是 `__ModuleLoader__.load({id,factory})`，`id == 包名` | `client/modules/src/client/manifest.ts:10-11,52-54` | 无 |
| F21 | `ClientContext` 由 `@deepseek-ai/dsh-client-runtime/client` 导出 | — | **❌ 已失效**：0.2.2-rc.1 的 410 个包中**不存在**该包；现行写法是 `import type { Context as ClientContext } from '@deepseek-ai/cordis'`（`client/locale/src/client/index.ts:7`）。`SlotRegistry` 现在 `client/ui-renderer/src/client/registry.ts:120` |
| F22 | **新增**：三个资源种类已声明 | `global` 内建；`session` 在 `core/session/src/types.ts:560-563`；`workspace` 在 `workspace/workspace/src/types.ts:19-22` | 这是 D-11/ADR-11 的依据 |
| F23 | **新增**：`@deepseek-ai/dsh-atomic-write` 提供 `writeFileAtomic`（`mode` 必填）+ `withFileLock` | `util/atomic-write/src/index.ts:80,238` | 设备表必须用它（§7.2.7） |
| F24 | **新增**：`dsh.compatibility` 零读取者；`engines.dsh` 才是门；判定用 `includePrerelease:true` | `util/package-manifest/src/types.ts:32-41`；`boot/app-boot/src/plugin-compatibility.ts:51-73` | ADR-10 |
| F25 | **新增**：`ws` 在官方被使用（gateway `^8.21.3`、liveshare `^8.18.3`），但**v0.2 不引入** | `api/gateway/package.json:66`；`experimental/liveshare/package.json:68` | ADR-6 |

### 13.2 待验证假设（v0.2 收缩到 6 条）

v0.1 有 15 条。v0.2 里：A2/A3/A4 已被源码证实（降级为"待探针确认运行时"）；A5 已从假设变成**已发生的事实**（被打包进 D-10）；A14 因 ADR-6 取消，不再相关。

| # | 假设 | 影响 | 验证方式 | 若证伪 |
|---|---|---|---|---|
| A1 | 该 web profile 真的装了 `connection` 与 `typertGateway` | 全部功能 | M0 探针：`ctx.inject(['connection','typertGateway'])` + `createPeer` + 一次 `session/list` | 按 01 §6 的三点位定位修复；或改用别的 profile/组合 |
| A2 | `PrincipalMap` 合并 + `registerPolicy` 在运行时生效（静态已确认） | G4 | M0 探针：合并后用计数器断言 `bindings()` 被调用 ≥1 次 | 暂缓角色验收，改为守卫侧白名单（安全性等价，失去统一裁决与快照） |
| A3 | 隧道 provider 在目标平台可用且行为稳定 | M4 | 真机取证：`--version` 探测 + 一次完整往返 | 按 ADR-4 换 provider |
| A4 | 真机网络策略不阻断长轮询（比 WS 风险更低） | M3/M4 | 真机 + 企业网络测试 | 明确报错并提示；不静默降级 |
| A5 | `approval/request` 监听器的 `next()` 语义在并发多设备下符合预期 | R-3 | 双设备并发审批的集成测试 | 加串行化锁（每 agent 一次只桥接一个审批） |
| A6 | Compose/Gradle 版本组合（Kotlin 2.4.21 / AGP 9.5.1 / BOM 2026.09.00）可构建 | M3 | 首次 `./gradlew assembleDebug`（**需先补 wrapper**） | 退回一组已验证组合并改本文 |

### 13.3 源方案内部矛盾与决议（v0.2：原 3 条 + 新增 3 条）

| # | 矛盾 | 为什么冲突 | 决议 |
|---|---|---|---|
| **C1** | "配对端点只接受回环来源" vs "远程设备输入配对码完成配对" | 远程设备在隧道外，兑换请求必然经隧道；若兑换端也要求回环，远程设备**永远无法配对** | 拆成签发端（门控）与兑换端（不门控）。**v0.2 加强**：签发端额外要求 `pairIssueToken`（§9.3 第 1 条），堵住"隧道在本机终止使 socket 看似回环"的洞 |
| **C2** | "`decide()` 在参数解码之前运行" | 实际顺序见 F5；参数**已经解码校验过** | 改写为"在业务分派之前"，不写依赖"未解码"的测试断言 |
| **C3** | "`approvals.respond` 是十个 Remote 方法之一" | 审批不是 Remote 方法，而是 owner-only waterfall | 保留为**本插件自有**方法 `hub/answerApproval`，并用**waterfall 监听器**实现（D-5，v0.1 的"调 `service.request()`"是错的） |
| **C4**（新） | "角色矩阵全挂 `global`" vs "官方按资源种类独立授权" | `session/prompt` 的 `sessionId` 被解析为 `session` 资源；只在 `global` 授权会被拒 | 能力矩阵按 `global`/`session`/`workspace` 分层（D-11/ADR-11） |
| **C5**（新） | "守卫围栏只允许回环 `Host`" vs "远程设备必须经隧道进入" | 经隧道的 `Host` 是公开 authority，回环门控会把自己人拒掉 | 引入 `publicAuthorities` 显式声明（D-9），并用 `pairIssueToken` 保住签发端 |
| **C6**（新） | "自有方法词表 + 翻译层" vs "官方 endpoint 60+" | 翻译层永远不全，且三处维护 | 删除翻译层，直接转发官方 endpoint（D-1） |

---

## 14. 实现检查清单（v0.2 新增）

实现任何一个 PR 之前，先过这张表：

```
[ ] 新增/修改的 endpoint 是否在 capabilities.ts 里，且资源种类正确？
[ ] 该 endpoint 是否落在 §8.6.5 的永不下放清单里？（交集必须为空）
[ ] 是否只用了 sharedFetch 派发，没有自己解码参数？
[ ] 是否假设了 WebSocket / $events 可用？
[ ] 新的守卫路由是否默认 fail-closed（无令牌即 401，不存在即 404）？
[ ] 新配置项是否在 schemastery Config 里且默认值安全？
[ ] 是否引入了新的转发头依赖？（禁止）
[ ] 审批相关改动是否保证"不接管就 next()"？
[ ] 是否改了 package.json 的 engines.dsh？（改则必须同步 compatibility 镜像）
[ ] 是否在日志里写了令牌/票据/短码/Authorization？
[ ] 长轮询改动是否保持 cursor 单向递增？
```

---

## 15. 参考资料

### 15.1 原始需求

- DeepSeek 分享对话：<https://chat.deepseek.com/share/9ivjv3m4scoxlacoew>
  （要求：一个插件同时支持双向；明确功能分支；写清 Android 实现）

### 15.2 本仓库的验证文档（v0.2 新增）

- [verification/01-harness-facts.md](./verification/01-harness-facts.md) — 对 DSH 0.2.2-rc.1 源码的逐条核对
- [verification/02-web-research.md](./verification/02-web-research.md) — 生态、官方文档、隧道、Android 栈、传输、配对 UX
- [verification/03-liveshare-precedent.md](./verification/03-liveshare-precedent.md) — LiveShare 先例实现级摘要
- [verification/04-design-deltas.md](./verification/04-design-deltas.md) — D-1…D-15 变更决议

### 15.3 本地查证路径（DSH 源码检出：`E:/Code/DSH/plugins/deepseek-harness`）

| 主题 | 路径 |
|---|---|
| 访问控制（服务与策略） | `packages/api/remote-access/{README.zh.md, src/index.ts, src/types.ts, src/snapshot.ts, src/client/*}` |
| 资源种类投影 | `packages/typert/protocol/src/{types.ts, remote-access.ts, index.ts}` |
| API Gateway（信封、流、错误码、Peer、`$events`） | `packages/api/gateway/{README.zh.md, src/index.ts, src/types.ts, src/stream-protocol.ts, src/access.ts}` |
| API Remotes（转发事件允许清单） | `packages/api/remotes/src/remote-events.ts` |
| 连接层（准入、Peer、`/api` 围栏、信封 schema） | `packages/client/connection/src/{rpc-host.ts, peer.ts, api-request-trust.ts, rpc-schema.ts, rpc.ts, index.ts}` |
| WebServer（路由/升级/通配拒绝） | `packages/host/webserver/src/{index.ts, injections.ts}` |
| 非 owner Peer 的完整先例 | `packages/experimental/liveshare/src/host/*` |
| 官方 endpoint 命名 | `packages/api/{session-controller,settings-controller,workspace-files,workspace-controller,terminal-controller,job-controller}/src/index.ts`、`packages/client/file-upload/src/index.ts`、`packages/goal/goal/src/index.ts` |
| 审批的真实通路 | `packages/interaction/user-approval/src/{index.ts, types.ts}` |
| 审批桥接的官方先例 | `packages/sdk/server/src/server.ts:123-140` |
| 原子写与文件锁 | `packages/util/atomic-write/src/index.ts` |
| 打包兼容判定 | `packages/boot/app-boot/src/plugin-compatibility.ts`、`packages/util/package-manifest/src/types.ts` |
| Web bundle 的默认端口 | `packages/bundle/web-app/cordis.patch.yml:186-188` |
| 服务与方法的权威目录 | `packages/extensions/tool-cordis/src/api-catalog.ts`（`remoteAccess` 条目在 2505 行起） |

### 15.4 v0.1 的错误引用路径（已修正，留档警示）

| v0.1 写的 | 实际 |
|---|---|
| `packages/api/remotes/lib/types/index.d.ts` | 检出无任何 `lib/` 构建产物 → `packages/api/remotes/src/index.ts` + `src/types.ts` |
| `packages/api/remotes/lib/types/client/index.d.ts` | → `packages/api/remotes/src/client/index.ts` |
| `boot/cmdline/src/index.ts:14`（作为 `3080` 默认值来源） | 那只是文档注释里的示例 → 真实定义在 `packages/bundle/web-app/cordis.patch.yml:186-188` |
| 多数 F 条省略 `packages/` 前缀 | 照抄会 `Test-Path` 失败；完整清单见 01 §4.2 |
| `E:/Code/DSH/plugins/dsh-solution-explorer/node_modules/`（作为类型核对源） | 那里装的是 **0.1.0-rc.8**，比审计基线低两个小版本 |

### 15.5 插件生态约定参考

- `E:/Code/DSH/plugins/dsh-solution-explorer/{package.json, cordis.patch.yml, tsdown.config.ts}`
- `E:/Code/DSH/plugins/dsh-mobile-layout/{package.json, cordis.patch.yml}`
- `E:/Code/DSH/plugins/dsh-hardssh/packages/dsh-hardssh/{package.json, src/index.ts}`（schemastery `Config` + `webServer.register/registerUpgrade` 的现行写法）

### 15.6 外部标准与文档

- [RFC 8628 §5.1](https://www.rfc-editor.org/rfc/rfc8628.html) — 设备授权授予的用户码熵与尝试预算
- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/) · [Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) · [HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/)
- [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel) · [device approval](https://tailscale.com/docs/features/access-control/device-management/device-approval)
- [AndroidX Security 发布说明](https://developer.android.com/jetpack/androidx/releases/security) · [EncryptedSharedPreferences（弃用）](https://developer.android.com/reference/androidx/security/crypto/EncryptedSharedPreferences)
- [Signal 设备链接](https://support.signal.org/hc/en-us/articles/360007320551-Device-linking)
- 相关文档：[ROADMAP.md](./ROADMAP.md) · [README.md](../README.md) · [android/README.md](../android/README.md)
