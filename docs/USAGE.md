# 安装、使用与远程接入

本文面向**第一次使用**本插件的人：从安装到让另一台设备接管本机，覆盖三条路径——

| 场景 | 走哪条路 | 见 |
|---|---|---|
| 只在本机用（一台机器开两个页面） | 默认配置，无需任何暴露 | [§2](#2-第一步本机自用默认就够) |
| **同一局域网**内的另一台设备 | `network: 'lan'` + 私有地址绑定 | [§3](#3-局域网内使用) |
| **跨公网**（异地、出差、手机流量） | 隧道转发 | [§4](#4-隧道远程接入) |

> 更偏运维的内容（通道拓扑、巡检、故障排查、发布）在 [DEPLOY.md](./DEPLOY.md)，
> 本文不重复，只在需要时指过去。

---

## 0. 先理解一件事：配对 = 授权

**扫码或输入短码，就等于把那台设备列为本机的可信操作者。** 从 0.3.1 起 `full`
配对**没有二次审批**，所以：

| 角色 | 能给什么 | 什么时候用 |
|---|---|---|
| `read-only` | 看会话、看文件、看状态 | 监控屏、只读观察 |
| `control` | 日常操作：开会话、发消息、跑工具 | **默认选它** |
| `full` | 装插件、写配置、改 API Key、权限目录 | 仅限「你自己的另一台机器」 |

- `full` = 远程安装插件 = **插件代码在宿主进程内运行**，等价于远程代码执行。
- 设备令牌是 bearer token，泄露后在**吊销前**可被重放；吊销立即生效。
- 令牌以 `sha256` 存在 `~/.dsh/remote-hub/devices.json`（`0600` / 目录 `0700`），**不是**钥匙串。

---

## 1. 安装

要求：**Node.js ≥ 24.9.0**、**DSH ≥ 0.2.2-rc.1 < 0.3.0**（已实测 rc.1 / rc.2 / rc.3）。

```bash
# 从 npm 安装
dsh plugin --profile web add @xiaopb/dsh-remote-hub

# 本地源码联调
dsh plugin --profile web add link:E:/Code/DSH/plugins/dsh-remote-hub

# 确认已安装
dsh plugin --profile web list
```

**升级或改配置后必须重启 Host 进程。** 守卫监听与隧道子进程是独立 OS 进程，不会热替换：

```bash
# 停掉占用 DSH Web 端口的进程，然后重新启动
dsh web --port 13091
```

装好后 DSH 侧栏会出现「云端设备」入口，守护进程监听 `http://127.0.0.1:8443`。

**健康检查**（本机执行，任何模式都适用）：

```bash
curl -s -H "X-Hub-Protocol: 1" http://127.0.0.1:8443/remote/health
# → {"ok":true,"protocolVersion":1}
```

---

## 2. 第一步：本机自用（默认就够）

默认配置是 **零暴露**：

```yaml
guardHost: 127.0.0.1     # 只绑回环
guardPort: 8443
network: loopback        # 只有本机可连
publicAuthorities: []    # 经隧道的请求一律拒绝
tunnel: { kind: none }
```

这一档已经能验证整个链路，适合先跑通再考虑对外：

1. 打开 DSH 页面 → 侧栏「云端设备」→「添加设备」。
2. 选角色（先用 `control`）→ 页面显示二维码 / 8 位短码。
3. 用另一台设备的浏览器打开本机页面并扫码，或输入短码。

> 二维码与短码 **TTL 15 秒、单次有效**。截屏发出去不是安全做法——TTL 只是缓解。

**无界面服务器**（没有 GUI 可点）用 CLI 签发：

```bash
dsh-remote-hub-pair --code --role control --label "我的笔记本"
# path: code
# secret: 7K3M9XQ2
# expires-at: 2026-11-14T09:12:00.000Z
```

---

## 3. 局域网内使用

### 3.1 为什么需要单独开关

守卫默认**只绑回环字面量**，`0.0.0.0` 在加载期直接抛错（错误文本含 `loopback`）。
这是有意的：把 `:8443` 绑到所有网卡等于把整个管理面交给同网段任何人。

所以要局域网直连，必须**显式**打开两个开关，并且**只能**用私有地址：

```yaml
guardHost: 0.0.0.0      # 或具体的私有地址，如 192.168.1.20
guardPort: 8443
network: lan            # ← 信任域切到局域网
```

加载期断言（`assertBindableHost`）的规则：

| `network` | 允许的 `guardHost` |
|---|---|
| `loopback`（默认） | 仅回环字面量（`127.0.0.0/8`、`::1`）。**`localhost` 不算**——它是名字，解析受 hosts/DNS 影响 |
| `lan` | `0.0.0.0` / `::`，或**私有**地址字面量（RFC1918、IPv6 ULA） |

**公网地址一律拒绝**：想从公网访问必须走隧道（§4）或 VPN，不能靠改绑定地址。

### 3.2 三个判据必须同时成立

`network: 'lan'` 会同时切换**绑定地址、来源围栏、socket 对端**三重判据。
改完重启后，用下面三条逐项确认——少一条就会看到「连得上但全部 403」：

```bash
# ① 确实绑到了局域网地址（而不是只有 127.0.0.1）
Get-NetTCPConnection -LocalPort 8443 -State Listen | Select-Object LocalAddress

# ② 从另一台机器能打通健康探针（把 IP 换成主机的局域网地址）
curl -s -H "X-Hub-Protocol: 1" http://192.168.1.20:8443/remote/health
# → {"ok":true,"protocolVersion":1}

# ③ 配对后 API 不再被 Origin 围栏拒绝（在配对的那台设备上，带令牌 + 对端 Origin）
curl -s -o /dev/null -w "%{http_code}\n" -H "X-Hub-Protocol: 1" \
  -H "Authorization: Bearer <token>" \
  -H "Origin: http://192.168.1.31:13091" \
  http://192.168.1.20:8443/remote/devices
# → 200（若为 403 且响应含 "source not allowed"，就是 Origin 围栏没放行）
```

可用 `/remote/devices` 做这项检查：它同样是受 Origin 围栏保护的守卫路由，
且不需要构造 `/remote/rpc` 的信封。

**第 ③ 条是最容易踩的坑。** `network: 'lan'` 模式下，接管方浏览器页面的 origin
是**对端机器自己的 DSH web 地址**（每台机器不同，例如 `http://192.168.1.31:13091`），
与守卫的 `Host` authority 天然不同源。若不放行，所有 RPC 都会得到
`403 source not allowed`——表现为「扫码成功、页面能开，但会话列表/模型列表/权限目录全是空」。

`network: 'lan'` 会自动放行**私有地址**来源的 Origin（`allowPrivateOrigin`，由
`network === 'lan'` 推导，无需手动配置）。公网 Origin 永不受益于此项。

> 若你的对端页面不在私有地址上（例如经隧道访问），则必须把它的 origin 显式写进
> `allowedOrigins`。该项默认空数组 = fail-closed。

### 3.3 签发局域网可达的配对信息

```bash
dsh-remote-hub-pair --qr --lan --role control
# lan-address: http://192.168.1.20:8443
# pair-link: http://192.168.1.20:8443/#dshrh=<ticket>
```

`--lan` 会把本机所有局域网 IPv4 地址打印出来，并给出可直接抄给另一台设备的
`pair-link`。把该链接在目标设备上打开即可完成配对。

### 3.4 局域网档位小结

| 项 | 建议值 | 理由 |
|---|---|---|
| `network` | `lan` | 只放行私网/链路本地来源 |
| `guardHost` | `0.0.0.0`（或用固定 DHCP 保留的私有地址） | 前者省事，后者更收敛 |
| `guardPort` | 固定，如 `8443` | 被占用会抛错，**不会**静默换端口 |
| `defaultRole` | `control` | 别让默认值变成 `full` |
| 设备表 | 定期检查 `0600` | 令牌靠 OS 权限保护 |

**同一 Wi-Fi 下的可信网络才用这一档。** 咖啡厅、酒店、公司访客网络请走 §4 的隧道。

---

## 4. 隧道远程接入

### 4.1 红线（先读这条）

> **隧道只指向守卫 `http://127.0.0.1:8443`。把隧道指向 `:3080` 是事故。**

`:3080` 是 DSH 自己的 Web GUI，认证后的浏览器 Peer **恒为 owner**。把它暴露出去，
`browserAuth` 就成了唯一防线。插件在组装 argv 时断言上游必须是
`http://127.0.0.1:<port>` 且不得含 `:3080`，用户附加参数里也不许夹带 `--url`——
断言失败即插件加载失败。

### 4.2 启用隧道

```yaml
guardHost: 127.0.0.1
guardPort: 8443
publicAuthorities: [hub.example.com]   # ← 你的隧道公网 authority（裸 host 或 host:port）
tunnel:
  kind: cloudflared
  restart: on-failure
```

生成的命令精确为：

```bash
cloudflared tunnel --url http://127.0.0.1:8443
```

**`publicAuthorities` 不填，所有经隧道的请求都会被来源围栏拒绝。** 这不是 bug，
是 fail-closed 的默认值。填的值必须与你实际的公网域名完全一致（含端口，若非默认）。

被 kill 后按 `restart: on-failure` 重启，退避 500ms 起、封顶 10s。
握手被 `401/403/410/426` 拒绝时会**停止**该注册不再重连（不会无限撞墙）。

### 4.3 选哪种隧道

| 方案 | 谁拿到 URL | 限制 | 建议 |
|---|---|---|---|
| Cloudflare **命名隧道** | 你指定的人 / IdP | 需安装与凭据管理 | **推荐默认** |
| Cloudflare **Quick Tunnel** | 任何拿到 URL 的人 | 官方标「测试用」；并发上限 200；不支持 SSE；主机名每次都变 | 仅临时演示 |
| Tailscale **Serve** | 仅 tailnet 内设备 | 对端需装 Tailscale | **安全姿态最好** |
| Tailscale **Funnel** | 任何拿到 URL 的人 | 只能 443/8443/10000、只走 TLS | 可用，但「URL 即攻击面」 |
| 自有服务器（SSH 反向隧道） | 你自己控制 | 无 CDN 防护，需自行加 HTTPS | 已有 VPS 时可选 |

> **具体怎么装、怎么写 `config.yml`、Windows 服务怎么配**，
> 见单独的 **[TUNNEL.md](./TUNNEL.md)** —— 那里按 Windows / Linux / macOS
> 分平台给了完整命令、官方校验方法和排错对照表。

### 4.4 完整远程操作流程

以下以「家里主机 `home`，出差笔记本 `laptop`」为例。

**在 `home` 上（被控端，一次性准备）：**

```yaml
# 配置
guardHost: 127.0.0.1
guardPort: 8443
publicAuthorities: [hub.example.com]
tunnel: { kind: cloudflared, restart: on-failure }
defaultRole: control
```

```bash
# 1. 起隧道（或由插件托管），确认真实域名
cloudflared tunnel --url http://127.0.0.1:8443
# → 从输出里拿到 https://<随机>.trycloudflare.com 或你的固定域名

# 2. 把该 authority 填进 publicAuthorities，然后重启 DSH Host

# 3. 验证：健康探针经隧道可达
curl -s -H "X-Hub-Protocol: 1" https://hub.example.com/remote/health
# → {"ok":true,"protocolVersion":1}

# 4. 验证：上游透传必须被拒（这是最重要的一条）
curl -s -o /dev/null -w "%{http_code}\n" -H "X-Hub-Protocol: 1" \
  https://hub.example.com/api/session/list
# → 404   （守卫路由表里没有 /api/*，说明没有把 DSH Web GUI 暴露出去）

# 5. 签发配对票据
dsh-remote-hub-pair --qr --role control
```

**在 `laptop` 上（控制端）：**

1. 把 `home` 的 DSH 页面换成本机地址打开（本机 DSH 页面的「云端设备」里添加目标）。
2. 输入上一步的短码，或用 `pair-link` 直接打开。
3. 配对成功后，页面顶部的业务视图（会话、工作区、文件、任务）都指向 `home`；
   **本机的设备管理页仍留在本地**。

**日常往返：** 断线重连无需重新配对（令牌还在），令牌吊销后立即失效。

### 4.5 隧道场景的自检清单

| 检查 | 命令 / 观察 | 期望 |
|---|---|---|
| 隧道上游正确 | 看 `cloudflared tunnel --url` 的目标 | `127.0.0.1:8443`，**不是** `:3080` |
| `publicAuthorities` 命中 | 从外网访问 `/remote/health` | `200`，不是 `403` |
| 没有暴露 GUI | 外网访问 `/api/session/list` | `404` |
| 令牌不落明文 | `devices.json` 里的 `tokenHash` | 64 位 hex，**没有** 43 字符 base64url 的 `token` |
| 文件权限 | `devices.json` | `0600`，目录 `0700` |
| 隧道状态 | DSH 页面「云端设备」 | 显示连接中/已连接，不是反复重连 |

---

## 5. 三档对照

| | 本机自用 | 局域网 | 隧道 |
|---|---|---|---|
| `network` | `loopback` | `lan` | `loopback` |
| `guardHost` | `127.0.0.1` | `0.0.0.0` 或私有地址 | `127.0.0.1` |
| `publicAuthorities` | `[]` | `[]` | **必填** |
| `tunnel.kind` | `none` | `none` | `cloudflared` |
| 谁能连 | 只有本机 | 同网段 | 拿到隧道入口 + 配对过 |
| 风险 | 最低 | 同网段可信度决定 | **URL 即攻击面** |

---

## 6. 常见问题

**扫码成功但页面全是空的（列表/模型/权限都空）**
→ Origin 围栏拒绝了 RPC。局域网档确认 `network: 'lan'`；隧道档确认对方 origin 在
`allowedOrigins` 里。表现为 `403 source not allowed`。

**改完配置没生效**
→ 守卫监听不会热替换，必须重启 Host 进程。

**`guardHost: 0.0.0.0` 启动报错**
→ 说明还是 `loopback` 档。两者必须一起改：`network: 'lan'` + 私有地址。

**经隧道访问返回 403**
→ `publicAuthorities` 没填或与你实际域名不一致（注意非默认端口要带 `:port`）。

**`guardPort` 被占用**
→ 插件**不会**静默换端口（换了会让隧道配置悬空）。先释放端口再启动。

**想从公网直接绑定地址访问**
→ 不支持，且是刻意的不支持。公网必须走隧道或 VPN。

---

## 7. 相关文档

- [DEPLOY.md](./DEPLOY.md)：通道拓扑、巡检脚本、故障排查、发布前检查清单
- [API-MATRIX.md](./API-MATRIX.md)：每个 endpoint × 每个角色的授权矩阵
- [ARCHITECTURE.md](./ARCHITECTURE.md)：身份、授权与持久化的数据路径
- [DESIGN.md](./DESIGN.md)：角色语义与状态归属
