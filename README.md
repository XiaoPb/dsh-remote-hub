# dsh-remote-hub

> 中文文档 ｜ [English version](README.en.md)

[![CI](https://github.com/XiaoPb/dsh-remote-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/XiaoPb/dsh-remote-hub/actions/workflows/ci.yml)
[![Release](https://github.com/XiaoPb/dsh-remote-hub/actions/workflows/release.yml/badge.svg)](https://github.com/XiaoPb/dsh-remote-hub/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@xiaopb/dsh-remote-hub?label=npm)](https://www.npmjs.com/package/@xiaopb/dsh-remote-hub)

**DSH 双角色远程接管插件（v0.2.5）**

文档：[部署与运维](docs/DEPLOY.md) ｜ [架构](docs/ARCHITECTURE.md) ｜ [设计契约](docs/DESIGN.md) ｜ [接口权限分布](docs/API-MATRIX.md) ｜ [文档索引](docs/INDEX.md) ｜ [更新日志](CHANGELOG.md) ｜ [English](README.en.md)

一个 Cordis 插件，让**一台 DSH 去操作另一台 DSH**。配对之后，控制端里受支持的业务视图指向目标 Host —— 会话、工作区、文件、任务都在远端；而 Remote Hub 自己的设备管理页仍然留在控制端本地。

> **验收状态**：已在隔离的 Web 控制端 + Debian Host 上验证接管、Full 角色工作区/会话创建、断开/重连、按角色限定的只读 API、远端文件浏览。四种 Web/Desktop 组合、凭据写入/登录、Android 未声明为完成。

---

## 核心功能

- **扫码或短码配对**：二维码票据与 8 位 Crockford 短码，**TTL 均为 15 秒**，配对成功即签发持久设备令牌。无界面主机用 `dsh-remote-hub-pair` 命令行出码。
- **三级角色，由 DSH Gateway 强制**：`read-only` / `control` / `full` 绑定到 endpoint 与资源，未知 endpoint **默认拒绝**；`full` **不等于** DSH owner。
- **红线不可下放**：`credentials/*`、`settings` 写方法、`directoryPicker/*`、`pluginManager/*`、`pluginMarket/*`、`account/*`、`remoteAccess/follow`、`$events` 无论何种角色都不外放，CI 每次构建都用断言复核。
- **官方传输接管**：HTTP RPC（`/remote/rpc`）与官方 WebSocket mux（`/remote/ws`）都指向已配对的 Host，不替换 DSH 内核。
- **默认零暴露**：守卫是**独立**监听，只绑回环字面量（默认 `127.0.0.1:8443`），端口被占时直接报错、**不静默换端口**；未配对设备 fail-closed。隧道默认 `kind: 'none'`。
- **凭据落点**：出站令牌由控制端本地 Host 保存（`~/.dsh/remote-hub/outbound-targets.json`，POSIX `0600`/`0700`）；浏览器侧只保存不透明 target ID，**不含明文令牌**；目标端设备表只存 `sha256(token)`。
- **断连可恢复**：断开只切换回本地，配对记录保留，一键重连。
- **可选伴生包 Remote Paths**：`@xiaopb/dsh-remote-paths` 提供远端目录浏览与聊天 `+` 菜单的云文件动作；本地文件选择与 dsh-hardssh 保持独立、不受影响。

---

## 安装

### 从 npm（推荐）

```bash
dsh plugin --profile web add @xiaopb/dsh-remote-hub
# 升级后必须重启 Host：守卫监听与隧道子进程不会热替换
```

### 从源码

```bash
git clone https://github.com/XiaoPb/dsh-remote-hub.git
cd dsh-remote-hub
pnpm install
pnpm run build
dsh plugin --profile web add link:$PWD
```

主包为 `@xiaopb/dsh-remote-hub@0.2.5`，伴生包为 `@xiaopb/dsh-remote-paths@0.2.5`。要求 **Node.js ≥ 24.9.0**、**DSH ≥ 0.2.1-rc.2 < 0.3.0-0**。

---

## 启用 Host

把包加入 DSH profile 的 roster 并重启该 Host：

```yaml
- id: remote-hub
  name: '@xiaopb/dsh-remote-hub'
```

roster id 固定为 `remote-hub`，**不随版本改变**。默认守卫只绑回环；受信局域网联调需显式配置：

```yaml
network: lan
guardHost: '0.0.0.0'
guardPort: 8443
singleController: true
defaultRole: control
```

> **红线**：不要让隧道指向 DSH Web GUI 端口（通常 `:3080`）。Remote Hub 守卫是**独立**监听，把它暴露出去等于把 owner 权限暴露出去；插件在组装隧道 argv 时断言上游必须是 `http://127.0.0.1:<port>` 且不得含 `:3080`。

完整配置项、隧道 provider 选型、巡检与故障排查见 [部署与运维](docs/DEPLOY.md)。

---

## 配对（操作者视角）

1. 本机 DSH 页面点「添加设备」，选角色（`read-only` / `control` / `full`）。
2. 页面渲染二维码；设备扫码，或输入 8 位短码（15 秒内有效，最多 5 次错误尝试）。
3. 设备兑换票据，收到一次 `{ deviceId, token, role }`；之后每请求带 `Authorization: Bearer <token>`。

无界面主机：

```bash
dsh-remote-hub-pair --code --role control --label edge-server
```

**不要把配对二维码截屏发出去**：短 TTL + 单次使用是缓解措施，不假装能防截图。令牌泄露 = 吊销前可重放，处置是立即吊销 + 审计。

---

## 验证

```bash
pnpm run typecheck        # host + client 双 tsconfig
pnpm run build            # tsc → tsdown（host / carrier-boot / client 顺序固定）
node scripts/run-all-tests.mjs   # 串行跑全部 test/*.test.mjs
node scripts/version-gate.mjs    # 兼容门矩阵
node scripts/contract-check.mjs  # 协议契约对账
node scripts/fence.mjs           # 来源围栏用例
node scripts/redlines.mjs        # 红线不可下放断言
```

CI 跑上面同一套。发布走 CI/CD，**不接受本地手工 `npm publish`**，详见 [发布流程](docs/RELEASE.md)。

---

## 限制

- **Android 延期**，不随本版本发布。
- **Desktop Host 组合未在隔离桌面实例上验证**；测试不会修改或重启你日常使用的 Desktop 实例。
- **凭据写入、账号登录、真实模型请求**需要专用测试凭据/账号，默认验收未覆盖。
- `full` **不会**自动变成 DSH owner：插件生命周期、动态 Cordis 执行、任意设置、凭据管理仍受独立管控，可能还需要 Host 审批。
- 守卫默认只绑回环；跨网访问必须先配置 `publicAuthorities`，否则经隧道的请求会被来源围栏**全部拒绝**（这是 fail-closed 的正确行为）。

---

## 相关文档

| 文档 | 内容 |
| --- | --- |
| [README.en.md](README.en.md) | English version |
| [docs/DEPLOY.md](docs/DEPLOY.md) | 部署、配置项、隧道选型、巡检、故障排查 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 数据通路、身份、授权、持久化 |
| [docs/DESIGN.md](docs/DESIGN.md) | 角色语义、状态归属、支持边界 |
| [docs/API-MATRIX.md](docs/API-MATRIX.md) | **全部接口 × 角色权限分布表**（自动生成） |
| [docs/RELEASE.md](docs/RELEASE.md) | CI/CD 发布流程与管控 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录 |

内部计划、历史设计、审计与环境特定的验收记录保存在被忽略的 `dev/docs/` 下，不进入发布包。

## 许可证

[MIT](LICENSE) © 2026 XiaoPb
