# dsh-remote-hub 部署与运维

> 本文只覆盖 **DSH 插件（host / client / core / 隧道）** 的部署。Android 部分按需求不实现，
> 但协议契约（`out/contract.json`）仍会导出，供未来的移动端消费。

## 0. 一句话红线

**隧道只指向守卫 `http://127.0.0.1:8443`；把隧道指向 `:3080` 是事故。**

`:3080` 是 DSH 自己的 Web GUI，认证后的浏览器 Peer **恒为 owner**。把它暴露出去，
`browserAuth` 就成了唯一防线，而官方自己明确写了「栅栏与公告都不保护监听端口本身」。
本插件的 `startTunnel()` 在组装 argv 时做断言：上游必须是 `http://127.0.0.1:<port>`，
且不得含 `:3080`；用户附加参数里也不许夹带 `--url` 或 `:3080`。断言失败即抛错，插件加载失败。

## 1. 安装与重启

```bash
# 本地联调（link 到源码目录）
dsh plugin --profile web add link:E:/Code/DSH/plugins/dsh-remote-hub

# 从 npm 安装（发布名必须留在 @xiaopb/ scope 内）
dsh plugin --profile web add @xiaopb/dsh-remote-hub

# 升级后必须重启 Host 进程：守卫监听与隧道子进程不会热替换
dsh plugin --profile web list
```

`cordis.patch.yml` 的 roster id 固定为 `remote-hub`，**不随版本改变**（改名会让旧配置的入口悬空）。

### 1.1 版本门

`package.json` 的 `engines.dsh` 是**唯一**被 DSH 读取的兼容门：

```jsonc
"engines": {
  "node": ">=24.9.0",
  "dsh": ">=0.2.1-rc.2 <0.3.0-0"
}
```

`dsh.compatibility` 只是人读镜像，必须与之同步，`dshReleases` 列出全部已测版本。
`scripts/version-gate.mjs` 在 CI 里断言矩阵
`0.2.1-rc.2=Y / 0.2.1-rc.5=Y / 0.2.2-rc.1=Y / 0.3.0-rc.1=n`；
**删掉上界会让 CI 直接变红**。

## 2. 配置项

配置是 schemastery `Config`（`host/src/config.ts`），由 DSH 的 settings 面持久化到 profile。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `guardHost` | `127.0.0.1` | **只接受回环字面量**；`0.0.0.0` 在加载期抛错（错误含 `loopback`） |
| `guardPort` | `8443` | 被占用时抛错，**不**静默换端口 |
| `publicAuthorities` | `[]` | 隧道公开 authority 白名单（`host[:port]`，canonical 校验）。**空数组时经隧道的请求全部被来源围栏拒**（fail-closed 的正确默认） |
| `defaultRole` | `control` | 操作者未指定时绑给新设备的角色 |
| `deviceTablePath` | `~/.dsh/remote-hub/devices.json` | 只存 `sha256(token)`，`mode 0600` / 目录 `0700` |
| `pairQrTtlMs` | `120000` | QR 票据 TTL（2 分钟） |
| `pairCodeTtlMs` | `600000` | 短码 TTL（10 分钟） |
| `maxPairAttempts` | `5` | 达预算即烧码/烧票据 |
| `streamHoldMs` | `4000` | 长轮询单次持有上限；也是吊销可见延迟的上界 |
| `streamBatchMax` | `64` | 单批最大帧数 |
| `streamBatchWindowMs` | `4` | 批量聚合窗口 |
| `streamPollSlackMs` | `2000` | 客户端超时余量 |
| `streamReadTimeoutMs` | `25000` | 服务端读超时兜底 |
| `streamIdleTtlMs` | `120000` | 无人轮询的流回收 |
| `maxStreamsPerDevice` | `4` | 每设备并发流数 |
| `approvalBridgeTimeoutMs` | `25000` | 审批桥接等待上限；超时交回 `next()` |
| `bridgeApprovals` | `true` | 安全评审否决时整体关掉接管（能力降级，不是降低安全性） |
| `tunnel` | `{ kind: 'none', restart: 'on-failure' }` | 默认零暴露 |

