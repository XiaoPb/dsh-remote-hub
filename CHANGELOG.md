# 更新日志

本文件记录 `@xiaopb/dsh-remote-hub` 与伴生包 `@xiaopb/dsh-remote-paths` 的公开变更。
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)；`0.x` 期间的次版本号可能包含不兼容变更。

## [0.5.5] - 2026-11-20

**修复：CI 上两个测试假失败（产品代码无误）。**

`auth-client.test.mjs` 与 `subaccounts.test.mjs` 从 0.5.2 起在 GitHub Actions 上
持续失败，而**同一提交本地通过**。失败信息是断言页面上找不到「本机账号」「账号 admin」，
但 CI 打印出的实际 HTML 是一段被截断的样式表——产品代码并没有问题。

### 根因

这两个测试用 `renderToStaticMarkup` 把整棵 React 树序列化成字符串再做正则匹配，
而 `ThemeStyle` 注入的 `RH_CSS` 有约 4 万字符，与页面内容混在同一个字符串里。
于是：

- 序列化在 CI 环境下于样式表中途截断，内容部分直接丢失，断言必然失败；
- 即便不截断，`/本机账号/u` 这类正则也可能命中 CSS 注释里的同名字样，
  通过与否都不能说明结构正确。

### 修复

结构性断言改为**直接遍历 React 元素树**，不再经过字符串序列化：

```js
findByTestId(tree, 'local-account')   // 结构
collectText(tree)                      // 可见文案（已跳过样式表字符串）
```

只保留真正需要检查 HTML 形态的地方（如 `<svg>` 二维码）继续用 `renderToStaticMarkup`。

### 验证

用 CI 同款 runner（`scripts/run-all-tests.mjs`）本地跑：

- 修复前：`FAILED: carrier-sync.test.mjs`（另一处），74 文件
- 修复后：**74/74 files passed**

配套 CI 关卡同样通过：`version-gate`（node-engine / manifest-version / upper-bound）、
`contract-check`、`verify-package`（40/40）。

## [0.5.4] - 2026-11-20

**登录页背景加上 DSH 图标水印，替代纯色单调背景。**

登录页此前是纯色背景（浅 `#f6f7f9` / 深 `#14161a`），观感单调。现在用**等比放大的
DSH 图标**作极淡背景水印。

### 实现要点

**用 `mask` + `currentColor`，而不是 `<img>`**

`favicon.svg` 是 `fill="#000"` 的**单色**图标。直接铺在深色背景上等于黑上加黑，
完全看不见。改用 `body::before` + CSS `mask`，前景色取 `currentColor`，
自动跟随主题：

- 浅色：前景 `#1b1d22`（深图标 on 浅底）
- 深色：前景 `#e8eaee`（浅图标 on 深底）

**不干扰表单可读性**

| 措施 | 原因 |
|---|---|
| `z-index: -1` + `body{isolation:isolate}` | 永远在卡片之下；`isolation` 必不可少，否则负 z-index 会穿到 `html` 背景之后完全不可见 |
| 不透明度分档：浅 `.16` / 深 `.20` | 实测对比度 1.45:1 / 1.74:1——看得出但不抢注意力；深色下前景与背景亮度差更小，故加一档补偿 |
| `pointer-events: none` | 纯装饰，不拦截点击 |
| `overflow: hidden` + `min(96vmin, 900px)` | 窄屏不撑出横向滚动条 |
| `forced-colors` 下 `display: none` | 高对比度模式下水印无价值，且可能与用户配色冲突 |

水印尺寸 `96vmin`（上限 900px），在 1256×908 视口下实测 871.67px。

### 验证

用「开启 vs 关闭水印」的截图字节差确认真的被绘制（纯计算样式不足以证明）：

- 浅色：39041 → 21870 bytes，差 17171
- 深色：40696 → 21917 bytes，差 18779

两种模式都确认水印已渲染，且前景色按主题正确反转。

## [0.5.3] - 2026-11-20

**修复：远程访问登录页没有网页图标。**

用 `https://<域名>/remote-web/login` 打开登录页时，浏览器标签页显示空白默认图标，
而登录后的主界面正常显示 DSH 图标——同一站点两种观感。

**根因**：`renderLoginPage`（`host/src/auth/web-session.ts`）拼出的 `<head>` 只有
`<title>` 和内联 `<style>`，**没有任何 `<link rel="icon">` 声明**。守卫其实早已支持
反代图标（`isProxyableAssetPath` 白名单里的 `/favicon*.svg`），只是登录页从未引用过。

**修复**：登录页补三条声明，指向守卫已有的官方图标资源：

```html
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="icon" type="image/svg+xml" href="/favicon-dark.svg" media="(prefers-color-scheme: dark)">
<link rel="apple-touch-icon" href="/favicon.svg">
```

与主界面用的是**同一份** `favicon.svg` / `favicon-dark.svg`，不会出现图标风格漂移；
深色模式图标走 `media` 查询，与官方声明方式一致。

