#!/usr/bin/env bash
# 生成完整的 release-notes.md（release.yml 用，CI 里也会先跑一遍校验）。
#
# 必填环境变量：
#   TAG           发布 tag，如 v0.2.5
#   VERSION       包版本，如 0.2.5
#   PACKAGE_NAME  npm 包名
#   TARBALL       打包产物文件名
#   SHA256        tarball 的 SHA-256
# 可选：
#   PUBLISH_METHOD、GITHUB_REPOSITORY、GITHUB_RUN_ID、GITHUB_EVENT_NAME
#
# 用法：bash scripts/release-notes.sh [输出文件]
set -euo pipefail

: "${TAG:?set TAG (e.g. v0.2.5)}"
: "${VERSION:?set VERSION (e.g. 0.2.5)}"
: "${PACKAGE_NAME:?set PACKAGE_NAME}"
: "${TARBALL:?set TARBALL}"
: "${SHA256:?set SHA256}"

OUT="${1:-release-notes.md}"
REPO="${GITHUB_REPOSITORY:-XiaoPb/dsh-remote-hub}"
EVENT="${GITHUB_EVENT_NAME:-local}"
SHORT_SHA="$(git rev-parse --short=7 HEAD 2>/dev/null || printf 'unknown')"
BUILD_TIME="$(date -u '+%Y-%m-%d %H:%M UTC')"
TARBALL_SIZE="$(du -h "$TARBALL" | cut -f1 | tr -d ' ')"
NODE_ENGINE="$(node -p "require('./package.json').engines.node || 'any'")"
DSH_RANGE="$(node -p "require('./package.json').engines.dsh || 'any'")"
COMPANION_VERSION="$(node -p "try{require('./companions/remote-paths/package.json').version}catch{''}")"
NPM_URL="https://www.npmjs.com/package/${PACKAGE_NAME}/v/${VERSION}"

if [ -n "${GITHUB_RUN_ID:-}" ]; then
  CI_LINE="- CI 运行记录：https://github.com/${REPO}/actions/runs/${GITHUB_RUN_ID}"
else
  CI_LINE="- 本地生成（未关联 CI 运行）"
fi

# 上一个 tag 作为变更范围起点；首个版本没有历史 tag 时退回全量历史。
PREV_TAG="$(git describe --tags --abbrev=0 HEAD^ 2>/dev/null || true)"
if [ -n "$PREV_TAG" ] && [ "$PREV_TAG" != "$TAG" ]; then
  RANGE="${PREV_TAG}..HEAD"
  COMPARE="[${PREV_TAG}...${TAG}](https://github.com/${REPO}/compare/${PREV_TAG}...${TAG})"
  RANGE_LABEL="\`${PREV_TAG}..${TAG}\`"
else
  RANGE="HEAD"
  COMPARE="[${TAG}](https://github.com/${REPO}/commits/${TAG})"
  RANGE_LABEL="本版本全部提交"
fi
COMMIT_COUNT="$(git rev-list --count --no-merges "$RANGE" 2>/dev/null || printf '0')"
CONTRIBUTORS="$(git log --no-merges --pretty='%an' "$RANGE" 2>/dev/null | sort -u | tr '\n' ',' | sed 's/,/, /g; s/, $//')"

NOTES_DIR="$(mktemp -d)"
trap 'rm -rf "$NOTES_DIR"' EXIT

for key in feat fix perf refactor build ci docs test style other; do
  : > "${NOTES_DIR}/${key}.md"
done

# 按 conventional commit 前缀分类（无前缀的归入「其他改动」）
while IFS=$'\t' read -r short subject; do
  [ -z "${subject}" ] && continue
  type=$(printf '%s' "${subject}" | sed -nE 's/^([a-z]+)(\([^)]*\))?!?:.*/\1/p')
  case "${type}" in
    feat|fix|perf|refactor|build|ci|docs|test|style) ;;
    *) type=other ;;
  esac
  printf -- '- %s (`%s`)\n' "${subject}" "${short}" >> "${NOTES_DIR}/${type}.md"
done < <(git log --no-merges --pretty=format:'%h%x09%s%n' "$RANGE" 2>/dev/null || true)