**加载期校验**（`validateConfig`）：回环字面量、裸 authority 白名单、
`streamHoldMs + streamPollSlackMs < streamReadTimeoutMs`、隧道开启时 `publicAuthorities` 非空。
任一不成立即抛错，插件不进入就绪。

## 3. 三条通道，分清

```
本机 GUI ── 同源 ──► ctx.remote.$mount()          （client 半边的同源模式，owner 权限）
设备 ── TLS ──► 隧道 ── HTTP ──► 守卫 :8443 ── 进程内 ──► DSH connection/Gateway
本机操作者 ──► /remote/pair/{ticket,code}（双条件回环 + pairIssueToken）
```

- 守卫是**独立** `node:http` 监听，只绑回环字面量。它**不是** DSH WebServer 的一条路由。
- 一元调用不是「代理到 upstream」，而是守卫用 `peer` 身份走
  `ctx.connection.createSharedFetchHandler('/api').fetch(request, peer)` 在进程内派发。
- v1 **不起任何 WebSocket**：下行是 `hub/stream.{open,next,cancel}` 三条**一元**方法，
  同样走 `POST /remote/rpc` 与官方 `decide()`。没有 `/remote/events`，没有 `ws` 依赖。

## 4. provider 选型

| provider | 谁能拿到 URL | 关键限制 | 定位 |
|---|---|---|---|
| Cloudflare **命名隧道** | 你指定的人 / IdP | 需要安装与凭据管理 | **推荐默认** |
| Cloudflare **Quick Tunnel** | 任何拿到 URL 的人 | 官方标「测试用」；每隧道最多 200 在途请求（超出 429）；**不支持 SSE**；主机名每次变 | **仅临时演示，不作文档默认** |
| Tailscale **Serve** | 仅 tailnet 内 | 需要设备装 Tailscale | **安全姿态最好** |
| Tailscale **Funnel** | 任何拿到 URL 的人 | 只能 443/8443/10000、只走 TLS、TLS 在本机终止 | 文档化支持，但必须明示「URL 即攻击面」 |

`kind: 'cloudflared'` 时生成的 argv 精确为：

```bash
cloudflared tunnel --url http://127.0.0.1:8443 [args...]
```

被 kill 后按 `restart: 'on-failure'` 重启，退避 500ms 起、封顶 10s、稳定 30s 归零。
握手被 `401/403/410/426` 拒绝时**停止该注册不再重连**（不是无限撞墙）。

### 4.1 接隧道前必须做的两件事

1. 把公网 authority 填进 `publicAuthorities`（例如 `hub.example.com`）。
   **不填的话所有经隧道的请求都会被三段来源围栏拒** —— 这不是 bug，是 D-9 的
   fail-closed 默认值。
2. 确认隧道的 `--url` 指向守卫，不是 `:3080`。

## 5. 配对（操作者视角）

1. 本机 DSH 页面点「添加设备」，选角色（`read-only` / `control` / `full`）。
   页面从 `__DSH_REMOTE_HUB__.pairIssueToken` 读进程内令牌 —— 它**只注入本机 index 页**，
   绝不经隧道传输。
2. 页面渲染二维码（32 字节票据，TTL 120s，单次）。设备扫码；或切到短码兜底
   （8 位 Crockford Base32，TTL 10 分钟，5 次错误预算即烧）。
3. 设备把票据/短码 POST 到 `/remote/pair` 兑换，收到一次 `{ deviceId, token, role }`。
4. 之后每请求 `Authorization: Bearer <token>`。

**不要把配对二维码截屏发出去**：TTL 120s + 单次使用是唯一缓解，不假装能防截图。
令牌泄露 = 吊销前可重放（v1 是 bearer，没有逐请求签名）；缓解是立即吊销 + 审计。

## 6. 巡检