**实测**（未登录状态，匿名 read-only peer）：

- `GET /remote-web/login` 的 head 含三条 icon 声明
- `GET /favicon.svg` → 200，`image/svg+xml`，3634 字节
- `GET /favicon-dark.svg` → 200，`image/svg+xml`，3634 字节
- 浏览器内 `new Image()` 两个图标均成功解码为 50×50

**测试**：`test/web-session.test.mjs` 里「不得引用外部样式表」的断言原本是
`/<link[^>]+href=/`，会把图标 `<link>` 一并判为违规。已收紧为只禁
`rel="stylesheet"`，并新增两条正面断言锁住 favicon 声明。

> 注：官方还有 `apple-touch-icon.png`，但守卫白名单只放行 `.svg`，
> 故 iOS 也用同一份 SVG（现代 iOS 可处理），不做会 404 的无效引用。

## [0.5.2] - 2026-11-18

**新增「信任的公网地址」配置；设置页更名为「身份与访问」。**

### 新增：信任的公网地址（`publicAuthorities`）

经 Cloudflare Tunnel 或任何域名访问时，浏览器发来的 `Host` 是域名，而守卫的来源围栏
只放行「回环字面量 ∪ `publicAuthorities`」。不声明就**所有接口 403**，页面显示
「authentication request failed (403) / 身份验证请求失败」。

此前只能改 `cordis.patch.yml` 再重启。现在可在「身份与访问」页直接查看和修改：

- 列出已声明的地址，每项标注 **配置中**（已生效）或 **待重启**（已保存但未生效）
- 输入框添加 / 按钮移除，行内校验即时反馈
- 保存后明确提示「需要重启 DSH 后生效」——这是冷字段，不假装已生效

**冷字段**：与 `guardPort` / `network` 同属 `CONFIG_COLD_WRITABLE_KEYS`。守卫的来源围栏
在装配时构建，热切等于重建监听，风险高于收益。

**写入校验**（服务端 `coercePublicAuthorities`，复用 `canonicalAuthority`，不另写正则）：

- 必须是裸 authority（`host` 或 `host:port`），拒绝 scheme / 路径 / userinfo / 百分号编码
- 拒绝通配符（`*`、`*.example.com`）
- 拒绝回环与私网地址（本就无条件放行，写进来只会误导）

**数据来源**：页面写入的运行时覆盖值优先于 `cordis.patch.yml`（方案 A：页面写入即权威）。

### 变更：设置页更名为「身份与访问」

原标题「登录与账号」只覆盖了「登录」这一个动作，管不了客户端信任与访问来源。
该页实际管理的是三类问题：

| 类别 | 区块 |
|---|---|
| 谁能进来 | 本机账号、子账号、对端账号 |
| 怎么证明是本人 | 口令管理、两步验证 |
| 从哪能进来 | 信任本浏览器、可信客户端、**信任的公网地址** |

英文对应 `Identity & access`。副标题改为「账号、验证方式与访问来源」。

### 修复

- **`restartPending` 永远为真**：旧实现用 `!==` 比较数组，引用不同就判为有改动，
  导致 `publicAuthorities` 永久显示「待重启」。改为 `sameColdValue` 内容比较。
- **`localhost` 未被识别为回环**：`isLoopbackLiteral` 只认 IP 字面量，
  主机名需单独判断，否则白名单会接受一个冗余且误导的 `localhost` 项。

## [0.5.1] - 2026-11-17

**UI 优化：深色主题可读性、登录步骤条、云端设备页信息架构。**

### 修复：深色外观下文字几乎不可读（严重）

深色主题下整页文字呈**黑色**、主按钮**白底白字**、绿色状态标签与步骤条看不清。两个叠加的根因：

1. **文字 token 接错了名字**。DSH 的文字色由 `--dsw-alias-label-primary /
   secondary / tertiary` 承载（见 `packages/client/ui-theme/src/styles/design-platform.css`），
   插件此前读的是 `--dsw-alias-text-primary` —— 宿主**根本没有这个 token**，
   于是永远回落到写死的近黑色 `#111418`。现在改为优先使用上位 label token，
   缺失时才用插件自己的安全兜底值。
2. **主题判定与宿主脱钩**。DSH 的主题是应用内设置，通过
   `html[data-ds-theme-source]` / `body[data-ds-dark-theme]` 标记，
   **不跟随** `prefers-color-scheme`。插件原来只看媒体查询，导致「系统浅色 + DSH 深色」时
   渲染成浅底白字。现在按「组件 `[data-theme]` → DSH 标记 → 系统偏好」的优先级判定。

另外不再继承 `--dsw-alias-brand-primary` 作按钮底色（它在深色下是近白色，语义是品牌反白），
语义色自持一套并单独提供 AA 达标的 `--rh-*-text` 文字色；`--rh-blue` 由 `#3B82F6` 调深到
`#2563EB`（白字对比 3.68:1 → 5.17:1）。

