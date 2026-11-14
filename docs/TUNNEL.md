# 隧道部署（Windows / Linux / macOS）

本文只讲一件事：**把 DSH Remote Hub 的守卫（`127.0.0.1:8443`）安全地暴露到公网**，
让异地的另一台设备能接管本机。

> 只在本机或局域网内用，不需要本文 —— 见 [USAGE.md](./USAGE.md) §2 / §3。

文中的 Cloudflare 步骤均已对照官方文档核对（2026-11 版）：
[创建本地管理隧道](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/)、
[配置文件参考](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/)、
[Windows 服务](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/as-a-service/windows/)。

---

## 0. 开始之前：三条红线

1. **隧道只指向 `http://127.0.0.1:8443`。**
   绝不能指向 `:3080`（DSH 自己的 Web GUI）——那是 owner 权限，暴露等于交出整台机器。
   插件在组装参数时会断言上游必须是 `http://127.0.0.1:<port>` 且不含 `:3080`，
   断言失败会让插件加载失败（这是保护，不是 bug）。

2. **`publicAuthorities` 必须填真实的隧道域名。**
   不填的话所有经隧道的请求都会被来源围栏拒绝（fail-closed 默认值）。
   填的值必须与实际域名**完全一致**，非默认端口要带 `:port`。

3. **`full` 角色 = 远程代码执行。**
   `full` 能装插件，而插件代码在宿主进程内运行。隧道 + `full` 等于把
   「在你这台机器上执行任意代码」的能力放到公网。默认给 `control`。

---

## 1. 选路线

| 你的情况 | 推荐路线 | 需要什么 |
|---|---|---|
| **没有任何服务器**，只有一台自己的电脑 | **方案 A：Cloudflare 命名隧道** | 一个托管在 CF 的域名 + 免费账号 |
| **有 VPS / 云服务器** | 方案 B：自有服务器中转 | 服务器 + 域名（可选） |
| 只想临时演示 5 分钟 | 方案 C：Quick Tunnel | 什么都不用，但**不安全**，仅限演示 |
| 两台机器都在 Tailscale 内 | 方案 D：Tailscale Serve | tailnet，安全性最好 |

---

## 2. 方案 A：Cloudflare 命名隧道（无自有服务器，推荐）

`cloudflared` 在**你自己的电脑**上运行，主动向 Cloudflare 建立**出站**连接，
把公网域名回源到本机 `127.0.0.1:8443`。

**因此不需要公网 IP、不需要路由器端口映射、不需要服务器。**

### 2.0 前置条件（官方要求）

1. 域名已**添加到 Cloudflare**（免费计划即可）；
2. 该域名的 **NS 已改为 Cloudflare**（否则 `tunnel route dns` 会失败）。

前置检查：若你的网络有严格防火墙，先确认能出站访问 Cloudflare 的 **`7844/TCP`**
（QUIC 模式另需 UDP）。

### 2.1 安装 cloudflared

#### Windows

```powershell
# ① winget（推荐，便于升级）
winget install --id Cloudflare.cloudflared --source winget

# ② Chocolatey
choco install cloudflared -y
```

或直接从[官方下载页](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)
取 `cloudflared-windows-amd64.exe`（当前版本约 55 MB；另有 `.msi`）。

**验证**（**重开终端**让 PATH 生效）：

```powershell
cloudflared --version
```

> **Windows 常见坑**
> - 装完当前终端不认命令 → 重开终端（PATH 只在进程启动时读取）。
> - 下载的文件名是 `cloudflared-windows-amd64.exe`，官方要求**重命名为
>   `cloudflared.exe`** 再用。
> - 公司电脑的 EDR 可能拦截外连，先试 `--protocol http2`（见 §2.7）。

#### Linux

```bash
# Debian / Ubuntu
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared

# RHEL / CentOS / Fedora
curl -fsSl https://pkg.cloudflare.com/cloudflared.repo | sudo tee /etc/yum.repos.d/cloudflared.repo
sudo yum update && sudo yum install -y cloudflared

# Arch
sudo pacman -Syu cloudflared
```

`systemd` 下 QUIC 需要内核缓冲区，建议放宽：

```bash
sudo sysctl -w net.core.rmem_max=8388608
echo 'net.core.rmem_max=8388608' | sudo tee /etc/sysctl.d/99-cloudflared.conf
```

#### macOS

```bash
brew install cloudflared
```

### 2.2 登录并创建隧道

```bash
cloudflared tunnel login
# → 浏览器打开，选你的域名，授权后回到终端
# → 生成 cert.pem 到默认目录

cloudflared tunnel create dsh-hub
# → Created tunnel dsh-hub with id 6ff42ae2-765d-4adf-8112-31c55c1551ef
# → 同时在默认目录生成 <UUID>.json 凭证文件

cloudflared tunnel list      # 确认已创建
```

