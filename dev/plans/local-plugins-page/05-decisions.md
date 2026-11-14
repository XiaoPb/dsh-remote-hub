# 05 · 决策记录（ADR）

> 每条决策 = `背景 / 选项 / 结论 / 依赖代价 / 失效条件`。结论变更时**追加**新条目，不要改写历史。

---

## ADR-001 · detail-file 转发用「薄转发」而不是自实现读取器

- **状态**：已推荐（待用户确认后落地）
- **背景**：官方页详情文档里的图片是相对 URL `api/plugin-manager/detail-file?...`；接管后该相对路径会解析到**云端** Host。
  本地页必须有一条**本机**的同名路由。
- **实测**：
  - `packages/boot/plugin-manager/src/bundle-detail.ts` 导出 `readBundleImage(bundle, document, destination, preferred, options)`
    —— 纯数据签名，内部已实现 `resolveBundleDir`、`localFiles/npmFiles`、路径穿越防护、大小上限、CDN 回退；
  - 官方路由处理器 `serveDetailFile()` 是 `private`，不能直接调；
  - 响应层 `detailImageResponse(outcome, cacheControl)` 在 `@deepseek-ai/dsh-plugin-detail/src/response.ts`，纯函数返回 `Response`。
- **选项**：
  - A. 薄转发：`listBundles()` 找 bundle → `readBundleImage()` → `detailImageResponse()`（~40 行）
  - B. vendored 同构读取器（~250 行，需与内核同步）
- **结论**：**A**。
- **依赖代价**：0 新增依赖（两个包都已在 Host 进程；本插件 Host 侧对 `@deepseek-ai/*` 全 external）。
- **失效条件**：目标 DSH 版本不再导出 `readBundleImage` ⇒ 转 B。
- **验证**：`test/local-plugin-detail-file.test.mjs`（owner 200 / 穿越拒绝 / 未知 bundle 404 / 超限同构错误 / 响应头逐项比对）。

---

## ADR-002 · 侧栏图标「手写同款 path」，不 import 官方组件

- **状态**：已推荐
- **背景**：需求是「图标使用和插件页一样」+「整体进来依赖不要太复杂」。
- **实测**：
  - 官方侧栏图标 = `PluginsPanelIcon` → `IconPluginPinwheelOutlineRegular`；
  - 图标本体只有 4 条 `<path>`，在 `ui-primitives/src/icons/artwork.ts:99`，viewBox `0 0 16 16`、`stroke=currentColor`；
  - import 官方组件会引入 `@deepseek-ai/dsh-client-ui-plugin-manager`，而该包 devDeps 含
    `@testing-library/react`、`react-dom`、`dsh-client-test-runtime`、`dsh-client-product-analytics`、
    `dsh-client-ui-layout`、`dsh-client-ui-sidebar`、`dsh-client-ui-settings` 等 30+ 包。
- **结论**：**手写同一条 path**，用测试锁住与上游字符串一致（官方换图时测试变红提醒同步）。
- **依赖代价**：0（相比 import 官方包，省掉 30+ 依赖）。
- **权衡**：牺牲"官方换图自动跟随"，换来"依赖极简 + 变更可见"。

---

## ADR-003 · CSS Module 预编译成 `.css.mjs`（**2026-11-14 修订**）

- **状态**：已实现（v1 的 transform 方案被 rolldown 1.2 否决，见下）
- **背景**：官方页面用 `import css from './PluginManagerPage.module.css'`，而本插件 client bundle 没有 CSS 管线。
- **v1（已废弃）**：用 `moduleTypes: { '.css': 'js' }` + `transform` 插件在打包期把 CSS 换成 JS。
  单独用 rolldown 跑通了，但接进 tsdown 后**两条硬限制叠加**，此路不通：
  1. tsdown 无条件追加自带的 `tsdown:css-guard`，只对 `id` 以 `.css` 结尾的模块抛
     「请安装 `@tsdown/css`」；它注册在 `order: 'post'`，我们无法注册更靠后的插件去覆盖；
  2. rolldown 1.2 已**移除 CSS 打包的运行时支持**：即使 transform 已把内容换成 JS，只要扩展名是 `.css`，
     仍然报 `UNSUPPORTED_FEATURE: Bundling CSS is no longer supported`。
  - 顺带否决：给说明符加 `?` 查询串绕过 guard —— rolldown 不解析 `x.module.css?`，报 `UNLOADABLE_DEPENDENCY`。
  - 顺带否决：装 `@tsdown/css` —— 违反「零新增运行时依赖」，且离线镜像里也没有这个包。
- **v2（现状）**：**在 tsc 产物目录里做等价替换**，rolldown 只看到普通 `.mjs`：
  1. `scripts/copy-client-css.mjs`（`clean → tsc host → tsc client → **本脚本** → tsc types → tsdown`）把每个
     `x.module.css` 编译成同名目录下的 `x.module.css.mjs`：`registerStylesheet(id, { classes, text })`
     + `export default classes`；
  2. 同一次遍历把产物 JS 里的 `'./x.module.css'` 改写成 `'./x.module.css.mjs'`；
  3. 顺便镜像非 TS 的运行时资源（vendored 的 `ui/anser.js`），tsc 不会 emit 它们。