**实测**：浅色 73/73、深色 73/73 个文字叶子全部 ≥ 4.5:1，最差 4.95:1。

### 修复：登录步骤条与实际流程不符

旧实现固定画 4 步（账号口令 → 修改口令 → 绑定两步验证 → 账号设置），
其中两步对新设备登录永远不会发生；登录完成后整条步骤条仍然挂着。

现在按实际路径生成：

- 首次登录（需改初始口令 + 绑 2FA）：4 步
- 新设备登录：3 步（账号口令 → 两步验证 → 账号设置），验证码页高亮第二项
- 登录完成：**不显示**

顺带修掉向导模式下 `login` 阶段被错标成第 4 步的问题。

### 变更：云端设备页信息架构

- **「谁连进了本机」移出运行页**：可信客户端属于身份管理，统一在设置页「身份与访问」；
  运行页的被控端卡片只保留本机接入信息，并给出设置页入口指引。
- **连接表单合并到一张卡的开头**：目标地址 / 用户名 / 口令 / 动态码 / 申请角色
  按一条纵向流程排列。此前地址在上半段、账号口令在下半段、中间还夹着「已保存的目标」，
  填一次连接要滚两屏。
- **已配对设备列表下移**：只列本机主动连出去的目标，当前连接的那台置顶标「已连接」，
  其余可一键重连或删除配对。
- 修复：云端模式刚连上时目标地址不显示（目标尚未写入列表时回退到 `mode.origin`）。
- 修复：已连接但列表为空时错误显示「0 台 + 空态」，让人以为没连上。

### 其它

- 语义色不再直接当文字色用（绿 `#22c55e` 白底仅 2.28:1），新增 `--rh-*-text` 一组。
- 输入框补齐可访问名称（`id` 与 `Field.htmlFor` 配对），axe `label` critical 清零。
- Segmented 键盘操作后不再丢焦点（根因是瞬时 `disabled`），方向键 / Home / End 全程可用。
- 页头不再是重复的 banner 地标；`sr-only` 改名 `rh-sr-only` 以符合自家命名规范。
- 480–899px 下双列下拉框改为纵向堆叠，不再被压到约 120px。

## [0.5.0] - 2026-11-16

**浏览器直连（方案 A）：不装桌面端也能用完整的 DSH 界面。**

这是本插件第一次让「只有浏览器」的场景成为一等公民。此前 Hub 只服务
**装了桌面端 / 已有客户端私钥**的设备；现在用手机、平板、别人的电脑打开
一个网址，输入账号口令 + 6 位动态码，就能拿到与桌面端一致的界面。

### 新增：守卫托管官方界面

- `GET <guard>/ ` 由守卫直接返回**官方 Web 外壳**（进程内
  `webServer.readResource` + peer 身份，不依赖自启动令牌），浏览器感知不到
  自己不是从 `:3080` 来的。
- `/api/*` 走 **HttpOnly Cookie** 认证后以 `remote-device` 身份派发；
  **认证在读 body 之前**，未登录一个字节都不转发。
- `WS /api/remote.mux` 同样走 Cookie 认证，让客户端的 `permission catalog`、
  插槽装配等依赖 Host generation 的服务正常建立。
- 浏览器侧角色由账号 `role` 决定（`acc_admin` → `full`，其余 `read-only`），
  **不会**以 `owner` 身份派发。

### 修复：不登录时不再给一个死页面

`GET <guard>/` 在未认证时 **302** 到 `/remote-web/login`（服务端判定，
不依赖客户端 JS），并带 `?next=` 便于登录后返回原页面。
登录页只接受同源相对路径，避免 `?next=` 变成开放重定向。

### 修复：登录表单不再退回裸 JSON

登录页生成的内联脚本曾因**模板字符串吃掉反斜杠**（`/^\/(?![\/\\])/`）
整段语法错误，导致 `preventDefault()` 没执行、表单原生 POST、
浏览器把接口 JSON 当页面渲染。改为 `charCodeAt` 判断，并加测试
把生成后的脚本交给 `node --check`。

同时修掉 `/remote-web/login/`（末尾斜杠）落到 404 JSON 的问题。

### 修复：TOTP 二维码扫不出来

自研编码器只能出两个固定版本，`otpauth://` 链接（约 140 字节）永远落在
版本 10（57 模块）；配 120px 显示尺寸就是 **2.1px/模块**，低于扫码器
普遍要求的 4px。改用 `qrcode-generator`（零依赖、随 bundle 内联）后
自动选最小版本（**49 模块**），显示尺寸按 `模块数 × 4 + 8` 自适应
（**204px → 4.16px/模块**），并加 `shape-rendering: crispEdges`
避免重采样出灰边。

### 新增：让 DSH 自身选用「浏览远程目录」

