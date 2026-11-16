# 浏览器直连（方案 A）

> 不装桌面端，也能用完整的 DSH 界面。
>
> 用手机、平板、别人的电脑打开一个网址，输入账号口令 + 6 位动态码，
> 拿到与桌面端一致的界面。官方端口 `:3080` **始终只绑回环**。

## 1. 两种接入方式

| | 桌面端 / 客户端（原有） | 浏览器直连（本文，0.5.0+） |
|---|---|---|
| 门户 | Hub 提供的「云端设备」页 | 守卫托管的官方界面 |
| 身份证明 | 客户端私钥 + 每请求签名 | HttpOnly 会话 Cookie |
| 认证时机 | 首次信任时用账号 + 2FA | **每次打开**都要账号 + 2FA |
| 适合 | 自己常用的电脑 | 手机、临时设备、没有客户端的环境 |
| 前置条件 | 装桌面端 | 只要浏览器 |

两者**并存**，用哪个取决于你在什么设备上。

## 2. 支持与不支持

### ✅ 支持

- **纯浏览器**（手机 / 平板 / 另一台电脑）打开守卫网址，登录后使用完整界面：
  会话、工作区、文件、插件页、设置页。
- 首次配置可在**无图形界面**的服务器上完成（见 §3）。
- 反向代理 / 隧道背后运行（见 §6）。
- 浏览器内**浏览远程目录**：新建工作区时弹出的是**服务器**的目录树。

### ❌ 不支持

- **`/api/directoryPicker/pick`（系统原生选择器）** —— 这条红线保留。
  浏览器永远不能要求服务器弹出系统文件对话框（那是服务器桌面上的一次真实交互，
  且无任何审计）。
- **未绑定 2FA 的账号从浏览器登录**。TOTP 必须在首次登录向导里绑定好；
  浏览器入口会直接拒绝（`auth-totp-required`）。
- **在纯浏览器里做「首次配置」用原生 OS 对话框的操作** —— 无图形界面时没有可弹的窗口。
- **把 `:3080` 直接暴露到网络**。它只有 `?token=` 一层，必须经由守卫。

## 3. 首次配置（服务器无图形界面）

这是最容易卡住的一步。**顺序不能颠倒**：TOTP 只能在首次登录向导里绑定，
而浏览器入口又要求已绑 TOTP，所以第一次必须走本地 Web。

### 3.1 建隧道到官方 Web

服务器上 `dsh web` 的官方端口只绑 `127.0.0.1:3080`，本地开隧道：

```bash
ssh -N -L 3080:127.0.0.1:3080 user@your-server
```

如果登录流程会打开新窗口，再补一条（它常用 `3081`）：

```bash
ssh -N -L 3081:127.0.0.1:3080 user@your-server
```

### 3.2 取启动令牌

每次启动 `dsh web` 都会生成新令牌，在启动日志里：

```bash
grep -o 'token=[A-Za-z0-9_-]*' ~/.dsh/dsh.log | tail -1
```

打开 `http://127.0.0.1:3080/?token=<上面的值>`。

### 3.3 取初始凭据

账号库为空时，插件会生成一次性初始凭据：

```bash
cat ~/.dsh/remote-hub/pending-admin.json
# {"username":"admin","password":"..."}
```

> **登录成功那一刻**才会生成 scrypt 哈希写入 `auth.db`，随后这个明文文件被删除。
> 在此之前口令只存在这里。

### 3.4 走完向导

**不要点账号菜单里的「登录」** —— 那个入口依赖弹出新窗口，
无图形界面的环境会一直停在「等待登录」。

正确的路径：

```
账号菜单 → 设置 → 左侧「登录与账号」
```

依次完成：

1. **改口令**（强制，只此一次）
2. **改账号名**（可选，只在这一次能改）
3. **绑定两步验证**（强制）—— 扫二维码或用「认证器密钥」手动输入，保存备用码

完成后 `~/.dsh/remote-hub/auth.db` 里才有账号，`pending-admin.json` 消失。

### 3.5 之后从浏览器用

```
http://<服务器>:<guardPort>/
```

会自动跳到登录页。登录后就是完整界面。

## 4. 配置

`cordis.patch.yml`：

```yaml
- id: remote-hub
  name: "@xiaopb/dsh-remote-hub"
  config:
    network: lan            # 允许同网段设备访问；loopback 仅本机
    guardHost: "0.0.0.0"    # 监听地址
    guardPort: 8443
    accountAuth:
      enabled: true         # 账号体系（浏览器直连依赖它）

# 让 DSH 选中 browse（浏览器内浏览远程目录），而不是 native
# （native 会在服务器桌面弹原生框 —— 无桌面时等于坏掉）
- id: connection
  config:
    trustedHosts:
      - 127.0.0.1
      - localhost
      - <你的主机名或 IP>:<guardPort>
```

> **`trustedHosts` 里必须有一个非回环 authority**。DSH 的
> `directory-picker-auto` 只在 `connection.allowsRemoteAuthorities` 为真时
> 才挂 `browse`，否则挂 `native`。`native` 在无桌面 / 浏览器场景下
> 会让「新建工作区」去拉**浏览器本地**的文件夹对话框，或干脆没反应。

## 5. 安全模型

### 5.1 三层边界

```
浏览器 ──(Cookie)──> 守卫 :8443 ──(进程内 dispatcher)──> Gateway ──> DSH
                     ↑ 认证在这里      ↑ remote-device 身份
                     官方 :3080 始终只绑 127.0.0.1
```

### 5.2 具体措施

