# dsh-remote-hub

> 中文文档 ｜ [English version](README.en.md)

[![CI](https://github.com/XiaoPb/dsh-remote-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/XiaoPb/dsh-remote-hub/actions/workflows/ci.yml)
[![Release](https://github.com/XiaoPb/dsh-remote-hub/actions/workflows/release.yml/badge.svg)](https://github.com/XiaoPb/dsh-remote-hub/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@xiaopb/dsh-remote-hub?label=npm)](https://www.npmjs.com/package/@xiaopb/dsh-remote-hub)

**DSH 双角色远程接管插件（v0.3.4）**

文档：[部署与运维](docs/DEPLOY.md) ｜ [架构](docs/ARCHITECTURE.md) ｜ [设计契约](docs/DESIGN.md) ｜ [接口权限分布](docs/API-MATRIX.md) ｜ [文档索引](docs/INDEX.md) ｜ [更新日志](CHANGELOG.md) ｜ [English](README.en.md)

> **⚠️ 安全提示**：`full` 配对 = 远程代码执行 + 可写宿主配置与 API Key，且 0.3.1 起**不再有审批环节**。只给完全可信的设备发放 `full`。详见下文「安全声明」。

一个 Cordis 插件，让**一台 DSH 去操作另一台 DSH**。配对之后，控制端里受支持的业务视图指向目标 Host —— 会话、工作区、文件、任务都在远端；而 Remote Hub 自己的设备管理页仍然留在控制端本地。

> **验收状态**：已在隔离的 Web 控制端 + Debian Host 上验证接管、Full 角色工作区/会话创建、断开/重连、按角色限定的只读 API、远端文件浏览。四种 Web/Desktop 组合、凭据写入/登录、Android 未声明为完成。

---

## ⚠️ 安全声明（务必先读）

本插件把一台机器交给另一台机器操作。**配对等同于授权**，请在使用前理解以下事实。

### 1. `full` 配对 = 远程代码执行（0.3.1 起不再有审批环节）

| 能力 | `read-only` | `control` | `full` |
| --- | :---: | :---: | :---: |
| 查看会话 / 工作区 / 文件 / 插件清单 | ✓ | ✓ | ✓ |
| 驱动会话（发消息、取消、审批） | — | ✓ | ✓ |
| 传文件、开终端、浏览云端目录 | — | — | ✓ |
| **修改宿主配置 / 写入 API Key** | — | — | ✓ |
| **安装 / 卸载 / 启停插件** | — | — | ✓ |

`full` 的写入**直接生效，不再询问本机 owner**。这意味着：

- 对方可以**安装任意插件**，而插件代码在你的机器上运行 —— 等价于拿到你账号下的代码执行权；
- 对方可以**改写 Provider 配置与 API Key**，把你的模型调用指向他们指定的端点，或写入自己的密钥；
- 对方可以修改其他宿主设置，并据此影响你后续的所有会话。

> **只给完全可信的设备发放 `full`。** 不确定时用 `control`（能操作会话，但碰不到配置与插件）。
> 单人自用、或「自己另一台机器」的场景之外，请慎用 `full`。

### 2. 令牌即身份，泄露即可被重放

- 配对成功后签发**长期设备令牌**（bearer），在吊销前可被重放；
- 请勿截屏或转发配对二维码/短码 —— 15 秒 TTL 与单次使用只是缓解，不能防截图；
- 怀疑泄露时**立即在「已连接设备」里吊销**该设备，并检查审计日志。

### 3. 默认只绑回环，接隧道前必须显式放行

- 守卫默认监听 `127.0.0.1:8443`，未配对设备一律拒绝（fail-closed）；
- 跨网访问需要隧道 + 在 `publicAuthorities` 里显式声明公网 authority，否则所有经隧道的请求都会被来源围栏拒绝；
- **绝对不要把隧道指向 `:3080`（DSH Web GUI）** —— 那等于把 owner 权限直接暴露到公网，插件在组装隧道参数时会断言并拒绝启动。

### 4. 密钥与日志

- 审计日志、诊断文件、`host-status.json` **不含令牌与 API Key**；写入类接口的载荷会先经掩码（`sk-****abcd`）；
- 但本机 `~/.dsh/remote-hub/` 下的令牌文件是**明文存储**（依赖 OS 文件权限 `0600`/`0700` 保护），不是系统钥匙串；
- 远程接管时，**浏览器侧**会持有到目标主机的令牌，请勿在不可信的机器上使用接管。

### 5. 明确不做的事

- `account/*`（官方登录态、余额）、`dynamicCordisRunner/*`（动态执行）、
  `directoryPicker/pick`（宿主桌面原生弹框）、`settings/openSettingsDocument` **对任何角色都不开放**；
- `full` **不等于** DSH owner：宿主侧的插件生命周期、凭据管理等由 DSH 自身策略与 Host 审批把关。

完整接口级权限见 [接口权限分布](docs/API-MATRIX.md)。

---

## 核心功能

- **扫码或短码配对**：二维码票据与 8 位 Crockford 短码，**TTL 均为 15 秒**，配对成功即签发持久设备令牌。无界面主机用 `dsh-remote-hub-pair` 命令行出码。
- **三级角色，由 DSH Gateway 强制**：`read-only` / `control` / `full` 绑定到 endpoint 与资源，未知 endpoint **默认拒绝**；`full` **不等于** DSH owner。**`full` 完全放开**：写配置、配置 Provider API Key、安装/卸载/启停插件都会**直接生效，不再弹审批卡**。
- **插件在只读配对下也完全可读**：已装插件清单、插件/市场目录、版本与详情对 `read-only` / `control` / `full` 三档都开放。
- **红线不可下放**：`account/*`（官方登录态）、`settings/openSettingsDocument`、`directoryPicker/*`、`pluginInventory/*`、`dynamicCordisRunner/*`、`remoteAccess/follow`、`$events` 无论何种角色都不外放；`settings/*`、`credentials/*`、`pluginManager/*`、`pluginMarket/*` 是**前缀红线 + 具名豁免**，未登记的方法一律拒绝。CI 每次构建都用断言复核。
- **密钥永不明文外流**：写入 API Key 时，审计日志与诊断文件里的密钥仍一律掩码为 `sk-****abcd`（即使已取消审批，脱敏不受影响）。
- **官方传输接管**：HTTP RPC（`/remote/rpc`）与官方 WebSocket mux（`/remote/ws`）都指向已配对的 Host，不替换 DSH 内核。
- **默认零暴露**：守卫是**独立**监听，只绑回环字面量（默认 `127.0.0.1:8443`），端口被占时直接报错、**不静默换端口**；未配对设备 fail-closed。隧道默认 `kind: 'none'`。
- **凭据落点**：出站令牌由控制端本地 Host 保存（`~/.dsh/remote-hub/outbound-targets.json`，POSIX `0600`/`0700`）；浏览器侧只保存不透明 target ID，**不含明文令牌**；目标端设备表只存 `sha256(token)`。
- **断连可恢复**：断开只切换回本地，配对记录保留，一键重连。
- **云端路径 UI（内置）**：云端目录浏览、新建目录、以及聊天 `+` 菜单把云端工作区文件加入消息——从 0.3.1 起**内置在本插件内**，不再需要单独安装伴生包。它只在接管生效时注册 UI，本机文件选择与 dsh-hardssh 流程完全不受影响。目录浏览需要 `full` 配对。

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

主包为 `@xiaopb/dsh-remote-hub@0.3.4`（云端路径 UI 已内置，无需其它包）。要求 **Node.js ≥ 24.9.0**、**DSH ≥ 0.2.1-rc.2 < 0.3.0-0**。

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