配置 `connection.trustedHosts` 含非回环 authority 后，DSH 的
`directory-picker-auto` 会挂 `browse` 后端 + 浏览客户端，
浏览器的「新建工作区」于是弹出**远程主机的目录树**，而不是拉起浏览器本地
的文件夹对话框。插件不再抢那两个插槽（抢了会盖掉官方实现）。

### 变更

- **目录选择交给官方**：删除插件自注册的 `conversation.hero.workspace.directoryFlow`
  / `sidebar.workspaces.directoryFlow`，仅在需要时提供 `cloudPathContext()`。
- **新增运行时依赖 `qrcode-generator`**（client bundle 内联，运行时无网络）。

### 迁移

- 想在浏览器里用：在 `cordis.patch.yml` 里为 `remote-hub` 行开
  `accountAuth.enabled: true`，并为 `connection` 行加 `trustedHosts`
  （详见 `docs/BROWSER-GATEWAY.md`）。
- 只走桌面端的老用户无需改动，行为保持原样。

## [0.4.0] - 2026-11-15

**账号 + 2FA 认证与可信客户端（第二个 Cordis 插件行 `@xiaopb/dsh-remote-hub/auth`），默认启用。**

守卫的长期 bearer 设备令牌在账号认证模式下被**租约 + 每请求客户端签名**取代：
偷到租约不足以冒用，还得持有该客户端的私钥。账号与 2FA 只在**建立信任**时使用，
之后按客户端公钥证明身份，7 天租约在后台静默轮换。

### 默认行为变更
- **`accountAuth.enabled` 默认 `true`**：Hub 不再接受长期设备令牌。
- **首次启动自动创建默认账号 `admin`**（仅当账号库为空）。初始口令**安装时随机生成**，
  明文写入 `~/.dsh/remote-hub/initial-password`（0600 / 目录 0700）；**改密成功后文件即删除**，
  不再有任何可用初始凭据。可用 `remote-hub-auth` 行的 `defaultAccount` 覆盖用户名/口令。
- **首次登录强制改密**：改密之前 `status` 之外的认证端点一律
  `auth-password-change-required`，因此绑定 2FA、信任客户端与轮换租约全部不可用，
  也就进不了 Hub。改密成功后该标记**永久清除**（只强制一次），之后仍可主动改密。
- **口令策略默认强密码**：≥12 位且包含大小写、数字、符号，且不含用户名；弱口令无法保存
  （服务端拒绝并返回未满足项清单）。设置页可切换为「基础口令」（≥8 位），立即生效。
  引导/改密/设置页共用同一份规则与逐条 ✓ 提示。
- **账号页移入设置**：`settings.section` 注册「登录与账号」（口令、2FA、可信客户端、
  口令策略）；侧栏只保留「云端设备」运行面。

### 新增

- **端口 / 网络模式可在页面修改**：「本机配置」里的 `guardPort` 与 `network` 从只读变为可编辑，
  保存即写入 `~/.dsh/remote-hub/overrides.json`（优先于 profile 配置）。它们属于**冷配置**——
  守卫的监听在装配时建立，换端口必须重建监听并丢弃全部在途连接（还连带隧道与邀请链接），
  因此不做热切换：页面显示「有修改待重启生效」，重启 `dsh web` 后生效。
- **独立认证插件行**：`@xiaopb/dsh-remote-hub/auth`，`provide('remoteHubAuth')`；
  Hub 行按 `accountAuth.enabled` 注入它，服务缺失时守卫保持关闭（fail-closed）。
- **账号与 MFA**：首个管理员仅回环创建；口令走 scrypt（拒绝明文历史值）；TOTP
  （RFC 6238）+ 10 个一次性备用码；登录按用户名限速，MFA 挑战 5 分钟、5 次错误即烧。
- **可信客户端**：每个浏览器/App 一把 ECDSA P-256 密钥（WebCrypto `extractable: false`），
  服务端只存公钥；公钥指纹仅供人眼核对，**不参与认证**。
- **每请求签名**：覆盖方法、路径、目标 authority、时间戳、一次性 nonce、客户端/密钥 id、
  租约代次与正文摘要；服务端原子拒绝重放与换体。
- **7 天租约轮换**：后台自动轮换、旧代次立即失效；重放旧代次视为令牌被盗并**撤销该客户端**。
- **一次性 WS 票据**：浏览器 WS 不能带自定义头，改为先签名换 30 秒、消费一次的票据，
  长期租约**不进入 URL**。
- **角色上限**：每个客户端有服务端 `roleCeiling`，可信会话内切换 `activeRole` 不再要求 2FA。
- **「登录与账号」页**：引导 / 口令 + MFA / 信任本浏览器 / 可信客户端列表（指纹、角色、
  撤销）/ 退出登录。退出只撤销会话，撤销客户端是独立动作。

### 迁移

- `accountAuth.enabled` **默认 true**（见上「默认行为变更」）。需要保留旧设备令牌语义的部署，
  在「登录与账号」页完成账号 + 2FA + 信任本浏览器后，再把 `cordis.patch.yml` 的
  `remote-hub` 行改成 `accountAuth.enabled: true` 并重启 Host。