| 措施 | 说明 |
|---|---|
| **认证在读 body 之前** | 未登录 `/api/*` 直接 401，零字节转发 |
| **HttpOnly Cookie** | `dsh_hub_session`，JS 读不到；`SameSite=Strict`；https 时加 `Secure` |
| **不以 owner 派发** | 浏览器身份是 `remote-device`，角色取自账号（管理员 `full`，其余 `read-only`） |
| **按资源种类授权** | `session` / `workspace` / `global` 分别绑定，避免越权 |
| **无原生对话框** | `directoryPicker/pick` 明确拒绝 |
| **每次重新认证** | 换设备、换浏览器都要重新走账号 + 2FA |
| **会话有上限** | 6 小时（`WEB_SESSION_TTL_MS`），过期需重新登录 |

### 5.3 你需要自己做的

- **一定用 https**。口令和动态码是明文 POST 的，走 http 等于在网络上裸奔。
  用反向代理终结 TLS（§6）；Cookie 会自动带 `Secure`。
- **不要把守卫暴露到公网**。`network: lan` 只接受私有地址；想在公网用，
  走 VPN 或 §6 的反向代理 + 额外一层访问控制。
- **保管好备用码**。手机丢了、TOTP 换机时靠它。用完记得重新生成。
- **初始凭据存在期间**（`pending-admin.json` 还在）尽快完成向导——
  那段时间里任何能读到该文件的人都能抢先登录。

## 6. 反向代理

守卫是个普通 HTTP + WebSocket 服务，可以放在 nginx / Caddy 后面。

### 6.1 必须满足的四点

1. **WebSocket 升级**必须透传 —— `/api/remote.mux` 是长连接，
   客户端的权限目录、插槽装配都依赖它。不升级的话页面会「能打开但功能全空」。
2. **保留 `Host` 头** —— 不要写成固定值。DSH 用它做同源判定。
3. **不要改写 Cookie 的 `Path`**，保持 `/`。
4. **HTTPS 终结在代理**，回源走 http（守卫自己不做 TLS）。

### 6.2 nginx

```nginx
server {
  listen 443 ssl http2;
  server_name dsh.example.com;

  ssl_certificate     /etc/ssl/certs/dsh.pem;
  ssl_certificate_key /etc/ssl/private/dsh.key;

  # 守卫是唯一入口；官方 :3080 不对外。
  location / {
    proxy_pass http://127.0.0.1:8443;
    proxy_http_version 1.1;

    # ① WebSocket 升级（必须有）
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection $connection_upgrade;

    # ② 原始 Host（DSH 用它做同源判定）
    proxy_set_header Host       $host;
    proxy_set_header X-Real-IP  $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # 长轮询 / 流式响应用，避免被代理提前掐断
    proxy_read_timeout  3600s;
    proxy_send_timeout  3600s;
    proxy_buffering     off;
  }
}
```

`http` 块里要有：

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}
```

### 6.3 Caddy（自动 TLS，配置最短）

```caddy
dsh.example.com {
  reverse_proxy 127.0.0.1:8443 {
    header_up Host {host}
    # Caddy 默认就透传 Upgrade 与长连接，无需额外配置
  }
}
```

### 6.4 反向代理后要检查的

| 检查 | 怎么看 |
|---|---|
| 登录页正常 | 访问 `https://域名/`，应跳到登录页而不是 JSON |
| Cookie 带 `Secure` | 浏览器开发者工具 → Application → Cookies，确认有 `Secure` |
| WebSocket 通 | Network 里找 `remote.mux`，状态应为 `101 Switching Protocols` |
| 功能非空 | 设置页「权限」区应显示可选项，而不是「不可用」 |

> 反代后 `guardOrigin` 用域名即可，插件按请求的 `Host` 判定同源，
> 不需要在配置里再写一遍域名。

## 7. 排查

### 页面能打开但功能全空 / 设置里「权限不可用」

WebSocket 没通。客户端的 `permission catalog` 等服务的建立依赖 Host
generation，而它来自 `/api/remote.mux` 这条长连接。
检查反向代理的 `Upgrade` / `Connection` 头，或直接用 `:8443` 直连确认。

### 登录后立刻被踢回登录页

- Cookie 没存下来：确认不是 https 与 http 混用（`Secure` Cookie 在 http 下不生效）。
- 反向代理改了 `Cookie` 的 `Path`。

### 登录表单提交后变成一堆 JSON

0.4.0 的 bug（登录页脚本语法错误导致表单原生提交），已在 0.5.0 修复。
若仍出现，确认部署的是 0.5.0+。

### 新建工作区没有弹目录 / 弹的是本地文件夹

`connection.trustedHosts` 缺非回环 authority，DSH 选了 `native` 后端。
按 §4 补上后重启。

### 二维码扫不出来

0.4.0 的二维码是 57 模块配 120px（2.1px/模块），低于扫码器要求。
0.5.0 起自动选版本并保证 ≥4px/模块。若仍扫不出，用「认证器密钥」
手动输入（设置页里那串 Base32）。

## 8. 实现要点（改代码时看）

| 文件 | 职责 |
|---|---|
| `host/src/guard-web.ts` | `/` 的 index 注入 + 静态资源进程内读取；未登录 302 |
| `host/src/guard.ts` | 路由分派、`/api/*` Cookie 认证、`/api/remote.mux` 升级 |
| `host/src/auth/web-session.ts` | 登录页、登录/MFA 端点、Cookie 构造 |
| `host/src/policy.ts` | `web:<accountId>` 身份的绑定（按资源种类） |
| `host/src/plugin.ts` | `readResource` 读 index/资源、`readerOf`、`roleOf` |

踩过的坑见本文 §7 与根目录 `CHANGELOG.md` 的 0.5.0 条目。