**默认目录**：

| 平台 | 路径 |
|---|---|
| Windows（用户身份运行） | `%USERPROFILE%\.cloudflared\` |
| Windows（**服务**身份运行） | `C:\Windows\System32\config\systemprofile\.cloudflared\` |
| Linux（root） | `/root/.cloudflared/` |
| macOS | `~/.cloudflared/` |

> **这条要记住**：以 SYSTEM 身份运行的 Windows 服务**看不到**你的用户目录。
> 服务方式的凭证必须放到 systemprofile 目录，见 §2.6。

### 2.3 写配置文件

> **最短路径**：只暴露一个服务时，官方允许只用一行 `url:`，
> 可以跳过下面整段 ingress。见 §2.3.1。

#### 2.3.1 单服务（最简单）

```yaml
url: http://127.0.0.1:8443
tunnel: 6ff42ae2-765d-4adf-8112-31c55c1551ef
credentials-file: C:\Users\you\.cloudflared\6ff42ae2-765d-4adf-8112-31c55c1551ef.json
```

#### 2.3.2 多服务 / 需要精确 hostname（推荐写法）

```yaml
tunnel: 6ff42ae2-765d-4adf-8112-31c55c1551ef
credentials-file: C:\Users\you\.cloudflared\6ff42ae2-765d-4adf-8112-31c55c1551ef.json

ingress:
  - hostname: hub.example.com          # 你的域名
    service: http://127.0.0.1:8443     # ← 必须是守卫，不是 :3080
  - service: http_status:404           # 兜底规则，必须放在最后
```

官方规则：**含 ingress 的配置文件必须始终以一条 catch-all 规则结尾**，
否则启动报错。

写入哪个文件？`<默认目录>/config.yml`，或用 `--config` 指定任意路径。

> **务必写 `127.0.0.1` 而不是 `localhost`。**
> 许多系统上 `localhost` 优先解析到 `::1`，而守卫只监听 IPv4 回环，
> 结果是 `connect: connection refused` → 公网 502，
> 而隧道日志显示「连接健康」，极难排查。

### 2.4 校验配置

官方提供了两条校验命令，**先跑它们再启动**：

```bash
# ① 规则本身是否合法
cloudflared tunnel ingress validate

# ② 某个 URL 会命中哪条规则
cloudflared tunnel ingress rule https://hub.example.com
# → Matched rule #1  hostname: hub.example.com
```

### 2.5 建 DNS 路由

```bash
cloudflared tunnel route dns dsh-hub hub.example.com
# → 创建 CNAME hub.example.com → <UUID>.cfargotunnel.com
```

手工替代：Cloudflare 控制台 → DNS 加 `CNAME`，目标 `<UUID>.cfargotunnel.com`，
**代理状态必须为「已代理」（橙云）**。

### 2.6 后台常驻

#### Windows（服务方式 —— 有坑，按官方步骤）

官方文档明确：以服务运行时要改 `ImagePath`，且凭证要复制到 systemprofile。

```powershell
# ① 建目录并把 exe 放进去
mkdir C:\Cloudflared\bin
copy cloudflared.exe C:\Cloudflared\bin\cloudflared.exe

# ② 管理员 CMD 进该目录，安装服务
cd C:\Cloudflared\bin
cloudflared.exe service install

# ③ 建 SYSTEM 的凭证目录
mkdir C:\Windows\System32\config\systemprofile\.cloudflared

# ④ 把 cert.pem 和隧道凭证复制过去
copy %USERPROFILE%\.cloudflared\cert.pem C:\Windows\System32\config\systemprofile\.cloudflared\cert.pem
copy %USERPROFILE%\.cloudflared\<UUID>.json C:\Windows\System32\config\systemprofile\.cloudflared\<UUID>.json
```

⑤ 把 `config.yml` 放到 `C:\Windows\System32\config\systemprofile\.cloudflared\config.yml`，
且其中的 `credentials-file` 指向该目录下的凭证：

```yaml
tunnel: <UUID>
credentials-file: C:\Windows\System32\config\systemprofile\.cloudflared\<UUID>.json
ingress:
  - hostname: hub.example.com
    service: http://127.0.0.1:8443
  - service: http_status:404
logfile: C:\Cloudflared\cloudflared.log
```

⑥ 改注册表 `HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\Cloudflared`
的 `ImagePath`（**注意不要多余空格**）：

```
C:\Cloudflared\bin\cloudflared.exe --config=C:\Windows\System32\config\systemprofile\.cloudflared\config.yml tunnel run
```

⑦ 启动并确认：

```powershell
sc start cloudflared
Get-Service cloudflared     # → Running
```

> **更省事的替代**：若不想碰注册表，用「用户身份登录后常驻」的计划任务，
> 就能直接用 `%USERPROFILE%\.cloudflared\` 下的凭证：
>
> ```powershell
> schtasks /create /tn "cloudflared-dsh-hub" /sc onlogon /rl HIGHEST `
>   /tr "C:\Cloudflared\bin\cloudflared.exe --config=%USERPROFILE%\.cloudflared\config.yml tunnel run dsh-hub"
> ```
>
> 代价：必须有人登录后才会启动。