- 切换后**旧设备令牌立即失效**，且不会被静默升级成受信客户端（必须重新登记公钥）。

## [0.3.6] - 2026-11-14

**本地插件页：在接管云端设备时可直接管理本机插件，功能与官方插件页对齐。**

侧栏新增「本地插件」入口（带绿点角标，与官方「插件」页区分），页面完整复用官方
`ui-plugin-manager` 的布局、图标与设计令牌；所有调用走本机直连通道（**不进 RPC 名册**，
避免云端经由 RPC 触达本机插件管理面）。

### 新增

- **本地插件直连通道**：15 个方法 + 事件流 + 详情图片路由，挂在
  `/api/hub/local-plugin-manager/*`，仅本机 owner 可用。
- **本地插件页**：列表 / 开关 / 安装 / 版本 / 更新 / 卸载 / 详情 / 状态全部等价；
  内置插件配置以只读形式展示当前生效值（配置写入仍在官方页）。
- **DSH 0.2.2-rc.1 与 0.2.2-rc.2 双版本支持**（rc.3 端点与 rc.2 一致，顺带兼容）。

### 修复

- **图标被涂黑**：生成器只保留 `viewBox`、丢掉根节点的 `fill="none"`，16 个描边图标中 13 个
  被 SVG 默认黑色填充涂满。
- **添加插件弹窗过窄**：样式表注入顺序使 `.dialog` 的 380px 覆盖了 `.installDialog` 的 560px。
- **详情图片裂图**：`readBundleImage` 在 0.2.2 未导出，改为走官方 `PluginManager.serveDetailFile()`。
- **README 渲染不如官方页**：改用宿主提供的官方 `MarkdownText`（完整 GFM：表格、代码高亮、
  数学公式），并修复嵌套图片语法 `[![alt](img)](href)` 被当作文本泄漏的问题。
- **内置卡片缺少说明**：从各插件词典取回副标题文案。

### 文档

- **新增 [docs/USAGE.md](docs/USAGE.md)**：面向首次使用者的安装 / 使用指南，覆盖
  本机自用、**局域网内使用**（`network: 'lan'` + 私有地址绑定 + Origin 围栏要点）与
  **隧道远程接入**（`publicAuthorities` / cloudflared / 完整往返流程 / 自检清单）三档，
  并给出三档配置对照与常见问题。
- **新增 [docs/TUNNEL.md](docs/TUNNEL.md)**：按平台给出完整的隧道部署教程
  （Windows / Linux / macOS），覆盖 Cloudflare 命名隧道的安装、登录、`config.yml`、
  `ingress validate` 校验、DNS 路由、后台常驻与验证；含 Windows 服务方式的凭证目录
  （`systemprofile`）这一高频坑、自有服务器 SSH 反向隧道 + nginx 反代、
  Quick Tunnel 与 Tailscale 方案，以及排错对照表与上线自检清单。
  文中 Cloudflare 步骤已对照官方文档核对。
- **修正权限描述过时**：README（中英）第 5 节把 `dynamicCordisRunner/*` 写作「对任何角色都不开放」，
  与实现不符——0.3.2 起它已是 **`full` 专属**（12 个端点）。同时 `pluginInventory/*`
  早已对三档角色开放，也一并从「红线不可下放」中移出。`docs/DESIGN.md` 与
  `docs/API-MATRIX.md` 的角色语义同步更新。
- **`docs/DEPLOY.md` 版本号漂移修正**：长期停在 0.3.4。现已纳入 `release-check` 的
  `doc-version` 校验（此前只校验 README 与 DESIGN），再漂移会在 CI 变红。

### 兼容性

- **端点差异按版本隔离**：0.2.2-rc.1 与 rc.2 之间有 18 个端点不同（含
  `officeToPdf/*` → `officeKit/*`、`subagents/interruptByParent` → `interruptByUser` 等更名）。
  建立 `core/src/version-drift.ts` 登记「版本差异」，不进静态矩阵也不判为漏登记；
  `audit-permissions` 支持 `DSH_REGISTRY_FILE` 对不同版本逐一校验。
- `dynamicCordisRunner` 端点清单对齐 0.2.2 实际产物（移除已不存在的 7 个旧端点）。
- 兼容范围：`>=0.2.2-rc.1 <0.3.0`；**0.3.0 尚未发布**，不声明。

## [0.3.5] - 2026-11-14

**权限补齐：完全接管 `dynamicCordisRunner` 端点权限管理（19 个方法全部 Full 权限）。**

### 修复

- **补齐所有 `dynamicCordisRunner/*` 权限**：所有 19 个方法（包括内部运行时方法）均授权给 Full 角色，
  通过 `FULL_ADMIN_ENDPOINTS` 声明。解决 `remote-access/denied: dynamicCordisRunner/inventory` 错误。
