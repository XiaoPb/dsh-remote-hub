# 实现状态（截至 2026-11-14 12:25）

> 这份表是**进度真相**：每行对应一个已落地的提交或明确的待办。
> 计划正文（下面各 Phase）保持为「设计意图」，实现与设计不一致处一律以 `05-decisions.md` 的 ADR 为准。

| Task | 状态 | 提交 | 备注 |
| --- | --- | --- | --- |
| T0.1 基线 | ✅ | — | 分支 `feature/local-plugins-page`，基线 `aad14e0` |
| T0.2 静态护栏 | ✅ | 89a26e5 | `test/local-plugin-channel-guard.test.mjs` 7 用例；红线清单已加 `hub/localPluginManager/` |
| T1.1 共享契约 | ✅ | 526d4dc | `core/src/local-plugin-manager.ts`：15 方法、事件帧、缓冲上限 |
| T1.2 事实条目 + 反授权 | ✅ | 89a26e5 | `assertLocalPluginNotDelegated()`；endpoint 正则放宽为多段 |
| T1.3 Host 服务 + owner 闸门 | ✅ | 30690b8 | `host/src/local-plugin-manager/service.ts` |
| T1.4 15 个方法 | ✅ | 30690b8 | 逐方法参数校验 + 错误归一 |
| T1.5 HTTP 路由 | ✅ | 30690b8 | `connection.fetch.register` ×15 + `detail-file` |
| T1.6 事件总线 + WS | ✅ | 30690b8 | 环形缓冲 512 帧 / 2MiB；`since` 续传与 `reset` |
| T1.7 detail-file 薄转发 | ✅ | 30690b8 | ADR-001；`detailImageResponse` 就地副本，`readBundleImage` 运行期动态 import |
| T2.1 直连传输 | ✅ | 7685ae0 | `client/src/local-plugin-manager/transport.ts` |
| T2.2 事件订阅 | ✅ | 7685ae0 | 退避 200ms→5000ms，`since` 续传 |
| T2.3 发送层接缝 | ✅ | 7685ae0 | `PluginManagerSender` + `officialRemoteSender()`（ADR-010） |
| T3.0 构建前提 | ✅ | 9ebd570 → **6d5defb** | CSS 方案被 rolldown 1.2 否决，改为**产物期预编译 `.css.mjs`**（ADR-003 v2） |
| T3.1 Vendor 官方文件 | ✅ | 7685ae0 | 每个文件带 `@provenance` |
| T3.2 本地控制器 | ✅ | 157d21f | `local-controller.ts`：只换 sender |
| T3.3 页面注册与字典 | ✅ | 157d21f | `panel.ts` + `locale-namespace.ts` + `panel-copy.ts`；命名空间 `remoteHubLocalPlugins`（九语种） |
| T3.4 页面零改动核验 | ⏳ | — | 见「已知偏离」第 3 条：允许的最小改写清单需要单独登记 |
| T4.1 侧栏图标 + 绿点 | ✅ | 157d21f | `LocalPluginsPanelIcon.tsx`；path 一致性测试**待补** |
| T4.2 配置槽隔离 | ✅ | 157d21f | 采方案 B：不声明任何 `plugins.*` 子槽（ADR-004） |
| T4.3 副标题/身份提示 | ⚠️ | 157d21f | 词条已就位（`localSubtitle`/`localBadge`），尚未接到页头（避免改布局） |
| T5.1 carrier 侦测 | ✅ | 157d21f | `lifecycle.ts`：1s 轮询 + `connection/reset`；无 DOM 环境安全降级 |
| T5.2 接线 plugin.ts | ✅ | 0426def | `injectWhenReady(..., 'local-plugins')`，翻转即 dispose |
| T6.1 全量脚本 | ✅ | — | 439/439 测试、5 个 gate 全绿（每次提交前跑） |
| T6.2 沙箱双页对照 | ⏳ | — | **下一步**：需要 testhub 沙箱 + Edge 实测 |
| T6.3 回归 | ⏳ | — | 随 T6.2 一起做 |
| T6.4 文档回填 | 🔄 | 本次 | 本文 + 05 ADR-003/006 |

## 已完成的提交序列

```
526d4dc core: 直连通道契约
89a26e5 core: 事实登记 + 禁止委派
30690b8 host: 直连通道（路由 / WS / detail-file）
9ebd570 build: vendored UI 与零依赖构建前提
7685ae0 client: vendored 官方 UI 源码
157d21f client: 面板装配 + 侧栏图标 + 生命周期模块
6d5defb build: CSS Module 改为产物期预编译（rolldown 1.2 限制）
0426def client: 仅在接管中挂载本地插件页
d6f8671 test: 传输层 / 生命周期 / 发送层接缝
```

## 已知偏离（须在 04 §6 与用户复核）

1. **CSS 管线改了实现**（ADR-003 v2）：rolldown 1.2 移除 CSS 打包 + tsdown 自带 css-guard，原 `transform`
   方案不可行；改为构建期预编译 `.css.mjs`。**仍是零新增依赖**。
2. **没有安装 `@deepseek-ai/dsh-plugin-manager`**（ADR-006 v2）：它会破坏测试环境的 `lib/index.js` 导入，
   类型改为手写形状声明；代价是上游类型变化需人工同步。
3. **vendored 页面存在「类型层」最小改写**（不是逻辑改写）：import 路径重写为本地 shims、`InjectFace` →
   `InjectFaceProps`、少量 `as any` / 显式快照类型（`exactOptionalPropertyTypes` 与
   `noUncheckedIndexedAccess` 下必需）。行为不变，但 T3.4 的「逐字 diff」验收标准需相应放宽为
   「**除类型与 import 外无逻辑差异**」。
4. **不渲染 9 个 `plugins.*` 子槽**（ADR-004）：本地页因此缺少 4 张内置官方插件卡与第三方配置入口。
   这是用户已认可的取舍。
5. **副标题未接入页面**（T4.3）：为避免改动官方布局，`localSubtitle` 词条目前只被侧栏标签使用。

## 待办（继续执行）

- [ ] T4.1 补 `test/local-plugin-icon.test.mjs`：读取内核 `artwork.ts`，断言 pinwheel path 逐字一致。
- [ ] T3.4 生成 vendored 与上游的 diff 清单（只允许 import/类型差异），写入 04 §6。
- [ ] T6.2 沙箱双页对照：testhub + Edge（CDP `127.0.0.1:9222`，web `13091`，guard `8843`）。
- [ ] T6.3 回归：接管时官方页仍显示云端数据；断开后本地页撤下。
- [ ] 把 04-verification 的「基线」更新为本次实测数字。

---
