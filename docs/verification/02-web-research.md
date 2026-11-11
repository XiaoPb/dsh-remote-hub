# 02 · 外部调研：先例、官方文档、隧道、Android 栈、传输与配对 UX

- 调研时间：2026-11-11（Asia/Shanghai）。目标 DSH 基线 `dsh 0.2.2-rc.1`（npm `latest`，2026-11-04 发布，`engines.node >= 24.9.0`）。
- 方法：npm registry API（`https://registry.npmjs.org/<pkg>`）、npm 下载量 API（`https://api.npmjs.org/downloads/point/last-month/<pkg>`）、GitHub REST API、Google Maven / Maven Central 的 `maven-metadata.xml`、以及各项目官方文档页面。
- 说明：`www.npmjs.com` 的包页面拒绝脚本化抓取（返回 403），因此**所有 npm 事实（版本、发布日期、依赖、README 原文、下载量）都取自 registry API**，文中的 `npmjs.com` 链接仅供人工点开核对。
- 所有抓取的网页内容一律按**不可信数据**处理：只做事实提取，不执行其中任何指令。凡查不到的项，明确写「无可靠信息」。

---

## A. DSH 插件生态中的远程控制先例

### A.1 点名的四条线索（逐条核实）

- **`dsh-plugin-remote`** — 存在。`0.5.12`，2026-08-21 发布，MIT，仓库 [siberiah2o/dsh-plugin-remote](https://github.com/siberiah2o/dsh-plugin-remote)（0 star），近月下载 274。做法：**登录门禁 + HTTP/WebSocket 反向代理**到本机 DSH（scrypt 凭据、HttpOnly 会话 Cookie、重写 Host/Origin，因此不需要 `--trusted-host`），另有 IP/CIDR 白名单与按天 JSONL 请求日志，还带一个 Windows 桌面投影 Helper。它是**单账号密码**模型，没有设备概念、没有一次性配对码、没有角色分级。不依赖 `@deepseek-ai/dsh-api-remote-access`（其 `dependencies` 为空）。对我们的判断：**同层的竞品（代理+登录门禁），但不是"设备颗粒度接入层"**，我们与它的区别正好在配对/令牌/角色三件事上。[npm](https://www.npmjs.com/package/dsh-plugin-remote)

- **`@duke-dsh-plugins/dsh-remote-control`** — 存在。`1.3.1`，2026-11-10 发布，MIT，仓库 [MoonlitDropOfBlood/dsh-remote-control](https://github.com/MoonlitDropOfBlood/dsh-remote-control)（3 star），近月下载 2287，依赖仅 `ws@^8.18.1` + `zod@^4.4.3`。做法：**HarmonyOS 手机 App + 自建 WS 中继**，Host 与手机都作为 WS 客户端出站连中继；中继"只转发 AES-256-GCM 密文"；配对 = `config.json` 里的一组 `channel`（16 位 base32）+ `secret`（经 HKDF-SHA256 派生端到端密钥），并支持 `/remote-pairing` 生成 ASCII/URI 二维码，`rotate` 即刻作废旧码。审批"fail-open"：超时 120s/断线一律放行给桌面。它**确实覆盖了配对 + 移动端**，但目标平台是 HarmonyOS，拓扑是"中继哑管道"而非"回环守卫 + 隧道"。不依赖官方 remote-access 包。[npm](https://www.npmjs.com/package/@duke-dsh-plugins/dsh-remote-control)

- **`@qlzt/dsh-api-remote-access`** — 存在。`0.2.1-rc.2`（2026-10-19）与 `0.2.2-rc.1`（2026-10-22），MIT，`repository` 指向 `https://gitee.com/zsping1989/deepseek-harness.git`。**这是官方包的私有 fork 重发布**：描述与官方逐字相同（"Method-level Remote access control for non-owner Peers and the per-Peer access snapshot"），依赖被换成同门 fork `@qlzt/dsh-typert-protocol@0.2.1-rc.2`。近月下载 249。它**没有任何配对/隧道/移动端代码**——就是一个被改过的访问控制包。对我们的判断：**它证明了官方 non-owner 访问控制这条缝已经被第三方拿来改**，我们不该再自造一套 ACL，应直接基于官方包注册 role/policy。[npm](https://www.npmjs.com/package/@qlzt/dsh-api-remote-access)

- **`@lemoncat7/dsh-remote-settings-compat`** — 存在。`0.6.7`，2026-11-05 发布，MIT，仓库 [lemoncat7/dsh-remote-settings-compat](https://github.com/lemoncat7/dsh-remote-settings-compat)（0 star），近月下载 1361，依赖 `http-proxy` + 官方 `@deepseek-ai/dsh-settings` / `dsh-credentials` / `dsh-client-connection`。做法：**可信 Origin 配置 + 独立密码网关**（默认 3081 → 原 3080），透明代理 HTTP 与 WebSocket，含登录限速、会话过期、可选 IP 绑定、一键撤销会话；"机器 API 保留目标插件的 Bearer Token 校验"，可单独开只读知识库分享。明确写了"可信 Origin 不等于密码保护"、"原始 DSH 端口应收紧访问"。README 声明最低 DSH `0.2.1-rc.2`、Node `^22.19.0` 或 `>=24`。对我们的判断：**这是"网关 + 凭据"路线上最成熟的一份先例，但依旧是单口令/单身份，没有设备表、没有角色**。[npm](https://www.npmjs.com/package/@lemoncat7/dsh-remote-settings-compat)

### A.2 名字与功能的更大范围扫描（npm search `dsh remote`，50 条）

- **`dsh-remote-hub` 这个名字在 npm 上已被占用**：`0.4.9`，2026-11-05 发布，MIT，维护者 `liaoguogang`，仓库 [liaoguogang-hub/dsh-remote-public](https://github.com/liaoguogang-hub/dsh-remote-public)（0 star），近月下载 **4127**。它是"电脑侧插件 + 原生 Android（Kotlin/Compose）App"：起桥接、自动开隧道（ngrok / cloudflared quick tunnel）、签发 **30 天 Cookie**，`dsh-remote qr` 出配对页，**二维码里只放一个 10 分钟有效、用一次即作废的配对码**（不含 Cookie），手动输入兜底。→ 本仓库计划的 npm 名 `@xiaopb/dsh-remote-hub`（未发布）不冲突，但**功能重叠度最高的就是它**：Android 原生端 + 隧道 + 一次性配对码 + 长寿命 Cookie。[npm](https://www.npmjs.com/package/dsh-remote-hub)

- 同赛道其它高相关包（版本 / 最近发布 / 近月下载 / 一句话）：

| 包 | 版本 · 日期 | 下载/月 | 做法要点 |
|---|---|---|---|
| [`@linxin666/dsh-remote-web-ui`](https://www.npmjs.com/package/@linxin666/dsh-remote-web-ui) | 0.4.16 · 2026-11-07 | **110079** | 扫码配对共享同一个 Web GUI（一次性 token + relay）；README 已声明**弃用**，能力迁往 `@linxin666/dsh-remote-bridge`，浏览器远程控制部分"已退休" |
| [`@mrrisega/dsh-remote`](https://www.npmjs.com/package/@mrrisega/dsh-remote) | 0.8.1 · 2026-11-10 | 9101 | 手机浏览器全功能控制，"免内网穿透"，自带 SaaS |
| [`dsh-remote-mobile`](https://www.npmjs.com/package/dsh-remote-mobile) | 1.10.3 · 2026-11-03 | 5238 | 局域网 / Tailscale 接入、扫码配对、RSA + 防爆破封禁、移动端 CSS |
| [`@xgone/dsh-remote`](https://www.npmjs.com/package/@xgone/dsh-remote) | 0.3.7-next.2 · 2026-11-05 | 2929 | 登录门禁 + **MFA/TOTP** + **三级角色 `admin`/`user`/`guest`** + 签名 Cookie；文档明确推荐 nginx / `ssh -R` / Tailscale / frp / Cloudflare Tunnel，并要求转发 WebSocket |
| [`dsh-web-startup-auth`](https://www.npmjs.com/package/dsh-web-startup-auth) | 0.1.14 · 2026-11-04 | 2621 | **替换官方 startup 以允许 `--host 0.0.0.0`** + 用户名/密码认证页；README 直说"原版 `@deepseek-ai/dsh-web-app/startup` 出于安全考虑硬拒绝 `--host 0.0.0.0`" |
| [`@eternalloveone/dsh-palm`](https://www.npmjs.com/package/@eternalloveone/dsh-palm) | 1.7.1 · 2026-11-02 | 2573 | 扫码配对的 `/m/` 手机 UI + `/m/api` RPC + SSE mux 桥 |
| [`dsh-remote-web-gateway`](https://www.npmjs.com/package/dsh-remote-web-gateway) | 0.2.2 · 2026-08-28 | 527 | Cloudflare Quick Tunnel + QR 配对 + 设备管理 + 可选 GitHub 登录 |
| [`westanke/dsh-remote-bridge`](https://github.com/westanke/dsh-remote-bridge) | 2.10.0 · 2026-11-01 | — | 把 DSH 私有 remote 协议翻成版本化 REST（AGPL-3.0，6 star），桌面端"手机设置"面板 |

- **反向结论（有用的负面结果）**：逐条查了上表所有包与 A.1 四条的 `dependencies`（`dsh-remote-mobile` 为空；`@xgone` 只有 `qrcode`；`@mrrisega` 只有 `ws`；`@eternalloveone/dsh-palm` 为 `zod/clsx/web-push/qrcode.react/@deepseek-ai/schemastery`；`@linxin666` 为 `zod/clsx/yaml/cloudflared/qrcode.react/schemastery`；`dsh-remote-web-gateway` 为 `http-proxy-3/jose/undici`），**没有任何一个依赖 `@deepseek-ai/dsh-api-remote-access`**；唯一与官方 remote-access 包有血缘关系的是 `@qlzt/dsh-api-remote-access`（fork 重发布）。也就是说：**"官方 non-owner 访问控制"这条能力，生态里几乎没人用**，绝大多数远程插件是"绕过它，直接代理整个 Web GUI"，从而继承"认证后的浏览器 = owner"这一 DSH 事实。

### A.3 判断：冗余、互补还是竞争

- **不冗余。** "设备表 + 每设备 Bearer token（落盘哈希）+ 三档角色在接入层生效 + 回环守卫 + 隧道只暴露守卫 + 原生 Android"这个组合，在上述任何包里都没有完整出现：`dsh-remote-hub` 有 Android 与配对码但**凭证是 30 天 Cookie 而非每设备令牌**；`@xgone/dsh-remote` 有三级角色但**角色绑在账号上、且靠代理整个 GUI**；`@duke-*` 有端到端加密与扫码但**没有角色**、平台是 HarmonyOS。
- **正面竞争。** 隧道 + 扫码 + "手机 App"的用户故事已经至少被 3 个包讲过（`dsh-remote-hub`、`dsh-remote-mobile`、`dsh-remote-web-gateway`），且 `@linxin666/*` 在该赛道有 11 万/月的量级。**"能不能用手机控制 DSH"不再是空白；"每个设备一把可吊销的钥匙、角色在 DSH 的 `decide()` 里生效"才是空白。**
- **互补。** 与 `@lemoncat7/dsh-remote-settings-compat`（密码网关 + 可信 Origin）在部署形态上重叠，但它解决"人怎么进来"，我们解决"进来的是哪台设备、能做什么"。

---

## B. DSH 官方文档中与远程访问相关的表述

仓库：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（默认分支 `master`，MIT，2026-11-04 最后推送）。

### B.1 监听地址：通配在加载期即被拒绝

- [`packages/host/webserver/README.zh.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/webserver/README.zh.md)：`host` 只接受"本机某个接口的一个具体 IPv4 或 IPv6 字面量"；"未指定地址——包括 Linux 视为 IPv4 any 的 IPv4-mapped 形式——**会在加载时被拒绝**，而不是一次性打开每个网络接口的端口"。
- 源码注释同义（[`src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/webserver/src/index.ts)）：`The unspecified address — IPv4 any, IPv6 any, and the IPv4-mapped forms of IPv4 any — is rejected at load: it would expose the port on every interface at once.`，并导出 `isWildcardHost()` / `isLoopbackHost()` 供组合层判定。
- 同一 README 的「已知限制」明确划界：**"不提供服务器级认证或来源策略"**，"绑定非回环地址仍会向该网络公开未受保护的 route 与静态资源"。
- 官方 `dsh web` 侧的结论更直接（[`packages/client/connection/README.zh.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/connection/README.zh.md)）：**"`dsh web --host 0.0.0.0` 不受支持。"**

### B.2 浏览器认证：启动令牌 → 签名 Cookie → `owner` Peer

同 [`connection/README.zh.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/connection/README.zh.md)：

- 每个进程一个随机启动令牌；`frontend-static` 只在 `GET /` 接受 `?token=`，写 Cookie 后 302 到干净路径。Cookie 是 **host-only、`Path=/`、`HttpOnly`、`SameSite=Strict`**，带绝对签发/过期区间，`cookieMaxAgeDays` 默认 **30**，签名 payload 绑定规范化 hostname 与 port；只有监听器自身是 TLS 时才加 `Secure`（"`publicUrl` 声明与转发头都不参与判断"）。
- **认证后的浏览器共用一个 Peer，principal 是 `owner`**：`ctx.connection.browserPeer` 由通过认证的浏览器连接共享，principal 为 owner，默认 `interactions: 'answer'`。
- **存在一条面向"非浏览器客户端"的官方接入缝**：`GET /connect?token=...&interactions=answer|none` "立即创建 principal 为 owner 的 Peer，返回 302、Mux 目标地址与签名 API Cookie"；API 连接默认 `interactions` 为 `none`，"一条 API socket 负责清理：重复关联返回 409，关闭时移除其 Peer"。→ 这是官方**唯一**的"API 设备接入"契约，但它签出来的仍是 **owner**。
- 官方自己列的限制（同一页「已知限制」）：明文 HTTP 监听器会在传输中暴露 bearer cookie；**"没有 logout 操作"**——清 Cookie 只结束单个浏览器会话，撤销全部会话要"删除 owner 凭据记录并重启 `dsh`"。

### B.3 `trustedHosts` 与 `isTrustedApiRequest`

- [`packages/client/connection/src/api-request-trust.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/connection/src/api-request-trust.ts)：认证之前每个请求都过这道栅栏。`Host` 必须是 **loopback**、**等于监听器的绑定 IP 字面量**（端口不限），或**匹配 `trustedHosts` 条目**（带端口精确匹配，不带端口匹配任意端口）；"不采信转发 header 或 `Origin`"；`Host` 可信但未认证 → **401**，`Host`/`Origin` 不信 → **403**；`sec-fetch-site: cross-site` 一律拒绝。注释点明设计意图：`Host is the one header rebinding cannot forge`，且"**这些检查防御 DNS rebinding 与跨站浏览器请求，绝不建立身份**"。
- 配置面见 [`docs/config-catalog.zh.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/config-catalog.zh.md)：`trustedHosts?: string[]`（"exact `host:port`, or port-less `host` matching any port"；"A non-canonical or non-bare authority fails plugin load"）、`cookieMaxAgeDays`（默认 30）、`maxRequestBodyBytes`（默认 300 MiB）。

### B.4 反向代理部署指引（官方 `public-deployments`）

[`docs/user/guide/public-deployments.zh.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/public-deployments.zh.md)：

- 代理必须**保留浏览器可见的 `Host`**（"栅栏把收到的 `Host` 与被接受的 authority 比对"）、**剥离挂载前缀**、**转发升级请求**（"每个请求与 WebSocket 升级都必须连同其 `Upgrade` 与 `Connection` 头抵达监听器"）、**改写 cookie 作用域**。
- `--public-url` **只是公告**："用 `--public-url` 公告它只是展示，并不等于接纳"；接纳要靠 `--trusted-host`。
- 最关键的免责句：**"无论是公告 URL 还是栅栏都不保护监听端口本身，因此请把端口限制在可信代理或网络内。"** → 官方把"链路安全"整体推给部署者，这正是本插件存在的理由。

### B.5 `dsh-api-gateway` / `/api/remote.mux`

- [`docs/api-gateway.zh.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/api-gateway.zh.md)：`@Remote({mode:'stream'})` 的每个产出项"经其多路复用的 **`/api/remote.mux` WebSocket** 或进程内载体投递"；Gateway 依赖 `@deepseek-ai/dsh-api-remote-access`，"**没有它就不启动**"；对非 owner Peer，"随后解析调用访问的资源并询问 `ctx.remoteAccess.decide()`，被拒的调用**不解析任何 lookup，也不激活 Agent**"。
- [`packages/api/gateway/README.zh.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/gateway/README.zh.md)：Host 按 `websocketHeartbeatIntervalMs`（**默认 2 秒**）发 Ping，"连续两个 Ping 间隔没有活动的 socket 会被终止"；`websocketCompression` 默认 `'deflate'`，只压 ≥1024 字符的 JSON 文本帧；每逻辑流上行缓冲上限 `streamInboxBytes` 默认 **262144**，超限以 `gateway/uplink-overflow` 结束该流；"WebSocket 上的流代表 Connection **在升级时接纳的 Peer**，该 scope 释放时 socket 关闭"。

### B.6 `dsh-api-remote-access`：non-owner 的真实边界（对我们影响最大）

[`packages/api/remote-access/README.zh.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/remote-access/README.zh.md)：

- `owner`（`{ kind: 'owner' }`）**从不受检查**；所有判定只针对非 owner principal：`registerPolicy(kind, policy)`、`invalidate(principal)`、`decide(request)`（返回 `allow`/`deny`，被拒抛 `remote-access/denied`）、`allows(resource)`、`snapshotFor(principal)`、`follow(signal)`。
- role = `{ name, resource, actions }`，binding = `{ role, resource, condition? }`；"只有在**每个**已解析资源上都有某个 binding 指向该资源、其 role 列出该 action、且没有 condition 或 condition 放行时，请求才被放行"。快照经 `webserver/index-inject` 以 `__DSH_REMOTE_ACCESS__` 注入每个渲染的 index。
- **两条硬限制，直接决定我们的能力边界**：
  1. **"交互参与（回答转发的 waterfall）仅限 owner：非 owner 的 `$events` 流只收到 policy 在事件资源上放行其 `event:<name>` action 的广播帧。"** → 非 owner 设备**无法回答审批/提问**。
  2. **"exact Connection Fetch route 不经过 Gateway；在各路由声明自己的访问规则之前，共享 Fetch handler 对所有非 owner Peer 返回 403。"** → 非 owner 设备**用不了**文件下载/上传这类精确路由。
  3. 另有一条信息泄露提醒：授权的 Session 其 `cwd`/工具路径本就含 owner 绝对路径，`$events` ready 帧会给出完整 `host`（含 `home`）。

### B.7 `liveshare`：官方唯一的"分享/远程查看"产品化先例（实验性）

[`docs/subsystems/liveshare.zh.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/liveshare.zh.md)、[包 README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/experimental/liveshare/README.zh.md)：

- 定位："让一位所有者通过**独立的 Liveshare 服务端**（relay）把一个会话分享给外部 viewer"；"默认 Web profile 不包含它"，需要作者在 `cordis.patch.yml` 插行或选 bundle 才启用。
- viewer 是**真正的非 owner principal**（`share-viewer`）："Gateway 依据本包注册的 remote access 策略判定该 Peer 的 `share-viewer` principal"，两档 `view`/`write` 各自对应一个沙箱，`bash`/`pwsh`/`cua`/`plugin_manager`/`schedule_*` "一律拒绝"。
- 与我们的设计最贴近的几句：**"交互审批与提问保留在 Host"**；"120 秒未轮询的流被回收"；relay 地址由所有者在分享弹窗里填，**没有内置默认中继**（"清除保存的地址后……会明确要求先保存地址，而不是回退到某个部署默认值"）；有 `relay-h2-idle.ts`、`viewer-authority`、`VIEWER_STATE_ANSWERS` 一整套 viewer 状态词汇表。
- 该包已发布到 npm：[`@deepseek-ai/dsh-experimental-liveshare`](https://www.npmjs.com/package/@deepseek-ai/dsh-experimental-liveshare) `0.2.2-alpha.2`（2026-10-27）。

### B.8 官方对"远程/移动"的正面表态

- **没有任何一处官方文档把"手机远程控制"列为已支持能力或路线图**（在 `docs/` 全量路径清单里逐项检索 `remote|liveshare|gateway|pair` 后确认）。官方立场只有两条：**监听地址拒绝通配**；**暴露到网络是部署者的事，官方只提供 `--trusted-host` / `--public-url` / `--tls-cert` 三件工具**。
- 反过来，官方确实提供的"远程"能力是：`@deepseek-ai/dsh-api-gateway`（RPC 机制）、`@deepseek-ai/dsh-api-remote-access`（non-owner 授权）、`liveshare`（会话分享给外部 viewer）。**这三者都不含配对、设备表、隧道**——与本仓库 §2 的判断一致。
- 生态里 `dsh-web-startup-auth` 的 README 从反面印证了官方硬拒绝 `0.0.0.0` 这件事仍在生效（[npm](https://www.npmjs.com/package/dsh-web-startup-auth)）。

---

## C. 隧道安全实践（2025–2026 现行文档）

### C.1 Cloudflare Tunnel

- 模型：`cloudflared` 从源站**只做出站连接**到 Cloudflare 边缘，"Your origins can serve traffic through Cloudflare without being vulnerable to attacks that bypass Cloudflare"；因为源站没有入站监听器，**Authenticated Origin Pulls 对它无效**（"Origin traffic is already authenticated using your tunnel's connector credentials"）。[官方 overview](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)
- **Quick Tunnel（`trycloudflare.com`，免账号）的硬限制，直接决定我们不能把它当默认**：官方标注"**for testing and development**"、无可用性保证、**每个 Quick Tunnel 最多 200 个在途请求，超出返回 429**、**不支持 Server-Sent Events (SSE)**、主机名每次都变、进程停止即失效。[Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- **WebSocket**：官方称"supports proxied WebSocket connections without additional configuration"，**所有套餐可用**；但"we may restart servers, which terminates WebSockets connections"（边缘换版会断连）；**WAF 只检查那条 101 请求，连接建立后不再检查**；计量上"只有初始 upgrade 请求算一次 HTTP 请求"。[WebSockets](https://developers.cloudflare.com/network/websockets/)
- **空闲超时**：官方只给行为不给数值——"Cloudflare will close a WebSocket connection when no data is transmitted in either direction for a period of time"，"Enterprise customers can contact their account team to configure a custom idle timeout"，建议是"implement a client-side heartbeat (ping/pong)"。→ **社区广泛流传的"100 秒"在官方文档里找不到**，**无可靠信息**；正确的做法是假定"会被静默断开"并自己发心跳。[同上](https://developers.cloudflare.com/network/websockets/)
- 连接上限与超时（可用于选配置）：客户端↔CF 的 HTTP/1.1 keep-alive 与 HTTP/2 idle 都封顶 **400 秒**；CF↔源站的 `connectTimeout` 默认 30s、`tlsTimeout` 10s、`keepAliveTimeout` **1m30s**、`keepAliveConnections` 默认 100 且"不限制并发总数"。[connection-limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/)、[origin-parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/)
- **头伪造**：`CF-Connecting-IP` "will only be sent on the traffic from Cloudflare's edge to your origin web server"；`X-Forwarded-For` 若原始请求已带该头则被**追加**而非替换；`True-Client-IP` 官方明确警告"if you are ... authenticating HTTP requests based on the IP address value ... its value can be spoofed"。→ 源站**只有在"请求只可能来自隧道"时才可信任这些头**；把它们当身份会破。[HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/)、[Restoring original visitor IPs](https://developers.cloudflare.com/support/troubleshooting/restoring-visitor-ips/restoring-original-visitor-ips/)
- **限流**：WAF rate limiting rules 有免费档，但**规则条数与可用字段随套餐收紧**（表中 Free 为 1 条规则；计数周期/缓解时长"not all values are available on all plans"）。→ 免费档不能当作唯一防线，应用层必须自带按设备的尝试预算。[Rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/)
- 若用 Cloudflare Access 作为前置身份：应用默认 **deny by default**，"a user must match an Allow policy before they are granted access"，可按 IdP、会话时长、独立 MFA 配置。[Self-hosted public application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)

### C.2 Tailscale

- **Serve 与 Funnel 是两条完全不同的暴露面**：Serve 只在 tailnet 内，Funnel "lets you route traffic from the broader internet to a local service ... for **anyone** to access—even if they don't use Tailscale"。Funnel 的限制：只支持 `tailnet-name.ts.net` 域下的 DNS 名、**只能监听 443 / 8443 / 10000**、**只走 TLS**、"Traffic sent over a Funnel is subject to **non-configurable bandwidth limits**"、同一端口不能同时被 Serve 与 Funnel 占用。[Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel)
- Funnel 的 TLS 在**设备本机终止**（"It then terminates the TLS connection and passes the decrypted request to the local service"），relay 不解密（"Funnel relay servers do not decrypt the traffic"）。→ 用 Funnel 时我们的守卫拿到的是**明文 HTTP**，`Secure` Cookie 与"HTTPS origin"判断不能靠监听器自身协议，必须靠外部 authority。
- 设备准入有官方机制：**device approval**（管理台批准 / 用 auth key 预授权）、auth key（可复用/一次性/临时节点）、以及**用 QR code 添加设备**。[device-approval](https://tailscale.com/docs/features/access-control/device-management/device-approval)、[auth keys](https://tailscale.com/docs/features/access-control/auth-keys)、[QR code](https://tailscale.com/docs/features/access-control/device-management/how-to/set-up-qr-code)
- 结论：**Tailscale 解决"网络层可达 + 设备身份"，但它不解决"应用层谁是谁"**——Funnel 把服务暴露给"任何拿到 URL 的人"，所以应用层认证仍然必需。

### C.3 其它方案（简）

- **frp**：仓库 [fatedier/frp](https://github.com/fatedier/frp) 活跃，文档站 <https://gofrp.org/en/docs/> 可用。本次尝试的 `gofrp.org/en/docs/features/security/` 返回 404，**关于其 token / stcp / TLS 的最新细节：无可靠信息**（不作为设计依据）。
- **zrok**：官方文档自述为"a secure, open-source, **self-hostable** sharing platform that simplifies shielding and sharing"。[NetFoundry zrok docs](https://netfoundry.io/docs/zrok/1.1/getting-started/)
- **ngrok**：文档入口 <https://ngrok.com/docs/>；免费档的固定域名/authtoken 流程被 `dsh-remote-hub` 的 README 详细记录（含 `--host-header=127.0.0.1` 改写要求），可作为"隧道改写 Host 头"的现实证据。
- **WireGuard**：<https://www.wireguard.com/>。它是网络层 VPN，**不提供应用层认证**，与 Tailscale 同类但需自管密钥与路由。
- 横向结论：**四条路线的共同点是"隧道从不承担鉴权"**；差异只在"谁能拿到 URL"（Funnel/Quick Tunnel = 任何人有 URL；Tailscale Serve / WireGuard = 仅 tailnet/peer）。官方 DSH 文档已经把这句话写死：栅栏与公告"都不保护监听端口本身"（§B.4）。

### C.4 综合姿态（可直接写进 ADR）

1. 隧道目标**只能是回环守卫**，DSH 的 `:3080` 永不出现在任何外部可达面上（与设计 G6 一致）。
2. **认证必须在应用层、按设备**；`CF-Connecting-IP` / `X-Forwarded-For` / `True-Client-IP` 只可作为**日志与限流的辅助信号**，不可作为身份。
3. **必须自带心跳**（服务端 Ping + 客户端 Pong），不依赖隧道保活；DSH 官方的 2s Ping / 两周期终止是一个现成的合理默认（§B.5）。
4. **必须自带尝试预算与限流**；Cloudflare 免费档限流能力有限（§C.1），Quick Tunnel 还有 200 在途请求上限。
5. 需要"任何人有 URL 也不怕"时，前面再叠一层 Cloudflare Access 或改用 Tailscale Serve。

---

## D. Android 客户端栈现状（2026-11-11）

### D.1 `androidx.security:security-crypto`：已全量弃用

- Google Maven 元数据：`androidx.security:security-crypto` 最新 **`1.1.0`**（`<release>1.1.0</release>`）；`security-crypto-ktx` 同为 `1.1.0`。[metadata](https://dl.google.com/dl/android/maven2/androidx/security/security-crypto/maven-metadata.xml)
- [AndroidX Security 发布说明](https://developer.android.com/jetpack/androidx/releases/security)：`1.1.0` 于 **2025-07-30** 发布；而 **`1.1.0-beta01`（2025-06-04）的 API Changes 就写着 "Deprecated all APIs in favour of existing platform APIs and direct use of Android Keystore."**
- 官方 API 参考的弃用文案（逐条）：
  - `EncryptedSharedPreferences`：**"Added in 1.0.0 · Deprecated in 1.1.0"**，"This class is deprecated. **Use `android.content.SharedPreferences` instead.**"
  - `MasterKey` / `MasterKeys`："Use `javax.crypto.KeyGenerator` with `AndroidKeyStore` instance instead."
  - `EncryptedFile`："Use `java.io.File` instead."
  - 来源：[EncryptedSharedPreferences](https://developer.android.com/reference/androidx/security/crypto/EncryptedSharedPreferences)、[package-summary](https://developer.android.com/reference/androidx/security/crypto/package-summary)
- **不要把 `security-crypto` 写进 2026 年的设计**（哪怕 `1.1.0` 是"最新正式版"，它同时是"全量弃用版"）。当前可辩护的三条替代路线：
  1. **手写 Keystore 包裹的 AES-GCM**：`KeyGenParameterSpec`（`setUserAuthenticationRequired(false)`、`PURPOSE_ENCRYPT|DECRYPT`、`BLOCK_MODE_GCM`）生成不可导出的 AES-256 密钥，密钥句柄存 Keystore，密文 + IV 存普通 `SharedPreferences`/DataStore。这正是官方弃用文案指的方向，无第三方依赖。
  2. **`com.google.crypto.tink:tink-android`**，Maven Central 最新 **`1.24.0`**（[metadata](https://repo1.maven.org/maven2/com/google/crypto/tink/tink-android/maven-metadata.xml)）。适合需要 key rotation / AEAD 抽象时。
  3. 社区 fork `ed-george/encrypted-shared-preferences`（"An updated fork of the AndroidX Crypto library (also known as JetSec) for on-going EncryptedSharedPreferences and EncryptedFile support post-deprecation"，[GitHub](https://github.com/ed-george/encrypted-shared-preferences)）。**只作为迁移桥，不作为新设计依赖**。
- 设计含义：**"令牌哈希落盘在服务端"之外，客户端也必须解决"令牌在手机上怎么存"**——D.1 的结论是"手写 Keystore 包裹的 AES-GCM + 明文 SharedPreferences"，并且**不要指望 Auto Backup**（官方 `EncryptedSharedPreferences` 文档里那条 WARNING 说的就是备份后密钥失效）。

### D.2 版本锚点（均可核验的"最新稳定"）

| 组件 | 最新稳定 | 证据 |
|---|---|---|
| Kotlin | **2.4.21**（`2.5.0-Beta2` 为预览） | [kotlin-stdlib metadata](https://repo1.maven.org/maven2/org/jetbrains/kotlin/kotlin-stdlib/maven-metadata.xml) |
| AGP（`com.android.tools.build:gradle`） | **9.5.1**（`9.6.0-alpha03` 已发布但为预览；`<release>` 字段指向 alpha，勿直接采信） | [Google Maven metadata](https://dl.google.com/dl/android/maven2/com/android/tools/build/gradle/maven-metadata.xml) |
| Compose BOM（`androidx.compose:compose-bom`） | **2026.09.00** | [Google Maven metadata](https://dl.google.com/dl/android/maven2/androidx/compose/compose-bom/maven-metadata.xml) |
| `kotlinx-serialization-json` | **1.12.0** | [Maven Central](https://repo1.maven.org/maven2/org/jetbrains/kotlinx/kotlinx-serialization-json/maven-metadata.xml) |
| OkHttp（`com.squareup.okhttp3:okhttp`） | **5.5.1** | [Maven Central](https://repo1.maven.org/maven2/com/squareup/okhttp3/okhttp/maven-metadata.xml) |
| `androidx.security:security-crypto` | 1.1.0（**已弃用**，见 D.1） | [Google Maven metadata](https://dl.google.com/dl/android/maven2/androidx/security/security-crypto/maven-metadata.xml) |

- 注意：Google Maven 的 `<release>`/`<latest>` 对 AGP 与 `security-crypto` 都会指向**预发布**或**弃用**版本，**必须自己过滤 `^\d+\.\d+\.\d+$`** 再取最后一个。

### D.3 是否存在官方 DeepSeek/DSH 的 Android 或 Kotlin SDK

- **不存在。** 证据：
  - Maven Central 检索 `deepseek`：5 条命中，全是 `org.springframework.ai:*` 与第三方 `com.agentsflex` 等，**无 `com.deepseek*`**；检索 `dsh`：92 条命中全是 `org.dishevelled:dsh-*`（生物信息学库）。[检索 API](https://search.maven.org/solrsearch/select?q=deepseek&rows=20&wt=json)
  - npm 上 `@deepseek-ai/dsh-android`、`@deepseek-ai/dsh-sdk`、`@deepseek-ai/dsh-kotlin`、`@deepseek-ai/dsh-client-android`、`@deepseek-ai/deepseek-android` **全部 404**。
  - 存在的官方 SDK 都是 **Node 侧**：`@deepseek-ai/dsh-sdk-protocol`、`@deepseek-ai/dsh-sdk-client`、`@deepseek-ai/dsh-sdk-jsonrpc-server`、`@deepseek-ai/dsh-sdk-app`（`0.1.2-alpha.2`）。
- 结论：**Android 端必须自建协议客户端**（这也是本仓库 `android/` 存在的理由），且**没有可对齐的官方 Kotlin 类型**，协议版本只能由我们自己维护与冻结。

---

## E. 协议/传输备选（供 ADR）

### E.1 WebSocket vs SSE vs 长轮询

- **SSE 是单向的**："This is a one-way connection, so you can't send events from a client to a server"（[MDN: Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)）。我们的场景需要上行（发消息、答审批），SSE 只能"下行 + 另开 HTTP 上行"，等于两条连接两套鉴权。
- **SSE 有浏览器级并发上限**："When not used over HTTP/2, SSE suffers from a limitation to the maximum number of open connections ... set to a **very low number (6)**"，且"marked as Won't fix in Chrome and Firefox"（[MDN: EventSource](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)）。
- **Cloudflare Quick Tunnel 明确不支持 SSE**（§C.1）——如果 Quick Tunnel 是支持路径之一，**SSE 直接被排除**。
- 长轮询：没有官方文档可直接引用其上限；但与隧道组合时每次都吃 `connectTimeout`/`keepAliveTimeout`（§C.1），且在 200 在途请求上限下会与真实请求抢额度。**不作为推荐路径**。
- 结论：**WebSocket 是唯一同时满足"双向 + 隧道友好 + 有官方先例"的选项**。

### E.2 Node 22+ 下 `node:http` upgrade + `ws` 是否仍是合理选择

- **是。** `ws@8.22.2`（2026-11-08 发布，MIT，`engines.node >=10`，[npm](https://www.npmjs.com/package/ws)）仍是 Node 生态里服务端 WS 的事实标准。
- Node 自带的是**客户端** `WebSocket`（`Class: WebSocket — Added in v21.0.0, v20.10.0 ... v22.4.0 No longer experimental`，[Node globals](https://nodejs.org/api/globals.html)），**不是 WS 服务器**；服务端仍要 `ws` 或手写握手。
- **DSH 官方自己就用 `ws`**：`@deepseek-ai/dsh-api-gateway` 的依赖里有 `ws@^8.21.3`，`@deepseek-ai/dsh-experimental-liveshare` 有 `ws@^8.18.3`。→ 与宿主保持同一实现，减少协议层差异。
- Node 版本面：官方发布表里 v22（Jod）仍标为 LTS（最近更新 2026-10-20），v24（Krypton）与 v26（Lithium）为更新的 LTS，v27 为 Alpha（[release schedule](https://nodejs.org/en/about/previous-releases)）；而 DSH `0.2.2-rc.1` 的 `engines.node` 是 **`>= 24.9.0`**。→ **我们的 `engines` 应跟随 DSH，而不是跟随 `ws` 的宽松下限**。

### E.3 DSH 官方是否已提供可复用的 WS 服务器

- **`@deepseek-ai/dsh-host-webserver` 提供的是"升级路由注册点"，不是开箱的 WS 服务器**：`registerUpgrade(route)` 为**精确 pathname** 添加 upgrade route，disposer 可移除；"upgrade 只做精确匹配，未命中连接直接关闭"；"upgrade handler 拥有协议握手与连接内容；webserver 只交付原始 socket 与 request"。
- 它对我们的实现有一个**必须照抄的细节**："Node 的 `closeAllConnections()` 既不包含升级 socket，也不包含握手尚未完成的 TLS socket，因此服务显式跟踪二者"，资源释放时"销毁所有受跟踪的升级 socket"。[webserver README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/webserver/README.zh.md)
- **`/api/remote.mux` 已被 Gateway 占用**，是 Gateway 自有的 WS 端点（"API Gateway 自己拥有 `/api/remote.mux` WebSocket 及其逻辑流"），**我们不可复用、更不可抢占**；它的 Peer 来自 Connection 在升级时的 `admit()`。
- 结论：**守卫要自己起监听（独立端口），但 upgrade 处理、socket 跟踪、心跳/背压策略都应照 `@deepseek-ai/dsh-host-webserver` + `@deepseek-ai/dsh-api-gateway` 的既有做法实现**，而不是引一个 Web 框架。

---

## F. 移动端配对 UX 先例

- **Signal Desktop / iPad 链接**：**纯 QR**。新设备显示二维码，主设备（手机）扫；"A device can only be linked during the registration flow"；**上限 5 台**；手机需**每 30 天**至少上线一次，否则解除链接；**45 天不活动**也会解除。没有数字码路径。[Signal Support: Linked Devices](https://support.signal.org/hc/en-us/articles/360007320551-Device-linking)
- **Tailscale**：不以"配对码"为主，而是 **auth key**（可复用 / 一次性 / ephemeral）+ **device approval**（管理台批准，或 auth key 预授权），另有**用 QR code 添加设备**的流程。[auth keys](https://tailscale.com/docs/features/access-control/auth-keys)、[device approval](https://tailscale.com/docs/features/access-control/device-management/device-approval)、[QR code](https://tailscale.com/docs/features/access-control/device-management/how-to/set-up-qr-code)
- **Syncthing**：**设备 ID**（由设备证书派生）+ 双向接受。配置里每个 `<device>` 有 `untrusted` 标志位；设备 ID 通过带外方式交换（历史上也支持 QR）。**没有短数字码**。[config 文档](https://docs.syncthing.net/users/config.html)
- **KDE Connect**：**"在一端发起配对请求，另一端弹提示确认"**——"You can now request pairing in one of the two devices. The other device will show a prompt asking to accept the pairing request."；无自动发现时用"Add devices by IP"。**该页未描述数字校验码流程**，故不宣称。[KDE UserBase: KDEConnect](https://userbase.kde.org/KDEConnect)
- **Home Assistant**：不是配对，而是**登录 + per-device refresh token**（"A refresh token is created each time you sign in from a device. Delete one to force that device to sign out."，未使用 90 天后自动清除）+ **long-lived access token** 给脚本/程序用。[HA authentication](https://www.home-assistant.io/docs/authentication/)
- **RFC 8628（OAuth 2.0 Device Authorization Grant）给的量化基线**，是本问题唯一可引的标准：
  - `user_code` 是给人手输的，"shorter codes are more desirable for usability reasons. This means the entropy is typically **less** than would be used for the device code"；因此"**it is recommended that the server rate-limit user code attempts**"。
  - "The user code SHOULD have enough entropy that, **when combined with rate-limiting and other mitigations**, a brute-force attack becomes infeasible"；并给出算例："an 8-character base 20 user code (with roughly **34.5 bits** of entropy), the rate-limiting interval and validity period would need to only allow **5 attempts** in order to get the same 2^-32 probability of success by random guessing"。
  - 报文示例里 `expires_in: 1800`（30 分钟）、`interval: 5`（秒），且"clients MUST use 5 as the default"。
  - 来源：[RFC 8628 §5.1 / §3.2](https://www.rfc-editor.org/rfc/rfc8628.html)
- **对"只给 6 位数字码"的判定（按 RFC 8628 §5.1 的算式自己算一遍）**：6 位十进制码空间 N = 10⁶ ≈ **19.9 bit**。RFC 的目标是"猜中概率 ≤ 2⁻³²"，即允许的尝试次数 a ≤ N × 2⁻³² = 2^19.93 × 2^-32 ≈ **2.4×10⁻⁴ 次**——**换句话说，6 位码在任何尝试预算下都达不到 2⁻³² 这条线**（连 1 次尝试都超）。实际能拿到的是：a=5 次时成功率 5×10⁻⁶ ≈ **2⁻¹⁷·⁶**；a=3 次时 ≈ 2⁻¹⁸·³。
- 所以 2026 年可辩护的写法不是"6 位够用"，而是**把风险写清楚并叠加纵深**：① **QR 作为主路径**（Signal 与 Tailscale 都如此）；② 数字码作为兜底，硬约束 **≤5 次/码、≤10 分钟 TTL、用一次即废、仅在回环侧签发、且必须绑定一条未认证会话**——上面这几条列出的约束同时成立时（预算、TTL、一次性、仅回环签发、绑定未认证会话），攻击面是"知道隧道 URL + 在 10 分钟窗口内猜中 + 抢在同一条会话上"，这是一个**可写进威胁模型**的残余风险，而不是"安全"；③ 若要真的满足 RFC 的量级，**换 8 位 Crockford Base32（40 bit）**：a=5 时成功率 5×2⁻⁴⁰ = **2⁻³⁷·⁷**，越过了 2⁻³²。
- 结论：**"纯 6 位数字码 + 无限重试"一定不可辩护；"6 位 + 四条硬约束"可辩护但必须明写残余风险；"8 位 base32 + 同样约束"才是与 RFC 对齐的方案。**（本设计 §3.1 G2 已含 TTL、一次性、仅回环签发三项，缺的是"尝试预算"与"码长"这两项决策。）

---

## 对设计文档的直接影响

1. **`security-crypto` 必须从 Android 设计里删掉**，改为"Keystore 包裹的 AES-256-GCM + 普通 SharedPreferences/DataStore"，或引 `tink-android:1.24.0`；不要写 `EncryptedSharedPreferences`（D.1）。
2. **Android 端没有官方 SDK 可依**，协议类型必须仓库内自持并冻结版本号；`kotlinx.serialization` + OkHttp 是唯一现实组合（D.3、D.2）。
3. **"审批/提问能在手机上回答"这条能力，用非 owner Peer 做不到**——官方明确"回答转发的 waterfall 仅限 owner"，liveshare 的做法是"审批与提问保留在 Host"。要么手机侧走一条独立于 `@Remote` 的守卫自有通道并回调 Host 内部服务，要么接受"手机只能看、不能答"（B.6、B.7）。这是 v1 最需要先决的一条。
4. **非 owner 设备用不了 exact Fetch 路由**（文件下载/上传会被 403），所以 `full` 角色的"文件互传"必须自带路由或改由 owner 侧代取（B.6）。
5. **角色不要自造 ACL，落成 `remoteAccess.registerPolicy()` 的 role/binding**，把"只读/控制/全权"映射成 role→action 集，让 `decide()` 在 lookup 之前就拒（B.5、B.6、A.1 的 `@qlzt` 先例）。
6. **守卫必须是独立监听，不能只靠 `--trusted-host` 放开 GUI**：官方把"端口保护"整体推给部署者，且 `0.0.0.0` 在加载期即被拒（B.1、B.3、B.4）。
7. **`/api/remote.mux` 不可复用也不可抢占**；守卫自己的 WS 要实现心跳（照抄 2s Ping / 两周期终止）、`streamInboxBytes` 式上行上限、以及 `closeAllConnections()` 不覆盖 upgrade socket 的显式跟踪（B.5、E.3）。
8. **SSE 不作为备选**：Quick Tunnel 不支持 SSE，且 SSE 单向 + 浏览器 6 连接上限；结论是 WebSocket + `ws@8.x`，`engines` 跟随 DSH 的 `node >= 24.9.0`（C.1、E.1、E.2）。
9. **隧道选型必须写清"谁能拿到 URL"**：Quick Tunnel = 任何人有 URL（且有 200 在途请求上限、无 SLA、主机名会变），只可作临时演示；默认路径应是命名 Cloudflare Tunnel 或 Tailscale Serve，Funnel 则须接受"任何人有 URL"（C.1、C.2、C.3）。
10. **认证绝不采信 `CF-Connecting-IP`/`X-Forwarded-For`/`True-Client-IP`**，它们只进日志与限流辅助；免费档 WAF 限流不足以当唯一防线，尝试预算必须应用层实现（C.1、C.4）。
11. **6 位配对码是"可辩护但不够"的决策项**：按 RFC 8628 §5.1 算式，6 位码（19.9 bit）即使只允许 5 次尝试成功率仍约 2⁻¹⁷·⁶，达不到 2⁻³² 线；要么明写残余风险并锁死"≤5 次/码 + ≤10 分钟 TTL + 一次性 + 仅回环签发 + 绑定未认证会话"，要么直接改 **8 位 Crockford Base32（40 bit，5 次尝试约 2⁻³⁷·⁷）** 并把 QR 作为主路径（F）。
12. **`dsh-remote-hub` 这个名字在 npm 上已被同赛道项目占用（Android+隧道+10 分钟配对码）**：发布名必须留在 `@xiaopb/` scope 内，且在 README 里明确与 `dsh-remote-hub` 的区别是"每设备令牌 + 角色在 `decide()` 生效"，否则会被当成重复造轮子（A.2、A.3）。
