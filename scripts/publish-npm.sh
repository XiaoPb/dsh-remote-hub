#!/usr/bin/env bash
# 把当前包发布到 npm，并在每一步之后**确认版本真的公开**，而不是只看 npm publish 的退出码。
#
# 为什么要这么写：npm 现在可能「接受」发布请求却不让版本立刻公开——
#   · 账号/令牌是 stage-only 策略（registry 回 E_STAGE_REQUIRED），请求被收进 Staged Packages 等 2FA 批准；
#   · 包第一次发布、或可信发布方没登记时，OIDC 也会被拒；
#   · registry 读路径走 CDN，publish 成功后 packument 可能还要 1~3 分钟才可见。
# 这些情况 npm CLI 的退出码都可能是 0，只看 rc 会得出「发布成功」的错误结论。
#
# 策略（与 dsh-mobile-layout 的 release.yml 同一套管控）：
#   1. 版本已公开               → 直接跳过（重跑安全）
#   2. Trusted Publishing(OIDC) → 发布 + 轮询确认公开
#   3. 仍未公开                 → 回退 NPM_TOKEN 再发一次 + 轮询确认公开
#   4. 发布请求被接受但读不到   → 不阻断（registry 在后台自动校验），打印确认命令
#   5. 所有方式都被拒           → 打印诊断（身份 / registry 状态 / staged 列表 / 错误原文）并失败
#
# 环境变量：
#   PACKAGE_NAME      必填，例如 @xiaopb/dsh-remote-hub
#   VERSION           默认读 package.json
#   REGISTRY          默认 https://registry.npmjs.org/
#   NODE_AUTH_TOKEN   可选；token 兜底用（Actions 里来自 secrets.NPM_TOKEN）
#   POLL_ATTEMPTS     确认公开的轮询次数，默认 18
#   POLL_INTERVAL     轮询间隔秒，默认 10
#   GITHUB_OUTPUT     由 Actions 注入；用于输出 method=<发布方式>
#   ACTIONS_ID_TOKEN_REQUEST_URL  由 Actions 注入；存在即认为可以走 OIDC
#   PROBE_REGISTRY    默认 1；0 表示失败诊断时不访问 registry（本地/单测用）
set -euo pipefail

PACKAGE_NAME="${PACKAGE_NAME:?PACKAGE_NAME is required}"
VERSION="${VERSION:-$(node -p "require('./package.json').version")}"
REGISTRY="${REGISTRY:-https://registry.npmjs.org/}"
REGISTRY="${REGISTRY%/}"
REG_HOST="${REGISTRY#*://}"
POLL_ATTEMPTS="${POLL_ATTEMPTS:-18}"
POLL_INTERVAL="${POLL_INTERVAL:-10}"
SPEC="${PACKAGE_NAME}@${VERSION}"
WORKDIR="${WORKDIR:-$(mktemp -d)}"
mkdir -p "$WORKDIR"
NAME_ENCODED="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$PACKAGE_NAME")"
VERSION_URL="${REGISTRY}/${NAME_ENCODED}/${VERSION}"

log() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }

set_output() { # key value
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"
  fi
  printf '    [output] %s=%s\n' "$1" "$2"
}

# ---------- 版本是否已公开 ----------
# 除了 npm view，再用带 cache-buster 的精确版本端点探一次，命中 200 就认为已公开。
is_public() {
  if npm view "$SPEC" version --registry "$REGISTRY" > /dev/null 2>&1; then
    return 0
  fi
  if [ "${PROBE_REGISTRY:-1}" != "0" ]; then
    local code
    code="$(curl -s -o /dev/null -m 15 -w '%{http_code}' -H 'Cache-Control: no-cache' \
      "${VERSION_URL}?ts=$(date +%s)" 2>/dev/null || true)"
    if [ "$code" = "200" ]; then
      info "（精确版本端点已返回 200，packument 还在 CDN 缓存里）"
      return 0
    fi
  fi
  return 1
}

wait_public() { # $1 = 方式标签，$2 = 轮询次数（可选）；成功 0，超时 1
  local label="$1" attempts="${2:-$POLL_ATTEMPTS}" attempt raw
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if is_public; then
      info "第 $attempt 次确认：$SPEC 已公开（$label）"
      return 0
    fi
    raw="$(npm view "$SPEC" version --registry "$REGISTRY" 2>&1 || true)"
    raw="$(printf '%s' "$raw" | head -n 2 | tr '\n' ' ')"
    info "第 $attempt/$attempts 次确认：尚未公开 · ${raw:-（无输出）}"
    # registry 的版本状态端点能直接说明「在自动校验 / 待批准 / 已拒绝」，每一轮都打一次
    probe_version_status
    if [ "$attempt" -lt "$attempts" ]; then sleep "$POLL_INTERVAL"; fi
  done
  return 1
}

