# 更新日志

本文件记录 `@xiaopb/dsh-remote-hub` 与伴生包 `@xiaopb/dsh-remote-paths` 的公开变更。
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)；`0.x` 期间的次版本号可能包含不兼容变更。

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
