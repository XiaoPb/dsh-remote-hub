# 发布流程与管控

> 本仓库**不接受本地手工 `npm publish`**。版本发布全部走 GitHub Actions，任何人（包括维护者）
> 都应当通过打 tag 触发流水线来完成发布。本文描述流水线做了什么、卡了什么、出问题怎么处置。

## 0. 一句话

**改版本 → 提交 → 推 `main` → 等 CI 绿 → 打 `v*` tag → 推 tag → 流水线自动校验、发布 npm、产出 GitHub Release。**

## 1. 工作流总览

| 文件 | 触发 | 作用 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | push / PR 到 `main`、手动 | 质量门禁，**不发布** |
| `.github/workflows/release.yml` | push `v*` tag、手动 | 发布 npm + GitHub Release |

两条流水线共用同一套自检入口（`npm run check`），保证「CI 绿的提交」与「被发布的提交」跑的是同一把尺。

## 2. CI（质量门禁）

矩阵：Node.js `24`（`engines.node` 要求 `>=24.9.0`，只用 24 一条线，避免版本分叉带来的假红/假绿）。

依次执行：

1. `pnpm install --frozen-lockfile` —— 锁文件必须与 `package.json` 一致；
2. `pnpm run typecheck` —— host + client 双 tsconfig 零错误；
3. `pnpm run build` —— tsc → tsdown，产物顺序固定（host / carrier-boot / client）；
4. `node scripts/verify-package.mjs` —— 包清单契约（入口、`files` 白名单、开发目录不进包）；
5. `node scripts/run-all-tests.mjs` —— 串行跑全部 `test/*.test.mjs`；
6. `node scripts/version-gate.mjs` —— 兼容矩阵 `0.2.1-rc.2=Y 0.2.1-rc.5=Y 0.2.2-rc.1=Y 0.3.0-rc.1=n`；
7. `node scripts/contract-check.mjs` —— 协议契约对账；
8. `node scripts/fence.mjs` —— 来源围栏用例；
9. `node scripts/redlines.mjs` —— 红线 endpoint 对 `full` 角色仍被拒绝；
10. `node scripts/render-api-matrix.mjs --check` —— **接口权限分布文档与代码一致**
    （`docs/API-MATRIX.md` 由脚本从构建产物生成，改权限却忘了重新生成会在这里变红）；
11. `node scripts/release-check.mjs` —— 版本在三处写死的地方保持一致；
12. `npm pack` + 干净目录里像消费者一样安装并校验（consumer 测试）；
13. 生成一次 release notes 冒烟（确保发布脚本本身没坏）。

> 第 11 步是「包能不能被真正装上」的唯一证据：`files` 白名单写错、产物漏打、
> 依赖装不上，都会在这里暴露，而不是等用户装的时候。

## 3. Release（发布流水线）

### 3.1 触发

- **打 tag**（主路径）：`git tag v0.2.5 && git push origin v0.2.5`
- **手动**（补发/重跑）：Actions → Release → Run workflow，指定 `ref`。

并发组 `release-<ref>`，`cancel-in-progress: false`：发布**不允许**被后来的运行打断。

### 3.2 步骤与门禁

```
tag ↔ package.json 版本强校验  ── 不一致直接失败，不进入任何发布动作
        ↓
npm run check（与 CI 同一入口） ── 任何一项红 ⇒ 不发布
        ↓
发布凭据探测（OIDC 可用性 / NPM_TOKEN 身份）
        ↓
npm 发布：OIDC 优先 → NPM_TOKEN 兜底 → 轮询确认版本真的公开
        ↓
npm pack + SHA-256
        ↓
生成 release notes → 创建/更新 GitHub Release（附 tarball + 校验和）
```

**版本门禁**：`package.json` 必须是 SemVer，且 tag 必须严格等于 `v<version>`。
tag 写错（例如 `v0.3.0` 却忘了改 `package.json`）时流水线在第一步就失败，不会产生一个错的包。

**发布后校验**：`scripts/publish-npm.sh` 不信任 `npm publish` 的退出码。npm 可能在
「接受请求」后进入自动校验（`status: validating`）或 staged 审批，此时退出码是 0 但版本并未可见。
脚本因此：

1. 先查版本是否**已经公开**（重跑安全，已发布则跳过）；
2. OIDC 发布后轮询 `npm view` + 带 cache-buster 的精确版本端点；
3. 仍未公开则回退 `NPM_TOKEN` 再发一次并继续轮询；
4. 请求被接受但读不到 ⇒ **不阻断**（registry 在后台校验，通常 1~3 分钟可见），打印确认命令；
5. 所有方式都被 registry **拒绝** ⇒ 打印诊断（token 身份、registry 版本状态、staged 列表、错误原文）并失败。