# ---------- registry 版本状态（需要 token）----------
# 例如 {"status":"validating"} 表示 npm 正在自动校验（provenance/签名），通常 1~3 分钟后才可读；
# 这一步能区分「还在校验」和「被拒 / 根本没有这次发布」。
probe_version_status() {
  if [ "${PROBE_REGISTRY:-1}" = "0" ] || [ -z "${NODE_AUTH_TOKEN:-}" ]; then
    return 0
  fi
  local body
  body="$(curl -sS -m 10 -H "Authorization: Bearer $NODE_AUTH_TOKEN" \
    "$REGISTRY/-/package/$NAME_ENCODED/version/$VERSION/status" 2>/dev/null || true)"
  if [ -n "$body" ]; then
    info "registry 版本状态：$(printf '%s' "$body" | tr -d '\n' | cut -c1-200)"
  fi
}

# ---------- 单次发布尝试 ----------
PUB_RC=0
PUB_LOG=''
publish_once() { # $1 = trusted|token，$2 = 1 带 provenance / 0 不带
  local mode="$1" prov="$2"
  local npmrc="$WORKDIR/npmrc-$mode"
  local extra=()
  PUB_LOG="$WORKDIR/publish-$mode.log"

  if [ "$mode" = "token" ]; then
    # 显式写死 registry + token，避免 setup-node 生成的 npmrc 被后面那次 `npm install -g npm@latest` 影响
    printf 'registry=%s\n//%s/:_authToken=%s\n' \
      "$REGISTRY" "$REG_HOST" "${NODE_AUTH_TOKEN}" > "$npmrc"
  else
    # 可信发布：npmrc 里绝不能有 token，否则 npm 不会走 OIDC
    printf 'registry=%s\n' "$REGISTRY" > "$npmrc"
  fi
  if [ "$prov" = "1" ]; then extra+=("--provenance"); fi

  log "npm publish（方式：$mode，provenance：$prov）"
  info "registry=$REGISTRY  userconfig=$npmrc"
  # @xiaopb 是 public scope：私有发布需要付费计划，因此 always --access public
  set +e
  NPM_CONFIG_USERCONFIG="$npmrc" npm publish --registry "$REGISTRY" --access public ${extra[@]+"${extra[@]}"} 2>&1 | tee "$PUB_LOG"
  PUB_RC=${PIPESTATUS[0]}
  set -e
  info "退出码：$PUB_RC"
}

grep_log() { grep -Eiq "$1" "${2:-$PUB_LOG}" 2>/dev/null; }

# registry 回「版本已存在」= 这次其实已经发出去了，只是读路径还没刷新；不用再换方式重发。
is_conflict() {
  grep_log 'previously published|EPUBLISHCONFLICT|E409|409 Conflict'
}

# 发布一次，必要时去掉 --provenance 重试。返回：0 正常发出 / 2 命中「已存在」
attempt_publish() { # $1 = trusted|token，$2 = 说明文字
  publish_once "$1" 1
  if is_conflict; then
    info "$2：registry 已存在该版本（$SPEC），只是读路径还没刷新"
    return 2
  fi
  if [ "$PUB_RC" -ne 0 ] && grep_log 'provenance|sigstore|id-token|oidc'; then
    info "provenance 相关失败，去掉 --provenance 重试"
    publish_once "$1" 0
    if is_conflict; then
      info "$2：registry 已存在该版本（$SPEC），只是读路径还没刷新"
      return 2
    fi
  fi
  return 0
}

# ---------- 诊断 ----------
diagnose() {
  local enc status body
  enc="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$PACKAGE_NAME")"

  log "诊断：npm / node 版本"
  info "npm $(npm --version) · node $(node --version) · registry $REGISTRY"
  if [ -n "${NODE_AUTH_TOKEN:-}" ]; then
    local identity
    identity="$(npm whoami --registry "$REGISTRY" 2>&1 | head -n 2 | tr '\n' ' ' || true)"
    info "token 身份：${identity:-（无法识别）}"
  fi

  log "诊断：包是否存在于 npm"
  body="$(npm view "$PACKAGE_NAME" version dist-tags --registry "$REGISTRY" 2>&1 || true)"
  info "$(printf '%s' "$body" | head -n 6 | tr '\n' ' ')"

  log "诊断：registry 上该版本的状态（能否看到 staged）"
  if [ "${PROBE_REGISTRY:-1}" = "0" ]; then
    info "（PROBE_REGISTRY=0，跳过 registry 探测）"
  elif [ -n "${NODE_AUTH_TOKEN:-}" ]; then
    status="$(curl -sS -m 20 -H "Authorization: Bearer $NODE_AUTH_TOKEN" \
      "$REGISTRY/-/package/$enc/version/$VERSION/status" 2>&1 || true)"
  else
    status="$(curl -sS -m 20 "$REGISTRY/-/package/$enc/version/$VERSION/status" 2>&1 || true)"
  fi
  if [ "${PROBE_REGISTRY:-1}" != "0" ]; then
    info "${status:-（无响应）}"
  fi

  log "诊断：npm stage list（npm ≥ 11.15 才有）"
  info "$(npm stage list "$PACKAGE_NAME" --registry "$REGISTRY" 2>&1 | head -n 12 || true)"

  log "诊断：发布日志里的报错行"
  info "$(grep -hE 'npm (error|ERR!)|E_STAGE_REQUIRED|E403|E401|EOTP|E404|E402' \
    "$WORKDIR"/publish-*.log 2>/dev/null | tail -n 8 || true)"
}