{
  echo "## 版本信息"
  echo ""
  echo "| 项目 | 值 |"
  echo "| --- | --- |"
  echo "| 版本 | \`${TAG}\` |"
  echo "| npm 包 | [\`${PACKAGE_NAME}@${VERSION}\`](${NPM_URL}) |"
  printf '| 伴生包 | `@xiaopb/dsh-remote-paths@%s` |\n' "${COMPANION_VERSION:-$VERSION}"
  echo "| 提交 | \`${SHORT_SHA}\` |"
  echo "| 提交数量 | ${COMMIT_COUNT}（${RANGE_LABEL}） |"
  echo "| 构建时间 | ${BUILD_TIME} |"
  echo "| 触发方式 | \`${EVENT}\` |"
  if [ -n "${PUBLISH_METHOD:-}" ]; then
    echo "| 发布方式 | ${PUBLISH_METHOD} |"
  fi
  echo "| 校验环境 | Node.js 24 / Ubuntu |"
  echo "| Node.js 要求 | \`${NODE_ENGINE}\` |"
  echo "| DSH 要求 | \`${DSH_RANGE}\` |"
  echo "| npm provenance | [在 npm 查看](${NPM_URL})（发布时启用 --provenance） |"
  echo ""
  echo "## 安装"
  echo ""
  echo '```sh'
  echo "# 从 npm 安装（推荐）"
  echo "dsh plugin --profile web add ${PACKAGE_NAME}@${VERSION}"
  echo ""
  echo "# 可选：远端目录浏览伴生包"
  echo "dsh plugin --profile web add @xiaopb/dsh-remote-paths@${COMPANION_VERSION:-$VERSION}"
  echo ""
  echo "# 从本 Release 的 tarball 离线安装"
  echo "dsh plugin --profile web add /path/to/${TARBALL}"
  echo ""
  echo "# 固定到本 tag 从 GitHub 安装"
  echo "dsh plugin --profile web add github:XiaoPb/dsh-remote-hub#${TAG}"
  echo '```'
  echo ""
  echo "安装后**重启 Host 进程**：守卫监听与隧道子进程不会热替换。默认守卫只绑 \`127.0.0.1:8443\`、"
  echo "未配对设备 fail-closed；接隧道前请先配置 \`publicAuthorities\`，且**不要把隧道指向 \`:3080\`**。"
  echo ""
  echo "## 发布产物"
  echo ""
  echo "| 文件 | 用途 | 大小 | SHA-256 |"
  echo "| --- | --- | --- | --- |"
  echo "| \`${TARBALL}\` | DSH Web（任意 Host） | ${TARBALL_SIZE} | \`${SHA256}\` |"
  echo "| \`${TARBALL}.sha256\` | 校验和 | - | - |"
  echo ""
  echo "## 变更内容"
  echo ""
  HAS_CHANGES=0
  for key in feat fix perf refactor build ci docs test style other; do
    if [ -s "${NOTES_DIR}/${key}.md" ]; then
      HAS_CHANGES=1
      case "${key}" in
        feat) title="新功能" ;;
        fix) title="问题修复" ;;
        perf) title="性能优化" ;;
        refactor) title="重构" ;;
        build) title="构建与依赖" ;;
        ci) title="CI/CD" ;;
        docs) title="文档" ;;
        test) title="测试" ;;
        style) title="代码风格" ;;
        *) title="其他改动" ;;
      esac
      echo "### ${title}"
      echo ""
      cat "${NOTES_DIR}/${key}.md"
      echo ""
    fi
  done
  if [ "$HAS_CHANGES" -eq 0 ]; then
    echo "本版本没有可分类的提交（可能是首个版本或发布提交本身）。"
    echo ""
  fi
  echo "## 质量校验"
  echo ""
  echo "- \`pnpm run typecheck\`：host + client 双 tsconfig 零错误"
  echo "- \`pnpm run build\`：tsc → tsdown（host / carrier-boot / client 顺序固定）"
  echo "- \`node scripts/run-all-tests.mjs\`：串行跑全部 \`test/*.test.mjs\`"
  echo "- \`version-gate\`：兼容矩阵 \`0.2.1-rc.2=Y 0.2.1-rc.5=Y 0.2.2-rc.1=Y 0.3.0-rc.1=n\`"
  echo "- \`contract-check\` / \`fence\` / \`redlines\`：协议对账、来源围栏、红线不可下放"
  echo "- 发布后校验版本确实在 registry 公开（\`npm view\` 轮询，失败会自动回退 token 并再确认）"
  echo "- 打包后在干净目录里安装并校验（CI consumer 测试）"
  echo "${CI_LINE}"
  echo ""
  echo "## 贡献者"
  echo ""
  echo "${CONTRIBUTORS:-（无）}"
  echo ""
  echo "## 对比"
  echo ""
  echo "${COMPARE}"
} > "$OUT"

echo "wrote $OUT ($(wc -l < "$OUT") lines)"