- **权限矩阵完整性**：将所有方法从红线移出，在 `ENDPOINT_TABLE` 中显式声明为 global 资源。
- **生产部署**：已在 Debian（debian.xiaopb.cn）和本地沙箱完整部署并验证。

### 被控 Host 权限端点覆盖（全部 Full 权限）

| 方法 | 说明 |
| --- | --- |
| `dynamicCordisRunner/define` | 定义新动态包 |
| `dynamicCordisRunner/run` | 运行动态包 |
| `dynamicCordisRunner/stop` | 停止运行 |
| `dynamicCordisRunner/undefine` | 取消定义 |
| `dynamicCordisRunner/list` | 列出已定义的动态包 |
| `dynamicCordisRunner/syncInspectManifest` | 同步检查清单 |
| `dynamicCordisRunner/getDefinition` | 查询定义详情 |
| `dynamicCordisRunner/queryRunning` | 查询运行状态 |
| `dynamicCordisRunner/getClientCode` | 获取客户端代码 |
| `dynamicCordisRunner/inventory` | 库存查询 |
| `dynamicCordisRunner/invoke` | 调用方法 |
| `dynamicCordisRunner/reportClientGuardFailure` | 上报客户端守卫失败 |
| `dynamicCordisRunner/reportRenderFailure` | 上报渲染失败 |
| `dynamicCordisRunner/resolveInspectQuery` | 解析检查查询 |
| `dynamicCordisRunner/resolveRequestRun` | 解析运行请求 |
| `dynamicCordisRunner/runHostHalf` | 运行 Host 半部分 |
| `dynamicCordisRunner/settleUserRun` | 结算用户运行 |
| `dynamicCordisRunner/stopFromPanel` | 从面板停止 |
| `dynamicCordisRunner/undefineFromPanel` | 从面板取消定义 |

### 检查清单

- ✓ `core/capabilities.ts`：`ENDPOINT_TABLE` 包含 19 个 `dynamicCordisRunner/*` 端点
- ✓ `core/capabilities-redlines.ts`：`FULL_ADMIN_ENDPOINTS` 包含所有 19 个方法
- ✓ `scripts/audit-permissions.mjs`：所有方法在 `INTENTIONAL_GAPS` 中有文档说明
- ✓ `docs/API-MATRIX.md`：自动重新生成，权限矩阵已更新
- ✓ Debian 部署：0.3.5 已部署，DSH 进程正常运行，无启动错误
- ✓ 本地沙箱：0.3.5 已部署到 default profile

### 部署验证

- Debian (debian.xiaopb.cn)：✓ 进程运行中 (PID 1124780)，配置已加载，无日志错误
- 本地沙箱 (Windows)：✓ default profile 已更新到 0.3.5



## [0.3.4] - 2026-11-14

**修复局域网配对 403 错误：私有地址 Origin 现在自动放行。**

### 问题

局域网模式（`network: 'lan'`）下，主控端浏览器（如 `http://127.0.0.1:13091`）向被控端守卫
（如 `http://192.168.0.17:8443`）发起跨域配对请求时，`Origin` 头是私有地址但与 `Host` 不同源，
被 fence 的第三段（Origin 检查）拦截为 403 "Origin does not match Host authority"。

之前需要在被控端手动配置 `allowedOrigins` 白名单才能通过，但这要求用户预先知道所有可能的端口。

### 修复

- **`allowPrivateOrigin`**：`checkSource()` 新增选项，当值为 `true` 且 Origin 是私有地址
  （RFC 1918 / 链路本地 / ULA）时，即使与 Host 不同源也放行。
- **自动启用**：`network === 'lan'` 时，`guard.ts` 自动传入 `allowPrivateOrigin: true`，
  无需手动配置。
- 公网 Origin 仍然拒绝（`isPrivateHostname()` 对公网地址返回 `false`）。
- **移除 `allowedOrigins` workaround**：之前的手动白名单配置不再需要。

### 测试

- `test/fence.test.mjs` 新增专项测试，覆盖 `127.0.0.1`、`localhost`、`10.x`、`172.16-31.x`、
  `192.168.x` 等私有地址 Origin。
- 端到端验证：testhub（`127.0.0.1:13091`）成功配对到 Debian（`192.168.0.17:8443`），
  无需 `allowedOrigins` 配置。

## [0.3.2] - 2026-11-13

**权限全面复核：补上 19 个漏登记的官方 endpoint，并把「漏登记」变成 CI 断言。**

### 修复

- `llm/discoverModels` 补进能力矩阵（三档共享只读）。它是官方**只读**远端适配器，
  按 `settingsNs` 让目标主机去问 Provider 有哪些模型；此前不在矩阵也不在 endpoint 表，
  远端「发现模型」被 `decide()` 以 `no-allow` 拒绝，界面弹出「远端权限不足」。