# =====================================================================
log "目标：$PACKAGE_NAME@$VERSION（tag v$VERSION）"

if is_public; then
  log "该版本已在 npm 公开，跳过发布"
  set_output method "already published"
  exit 0
fi

# 用一种方式发布并确认可见。返回 0 = 已确认公开（method 已写入输出）
CONFLICT=0
ACCEPTED=0
try_method() { # $1 = trusted|token，$2 = 日志标签，$3 = method 输出值
  local mode="$1" label="$2" method="$3" rc=0

  attempt_publish "$mode" "$label" || rc=$?
  if [ "$rc" = "2" ]; then CONFLICT=1; fi
  if [ "$PUB_RC" = "0" ] || [ "$rc" = "2" ]; then ACCEPTED=1; fi

  # 发布被直接拒（认证/权限问题）时不用等：等也不会变公开，直接换下一种方式
  if [ "$PUB_RC" -ne 0 ] && [ "$CONFLICT" = "0" ]; then
    info "$label 被拒（退出码 $PUB_RC），跳过等待"
    if grep_log 'ENEEDAUTH|E401|E403|need auth'; then
      info "提示：认证没通过。OIDC 需要先在 npm 包设置里登记 Trusted Publisher（repo + release.yml）；"
      info "      token 需要是可发布的 granular token，且 allowed packages 包含本包。"
    fi
    if grep_log 'E402|private packages'; then
      info "提示：E402 表示 scope 不支持私有包。本流水线固定 --access public，"
      info "      若仍出现请检查仓库/组织的 npm 计划与 token 的 package 权限。"
    fi
    return 1
  fi

  local attempts="$POLL_ATTEMPTS"
  if [ "$CONFLICT" = "1" ]; then attempts=$((POLL_ATTEMPTS * 2)); fi
  if wait_public "$method" "$attempts"; then
    set_output method "$method"
    return 0
  fi
  return 1
}

# ---------- 1) Trusted Publishing (OIDC) ----------
if [ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then
  if try_method trusted "可信发布" "trusted publishing (OIDC)"; then exit 0; fi
  info "可信发布没有让版本在等待窗口内可见"
else
  info "没有 OIDC 上下文（ACTIONS_ID_TOKEN_REQUEST_URL 缺失），跳过可信发布"
fi

# ---------- 2) NPM_TOKEN 兜底 ----------
if [ "$CONFLICT" = "1" ]; then
  info "registry 已收录 $SPEC，token 兜底重发没有意义，跳过"
elif [ -n "${NODE_AUTH_TOKEN:-}" ]; then
  if try_method token "token 发布" "NPM_TOKEN"; then exit 0; fi
  info "token 发布同样没有让版本在等待窗口内可见"
else
  info "没有 NODE_AUTH_TOKEN（仓库 Secret NPM_TOKEN 未配置），跳过 token 兜底"
fi

# 两种方式都试过：最后再给 registry 一段纯等待（CDN 刷新可能慢到几分钟）
if [ "$CONFLICT" = "1" ]; then
  log "两种方式都已把版本发出去，最后再等一轮 registry 刷新"
  if wait_public "最终确认" $((POLL_ATTEMPTS * 2)); then
    set_output method "published (registry 刷新后确认)"
    exit 0
  fi
fi

# ---------- 3) 收尾 ----------
# npm publish 返回 0 后 registry 可能还要先做自动校验（status 显示 "validating"），1~3 分钟后版本才可读。
# 所以「窗口内没读到公开版本」不再让流水线失败——只提醒，GitHub Release 照常产出。
if [ "$ACCEPTED" = "1" ]; then
  log "发布请求已被 registry 接受，等待窗口内还没读到公开版本 —— 不阻断发布流程"
  info "npm 正在后台完成自动校验，通常几分钟内可见；稍后可用以下命令确认："
  info "  npm view $SPEC version"
  probe_version_status
  set_output method "publish accepted (visibility pending)"
  exit 0
fi

# ---------- 真失败：没有任何一次发布被 registry 接受 ----------
diagnose
cat <<'EOF'

::error title=Publish rejected::所有发布方式都没有被 registry 接受（不是「等待可见性」的问题）。请按顺序排查：
  1) 上面的「诊断」里看 token 身份（whoami）是否是期望账号；
  2) 仓库 Secret NPM_TOKEN 必须是**可发布**的 granular token（不能是 stage-only / read-only，
     allowed packages 要包含本包）；本地验证：npm login && npm publish --access public --dry-run；
  3) 若想让 OIDC（Trusted Publishing）生效，需在 npm 包设置里登记 Trusted Publisher：
     repo + workflow 文件名 release.yml。
EOF
exit 1