**Release 产物**：tarball 与其 `.sha256` 一起挂到 GitHub Release，`fail_on_unmatched_files: true`
保证附件缺失时失败，不会产出「只有标题的 Release」。

### 3.3 凭据

| 凭据 | 位置 | 说明 |
| --- | --- | --- |
| `secrets.NPM_TOKEN` | 仓库 Secret | **可发布**的 granular token：不能是 read-only / stage-only，allowed packages 必须包含 `@xiaopb/dsh-remote-hub` |
| `id-token` | workflow 权限 | OIDC 可信发布；需在 npm 包设置里登记 Trusted Publisher（repo + workflow `release.yml`） |
| `secrets.GITHUB_TOKEN` | Actions 自动注入 | 创建 Release，`contents: write` |

> **scope 与可见性**：`@xiaopb` 目前没有付费计划，registry 对 `access: restricted` 回 **E402
> "You must sign up for private packages"**。因此流水线**固定 `--access public`**，
> 这也是本包作为开源 DSH 插件的预期形态。

> **令牌不落盘**：token 只在 Secret 中；任何提交里出现 token 都视为事故（`.gitignore` 已忽略 `dev/`）。
> 本地 `dev/npm_token` 仅用于人工排查，**不得**进入仓库。

### 3.4 重跑语义

- 发布步骤是**幂等**的：版本已公开 ⇒ 直接跳过，随后照常重建 tarball 与 Release（覆盖更新）。
- 失败的流水线重跑不会产生重复版本；要换版本必须改 `package.json` + 重新打 tag。

## 4. 维护者操作手册

### 4.1 发一个新版本

```bash
# 1) 改版本：package.json + companions/remote-paths/package.json 必须同步
#    同时更新 README.md / README.en.md 的版本号、docs/DESIGN.md 的 Version、
#    以及 CHANGELOG.md 的版本条目（release-check 会逐一断言）
node scripts/release-check.mjs

# 2) 本地过一遍门禁
pnpm run typecheck && pnpm run build && npm run check

# 3) 提交并推 main，等 CI 绿
git add -A && git commit -m "release: prepare remote hub 0.3.0"
git push origin main

# 4) 打 tag 触发发布
git tag v0.3.0 && git push origin v0.3.0
```

### 4.2 只验证发布脚本（不真的发布）

```bash
# 本地用假 npm 跑发布逻辑：PROBE_REGISTRY=0 时不访问 registry
PACKAGE_NAME=@xiaopb/dsh-remote-hub VERSION=0.0.0-test PROBE_REGISTRY=0 \
  POLL_ATTEMPTS=1 POLL_INTERVAL=0 bash scripts/publish-npm.sh

# 校验 release notes 生成器
bash scripts/release-notes.sh /tmp/notes.md
```

## 5. 故障处置

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| `tag vX does not match package.json version` | 忘了同步版本 | 改 `package.json` 后提交，删掉错 tag 重打 |
| `companions/remote-paths version != ...` | 伴生包版本漂移 | 同步两个 `package.json` |
| `doc-version: README.md` 失败 | README 里写死的版本过期 | 更新中英 README 与 `docs/DESIGN.md` |
| `E402 You must sign up for private packages` | 误用了 restricted | 确认流水线带 `--access public`（脚本已固定） |
| `E403 / ENEEDAUTH` | token 无发布权限或包不在 allowed packages | 重签 granular token，更新 Secret `NPM_TOKEN` |
| `EOTP / E_STAGE_REQUIRED` | 账号开了 2FA/staged 发布 | 采用 OIDC 可信发布，或关闭 staged publishing |
| 发布成功但几分钟内 `npm view` 仍 404 | registry 自动校验 + CDN 缓存 | 正常现象；流水线不阻断，稍后复查 |
| Release 附件缺失 | pack 产物名不符 | 看 `fail_on_unmatched_files` 报错，检查 `npm pack` 输出 |

## 6. 与 dsh-mobile-layout 的差异

管控思路与 `dsh-mobile-layout` 的发布流程一致（tag 门禁 → 同一套自检 → OIDC 优先 + token 兜底 →
轮询确认公开 → tarball + SHA-256 + Release）。本仓库的差异只有：

- 用 **pnpm + 锁文件（`--frozen-lockfile`）**，因为本包有真实依赖（`ws`）与 peer 依赖；
- 自检入口是 `npm run check`，串联本仓库既有的 `version-gate` / `contract-check` / `fence` / `redlines`；
- 新增 `release-check`（版本三处一致 + 双语 README 互链 + CHANGELOG 条目）、`verify-package`
  （包清单契约 + consumer 安装）与 `render-api-matrix --check`（权限文档不漂移）三个门禁；
- Node 矩阵只有 24 一条线（`engines.node >= 24.9.0`），不做双版本试探。