- 按官方注册表复核后补齐另外 18 个此前**未登记**的 endpoint：

  | 角色 | 补齐的 endpoint |
  | --- | --- |
  | 三档只读 | `agentPresets/read`、`commands/execute`、`schedule/view`、`schedule/deliveryLimits`、`session/canOpenWorkspacePath`、`skills/list`(global)、`messageFeedback/list` |
  | control 起 | `agentPresets/select`、`schedule/{create,edit,run}`、`messageFeedback/put`、`subagents/{prompt,interruptByParent}` |
  | full 起 | `schedule/deleteInactive`、`messageFeedback/delete` |

### 新增门禁

- `scripts/audit-permissions.mjs`：把**官方 Typert 注册表里的全部 150 个 endpoint**
  与能力矩阵逐条对账。每个 endpoint 必须显式归入「已授权 / 红线 / 未实现（写明理由）」
  之一，否则 CI 失败。脚本同时检测「矩阵里登记了官方不存在的 endpoint」。
  已接入 `ci.yml` 与 `release.yml`，本地可用 `npm run audit:permissions`。
- 当前状态：已授权 120、红线 25、未实现 5（`officeToPdf/*`、`sessionFeedback/record`
  等，均写明理由）、未登记遗漏 **0**。

### 说明

- 未实现的 5 类在 `scripts/audit-permissions.mjs` 的 `INTENTIONAL_GAPS` 里逐条写明原因，
  不是「忘记」，而是「尚未评审」——放开前需要单独设计。
- `docs/API-MATRIX.md` 随矩阵重新生成。
## [0.3.1] - 2026-11-13

**插件权限：`full` 完全放开、不再审批；其他角色也能完整读取插件。**

### 变更（不兼容 / 安全边界调整）

- **取消 owner 逐次审批**：`APPROVAL_REQUIRED_ENDPOINTS` 清空。
  以下 13 个接口现在只要配对角色是 `full` 就**直接生效**，不再弹批准卡，也不再有超时拒绝：
  - 插件：`pluginManager/{installBundle,updateBundle,removeBundle,cancelInstall,setBundleEnabled,setPluginEnabled,setVersionExemption}`、`pluginMarket/setIndexes`
  - 配置与凭据：`settings/{update,replace,mutate}`、`credentials/{set,unset}`

  > **安全代价（务必知晓）**：`full` 配对 = 远程代码执行 + 可写宿主配置与 API Key。
  > 只给可信设备发放 `full`；不确定时用 `control`。
- **插件清单改为三档共享只读**：`pluginInventory/list` 从红线移入 `SHARED_READ_ENDPOINTS`，
  `read-only` / `control` / `full` 都能读取已装插件清单；`pluginInventory/` 改为「前缀红线 + 具名豁免」，
  未登记方法仍默认拒绝。

### 保持不变

- **密钥掩码与审计照旧**：写入类 endpoint 的载荷在落审计/诊断前仍经过 `core/src/redact.ts`，
  明文 API Key 不会出现在日志里。审批机制代码保留在 `host/src/sensitive-approval.ts`，
  需要恢复时往 `APPROVAL_REQUIRED_ENDPOINTS` 加回条目即可。
- `account/*`（官方登录态）、`dynamicCordisRunner/*`、`directoryPicker/pick`、
  `settings/openSettingsDocument`、`remoteAccess/follow` 仍是红线。
## [0.3.0] - 2026-11-13

**云端路径 UI 内置进本插件；`full` 开放云端目录浏览与新建目录。**

### 变更（不兼容）

- **`@xiaopb/dsh-remote-paths` 不再作为独立包发布**。云端目录浏览 / 新建目录 / 「云端文件」菜单
  已内置到 `@xiaopb/dsh-remote-hub`，只需安装这一个包。
  - 源码移到 `client/src/paths/`，随主 `lib/client.js` 一起编译；
  - 由 `client/src/index.ts → applyCloudPaths()` 在主插件装配时注册，等
    `slots` / `commandUi` / `sessions` / `conversation` 就绪后生效；
  - 仓库不再有 `companions/` workspace，`pnpm-workspace.yaml` 只保留根包。
- **为什么不能做成同一包的第二条 roster**：DSH 的 `dsh.client` 声明按**包**生效
  （`resolveMeta` 只认包名根 specifier，且固定读 `exports["./client"]`），
  子路径 roster 的 specifier 会被 `exactPackageSpecifier()` 判为 undefined，
  客户端 bundle 根本不会被加载。因此只能并入主 bundle，按载体激活与否在运行期决定是否注册。

### 新增

- `directoryPicker/list`、`directoryPicker/createDirectory` 开放给 `full`（云端路径 UI 使用），
  `workspaceFiles/list` 三档共享不变。
- `directoryPicker/` 改为**前缀红线 + 具名豁免**：宿主原生弹框 `directoryPicker/pick`
  与任何未登记的 picker 方法仍然默认拒绝。

### 保持不变

- 本机模式下云端路径 UI **不注册任何槽位**，原生目录选择与 dsh-hardssh 流程不受影响。
- `account/*`（官方登录态）仍是红线。

