# 云端设备管理页 UI 优化计划

更新：2026-11-15。范围仅为 `client/src/panel/RemoteHubPage.ts` 及其针对性测试；`client/src/local-plugin-manager/` 不改。

## 目标与边界

- 手机窄屏无水平溢出，卡片中的连接、删除等操作尺寸和层级清晰。
- 页面标题在 `.rh-root` 纵向滚动期间始终可见，而不是每张卡的标题轮流吸顶。
- 已配对设备优先显示“连接”，删除类操作与主操作隔开并沿用已有确认流程。
- 在目标地址栏粘贴完整 `#dshrh=` 配对链接时，自动拆分地址和票据；不记录或显示票据到诊断日志。
- 守卫诊断信息在手机端单列、桌面端双列，长值换行。
- 只在 `testhub` 沙箱的 `web` profile 中安装新 tgz 验证；保留 `home/remote-hub/` 的配对数据。测试时不触发连接、删除、签发或配置保存。

## 实施与验收

1. [x] 核对真实运行环境：testhub 目录有 1 台出站目标、0 台入站设备。启动初期同源管理请求失败，页面刷新并等待加载后恢复配对卡。
2. [x] 修正页面结构与样式：去掉失效的卡片观察器和重复确认；页面标题吸顶；配对卡主次按钮同栏；诊断区响应式分隔行；根容器不再用内联 padding 压住手机断点。
3. [x] 地址栏支持完整配对链接，复用 `parsePairLink()` 并用单元测试覆盖合法链接、普通地址和非法文本。
4. [x] 运行 `node scripts/build.mjs` 与 `node --test test/panel.test.mjs`；构建通过，55 项面板测试通过。
5. [x] `npm pack` 产出 0.3.6 tgz，使用 `dsh plugin --profile web add <tgz>` 安装到 testhub，重启 13091 对应进程，CDP 核对新样式已加载且配对卡仍存在。
6. [x] 最后一轮细节修正重新打包安装；375px 与 1280px 的 CDP 测量均通过。真实手机仍未测试。
7. [x] 完整 459 项测试零失败、最终 diff 复核，详见 [实施报告](./ui-optimization-report.md)。

## 防误触原则

不使用定时解锁、长按或滑动删除：这些方式会造成不可预测的交互和无障碍问题。删除操作使用较弱的危险样式和空间分隔；删除记录沿用 `DeviceDeleteDialog`，清除全部沿用已有单次确认。危险操作在 CDP 测试中只检查布局与 DOM，不实际执行。

## 沙箱记录

- 沙箱 `DSH_HOME`: `E:\dsh-box-data\dsh-box-files\data\sandboxes\testhub\home`。
- Profile: `web`；界面端口 13091；浏览器通过已认证 Edge CDP 页面访问。
- 最新 tgz: `dev/ui-sandbox-pack-20261115/xiaopb-dsh-remote-hub-0.3.6.tgz`。最后一轮源码变动后需重新打包再安装，不可将编译成功等同于运行页已更新。
- UI 验证只输出目标数量、错误状态和非敏感几何信息，不输出配对凭据、二维码内容或启动 URL 的令牌。