#### Linux

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
systemctl status cloudflared
```

#### macOS

```bash
sudo cloudflared service install
```

### 2.7 在 DSH 里登记

编辑 DSH profile 中本插件的配置：

```yaml
guardHost: 127.0.0.1
guardPort: 8443
publicAuthorities:
  - hub.example.com        # 与 config.yml 的 hostname 完全一致
tunnel:
  kind: none               # 隧道由 cloudflared 服务承担
  restart: on-failure
```

**改完必须重启 DSH Host 进程**（守卫监听不会热替换）。

> **`tunnel.kind` 怎么选？**
> - `none`：你自己把 cloudflared 做成系统服务（上文方式）——**推荐**，
>   因为开机自启、日志、重启策略都由 OS 负责。
> - `cloudflared`：插件代管 cloudflared 子进程（argv 固定为
>   `cloudflared tunnel --url http://127.0.0.1:8443`），适合临时验证。
>   注意这条命令走的是 **Quick Tunnel** 语义（随机域名），
>   与上面的命名隧道不通用——长期部署请用 `none`。

### 2.8 验证

```bash
# ① 本机守卫活着
curl -s -H "X-Hub-Protocol: 1" http://127.0.0.1:8443/remote/health
# → {"ok":true,"protocolVersion":1}

# ② 公网经隧道可达（换一台机器或用手机流量）
curl -s -H "X-Hub-Protocol: 1" https://hub.example.com/remote/health
# → {"ok":true,"protocolVersion":1}

# ③ 确认没把 DSH GUI 暴露出去（最重要）
curl -s -o /dev/null -w "%{http_code}\n" -H "X-Hub-Protocol: 1" \
  https://hub.example.com/api/session/list
# → 404
```

Windows PowerShell 等价写法（必须写 `curl.exe`，`curl` 是别名）：

```powershell
curl.exe -s -H "X-Hub-Protocol: 1" http://127.0.0.1:8443/remote/health
curl.exe -s -o NUL -w "%{http_code}`n" -H "X-Hub-Protocol: 1" https://hub.example.com/api/session/list
```

**若 QUIC(UDP) 被限速**，表现为请求耗时 2–15 秒剧烈抖动、大量超时，
但隧道日志显示「健康」。改走 TCP：

```powershell
cloudflared.exe --protocol http2 --config <config.yml> tunnel run dsh-hub
```

---

## 3. 方案 B：自有服务器中转（SSH 反向隧道）

适合本来就有 VPS 的情况。**这种方式没有 CDN 防护，请自行加 HTTPS。**

### 3.1 建立反向隧道

在**被控端**（你自己的电脑）执行：

```bash
ssh -N -R 127.0.0.1:18443:127.0.0.1:8443 user@your-server
```

语义：把**服务器**的 `127.0.0.1:18443` 转发到**本机**的 `8443`。
用 `127.0.0.1:` 而非 `0.0.0.0:`，只在服务器回环上开端口，配合 nginx 即可。

### 3.2 服务器侧 HTTPS 反代

```nginx
server {
  listen 443 ssl http2;
  server_name hub.example.com;

  ssl_certificate     /etc/letsencrypt/live/hub.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/hub.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:18443;
    proxy_http_version 1.1;
    proxy_set_header Host $host;              # ← 不能省，来源围栏依赖它
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;                 # WebSocket / 长轮询
  }
}
```

### 3.3 在插件里登记

```yaml
publicAuthorities:
  - hub.example.com
tunnel:
  kind: none
```

### 3.4 保活

```bash
autossh -M 0 -N -R 127.0.0.1:18443:127.0.0.1:8443 \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
  user@your-server
```

Windows 上可用 WSL，或用 `nssm` 把 ssh 命令包装成服务。

---

## 4. 方案 C：Quick Tunnel（仅临时演示）

```bash
cloudflared tunnel --url http://127.0.0.1:8443
# → https://<随机>.trycloudflare.com
```

然后把该域名填进 `publicAuthorities`。

**官方标注的限制**：URL 每次启动都变；任何拿到 URL 的人都能访问（**无身份门槛**）；
每隧道最多 200 在途请求（超出 429）；**不支持 SSE**。

仅用于「五分钟验证链路是否通」。

---

## 5. 方案 D：Tailscale（安全性最好）

```bash
tailscale serve --bg 8443      # 只在 tailnet 内可达
```

```yaml
publicAuthorities:
  - your-host.tailXXXX.ts.net
