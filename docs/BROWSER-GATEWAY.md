# 浏览器直连（方案 A）：部署与验证

> 守卫托管官方界面：浏览器经隧道打开 `<guard>/`，账号 + 口令 + 2FA 之后
> 直接进入完整的 DSH 界面。官方端口 `:3080` **始终只绑回环**。

## 1. 它解决什么

传统做法是把 `:3080` 通过隧道暴露出去，但那意味着：
- 认证只是 URL 里的 `?token=`，公网可见、无 2FA、无设备概念；
- 认证后浏览器恒为 `owner`，权限拉满。

方案 A 把守卫放在前面：浏览器只认守卫，守卫用**账号体系**（口令 + TOTP +
HttpOnly Cookie）认证，认证后才以 `remote-device` 身份派发到 Gateway。

## 2. 配置

`cordis.patch.yml` 需要两项：

```yaml
- id: remote-hub
  name: "@xiaopb/dsh-remote-hub"
  config:
    network: lan
    guardHost: "0.0.0.0"
    guardPort: 8443
    accountAuth:
      enabled: true

# 让 DSH 选中 browse 目录选择后端（浏览器内浏览远程目录），
# 而不是 native（会在宿主桌面弹原生框）。
- id: connection
  config:
    trustedHosts:
      - 127.0.0.1
      - localhost
      - <你的主机名>:<端口>
```

`trustedHosts` 里必须有一个**非回环 authority**：DSH 的
`directory-picker-auto` 只在 `connection.allowsRemoteAuthorities` 为真时
才挂 `browse`，否则挂 `native` —— 后者会让浏览器的「选择工作区」
去拉开**浏览器本地**的文件夹对话框。

## 3. 路由

| 路由 | 行为 |
|---|---|
| `GET /` | 官方 index（`readResource` + peer，不需要自启动令牌） |
| `GET /assets/*`、`/plugins/*`、manifest | 同上，进程内读取 |
| `GET/POST /remote-web/login`、`/remote-web/mfa` | 登录页与两个端点 |
| `POST /api/*` | Cookie 认证后以 `remote-device` 派发 |
| `WS /api/remote.mux` | Cookie 认证后认领（客户端服务靠它拿到 Host generation） |

**认证一律在读 body 之前**：未认证直接 401，零字节转发。

## 4. 已实测（Debian，经 SSH 隧道，真实 Edge）

| 项 | 结果 |
|---|---|
| `GET /` | 200，含 `__DSH_REMOTE_HUB__ = { mode: 'remote-browser' }` |
| 口令 → MFA | 200 → 200（HttpOnly Cookie） |
| `/api/*` 带 Cookie | 200（穿透到 Gateway） |
| `/api/*` 匿名 | 401 |
| `WS /api/remote.mux` | open |
| 官方 `:3080` | `127.0.0.1` only |

界面显示远程主机真实数据（工作区 `l-evk-t2-gh3020`、模型列表、composer 可用）；
「添加工作区」弹出**远程目录**（Debian 的 `公共/模板/视频/文档/code/esp-idf/…`），
与本机（`AppData/Cookies/Links`）完全不同。

## 5. 排查记录（踩过的坑）

1. **官方 index 需要自启动令牌** —— 不要去找那个令牌。官方 liveshare 的做法是
   `webServer.readResource(request, peer)`：给了 peer 身份就放行。
2. **远程标记必须在 `</body>` 之前注入**：Host 自己也往
   `globalThis.__DSH_REMOTE_HUB__` 写配对令牌与设备表，写在 `<head>` 会被后写者覆盖。
   必须 `Object.assign` 合并，不能赋值。
3. **policy 必须按资源种类分别绑定**。只在 `global` 上授权会让
   `session/create` 被 `no-allow` 拒绝（页面报
   `initial Session restoration failed`），工作区永远建不起来。
4. **账号模式客户端不在设备表里**（`dev_*` vs `cli_*`），
   `policy.bindings()` 必须回落到 auth 侧查询，否则全量 403。
5. **角色取自会话**（`AuthSessionView.role`），不要按 `accountId` 去
   `listTrustedClients()` 里找——`TrustedClientView` 不含 `accountId`，
   恒匹配不到会退化成 `read-only`。
6. **WS mux 升级必须接线**：客户端的 `permission catalog` 等服务的建立依赖
   Host generation，而它来自 `/api/remote.mux` 这条长连接。
