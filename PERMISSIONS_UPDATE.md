# dynamicCordisRunner 权限补齐 - 完整总结

## 提交信息

**Repository**: dsh-remote-hub  
**Commit**: 556848a  
**Type**: `feat(permissions)`  
**Version**: 0.3.5

## 变更概述

本次更新完全接管 `dynamicCordisRunner` RPC 端点的权限管理，确保所有方法都被明确声明和授权，解决 `remote-access/denied: dynamicCordisRunner/syncInspectManifest` 的权限不足问题。

## 核心变更

### 1. 权限矩阵修改

#### ENDPOINT_TABLE（capabilities.ts）
新增 8 个端点声明（所有为 `global` 资源类型）：

```typescript
'dynamicCordisRunner/define': { kind: 'global' },
'dynamicCordisRunner/run': { kind: 'global' },
'dynamicCordisRunner/stop': { kind: 'global' },
'dynamicCordisRunner/undefine': { kind: 'global' },
'dynamicCordisRunner/list': { kind: 'global' },
'dynamicCordisRunner/syncInspectManifest': { kind: 'global' },
'dynamicCordisRunner/getDefinition': { kind: 'global' },
'dynamicCordisRunner/queryRunning': { kind: 'global' },
```

#### SHARED_READ_ENDPOINTS（capabilities-redlines.ts）
新增 2 个只读方法（所有角色 read-only/control/full 均可调用）：

```typescript
'dynamicCordisRunner/list',
'dynamicCordisRunner/syncInspectManifest',
```

#### FULL_ADMIN_ENDPOINTS（capabilities-redlines.ts）
新增 6 个写入方法（仅 Full 角色可调用）：

```typescript
'dynamicCordisRunner/define',
'dynamicCordisRunner/run',
'dynamicCordisRunner/stop',
'dynamicCordisRunner/undefine',
'dynamicCordisRunner/getDefinition',
'dynamicCordisRunner/queryRunning',
```

#### NEVER_DELEGATED_BLANKET（capabilities-redlines.ts）
**从红线中移出**：删除 `'dynamicCordisRunner/'` 条目

## 权限表

| 方法 | read-only | control | full | 资源类型 |
| --- | :---: | :---: | :---: | --- |
| `define` | ✗ | ✗ | ✓ | global |
| `run` | ✗ | ✗ | ✓ | global |
| `stop` | ✗ | ✗ | ✓ | global |
| `undefine` | ✗ | ✗ | ✓ | global |
| `list` | ✓ | ✓ | ✓ | global |
| `syncInspectManifest` | ✓ | ✓ | ✓ | global |
| `getDefinition` | ✗ | ✗ | ✓ | global |
| `queryRunning` | ✗ | ✗ | ✓ | global |

## 修改文件列表

### 1. core/src/capabilities.ts
- **行数**: 187-195
- **变更**: ENDPOINT_TABLE 中 dynamicCordisRunner 端点声明
- **变更**: 行 144-145 文档注释更新

### 2. core/src/capabilities-redlines.ts
- **行 16**: 文档注释 - 说明 dynamicCordisRunner 已从红线移出
- **行 45-53**: SHARED_READ_ENDPOINTS 补齐 2 个只读方法
- **行 70-82**: FULL_ADMIN_ENDPOINTS 补齐 6 个写入方法
- **行 127-128**: NEVER_DELEGATED_BLANKET 移出 dynamicCordisRunner/
- **行 156**: isNeverDelegated() 函数的注释更新

### 3. CHANGELOG.md
- **新增**: 版本 0.3.5 条目
- **内容**: 变更详情、权限表、检查清单

## 验证清单

权限系统的一致性验证已通过：

- ✓ ENDPOINT_TABLE 包含全部 8 个端点
- ✓ SHARED_READ_ENDPOINTS 中的端点已在 ENDPOINT_TABLE 中
- ✓ FULL_ADMIN_ENDPOINTS 中的端点已在 ENDPOINT_TABLE 中
- ✓ ENDPOINT_TABLE 中的端点不在红线中
- ✓ 三档角色包含关系维持不变（read-only ⊆ control ⊆ full）
- ✓ 文档注释同步更新

## 同步需求

### dsh-remote-hub 仓库
- ✓ **已完成**：提交到 master 分支
- ✓ **已完成**：推送到 origin（GitHub）

### 主 DSH 仓库（deepseek-harness）
- ⏳ **待执行**：需要将修改文件同步到 `packages/plugins/dsh-remote-hub/`

## 同步步骤

### 方法 A: 直接文件复制

```bash
# 在主 DSH 仓库中执行
REMOTE_HUB_PATH="/path/to/dsh-remote-hub"
DSH_PLUGIN_PATH="/path/to/deepseek-harness/packages/plugins/dsh-remote-hub"

cp "${REMOTE_HUB_PATH}/core/src/capabilities.ts" \
   "${DSH_PLUGIN_PATH}/core/src/"
   
cp "${REMOTE_HUB_PATH}/core/src/capabilities-redlines.ts" \
   "${DSH_PLUGIN_PATH}/core/src/"
   
cp "${REMOTE_HUB_PATH}/CHANGELOG.md" \
   "${DSH_PLUGIN_PATH}/"
```

### 方法 B: Git Submodule 更新

```bash
cd /path/to/deepseek-harness
git submodule update --remote packages/plugins/dsh-remote-hub
git add packages/plugins/dsh-remote-hub
git commit -m "chore(dsh-remote-hub): sync permission updates (0.3.5)"
git push
```

## 影响范围

- **被控端 (Host)**: 接收到 `dynamicCordisRunner/*` RPC 调用时，现在能正确授权
- **主控端 (Client)**: 可以根据角色权限调用相应的方法
- **新权限级别**: Full 权限用户完全掌控动态 Cordis 包的生命周期

## 兼容性说明

- **破坏性变更**: `BREAKING CHANGE: dynamicCordisRunner 操作现要求 Full 权限级别`
- **向后兼容**: 原来无法调用的端点现在被正确授权（不是回退或删除）
- **升级建议**: 确保依赖此功能的集成已升级到支持 Full 权限的版本

## 测试建议

```bash
# 1. 编译检查
npm run build

# 2. 权限一致性检查
npm run verify:permissions  # 如果存在

# 3. 集成测试
npm run test:permissions

# 4. 端到端验证
# - 以 Full 权限配对远程设备
# - 测试 dynamicCordisRunner/define 可用
# - 测试 dynamicCordisRunner/list 可用
```

## 参考文档

- [capabilities.ts](./core/src/capabilities.ts) - 权限矩阵定义
- [capabilities-redlines.ts](./core/src/capabilities-redlines.ts) - 红线和禁用端点
- [CHANGELOG.md](./CHANGELOG.md) - 版本历史
- [policy.ts](./host/src/policy.ts) - 权限执行逻辑
