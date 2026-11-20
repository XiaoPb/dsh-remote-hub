# dsh-remote-hub

> 中文文档 ｜ [English version](README.en.md)

[![CI](https://github.com/XiaoPb/dsh-remote-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/XiaoPb/dsh-remote-hub/actions/workflows/ci.yml)
[![Release](https://github.com/XiaoPb/dsh-remote-hub/actions/workflows/release.yml/badge.svg)](https://github.com/XiaoPb/dsh-remote-hub/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@xiaopb/dsh-remote-hub?label=npm)](https://www.npmjs.com/package/@xiaopb/dsh-remote-hub)

**DSH 双角色远程接管插件（v0.5.5）**

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

- 账号登录成功后为**本机客户端公钥**签发租约（默认 7 天自动轮换），租约可被重放；
- 请勿导出或转发客户端的私钥（它存在浏览器/客户端的密钥库里）；
- 怀疑泄露时**立即在「设置 → 登录与账号 → 可信客户端」里撤销**该客户端：撤销立即生效，
  记录本身保留一天（用于识别迟到请求），一天后连同密钥与租约一起清除。

### 3. 默认只绑回环，接隧道前必须显式放行

- 守卫默认监听 `127.0.0.1:8443`，未配对设备一律拒绝（fail-closed）；
- 跨网访问需要隧道 + 在 `publicAuthorities` 里显式声明公网 authority，否则所有经隧道的请求都会被来源围栏拒绝；
- **绝对不要把隧道指向 `:3080`（DSH Web GUI）** —— 那等于把 owner 权限直接暴露到公网，插件在组装隧道参数时会断言并拒绝启动。

### 4. 密钥与日志

- 审计日志、诊断文件、`host-status.json` **不含令牌与 API Key**；写入类接口的载荷会先经掩码（`sk-****abcd`）；
- 但本机 `~/.dsh/remote-hub/` 下的令牌文件是**明文存储**（依赖 OS 文件权限 `0600`/`0700` 保护），不是系统钥匙串；
- 远程接管时，**浏览器侧**会持有到目标主机的令牌，请勿在不可信的机器上使用接管。

### 5. 明确不做的事

- `account/*`（官方登录态、余额）、`directoryPicker/pick`（宿主桌面原生弹框）、
  `settings/openSettingsDocument`、`remoteAccess/follow`、`$events` **对任何角色都不开放**；
- `dynamicCordisRunner/*`（动态执行）**不是**红线：0.3.2 起改为 **`full` 专属**，`read-only` / `control` 一律拒绝；
- `full` **不等于** DSH owner：宿主侧的插件生命周期、凭据管理等由 DSH 自身策略与 Host 审批把关。

完整接口级权限见 [接口权限分布](docs/API-MATRIX.md)。

---

## 两种用法

| | 桌面端 / 客户端 | 浏览器直连（0.5.0+） |
|---|---|---|
| 怎么用 | 装 DSH 桌面端，在「云端设备」里填对端地址配对 | 浏览器打开 `http://<host>:<guardPort>/ ` |
| 身份 | 客户端私钥，每请求签名 | HttpOnly 会话 Cookie |
| 认证 | 首次信任时用账号 + 2FA，之后 7 天租约静默轮换 | **每次打开**都要账号 + 口令 + 动态码 |
| 适合 | 自己的常用电脑 | 手机、平板、临时设备、无客户端环境 |
| 需要 | 装客户端 | 只要浏览器 |

两者并存，用哪个取决于你在什么设备上。浏览器直连的完整说明见
**[docs/BROWSER-GATEWAY.md](docs/BROWSER-GATEWAY.md)**。

### 快速上手：浏览器直连

**前提**：账号已绑定两步验证。未绑定的账号浏览器入口会拒绝
（TOTP 只能在首次登录向导里绑定）。

1. 在 Host 的 `cordis.patch.yml` 开 `accountAuth.enabled: true`，
   并给 `connection` 行加 `trustedHosts`（含一个非回环 authority，
   否则「新建工作区」会去拉浏览器本地的文件夹）。详见文档 §4。
2. 浏览器打开 `http://<host>:<guardPort>/`，自动跳到登录页。
3. 输入账号、口令、6 位动态码。

**服务器没有图形界面？** 第一次配置必须走本地 Web（经 SSH 隧道），
因为 TOTP 绑定只能在首次登录向导里完成。完整步骤见
[docs/BROWSER-GATEWAY.md §3](docs/BROWSER-GATEWAY.md)。

### 反向代理

守卫是普通 HTTP + WebSocket，可以放在 nginx / Caddy 后面。**关键是透传
WebSocket 升级**（`/api/remote.mux` 是长连接，权限目录等客户端服务依赖它）
并保留原始 `Host` 头。配置样例见
[docs/BROWSER-GATEWAY.md §6](docs/BROWSER-GATEWAY.md)。

---

## 核心功能

- **账号登录建立信任**：在「云端设备 → 连接其他设备」里填对端守卫地址，用**对端的账号**登录（需要时填动态码），
  成功后本机公钥被登记为对端的一个可信客户端，之后重连不再需要 2FA。首次登记要求对端已绑定两步验证。
- **三级角色，由 DSH Gateway 强制**：`read-only` / `control` / `full` 绑定到 endpoint 与资源，未知 endpoint **默认拒绝**；`full` **不等于** DSH owner。**`full` 完全放开**：写配置、配置 Provider API Key、安装/卸载/启停插件都会**直接生效，不再弹审批卡**。
- **插件在只读配对下也完全可读**：已装插件清单、插件/市场目录、版本与详情对 `read-only` / `control` / `full` 三档都开放。
- **红线不可下放**：`account/*`（官方登录态）、`settings/openSettingsDocument`、`directoryPicker/pick`、`remoteAccess/follow`、`$events` 无论何种角色都不外放；`settings/*`、`credentials/*`、`pluginManager/*`、`pluginMarket/*` 是**前缀红线 + 具名豁免**，未登记的方法一律拒绝。CI 每次构建都用断言复核。
- **Full 专属面**：`dynamicCordisRunner/*`（12 个动态执行端点）与 `directoryPicker/list`、`directoryPicker/createDirectory` 只对 `full` 开放；`pluginInventory/*`（已装插件清单，只读）对三档角色都开放。
- **密钥永不明文外流**：写入 API Key 时，审计日志与诊断文件里的密钥仍一律掩码为 `sk-****abcd`（即使已取消审批，脱敏不受影响）。
- **官方传输接管**：HTTP RPC（`/remote/rpc`）与官方 WebSocket mux（`/remote/ws`）都指向已配对的 Host，不替换 DSH 内核。
- **默认零暴露**：守卫是**独立**监听，只绑回环字面量（默认 `127.0.0.1:8443`），端口被占时直接报错、**不静默换端口**；未配对设备 fail-closed。隧道默认 `kind: 'none'`。
- **凭据落点**：出站令牌由控制端本地 Host 保存（`~/.dsh/remote-hub/outbound-targets.json`，POSIX `0600`/`0700`）；浏览器侧只保存不透明 target ID，**不含明文令牌**；目标端设备表只存 `sha256(token)`。
- **断连可恢复**：断开只切换回本地，配对记录保留，一键重连。
- **云端路径 UI（内置）**：云端目录浏览、新建目录、以及聊天 `+` 菜单把云端工作区文件加入消息——从 0.3.1 起**内置在本插件内**，不再需要单独安装伴生包。它只在接管生效时注册 UI，本机文件选择与 dsh-hardssh 流程完全不受影响。目录浏览需要 `full` 配对。

---

## 账号认证与可信客户端（可选，推荐）

守卫原生的「长期设备令牌」是静态 bearer：**拿到它就等于拿到该设备的权限**。本版本
增加第二个 Cordis 插件行 `@xiaopb/dsh-remote-hub/auth`，把 Hub 认证升级为
**账号 + 2FA 建立信任，之后按客户端私钥逐请求签名**：

```yaml
- insert:
    - id: remote-hub
      name: '@xiaopb/dsh-remote-hub'
      config:
        accountAuth:
          enabled: true      # 切换后旧设备令牌立即失效
- insert:
    - id: remote-hub-auth
      name: '@xiaopb/dsh-remote-hub/auth'
```

### 它解决什么

| 风险 | 旧模型 | 账号认证模型 |
|---|---|---|
| 令牌泄露 | 直接冒用，直到吊销 | 只有租约还不够，必须同时持有客户端私钥 |
| 长期凭据 | 令牌长期有效 | 7 天租约，后台静默轮换；重放旧代次会撤销客户端 |
| 撞库 / 弱口令 | 无 | 口令 scrypt + TOTP + 登录限速 + MFA 挑战即烧 |
| 多设备共用 | 一台设备一个长期令牌 | 每个浏览器/App 独立公钥，可单独撤销 |
| WS 凭据进 URL | `?token=` 长期令牌 | 30 秒、一次性升级票据 |

**信任只跟客户端密钥走**：IP、User-Agent、canvas 指纹都不参与认证（指纹只在列表里
供人眼核对）。信任一次之后切换角色**不再要求 2FA**——只有超出该客户端服务端上限时才会被拒绝。

### 使用

1. 首次启动会创建默认账号 **`admin`**，初始口令**随机生成**并写在
   `~/.dsh/remote-hub/initial-password`（`0600`，目录 `0700`）。服务器上直接
   `cat ~/.dsh/remote-hub/initial-password` 取值。
2. 打开 DSH Web → **设置 → 登录与账号**，用 `admin` + 初始口令登录。
3. **必须先改密**（只强制这一次）：改密前不能绑定 2FA、不能信任客户端、也拿不到
   Hub 租约。改密成功后 `initial-password` 文件被删除，旧口令立即失效。
4. 绑定认证器（TOTP）并保存备用码 → 「信任本浏览器」→ 拿到 7 天租约。
5. 之后切换权限、撤销客户端都在同一页完成；口令策略也在这一页切换。

### 两套账号，别混在一起

| | 本机账号 | 对端账号 |
|---|---|---|
| 是谁 | 这台 DSH 上的那一个账号（`admin` 或你改过的名字） | 你在**别的机器**上登录用的账号 |
| 管什么 | 谁能登录这台机器的 DSH Web / 设置页 | 本机作为控制端能连哪台目标机 |
| 在哪配 | 设置 → 登录与账号 → 本机账号 | 设置 → 登录与账号 → 对端账号（记录列表） |
| 信任载体 | 本机签发的客户端公钥（本机已信任的客户端） | 目标机签发的客户端公钥（记录在出站档案） |
| 影响范围 | 撤销后本机 Web 会重新要求登录 | 移除后本机不再能连那台目标，目标端记录需在对端撤销 |

设置页把两者分开显示：本机账号那块是口令、2FA、策略、以及「本机已信任的客户端」；
对端账号那块是「本机在别的机器上建立过的信任」，可以移除单条记录。
**两边互不影响**：改本机账号口令不会让对端信任失效，撤销对端信任也不会把你从本机登出。

### 浏览器能不能直接访问守卫

不能，也不需要。守卫对外只有 JSON RPC 与 WebSocket，不提供网页；它要求「租约 + 每请求
客户端签名」，而这个签名由 DSH 的浏览器端（carrier）用本机 WebCrypto 私钥完成。
所以正常路径是：浏览器打开 DSH Web → 由 DSH 客户端把 `/api` 转发到目标守卫。

不带 DSH 客户端直连守卫只对**自己实现签名的客户端**（原生 App、另一套 DSH）可行，
协议见 `/remote-auth/*` 与 `/remote/rpc` 的签名头约定。


### 口令策略

默认**仅允许强密码**：≥12 位，且包含小写、大写、数字、符号，并且不含用户名。
弱口令无法保存——服务端拒绝并返回具体未满足项，设置页逐条打 ✓/✗ 提示。
可在设置页切换为「基础口令」（仅要求 ≥8 位），切换立即生效（已有口令不受影响）。

> 初始口令只用于引导窗口；它不写入日志、不打印到 stdout，改密成功即删除文件。
> 如果账号已存在，启动时不会重建该文件，并会清理遗留的同一文件。

> **已知限制（重要）**：账号认证开启时，旧的「邀请码 → 长期设备令牌」兑换会被守卫
> 明确拒绝（错误码 `auth-account-required`）。原因是该流程签发的是静态 bearer，
> 而开启账号认证后守卫只接受「租约 + 客户端签名」。跨机接管（在控制端输入目标账号 +
> TOTP 后建立信任）需要把认证面挂到守卫上并让 carrier 使用签名，这部分尚未完成；
> 在那之前，跨机接管需要把 `accountAuth.enabled` 设为 `false`（回到设备令牌模型）。

### 边界（诚实说明）

- 私钥不可导出，但**能控制已信任浏览器的恶意脚本仍可代替你签名**——这是任何
  「登录态」都有的残余风险，靠撤销 + 审计收敛，不宣称消除。
- 清空浏览器站点数据 / 无 IndexedDB 的隐私模式 → 私钥丢失，需要重新「信任本浏览器」。
- 账号数据落在 `~/.dsh/remote-hub/auth.json`（0600，原子写）：口令是 scrypt 派生值，
  会话与租约只存 sha256；**TOTP 密钥必须明文存在**才能算码，因此依赖文件权限保护。
- 多账号共用同一份会话/工作区数据仍未支持：DSH 是单租户。
- 认证原语（scrypt 口令派生、RFC 6238 TOTP）的思路参考了 MIT 许可的
  [`@xgone/dsh-remote`](https://github.com/xgone/dsh-remote)，本仓库为**独立重写**：
  未沿用其无状态 HMAC 会话（缺少按客户端撤销），也未沿用「明文历史口令可比」的分支。

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

主包为 `@xiaopb/dsh-remote-hub@0.5.5`（云端路径 UI 已内置，无需其它包）。要求 **Node.js ≥ 24.9.0**（认证存储用内置 `node:sqlite`；22.5+ 亦可运行，但在 22.x 上属实验特性，仅供自测）、**DSH ≥ 0.2.2-rc.1 < 0.3.0**（已发布：0.2.2-rc.1 / rc.2 / rc.3）。

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

### 运行时改端口 / 网络模式

页面「云端设备 → 本机配置」里可以直接改 **监听端口** 与 **网络模式**：

- 保存会立即写入 `~/.dsh/remote-hub/overrides.json`（优先于 profile 配置），
  但**不会热切换**：守卫的监听在装配时建立，换端口意味着销毁监听并丢弃全部在途连接，
  还会连带隧道与已发出的邀请链接。所以页面会显示「有修改待重启生效」，
  **重启 `dsh web` 后**才绑定新端口。
- 端口被占用时启动仍会自动顺延 +1，实际端口写在诊断区（`guard-port-shifted` 审计）。
- 想彻底回到 profile 配置（清掉覆盖值），删除 `overrides.json` 里对应键或整份文件即可。

完整配置项、隧道 provider 选型、巡检与故障排查见 [部署与运维](docs/DEPLOY.md)。

---

## 连接（操作者视角）

本版本已移除「邀请码 / 二维码 / 短码 / 深链」配对，唯一入口是**账号登录**：

1. 在**主控端**页面打开「云端设备 → 连接其他设备」；
2. 填对端守卫地址（形如 `http://192.168.1.10:8443`），再填**对端**的用户名 / 口令，
   对端要求两步验证时一并填 6 位动态码，选申请的角色；
3. 登录成功后本机公钥被登记为对端的一个可信客户端，页面切到「已连接」，整机开始读取对端数据；
4. 之后重连走已保存的目标（私钥签名，不再要 2FA）；撤销在
   对端的「设置 → 登录与账号 → 可信客户端」里做。

被控端（对端）侧：`/remote/pair` / `/remote/pair/ticket` / `/remote/pair/code` 现在一律 404，
守卫只保留 `health` / `rpc` / `ws` / 账号认证面与设备管理面。

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

### 浏览器直连的边界

- **系统原生目录选择器（`directoryPicker/pick`）永远不开放**：浏览器不能让服务器弹出
  系统文件对话框。浏览器里用的是「浏览远程目录」，走的是另一条白名单端点。
- **未绑定两步验证的账号无法从浏览器登录**（`auth-totp-required`）。TOTP 只能在
  首次登录向导里绑定，所以第一次配置必须走本地 Web。
- **无图形界面的服务器**不能完成需要 OS 对话框的首次配置操作 —— 服务器上根本没有可弹的窗口。
- **不要把守卫直接暴露到公网**。`network: lan` 只接受私有地址；公网场景请走
  VPN，或反向代理 + 额外一层访问控制。
- **务必用 https**。口令与动态码是明文 POST，反代终结 TLS 后 Cookie 才会带 `Secure`。

---

## 相关文档

| 文档 | 内容 |
| --- | --- |
| [README.en.md](README.en.md) | English version |
| [docs/BROWSER-GATEWAY.md](docs/BROWSER-GATEWAY.md) | **浏览器直连**：支持/不支持、安全模型、无界面服务器首次配置、反向代理 |
| [docs/DEPLOY.md](docs/DEPLOY.md) | 部署、配置项、隧道选型、巡检、故障排查 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 数据通路、身份、授权、持久化 |
| [docs/DESIGN.md](docs/DESIGN.md) | 角色语义、状态归属、支持边界 |
| [docs/API-MATRIX.md](docs/API-MATRIX.md) | **全部接口 × 角色权限分布表**（自动生成） |
| [docs/RELEASE.md](docs/RELEASE.md) | CI/CD 发布流程与管控 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录 |

内部计划、历史设计、审计与环境特定的验收记录保存在被忽略的 `dev/docs/` 下，不进入发布包。

## 致谢

本项目的远端接管思路与认证原语，来自一个更早的开源实现：

- **[@xgone/dsh-remote](https://github.com/xgone/dsh-remote)** —— 感谢
  [@xgone](https://github.com/xgone) 及其贡献者。

账号认证这一块（scrypt 口令派生、RFC 6238 TOTP、备用码、浏览器登录页与
账号 UI）的做法源自该项目的启发。本仓库是**独立重写**：保留了它的思路与
MIT 许可的归属，但没有沿用其中几处我们认为不适合本场景的语义 ——

| 方面 | `@xgone/dsh-remote` | 本仓库 |
|---|---|---|
| 会话 | 无状态 HMAC，无法按客户端撤销 | 有状态、可撤销，租约 7 天轮换 |
| MFA nonce | 只存在进程内存（重启即失效） | 持久化，且原子防重放 |
| 历史口令 | 明文值可比对 | 拒绝，只认 scrypt 派生值 |
| 认证时机 | 建立信任时用账号 + 2FA | 同左；但浏览器直连**每次**都要重新认证 |

如果这些差异对你的场景不重要，也值得直接看看上游项目。

---

## 许可证

[MIT](LICENSE) © 2026 XiaoPb

