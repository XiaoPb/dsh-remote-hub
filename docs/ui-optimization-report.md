# 云端设备管理页 UI 实施与验证记录

日期：2026-11-15。范围仅 `client/src/panel/RemoteHubPage.ts`；本地插件页未修改。

## 已实施

- 页面级页头位于 `.rh-root` 的真实滚动容器内并保持吸顶，去掉先前错误的卡片级吸顶观察器。
- 移除覆盖响应式 CSS 的根容器行内 padding；375px 手机布局无横向溢出。
- 已配对出站卡“连接”与“删除配对”同栏分隔；前者为主按钮，后者为危险轮廓按钮。离线视觉弱化只应用于设备信息，不削弱操作控件。
- “清除全部”保留原动作层的一次确认，删除记录保留已有 `DeviceDeleteDialog`；移除前一轮重复确认与定时解锁。
- 地址框可直接粘贴完整 `#dshrh=` 链接并自动拆分为地址与票据；普通地址保持原行为。
- 守卫诊断区改为桌面两列、手机单列的分隔行；所有分组标题和值字号一致。

## testhub 真实验证

- 原数据目录 `E:\dsh-box-data\dsh-box-files\data\sandboxes\testhub\home\remote-hub` 未清理；读取到 1 个出站配对目标，0 个入站设备。沙箱启动初期的同源管理通道失败是页面在接口就绪前请求导致的临时现象；刷新且等待后已配对目标恢复。最终运行页无该错误。
- 使用 `npm pack` 生成 `dev/ui-sandbox-pack-20261115-final/xiaopb-dsh-remote-hub-0.3.6.tgz`，由 `dsh plugin --profile web add <tgz>` 安装在 testhub profile，随后只重启沙箱 13091。已检查 profile 依赖和运行页面加载新版样式，未修改主 Harness profile。
- Edge CDP：375×812 下吸顶页头顶端与滚动容器顶端均为 y=48；“连接”96×44px、“删除配对”约 123×44px，同一行且相隔；诊断单列，无横向溢出。[375px 截图](../dev/remote-hub-375-final.png)
- Edge CDP：1280×900 下页头与滚动容器顶端均为 y=0；诊断双列（439px / 439px），无横向溢出。[桌面截图](../dev/remote-hub-desktop.png)
- 在真实页面用无效合成票据测试地址框粘贴：地址自动变为裸 origin、票据字段长度 43、连接按钮随之就绪；没有实际连接。测试后刷新清除了合成输入，原出站卡仍在。
- 最终诊断区字段字号在 Edge 计算值中为标签 11px、值 12px；滚动后标题仍在顶部。
- `node scripts/build.mjs` 构建通过；完整 `node --test test/*.test.mjs`：459 项、458 通过、1 跳过、0 失败；最终面板/目标测试 59 项通过；`git diff --check` 无异常。

## 尚未覆盖

- 无实际 iOS/Android 设备测试；CDP 的 375px 验证是 Edge 视口模拟。
- 未测试真实配对、断开、删除、清除和配置保存，以免改变 testhub 已保存的设备与配置。
- 沙箱旧运行时与包兼容性配置使用该沙箱已有安排；安装命令报告 peer dependency 警告，但页面加载与上述检查通过。
