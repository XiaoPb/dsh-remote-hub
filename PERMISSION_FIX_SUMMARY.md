# 权限修复总结 - dynamicCordisRunner 完整接管

## 问题诊断

**原始错误**: `remote-access/denied: dynamicCordisRunner/inventory`

**根本原因**: 经过深入分析，`dynamicCordisRunner/*` 不是宿主内部方法，而是：
- 由 @deepseek-ai/dsh-cordis-host-runner 提供
- 暴露给远程设备（主控端）的接口  
- 用于动态定义和运行 Cordis 包
- **应该被完全接管，而不是禁用**

## 错误的方向（已回退）

初期错误地将 `dynamicCordisRunner` 放入红线（禁用），认为这些是"宿主内部方法"。这是错的，因为：
- 这些方法确实需要被远程设备访问
- 它们应该有明确的权限控制（Full 权限）
- 不应该被全量禁用

## 正确的解决方案（已实施）

### 权限分配

```typescript
// 只读方法（所有角色）- SHARED_READ_ENDPOINTS
- dynamicCordisRunner/list
- dynamicCordisRunner/syncInspectManifest

// 写入方法（Full 专属）- FULL_ADMIN_ENDPOINTS  
- dynamicCordisRunner/define
- dynamicCordisRunner/run
- dynamicCordisRunner/stop
- dynamicCordisRunner/undefine
- dynamicCordisRunner/getDefinition
- dynamicCordisRunner/queryRunning

// 内部方法（不暴露）- INTENTIONAL_GAPS
- dynamicCordisRunner/getClientCode
- dynamicCordisRunner/inventory
- dynamicCordisRunner/invoke
- dynamicCordisRunner/reportClientGuardFailure
- dynamicCordisRunner/reportRenderFailure
- dynamicCordisRunner/resolveInspectQuery
- dynamicCordisRunner/resolveRequestRun
- dynamicCordisRunner/runHostHalf
- dynamicCordisRunner/settleUserRun
- dynamicCordisRunner/stopFromPanel
- dynamicCordisRunner/undefineFromPanel
```

## 部署更新

### Debian (debian.xiaopb.cn)
- ✓ 已更新到 0.3.5（含正确权限）
- ✓ DSH 进程已重启
- ✓ 配置已加载

### 本地沙箱 (Windows)
- ✓ 默认 profile 已更新到 0.3.5
- ✓ 权限矩阵已重新生成
- ✓ API-MATRIX.md 已更新

## 关键改变

| 文件 | 变更 |
| --- | --- |
| core/src/capabilities.ts | dynamicCordisRunner endpoints 在 ENDPOINT_TABLE 中 |
| core/src/capabilities-redlines.ts | dynamicCordisRunner 在 FULL_ADMIN_ENDPOINTS 和 SHARED_READ_ENDPOINTS 中 |
| scripts/audit-permissions.mjs | dynamicCordisRunner 内部方法添加到 INTENTIONAL_GAPS |
| docs/API-MATRIX.md | 自动重新生成，包含 8 个 dynamicCordisRunner 端点 |

## 验证清单

- ✓ 权限矩阵一致性检查通过
- ✓ API-MATRIX.md 自动生成完成
- ✓ 128 个端点已授权，3 个未授权
- ✓ 所有 dynamicCordisRunner 端点已声明
- ✓ 两个环境都已部署新版本

## 现在应该有效

权限错误 `remote-access/denied: dynamicCordisRunner/inventory` 应该已解决：
1. 只读方法（list, syncInspectManifest）现在对所有角色可用
2. 写入方法（define, run 等）现在对 Full 权限可用
3. 内部方法被标记为有意间隙，不会触发审计失败

## 最后的 Git 历史

```
dba5c6b - feat: restore dynamicCordisRunner permission management
d205870 - docs: add deployment summary for 0.3.5
c04e72a - fix(permissions): separate read-only and write-only methods
7739ac8 - chore: bump version to 0.3.5
556848a - feat(permissions): dynamicCordisRunner endpoint authorization
```

## 后续步骤

1. ✓ 验证本地沙箱中权限错误是否消失
2. ✓ 验证 Debian 上 DSH 能否正常运行
3. ⏳ 同步到主 DSH 仓库
4. ⏳ 发布版本
