# 权限变更同步通知 (0.3.5)

## 提交信息

**commit**: ecc8a62  
**内容**：权限补齐：完全接管 dynamicCordisRunner 端点权限管理

## 已同步位置

- ✓ **dsh-remote-hub 主仓库**：已推送到 `origin/master`
  - 仓库：`github.com:XiaoPb/dsh-remote-hub.git`
  - 分支：master
  - 提交哈希：ecc8a62

## 需要同步的文件

修改的三个文件需要同步到主 DSH 仓库（deepseek-harness）的 `packages/plugins/dsh-remote-hub` 目录：

| 文件 | 说明 |
| --- | --- |
| `core/src/capabilities.ts` | ENDPOINT_TABLE 补齐 8 个 dynamicCordisRunner 端点 |
| `core/src/capabilities-redlines.ts` | 从红线移出 dynamicCordisRunner，补齐权限声明 |
| `CHANGELOG.md` | 新增版本 0.3.5 的更新日志 |

## 权限变更摘要

### 新增端点声明（ENDPOINT_TABLE）
- `dynamicCordisRunner/define` - Full 专属
- `dynamicCordisRunner/run` - Full 专属
- `dynamicCordisRunner/stop` - Full 专属
- `dynamicCordisRunner/undefine` - Full 专属
- `dynamicCordisRunner/list` - 三档共享只读
- `dynamicCordisRunner/syncInspectManifest` - 三档共享只读
- `dynamicCordisRunner/getDefinition` - Full 专属
- `dynamicCordisRunner/queryRunning` - Full 专属

### 权限规则变更
1. **从 `NEVER_DELEGATED_BLANKET` 移出**：`dynamicCordisRunner/`
2. **添加到 `SHARED_READ_ENDPOINTS`**：`dynamicCordisRunner/list`, `dynamicCordisRunner/syncInspectManifest`
3. **添加到 `FULL_ADMIN_ENDPOINTS`**：所有 6 个写入方法

## 同步步骤

### 方法 1：直接复制文件（适合单次同步）

```bash
# 在主 DSH 仓库中
cd /path/to/deepseek-harness
cp -r /path/to/dsh-remote-hub/core/src/capabilities.ts packages/plugins/dsh-remote-hub/core/src/
cp -r /path/to/dsh-remote-hub/core/src/capabilities-redlines.ts packages/plugins/dsh-remote-hub/core/src/
cp -r /path/to/dsh-remote-hub/CHANGELOG.md packages/plugins/dsh-remote-hub/
```

### 方法 2：Git 方式（适合长期同步）

如果 dsh-remote-hub 作为 submodule：

```bash
cd /path/to/deepseek-harness
git submodule update --remote packages/plugins/dsh-remote-hub
git add packages/plugins/dsh-remote-hub
git commit -m "同步 dsh-remote-hub 权限补齐 (0.3.5)"
```

## 验证清单

同步完成后，验证以下内容：

- [ ] 文件已复制到 `packages/plugins/dsh-remote-hub/core/src/` 和 `packages/plugins/dsh-remote-hub/`
- [ ] `ENDPOINT_TABLE` 包含所有 8 个 `dynamicCordisRunner/*` 端点
- [ ] `SHARED_READ_ENDPOINTS` 包含 `list` 和 `syncInspectManifest`
- [ ] `FULL_ADMIN_ENDPOINTS` 包含所有 6 个写入方法
- [ ] `NEVER_DELEGATED_BLANKET` 不包含 `dynamicCordisRunner/`
- [ ] CHANGELOG.md 已更新 0.3.5 条目

## 后续操作

- [ ] 在主 DSH 仓库创建 PR 或提交更改
- [ ] 更新 dsh-remote-hub 包版本号（如需要）
- [ ] 发布新版本到 npm registry

## 联系方式

如有问题，请参考 dsh-remote-hub 仓库的 CHANGELOG.md 了解详细变更说明。