```bash
# 守卫只绑回环（PowerShell）
Get-NetTCPConnection -LocalPort 8443 -State Listen | Select-Object LocalAddress,LocalPort

# 健康探针（本机）
curl -s -H "X-Hub-Protocol: 1" http://127.0.0.1:8443/remote/health
# → {"ok":true,"protocolVersion":1}

# 上游透传必须被拒（经隧道）
curl -s -o /dev/null -w "%{http_code}" -H "X-Hub-Protocol: 1" https://<tunnel-host>/api/session/list
# → 404（守卫路由表里没有 /api/*）
```

设备表巡检：文件应是 `0600`，内容形如
`{"version":1,"devices":[{"deviceId":"…","label":"…","role":"control","tokenHash":"<64 hex>",…}]}`。
**任何 43 字符 base64url 的 `token` 字段都是事故**；`scripts/sec-check.mjs` 会断言。

## 7. 故障排查

| 现象 | 最可能的原因 | 处置 |
|---|---|---|
| 插件加载即抛 `ctx.connection is unavailable` | profile 没装 `@deepseek-ai/dsh-client-connection` | 用 `probeServices(ctx)` 定位；补装 connection 服务 |
| 加载即抛 `ctx.remoteAccess is unavailable` | 没装 Gateway / remote-access | 补装；Gateway 的 `static inject` 就含这两项 |
| 端口 8443 被占 | 另一个进程占了 | `Get-NetTCPConnection` 查；**不允许自动换端口** |
| 经隧道的请求全 403 | `publicAuthorities` 没填 | 填公网 authority 并重启 |
| `/api/*` 返回 404 | **正确行为**；守卫只认 `GUARD_ROUTES` 五条路由 | 用 `POST /remote/rpc` 发官方 `client-request` 信封 |
| 只读设备调 `session/prompt` 得 `remote-access/denied` | **正确行为**；`decide()` 在业务方法之前拒 | 检查 `capabilities.ts` 与设备角色 |
| 全部设备 403（`no-allow`） | `registerPolicy` 没先于第一个 `createPeer` | 装配顺序由 `plugin.ts` 强制；不要改 |
| 设备表损坏 / `version: 99` | 启动期 fail-closed 抛错 | **不**静默清空；人工修复或重新配对 |
| 隧道断开 | 外部不可达，本机零影响 | 按退避重启；长轮询客户端不洪泛 |
| 守卫重启 | 客户端恢复，令牌仍有效 | 旧 `streamId` 得 `stream-not-found` 而非挂死 |
| 审批卡片不出现 | `bridgeApprovals: false` 或 session 不在可见集合 | 桥接**不接管就 `next()`**，owner 的审批照常到本机 UI |
| 时钟跳变 | 配对 TTL 立即过期（可接受）；令牌不依赖时间 | 校时 |

## 8. 发布前检查清单

```
[ ] pnpm typecheck && pnpm build 全绿；依赖树无 dsh-client-runtime、无 ws
[ ] scripts/version-gate.mjs 四项矩阵全绿
[ ] node --test test/*.test.mjs 全绿
[ ] scripts/fence.mjs / redlines.mjs / contract-check.mjs 全绿
[ ] 安全门禁（G-1 无 WS、G-7 红线、G-8 审批不吞 owner）
[ ] engines.dsh 的上界未被放宽；dshReleases 已列出全部已测版本
[ ] docs/DESIGN.md 与实现无冲突；D-1…D-15 每条都有对应落点
[ ] ROADMAP 的任务勾选与实际一致（Android 任务按需求不实现）
[ ] CHANGELOG 记录 PROTOCOL_VERSION / 设备表 version 是否变化
```

## 9. 升级 DSH 时重核七处

1. `isTrustedApiRequest` 的判据（`host/src/fence.ts` 是同语义独立实现）。
2. `PrincipalMap` / `PeerScope` 的形状与 `interactions` 默认值。
3. `sharedFetch` 对非 owner 的 exact-Fetch-403 行为。
4. `approval/request` 的 waterfall 签名与 ScopeTarget 语义。
5. 能力矩阵里每个 endpoint 是否仍存在（对账测试）。
6. `ctx.typert.local.list()` 全集 vs `GUARD_ROUTES` ∪ `capabilities.ts` ∪ 红线清单。
7. `hub/stream.next` 依赖的 endpoint 段字符集是否仍允许 `.`。
