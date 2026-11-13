# dsh-remote-hub 0.3.5 部署完成

## 部署环境

| 环境 | 状态 | 版本 | 安装方式 |
| --- | --- | --- | --- |
| Debian (debian.xiaopb.cn) | ✓ 完成 | 0.3.5 | npm install |
| 本地沙箱 (Windows) | ✓ 完成 | 0.3.5 | npm install |

## 包信息

- **包名**: @xiaopb/dsh-remote-hub
- **版本**: 0.3.5
- **文件**: xiaopb-dsh-remote-hub-0.3.5.tgz
- **大小**: 285.5 KB
- **包含文件**: 61 个

## 部署步骤总结

### 1. Debian 部署

```bash
# 上传包
scp xiaopb-dsh-remote-hub-0.3.5.tgz debian.xiaopb.cn:/tmp/

# 安装到 default profile
dsh plugin --profile default add /tmp/xiaopb-dsh-remote-hub-0.3.5.tgz

# 验证
dsh plugin --profile default ls | grep remote-hub
```

**结果**: ✓ 成功安装 @xiaopb/dsh-remote-hub@0.3.5

### 2. 本地沙箱部署

```bash
# 安装到 default profile（本地路径）
dsh plugin --profile default add 'E:\Code\DSH\plugins\dsh-remote-hub\xiaopb-dsh-remote-hub-0.3.5.tgz'

# 验证
dsh plugin --profile default ls | Select-String remote-hub
```

**结果**: ✓ 成功安装 @xiaopb/dsh-remote-hub@0.3.5

## 权限变更已生效

已在两个环境中部署的权限补齐变更：

### 新增 8 个 dynamicCordisRunner RPC 端点

#### 只读方法（所有角色可调用）
- ✓ `dynamicCordisRunner/list` - 列出已定义的动态包
- ✓ `dynamicCordisRunner/syncInspectManifest` - 同步检查清单

#### 写入方法（Full 权限专属）
- ✓ `dynamicCordisRunner/define` - 定义新动态包
- ✓ `dynamicCordisRunner/run` - 运行动态包
- ✓ `dynamicCordisRunner/stop` - 停止运行
- ✓ `dynamicCordisRunner/undefine` - 取消定义
- ✓ `dynamicCordisRunner/getDefinition` - 查询定义详情
- ✓ `dynamicCordisRunner/queryRunning` - 查询运行状态

## 验证命令

### Debian
```bash
# 查看已安装包版本
dsh plugin --profile default why @xiaopb/dsh-remote-hub

# 查看配置
dsh --profile default --dump-config | grep -A 5 "remote-hub"
```

### 本地
```powershell
# 查看已安装包版本
dsh plugin --profile default why @xiaopb/dsh-remote-hub

# 查看配置
dsh --profile default --dump-config | Select-String -A 5 "remote-hub"
```

## 代码变更统计

- **文件修改**: 3 个
- **新增行**: 58 行
- **删除行**: 4 行
- **净增**: 54 行

### 修改的文件
1. `core/src/capabilities.ts` - ENDPOINT_TABLE 补齐 8 个端点
2. `core/src/capabilities-redlines.ts` - 权限规则更新
3. `docs/API-MATRIX.md` - 权限表自动重新生成

## 提交历史

| 提交 | 类型 | 消息 |
| --- | --- | --- |
| 556848a | feat | dynamicCordisRunner endpoint authorization |
| c04e72a | fix | separate read-only and write-only methods |
| 7739ac8 | chore | bump version to 0.3.5 |

## 下一步

- [ ] 在 deepseek-harness 主仓库同步这些变更
- [ ] 测试 remote-access/denied 错误是否已解决
- [ ] 验证 Full 权限设备能正确调用 dynamicCordisRunner 方法
- [ ] 验证其他角色被正确拒绝

## 故障排除

如果出现 `remote-access/denied: dynamicCordisRunner/syncInspectManifest`：

1. 确保已更新到 0.3.5 版本
2. 重启 DSH 应用
3. 确认配对设备权限级别为 Full
4. 检查 `docs/API-MATRIX.md` 中的权限表

## 联系方式

部署问题请参考：
- PERMISSIONS_UPDATE.md - 详细的权限变更说明
- CHANGELOG.md - 版本历史和发布说明
- docs/API-MATRIX.md - 权限分布矩阵