## [0.2.6] - 2026-11-13

**Full 可以写配置、配置 Provider API Key、安装插件；官方登录态仍不可控。**

### 新增

- **Provider / API Key / 模型配置（远端）**：`full` 现在可以
  - `credentials/describe`（三档共享只读，只返回「是否已设置/来源/是否可写」，**从不返回密钥值**）
  - `credentials/set` / `credentials/unset`（仅 `full`）
  - `settings/update` / `settings/replace` / `settings/mutate`（仅 `full`）
  远端设置页因此能渲染 API Key 行、保存 Key、选择 Provider 与模型。
- **插件管理（远端）**：`full` 可以安装 / 升级 / 卸载 / 启停插件与 bundle，
  以及配置市场源（`pluginMarket/setIndexes`）；插件/市场的只读目录三档共享。
- **逐次 owner 审批（D-16）**：上面每一项写入，每次调用都会向本机 owner 投递审批卡，
  未获批准就是 `remote-access/denied`。
  - **超时无人应答 = 拒绝**（fail-closed），绝不静默放行；
  - 同一设备 + 同一载荷 60 秒内复用批准，避免一次保存触发多轮审批；**拒绝从不缓存**；
  - 审批与工具审批复用同一条 `hub/answerApproval` 回复通道与可见性约束。
- **密钥掩码**：`core/src/redact.ts` 统一脱敏，审批卡 / 审计 / 诊断里密钥显示为
  `sk-****abcd`；同时识别「字段名像密钥」与「值像凭据」两种情况，避免漏掩码。

### 变更（不兼容）

- `settings/{update,replace,mutate}`、`credentials/{set,unset}` 以及 `pluginManager/*`、
  `pluginMarket/setIndexes` 的写方法**不再属于红线**，改为 `full` 专属 + 逐次审批。
  安全模型从「不做」变为「能做，但每次都要 owner 点头」。
- 前缀红线新增 `credentials/`、`settings/`：**未登记的方法**（如 `credentials/rotate`）
  仍然默认拒绝；`settings/openSettingsDocument` 保持红线。
- `SHARED_READ_ENDPOINTS` 新增 `credentials/describe`、`pluginManager/listVersions`、
  `pluginManager/readBundleDetail`、`pluginMarket/readEntryDetail`。

### 保持不变

- `account/*`（官方登录态与余额）**仍不可控**，按需求保持红线。
- `directoryPicker/*`、`pluginInventory/*`、`dynamicCordisRunner/*`、`remoteAccess/follow`、`$events` 仍是红线。

### 修复

- 审批超时用的定时器曾 `unref()`，等待期间若事件循环无其他句柄会导致超时永不触发、
  请求静默挂死；已去掉 `unref()`。

### 工程与发布

- 新增 `test/sensitive-approval.test.mjs`（17 项，含「审批卡/审计不含明文密钥」「超时不放行」
  「拒绝不缓存」「别的设备不能代答」回归）；`test/full-administration.test.mjs` 覆盖新权限矩阵。
- `docs/API-MATRIX.md` 新增「需要 owner 逐次审批的接口」一节，CI 断言与代码一致。

## [0.2.5] - 2026-11-13

首个公开版本，同时作为 CI/CD 发布流水线的基线版本。

### 新增

- 双角色包结构：同一包两个 Cordis 入口，host 半边（配对、设备令牌、角色策略、回环守卫、隧道监督）与 client 半边（接管官方 `__DSH_TRANSPORT__`）。
- 扫码 / 8 位 Crockford 短码配对，TTL 均为 15 秒，单次使用，失败预算 5 次后烧码。
- `read-only` / `control` / `full` 三级角色，由 DSH Gateway 的 endpoint 与资源绑定强制；未知 endpoint 默认拒绝。
- 红线清单（凭据、设置写入、目录选择、插件管理、账号、`remoteAccess/follow`、`$events`）对全部角色不外放，CI 断言复核。
- 出站令牌由控制端本地 Host 持久化；浏览器载体只持有不透明 target ID。
- 断开保留配对记录，支持一键重连。
- 可选伴生包 `@xiaopb/dsh-remote-paths`：远端目录浏览与聊天 `+` 菜单云文件动作。
- `dsh-remote-hub-pair` CLI：无界面主机的配对出码入口。

### 工程与发布

- GitHub Actions CI：typecheck、构建、50 个测试文件、兼容矩阵、契约对账、来源围栏、红线断言。
- 发布流水线 `release.yml`：打 `v*` tag 触发，tag 与 `package.json` 版本强校验，npm 可信发布优先、`NPM_TOKEN` 兜底并轮询确认版本公开，产出 tarball + SHA-256 与 GitHub Release。
- 中英双语文档：`README.md` / `README.en.md`、部署、架构、设计契约、发布流程。

### 已知限制

- Android 延期。
- Desktop 四种组合未在隔离实例上验证。
- 凭据写入、账号登录与真实模型请求未纳入默认验收。
