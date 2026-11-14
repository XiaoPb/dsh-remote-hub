# 沙箱实测记录（testhub / DSH 0.2.1-rc.4）

> 环境见 `dev/REMOTE-HUB-WEB-SANDBOX.md`：DSH_HOME `E:\dsh-box-data\dsh-box-files\data\sandboxes\testhub\home`，
> web `13091`，guard `8843`，Edge CDP `127.0.0.1:9222`。
> 插件通过 `npm pack` → `pnpm add file:…/xiaopb-dsh-remote-hub-0.3.5.tgz` 装进 profile `web`。

## 1. 端到端结果（2026-11-14 13:26）

| 检查 | 结果 |
| --- | --- |
| 侧栏出现「本地插件」行 | ✅（顺序：插件 / 自动化任务 / 云端设备 / **本地插件** / 更多） |
| 侧栏图标 = 官方 pinwheel + 绿点 | ✅ `local-plugins-nav-icon` + `local-plugins-nav-dot`（绿点 `--dsw-alias-state-success-primary`，描边 `--dsw-alias-bg-layer-1`） |
| 主面板渲染官方页面 | ✅ 标题「插件 / 安装、启用和配置插件」，分组「内置插件配置 / 实验性插件 / 已安装插件」，动作「刷新 / 添加插件 / 更多」 |
| 样式注入 | ✅ 18 张 `style[data-plugin-css]`，主页面 297 条规则 |
| 按钮外观（令牌继承） | ✅ 「刷新」描边态 `color rgb(15,17,21)`、`radius 8px`；「添加插件」实心态 `bg rgb(15,17,21)`、`color white` |
| 直连通道（15 方法） | ✅ 见 §2 |
| 事件通道 | ✅ 握手 `{"type":"hello","seq":0}` |
| 断开接管 → 撤下 | ✅ 行消失、18 张样式表全部移除 |
| 恢复接管 → 重现 | ✅ 行与样式表回来，无注入告警 |

## 2. 直连通道矩阵（认证 Cookie + POST `{args}`）

```
listBundles        200 array(21)        listPlugins      200 array(195)
listInventory      200 object(…)        registries       200 object(…)
fastestRegistry    200 "https://registry.npmmirror.com/"
inspect            200 object(status,problem,reason,registries)
listVersions       501 unavailable      readBundleDetail 501 unavailable   ← 该 DSH 版本没有这两个方法
setPluginEnabled   200 object(…)        setBundleEnabled 200 object(…)
removeBundle       200 object(…)
```

- 未认证（无 Cookie）→ **401**；RPC 路径 `/api/localPluginManager/*` 不存在（直连通道不在 RPC 名册）。
- `501 unavailable` 是「这版 Host 没有该能力」，不是故障：面板把它显示为不可用。

## 3. 实测发现并修复的 5 类缺陷（已入回归测试）

1. **面板不挂载**：`injectWhenReady` 未声明 `configForms` → fiber 作用域 proxy 抛
   `cannot get property "configForms" without inject`。修复：注入集合与官方页一致。
2. **渲染崩溃**：本页不声明 `plugins.*` 子槽，宿主可以不提供 `renderSlot` →
   `TypeError: renderSlot is not a function`。修复：统一走 `renderContribution()` 守卫。
3. **事件通道连不上**：`requestRejection()` 已内部 `admit()`；再调 `admitConnection()` 会把 peer
   标成 `ownsSocket`（只有 `/ws` 升级路径会释放），于是 409 并挂断 socket。
   修复：只 `admit()` 一次 + owner 断言。
4. **通道与守卫耦合**：直连通道原本挂在守卫 assembly 里，缺 `remoteAccess` 时整体不跑。
   修复：独立的 `inject(['pluginManager','connection','webServer'])` fiber。
5. **样式一条都不注入**（用户反馈「按键效果很差」）：
   - 只注入了主页面那一张 → 所有原子组件退回浏览器默认外观（按钮就是原生 `<button>`）；
   - 生成的样式模块把**产物名** `X.module.css.mjs` 当作样式表标识注册，而面板按
     `X.module.css` 取表 → 永远取不到；
   - 构建脚本把「所有字符串里的 `.module.css`」都加了 `.mjs` 后缀，连运行期键
     `installStylesheet('Button.module.css')` 也被改写。
   修复：注入全部 18 张表；标识恒为 `x.module.css`；只改写**模块说明符**（`from '…'` / `import('…')`）。

## 4. 设计令牌（token）继承的结论

令牌（`--dsw-alias-*`、`--dsw-radius-*`）由宿主声明在 **`<body>`** 上（实测 `:root` 上没有），
`<style>` 注入到 `<head>` 后靠 CSS 变量继承生效 —— 与官方 `styleInjectionModule()` 行为一致，
因此**无需**额外复制令牌或改动宿主。

## 5. 尚未覆盖

- 安装 / 更新 / 卸载的真实流程（需要联网 registry 操作；本轮只验证了契约形状与错误映射）。
- `readBundleDetail` 的详情页与图片转发（本版 DSH 不提供该方法，恒走 501 分支）。
- 双页**像素级**对照：CDP `Page.captureScreenshot` 在本页面拿到的是陈旧帧，
  改用 DOM 结构与计算样式对照（见 §1），像素对照留到桌面端人工确认。