```

**为什么最安全**：`serve` 不出公网，设备本身就有 WireGuard 身份，
本插件的设备令牌是**第二层**。代价是每台设备要装 Tailscale。

若改用 `tailscale funnel` 则变为公网可达（只能用 443/8443/10000 且必须 TLS）。

---

## 6. 平台差异速查

| 事项 | Windows | Linux | macOS |
|---|---|---|---|
| 安装 | `winget install Cloudflare.cloudflared` | apt / yum / pacman | `brew install cloudflared` |
| 凭证目录（用户） | `%USERPROFILE%\.cloudflared` | `~/.cloudflared` | `~/.cloudflared` |
| 凭证目录（服务） | `C:\Windows\System32\config\systemprofile\.cloudflared` | `/root/.cloudflared` | 同用户 |
| 服务安装 | `service install` + 改注册表 `ImagePath` | `cloudflared service install` | `cloudflared service install` |
| 开机自启 | `sc start cloudflared` / 计划任务 | `systemctl enable --now` | launchd |
| 内核缓冲区 | 不适用 | 建议调 `net.core.rmem_max` | 不适用 |
| 命令写法 | PowerShell 用 `curl.exe` | `curl` | `curl` |
| 常见坑 | 文件名要改成 `cloudflared.exe`；服务看不到用户目录；EDR 拦截 | 防火墙 / SELinux | 首次运行需在「隐私与安全」放行 |

---

## 7. 关于第三方管理插件

社区有图形化的 Cloudflare 隧道管理器，可省去手改 `config.yml`：

- [dsh-cloudflared-manager](https://github.com/96bearli/dsh-cloudflared-manager)
  —— 在 DSH 面板里增删 ingress 映射、自动写 DNS、启停本地服务、看日志。

**但据其 README 自述**：

> 当前版本只支持 **Linux x64**，并且是按 Docker 容器环境调优的。
> 在 macOS / **Windows** / ARM 上安装**会拿不到可用的二进制**。

| 你的平台 | 能否用 |
|---|---|
| Linux x64（含 Docker） | ✅ |
| **Windows** | ❌ 请按 §2.1–§2.8 手工部署 |
| macOS / ARM | ❌ 同上 |

即便在 Linux 上用它，**ingress 目标依然必须是 `http://127.0.0.1:8443`**，
并且要把分配到的固定域名填进本插件的 `publicAuthorities`。
它负责「怎么暴露」，本插件负责「暴露之后谁能做什么」。

---

## 8. 排错对照表

| 现象 | 最可能原因 | 处置 |
|---|---|---|
| 公网 `403`，body 含 `source not allowed` | `publicAuthorities` 未填或与真实域名不符 | 核对大小写、子域、`:port` |
| 公网 `502`，隧道日志「健康」 | ingress 指向的端口没有服务；或 `localhost` 解析到 `::1` | 改成 `http://127.0.0.1:8443` |
| 访问返回 `404`（连 `/remote/health` 也 404） | 隧道或 DNS 指向错误 | `cloudflared tunnel ingress rule <url>` 看命中哪条 |
| 启动报 ingress 校验失败 | 最后一条不是 catch-all | 补 `- service: http_status:404` |
| 请求 2–15 秒抖动、大量超时 | QUIC(UDP) 丢包 | 改 `--protocol http2` |
| 「隧道建了却找不到」 | 管理员/普通用户终端混用 | 统一身份；服务方式看 systemprofile 目录 |
| Windows 服务启动即退出 | 未改 `ImagePath`，或凭证还在用户目录 | 按 §2.6 逐条核对 |
| 扫码成功但页面全空 | Origin 围栏 | 见 [USAGE.md](./USAGE.md) §3.2 |
| 改配置不生效 | 未重启 DSH / 未重启 cloudflared 服务 | 两者都要重启 |

---

## 9. 上线前自检清单

- [ ] `config.yml` 的 `service` 是 `http://127.0.0.1:8443`，**不是** `:3080`
- [ ] `cloudflared tunnel ingress validate` 通过
- [ ] `publicAuthorities` 与实际域名逐字一致
- [ ] 公网 `/remote/health` 返回 `200`
- [ ] 公网 `/api/session/list` 返回 `404`
- [ ] 默认角色是 `control`，不是 `full`
- [ ] `~/.dsh/remote-hub/devices.json` 权限 `0600`，只有 `tokenHash`、无明文 `token`
- [ ] cloudflared 已开机自启，重启机器后确认仍在线
- [ ] 知道如何吊销设备（泄露时的第一步）

---

## 10. 相关文档

- [USAGE.md](./USAGE.md)：安装、本机自用、局域网使用
- [DEPLOY.md](./DEPLOY.md)：通道拓扑、巡检、故障排查
- [API-MATRIX.md](./API-MATRIX.md)：每个 endpoint × 每个角色的授权矩阵