- **踩过的两个坑（都已写进代码注释，防止回退）**：
  - rolldown 的相对解析不接受「向上越级再向下」（`../../../local-plugin-manager/css-modules.js`），
    只接受单段形态（`./css-modules.js` / `../css-modules.js`）——prelude 按产物所在层级只生成这两种；
  - tsdown 的 `deps.neverBundle` 语义是「never bundle = 一律 external」，原规则
    `alwaysBundle: (s) => !browserExternal(s)` 会把**相对路径**也判成 external，结果 bundle 里留下了
    `require("css-modules.js")`。已改为 `deps: { external: browserExternal }`（纯 allowlist）。
  - 生成模块调用的入口用 `__dshLocalRegisterStylesheet`（而非 `registerStylesheet`）：打包器会按需给同名
    局部函数加 `$1` 后缀，用独特名字可保证别名永远指向 `css-modules.ts` 里真正那张表。
- **选项回顾**：A. `lightningcss`（新增原生依赖）；B. esbuild `local-css`（新增 esbuild）；
  C. 自研编译器 + 产物期替换 —— **0 依赖，采纳**。
- **依赖代价**：0。
- **验证**：`test/local-plugin-css.test.mjs`（15 条：分词、作用域、`:global()`、逗号组、`moduleSource` 形状）、
  `test/client-bundle-takeover.test.mjs`（真实 `lib/client.js` 求值，bundle 内只剩 `react*` 三个 require）、
  沙箱 DOM 类名与官方页比对（见 `04-verification.md`）。

---

## ADR-004 · 本地页不声明 `plugins.*` 子槽（方案 B，**2026-11-14 已实测并获用户确认**）

- **状态**：**已定稿（用户 2026-11-14 明确选择「接受只读」）**
- **背景**：官方页在 `main` 注册里声明了 9 个子槽；ui-slots 的语义是**声明即独占渲染授权**
  （"Declaring is claiming"），且 `register()` 对已声明的子槽直接抛
  `slot "x" is already declared (by …)` —— **一个子槽只能有一个声明者**。
- **实测（testhub / DSH 0.2.2-rc.1）**：
  - 本地页也声明这 9 个子槽 → 抛 `slot "plugins.add.actions" is already declared`，本地页整体降级不挂；
  - 本地页不声明 → 宿主渲染器只在条目声明了 `children` 时才把 `renderSlot` 放进 kit
    （`ui-renderer/scoped-slots.tsx`：`if (entry.children !== undefined)`），于是
    `props.renderSlot === undefined`，所有子槽贡献渲染为空。
  - 结论：**在同一宿主里，「本地页渲染配置表单」与「官方页正常工作」不可兼得**（除非改内核）。
- **选项**：
  - A. 本地页声明 → 与官方页互斥（实测冲突，否决）；
  - B. 本地页不声明、配置区只读 → 官方页 100% 不变（**采纳**）；
  - C. 自绘配置表单（绕开子槽，直接读 `ctx.configForms`）→ 外观无法与原插件自绘 UI 一致；
  - D. 改内核让 `main` 子槽按 panel key 隔离 → 需要修改 `deepseek-harness`（当前禁止）。
- **结论**：**B**。本地页的定位是「接管期间看/管本机插件」：列表、开关、安装、版本、更新、卸载、
  详情、状态全部等价；**内置插件配置区为空（只读）**，配置在前台状态下的官方「插件」页完成。
- **依赖代价**：0；**不修改内核**。
- **实现要求**：页面必须走 `renderContribution()` 守卫（未提供渲染器 / 拒绝该 key 都返回 null），
  绝不直接调用 `props.renderSlot`，否则会抛 `SlotOwnershipError` 导致整页崩溃。
- **登记**：见 [04-verification.md](./04-verification.md) §6、[06-sandbox-record.md](./06-sandbox-record.md)。

---

## ADR-005 · 插件管理直连接口不进 RPC 名册

- **状态**：已定（需求硬约束：不释放给 RPC、避免云端调用）
- **背景**：官方页走 `ctx.remote` → `/api` RPC → api-gateway → `decide()`；接管后整条链路指向云端。
- **结论**：新接口走 `ctx.connection.fetch.register` 的**精确路径**（owner-only），并配一条独立 WS；
  在 `ENDPOINT_TABLE` 只登记**事实条目**（`hub: true`），不进任何角色矩阵；不触碰 `rpc.intercept` 与 `registerRemoteEvents`。
- **依赖代价**：0（全部是宿主已有 API）。
- **验证**：`POST /api/localPluginManager/*` 必须 404；`remote-device` peer 一律 403；`assertLocalPluginNotDelegated()` 断言。

---

## ADR-006 · 依赖增补（**2026-11-14 修订**）

- **v1**：计划只补 `@deepseek-ai/dsh-plugin-manager@0.2.2-rc.1`（纯类型）。**实际未采纳**：该包的 `./types`
  在测试环境里与 `lib/index.js` 的静态 import 冲突（`ERR_MODULE_NOT_FOUND @deepseek-ai/dsh-plugin-detail`），
  且宿主不保证安装它。改为**手写形状声明**（`client/src/local-plugin-manager/official-shims-types.ts`、
  `host/src/local-plugin-manager/official-types.ts`），代价是包类型变化时需人工跟进（见 ADR-007）。
- **v2 实际增补（全部为 devDependency / peer，运行时依赖为 0）**：
  - `react-dom` + `@types/react-dom`（**dev**）：vendored 页面用 `createPortal` 渲染模态，tsc 需要类型；
  - `react-dom` 加入 **peerDependencies**（与已有的 `react` peer 并列），运行时由宿主模块表提供；
  - `dependencies` 里已有的 `react-dom` 保持不变（构建期同事已在用）。
- **仍然禁止**：`@deepseek-ai/dsh-client-ui-plugin-manager`（照搬源码而不是依赖包）、`lightningcss`、
  `esbuild`、`@tsdown/css`。
- **评审口径**：每个新增 import 必须回答「是否已在宿主进程 / 是否已在模块表 / 是否纯类型」。
