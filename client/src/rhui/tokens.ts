/**
 * Remote Hub 设计系统：`--rh-*` token 与基础样式（**权威基线**：`dev/ui-redesign/design-system.md`）。
 *
 * 两条硬约束（由 `test/rh-design-system.test.mjs` 守门）：
 *  1. 本文件是**唯一**允许出现字面色值（`#RRGGBB` / `rgba()`）的地方；
 *     `client/src/**` 其余文件（含公共组件）一律只写 `var(--rh-*)`。
 *  2. `client/src/**` 内不再出现非 `--rh-*` 的 CSS 变量定义与 `dsw-alias` 内联兜底色值。
 *
 * 注入方式：`renderRemoteHubPage` / `renderAccountPage` 的根容器里
 * `React.createElement('style', {'data-rh-theme': ''}, RH_CSS)`（幂等；同一份字符串
 * 只会让浏览器解析一次）。外部宿主可以预先在任意祖先元素覆盖 `--rh-*` 整体换肤。
 *
 * 亮暗双套：亮色为默认；`@media (prefers-color-scheme: dark)` 跟随系统，
 * 根容器 `[data-theme="dark"]` 可强制（DSH 侧边弹窗里由宿主决定）。
 *
 * @module dsh-remote-hub/client/rhui/tokens
 */

/** token 定义块（亮色默认值 + 宿主 token 回退）。 */
const LIGHT_TOKENS = `  /* ── 表面 ─────────────────────────────────────────── */
  --rh-bg: var(--dsw-alias-bg-layer-1, #F7F8FA);
  --rh-surface: var(--dsw-alias-bg-layer-2, #FFFFFF);
  --rh-border: var(--dsw-alias-border-l1, #ECECF0);
  --rh-border-strong: var(--dsw-alias-border-l2, #E0E2E8);
  /* ── 文字 ─────────────────────────────────────────── */
  --rh-text: var(--dsw-alias-text-primary, #111418);
  --rh-text-2: var(--dsw-alias-text-secondary, #6B7280);
  --rh-text-3: var(--dsw-alias-text-tertiary, #9CA3AF);
  /* ── 选中态（跟随宿主：分段控件 / 标签的选中底）──────
   * 默认走宿主的 layer-3 / hover 颜色，不用纯黑；只有宿主完全没提供时才回退到
   * 浅灰底。--rh-accent 是「选中底」，强调按钮等需要深底的地方用 --rh-strong。 */
  --rh-accent: var(--dsw-alias-bg-layer-3, #E9EAEE);
  --rh-accent-fg: var(--dsw-alias-text-primary, #111418);
  --rh-accent-hover: var(--dsw-alias-bg-layer-hover, #E2E4E9);
  --rh-strong: #111418;
  --rh-strong-fg: #FFFFFF;
  --rh-strong-hover: #1F2228;
  /* ── 语义色 ───────────────────────────────────────── */
  --rh-blue: var(--dsw-alias-brand-primary, #3B82F6);
  --rh-blue-bg: rgba(59,130,246,.1);
  --rh-blue-ring: rgba(59,130,246,.2);
  --rh-green: var(--dsw-alias-state-success-primary, #10B981);
  --rh-green-bg: rgba(16,185,129,.12);
  --rh-red: var(--dsw-alias-state-error-primary, #EF4444);
  --rh-red-bg: rgba(239,68,68,.1);
  --rh-red-ring: rgba(239,68,68,.2);
  --rh-orange: var(--dsw-alias-state-warning-primary, #F59E0B);
  --rh-orange-bg: rgba(245,158,11,.1);
  --rh-purple: #8B5CF6;
  --rh-purple-bg: rgba(139,92,246,.1);
  /* ── 阴影 ─────────────────────────────────────────── */
  --rh-shadow: 0 1px 3px rgba(17,20,24,.06), 0 4px 16px rgba(17,20,24,.04);
  --rh-shadow-lg: 0 8px 32px rgba(17,20,24,.12);
  --rh-mask: rgba(0,0,0,.4);`

/** 暗色覆盖值（系统偏好与 `[data-theme="dark"]` 共用一份）。 */
const DARK_TOKENS = `  --rh-bg: #17191d;
  --rh-surface: #1f2228;
  --rh-border: #2c3037;
  --rh-border-strong: #3a4048;
  --rh-text: #eceef1;
  --rh-text-2: #a3aab4;
  --rh-text-3: #6d747e;
  --rh-accent: var(--dsw-alias-bg-layer-3, #2c3037);
  --rh-accent-fg: var(--dsw-alias-text-primary, #eceef1);
  --rh-accent-hover: var(--dsw-alias-bg-layer-hover, #343941);
  --rh-strong: #eceef1;
  --rh-strong-fg: #17191d;
  --rh-strong-hover: #ffffff;
  --rh-blue-bg: rgba(59,130,246,.15);
  --rh-green-bg: rgba(16,185,129,.18);
  --rh-red-bg: rgba(239,68,68,.15);
  --rh-orange-bg: rgba(245,158,11,.15);
  --rh-purple-bg: rgba(139,92,246,.15);
  --rh-shadow: 0 1px 3px rgba(0,0,0,.2), 0 4px 16px rgba(0,0,0,.12);
  --rh-shadow-lg: 0 8px 32px rgba(0,0,0,.5);`

/** 字号 / 字体 / 形状 / 间距（两套配色共用）。 */
const SCALE_TOKENS = `  /* ── 字号 ─────────────────────────────────────────── */
  --rh-fs-h1: 24px;
  --rh-fs-h2: 17px;
  --rh-fs-h3: 14px;
  --rh-fs-label: 12px;
  --rh-fs-body: 13px;
  --rh-fs-mono: 12px;
  --rh-fs-stat: 28px;
  --rh-font: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  --rh-mono: "SF Mono", ui-monospace, "Roboto Mono", Menlo, Consolas, monospace;
  /* ── 形状 / 间距 ──────────────────────────────────── */
  --rh-radius: 14px;
  --rh-radius-sm: 10px;
  --rh-radius-pill: 999px;
  --rh-gap: 16px;
  --rh-pad: 20px;
  --rh-pad-mobile: 14px;`

/** `--rh-*` 变量块（供宿主在任意祖先元素上覆盖：`Object.assign(el.style, RH_TOKENS)`）。 */
export const RH_TOKEN_CSS = `.rh-root, [data-rh-scope] {
${LIGHT_TOKENS}
${SCALE_TOKENS}
}`

/** 设计系统完整样式表（token + 组件类 + 响应式）。 */
export const RH_CSS = `${RH_TOKEN_CSS}

/* 暗色：系统偏好（宿主显式 [data-theme="light"] 时不被覆盖） */
@media (prefers-color-scheme: dark) {
  .rh-root:not([data-theme="light"]), [data-rh-scope]:not([data-theme="light"]) {
${DARK_TOKENS}
  }
}
/* 暗色：宿主强制 */
.rh-root[data-theme="dark"], [data-rh-scope][data-theme="dark"] {
${DARK_TOKENS}
}

/* ===== 组件 ===== */
/* 页面容器：自身滚动，背景铺满（宿主 main 槽位高度不可控）。 */
.rh-root {
  width: 100%;
  box-sizing: border-box;
  background: var(--rh-bg);
  color: var(--rh-text);
  font-family: var(--rh-font);
  font-size: var(--rh-fs-body);
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
.rh-root.rh-scroll {
  height: 100%;
  max-height: 100vh;
  overflow-y: auto;
  overflow-x: hidden;
  box-sizing: border-box;
  /* 最外层必须自己留白：宿主 main 槽位没有内边距，否则内容直接贴边。 */
  padding: 24px 24px 56px;
  scroll-padding-top: 92px;
  overscroll-behavior: contain;
}
.rh-root.rh-scroll > .rh-shell { padding: 0; }
/* 嵌入式（宿主已给内边距）：不重复留白。 */
.rh-root.rh-embed { padding: 0; }
.rh-shell { max-width: 1080px; margin: 0 auto; width: 100%; box-sizing: border-box; }
.rh-shell.rh-narrow { max-width: 760px; }

/* ===== 页头（标题栏）=====
 * 吸顶时背景要横跨整宽，标题文字却必须与卡片左缘对齐：
 * 用负外边距把背景铺满，再用等量内边距把内容推回 24px，与卡片左缘严格对齐。 */
.rh-page-head { margin: 0 0 24px; }
.rh-root.rh-scroll:not(.rh-settings) > .rh-shell > .rh-page-head {
  position: sticky; top: -24px; z-index: 20;
  margin: 0 -24px 20px;
  padding: 24px 24px 12px;
  background: var(--rh-bg);
  border-bottom: 1px solid var(--rh-border);
}

/* ===== 设置页：自带滚动容器 + 吸顶页头/步骤条 =====
 * 宿主（DSH Settings 弹窗）高度不可控、内容又很长，页面必须自己滚：
 * .rh-root.rh-settings 是唯一滚动容器，页头与步骤条一起吸顶。
 *
 * 横向留白只有一层：容器 24px。标题、步骤条、卡片全部落在同一条竖线上，
 * 吸顶块的背景与分隔线横跨内容区（两侧各留 16px），不会压到面板边缘。 */
.rh-root.rh-settings {
  height: 100%;
  max-height: 100vh;
  overflow-y: auto;
  overflow-x: hidden;
  box-sizing: border-box;
  padding: 24px 24px 56px;
  scroll-padding-top: 130px;
  overscroll-behavior: contain;
}
.rh-root.rh-settings > .rh-shell { padding: 0; }
.rh-page-sticky {
  position: sticky; top: -24px; z-index: 20;
  background: var(--rh-bg);
  padding: 20px 0 10px;
  margin: 0 0 12px;
  border-bottom: 1px solid var(--rh-border);
}
.rh-page-sticky .rh-page-head { margin: 0 0 12px; }
.rh-page-sticky .rh-page-head { padding: 0; border: 0; position: static; }
.rh-page-body { display: block; min-width: 0; }

/* 紧凑页头（ready 态）：标题与右侧提示同一行，不再占一整段说明。 */
.rh-page-head.is-compact { margin-bottom: 10px; }
.rh-page-head-row { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.rh-page-head-hint {
  font-size: var(--rh-fs-label); color: var(--rh-text-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* ===== 可收起的卡片（设置页区块默认收起）===== */
.rh-section.is-collapsible > .rh-section-head { margin-bottom: 0; }
.rh-section.is-collapsed { padding-top: 14px; padding-bottom: 14px; }
.rh-section.is-collapsed .rh-section-title { font-weight: 600; }
.rh-section-summary {
  font-size: var(--rh-fs-label); color: var(--rh-text-2); font-weight: 500;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 55%;
}
.rh-section-toggle {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 28px; height: 28px; margin-left: 4px; padding: 0;
  border: 1px solid var(--rh-border-strong); border-radius: 50%;
  background: var(--rh-surface); color: var(--rh-text-2);
  cursor: pointer; transition: transform .18s ease, border-color .15s ease, color .15s ease;
}
.rh-section-toggle:hover { color: var(--rh-text); border-color: var(--rh-text-3); }
.rh-section-toggle:focus-visible { outline: 2px solid var(--rh-blue); outline-offset: 2px; }
.rh-caret {
  width: 0; height: 0; border-left: 5px solid transparent; border-right: 5px solid transparent;
  border-top: 6px solid currentColor; transform: translateY(1px);
  transition: transform .18s ease;
}
.rh-section-toggle[aria-expanded="false"] .rh-caret { transform: rotate(-90deg) translateX(2px); }
.rh-section.is-collapsible > .rh-section-head + .rh-section-desc { margin-top: 8px; }

/* 步骤条（登录 → 两步验证 → 设置） */
.rh-steps {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  list-style: none; margin: 0; padding: 0;
}
.rh-step {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: var(--rh-fs-label); font-weight: 500; color: var(--rh-text-3);
  padding: 3px 10px 3px 4px; border-radius: var(--rh-radius-pill);
  background: var(--rh-bg);
}
.rh-step-no {
  width: 18px; height: 18px; border-radius: 50%; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700;
  background: var(--rh-border); color: var(--rh-text-2);
}
.rh-step.is-current { color: var(--rh-text); background: var(--rh-surface); border: 1px solid var(--rh-border-strong); }
.rh-step.is-current .rh-step-no { background: var(--rh-strong); color: var(--rh-strong-fg); }
.rh-step.is-done { color: var(--rh-green); }
.rh-step.is-done .rh-step-no { background: var(--rh-green-bg); color: var(--rh-green); }
.rh-h1 {
  margin: 0; font-size: var(--rh-fs-h1); font-weight: 700; letter-spacing: -.3px;
  color: var(--rh-text); display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
}
.rh-lead { margin: 6px 0 0; font-size: var(--rh-fs-body); color: var(--rh-text-2); }
.rh-page-title { min-width: 0; overflow-wrap: anywhere; }

/* 卡片 / Section */
.rh-card {
  display: block; box-sizing: border-box; min-width: 0;
  background: var(--rh-surface); border: 1px solid var(--rh-border);
  border-radius: var(--rh-radius); padding: var(--rh-pad);
  box-shadow: var(--rh-shadow); margin: 0 0 20px;
}
.rh-card.is-danger { border-color: var(--rh-red); box-shadow: none; }
.rh-card.is-flush { padding: 0; overflow: hidden; }
.rh-section { display: block; margin: 0 0 20px; }
.rh-section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.rh-section.is-card > .rh-section-head { margin-bottom: 4px; }
.rh-section-title {
  margin: 0; font-size: var(--rh-fs-h3); font-weight: 600; color: var(--rh-text);
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0;
}
.rh-section-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rh-section-desc { margin: 4px 0 12px; font-size: var(--rh-fs-label); color: var(--rh-text-2); }
.rh-section-body { display: block; min-width: 0; }

/* 按钮 */
.rh-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 34px; padding: 7px 14px; box-sizing: border-box;
  font-family: inherit; font-size: var(--rh-fs-body); font-weight: 600; line-height: 1;
  border-radius: var(--rh-radius-sm); border: 1px solid var(--rh-border-strong);
  background: var(--rh-surface); color: var(--rh-text);
  cursor: pointer; white-space: nowrap; transition: opacity .15s ease, background .15s ease, border-color .15s ease;
  touch-action: manipulation;
}
.rh-btn:hover:not(:disabled) { opacity: .88; }
.rh-btn:active:not(:disabled) { opacity: .72; }
.rh-btn:focus-visible { outline: 2px solid var(--rh-blue); outline-offset: 2px; }
.rh-btn:disabled { opacity: .4; cursor: not-allowed; pointer-events: none; }
.rh-btn.is-primary { background: var(--rh-blue); border-color: var(--rh-blue); color: #fff; }
.rh-btn.is-danger { background: var(--rh-red-bg); border-color: var(--rh-red); color: var(--rh-red); }
.rh-btn.is-ghost { background: transparent; border-color: transparent; color: var(--rh-text-2); }
.rh-btn.is-ghost:hover:not(:disabled) { color: var(--rh-text); background: var(--rh-bg); }
.rh-btn.is-selected { background: var(--rh-accent); border-color: var(--rh-border-strong); color: var(--rh-accent-fg); }
.rh-btn.is-small { height: 28px; padding: 4px 10px; font-size: var(--rh-fs-label); font-weight: 500; }
.rh-btn.is-large { height: 40px; padding: 9px 20px; }
.rh-btn.is-block { width: 100%; }
.rh-spinner {
  width: 12px; height: 12px; flex: none; border-radius: 50%;
  border: 2px solid currentColor; border-right-color: transparent;
  animation: rh-spin .7s linear infinite;
}
@keyframes rh-spin { to { transform: rotate(360deg) } }

/* 输入 */
.rh-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; margin: 0 0 12px; }
.rh-field-label { font-size: var(--rh-fs-label); font-weight: 500; color: var(--rh-text-2); }
.rh-field-hint { font-size: var(--rh-fs-label); color: var(--rh-text-3); }
.rh-field-error { font-size: var(--rh-fs-label); color: var(--rh-red); }
.rh-input, .rh-textarea, .rh-select {
  width: 100%; min-width: 0; box-sizing: border-box;
  font-family: inherit; font-size: var(--rh-fs-body); color: var(--rh-text);
  background: var(--rh-surface); border: 1px solid var(--rh-border-strong);
  border-radius: var(--rh-radius-sm); padding: 8px 12px;
}
.rh-input, .rh-select { height: 36px; }
.rh-textarea { min-height: 88px; line-height: 1.55; resize: vertical; }
.rh-input::placeholder, .rh-textarea::placeholder { color: var(--rh-text-3); }
.rh-input:hover:not(:disabled), .rh-select:hover:not(:disabled), .rh-textarea:hover:not(:disabled) { border-color: var(--rh-text-3); }
.rh-input:focus, .rh-select:focus, .rh-textarea:focus {
  border-color: var(--rh-blue); outline: 2px solid var(--rh-blue-ring); outline-offset: 0;
}
.rh-input.is-error, .rh-select.is-error, .rh-textarea.is-error { border-color: var(--rh-red); }
.rh-input.is-error:focus, .rh-select.is-error:focus, .rh-textarea.is-error:focus {
  outline-color: var(--rh-red-ring);
}
.rh-input.is-mono, .rh-textarea.is-mono, .rh-code {
  font-family: var(--rh-mono); font-size: var(--rh-fs-mono);
}
.rh-input:disabled, .rh-select:disabled, .rh-textarea:disabled { opacity: .5; cursor: not-allowed; }
.rh-input.is-otp {
  height: 44px; font-family: var(--rh-mono); font-size: 20px; letter-spacing: 6px; text-align: center;
}
.rh-input-wrap { position: relative; display: flex; align-items: center; }
.rh-input-wrap > .rh-input { padding-right: 44px; }
.rh-eye {
  position: absolute; right: 4px; top: 3px; height: 30px; width: 34px;
  border: 0; background: transparent; color: var(--rh-text-2); cursor: pointer; border-radius: 6px;
}
.rh-eye:hover { color: var(--rh-text); }

/* Pill / 状态标签 */
.rh-pill {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px; border-radius: var(--rh-radius-pill);
  font-size: var(--rh-fs-label); font-weight: 500; line-height: 1.4;
  background: var(--rh-bg); color: var(--rh-text-2); border: 1px solid transparent;
  white-space: nowrap;
}
.rh-pill.is-online { background: var(--rh-green-bg); color: var(--rh-green); }
.rh-pill.is-offline { background: var(--rh-bg); color: var(--rh-text-3); }
.rh-pill.is-error { background: var(--rh-red-bg); color: var(--rh-red); }
.rh-pill.is-warning { background: var(--rh-orange-bg); color: var(--rh-orange); }
.rh-pill.is-neutral { background: var(--rh-bg); color: var(--rh-text-2); border-color: var(--rh-border-strong); }
.rh-pill.is-info { background: var(--rh-blue-bg); color: var(--rh-blue); }
.rh-pill.is-purple { background: var(--rh-purple-bg); color: var(--rh-purple); }
.rh-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: none; }

/* Notice */
.rh-notice {
  display: block; box-sizing: border-box; margin: 0 0 12px;
  padding: 10px 14px; border-radius: var(--rh-radius-sm);
  border-left: 3px solid var(--rh-blue); background: var(--rh-blue-bg);
  color: var(--rh-text); font-size: var(--rh-fs-body);
}
.rh-notice.is-success { border-left-color: var(--rh-green); background: var(--rh-green-bg); }
.rh-notice.is-error { border-left-color: var(--rh-red); background: var(--rh-red-bg); color: var(--rh-red); }
.rh-notice.is-warning { border-left-color: var(--rh-orange); background: var(--rh-orange-bg); }

/* Toggle */
.rh-toggle {
  display: inline-flex; align-items: center; gap: 10px;
  border: 0; background: transparent; padding: 0; cursor: pointer;
  font-family: inherit; font-size: var(--rh-fs-body); color: var(--rh-text);
}
.rh-toggle:focus-visible { outline: 2px solid var(--rh-blue); outline-offset: 3px; border-radius: var(--rh-radius-pill); }
.rh-toggle:disabled { opacity: .4; cursor: not-allowed; }
.rh-switch {
  width: 42px; height: 24px; border-radius: 999px; flex: none;
  background: var(--rh-border-strong); position: relative;
  transition: background .18s ease;
}
.rh-switch::after {
  content: ""; position: absolute; top: 2px; left: 2px;
  width: 20px; height: 20px; border-radius: 50%;
  background: var(--rh-surface); transition: left .18s ease;
}
.rh-toggle[aria-checked="true"] .rh-switch { background: var(--rh-green); }
.rh-toggle[aria-checked="true"] .rh-switch::after { left: 20px; }

/* Segmented */
.rh-seg {
  display: inline-flex; align-items: stretch; gap: 4px; flex-wrap: wrap;
  padding: 3px; border-radius: var(--rh-radius-pill);
  background: var(--rh-bg); border: 1px solid var(--rh-border);
}
.rh-seg-btn {
  border: 1px solid transparent; background: transparent; color: var(--rh-text-2);
  font-family: inherit; font-size: var(--rh-fs-label); font-weight: 500;
  padding: 5px 12px; border-radius: var(--rh-radius-pill); cursor: pointer; white-space: nowrap;
}
.rh-seg-btn:hover:not(:disabled):not([aria-pressed="true"]) { background: var(--rh-accent-hover); color: var(--rh-text); }
.rh-seg-btn[aria-pressed="true"] {
  background: var(--rh-accent); border-color: var(--rh-border-strong); color: var(--rh-accent-fg);
  box-shadow: var(--rh-shadow);
}
/* 选中项悬停时保持浅色选中底（不再反转变黑）。 */
.rh-seg-btn[aria-pressed="true"]:hover:not(:disabled) {
  background: var(--rh-accent-hover); color: var(--rh-accent-fg);
}
.rh-seg-btn:disabled { opacity: .4; cursor: not-allowed; }
.rh-seg-btn:focus-visible { outline: 2px solid var(--rh-blue); outline-offset: 1px; }

/* Skeleton */
.rh-skeleton {
  height: 18px; border-radius: 8px; margin-bottom: 12px;
  background: linear-gradient(90deg, var(--rh-border) 25%, var(--rh-surface) 37%, var(--rh-border) 63%);
  background-size: 400% 100%;
  animation: rh-shimmer 1.4s ease infinite;
}
@keyframes rh-shimmer { from { background-position: 100% 50% } to { background-position: 0 50% } }

/* 空状态 */
.rh-empty { text-align: center; padding: 32px 20px; color: var(--rh-text-3); font-size: var(--rh-fs-body); }
.rh-empty-ic { font-size: 32px; line-height: 1; margin-bottom: 10px; }
.rh-empty-title { font-size: var(--rh-fs-h3); font-weight: 600; color: var(--rh-text); margin-bottom: 4px; }
.rh-empty-desc { margin: 0 auto 12px; max-width: 420px; color: var(--rh-text-2); font-size: var(--rh-fs-label); }

/* 行 / 列表 */
.rh-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rh-row.is-wrap { flex-wrap: wrap; }
.rh-stack { display: flex; flex-direction: column; gap: var(--rh-gap); }
.rh-divider { height: 1px; background: var(--rh-border); border: 0; margin: 16px 0; }
.rh-kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(160px, 100%), 1fr)); gap: 8px 16px; }
/*
 * 出站卡片的四项事实：**自适配列数**，每项永远单行。
 *
 * 列数只允许 4 / 2 / 1（绝不出现 3 列这种半残的排法）：容器放得下 4 列就四个排一行；
 * 否则 2×2；再窄就一列一个。每格最小宽度用 --rh-fact-min（默认 150px，够放
 * 「最近连接 + 2026/11/15 19:14:23」这一项），值一律 nowrap，不折行也不截断。
 */
.rh-dev .rh-kv {
  --rh-fact-min: 150px;
  --rh-fact-gap: 20px;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px var(--rh-fact-gap);
  margin: 2px 0;
}
/* 4 列放不下 → 2 列（2×2）。门槛 = 4 × 最小格宽 + 3 × 间距。 */
@container (max-width: 659px) {
  .rh-dev .rh-kv { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
/* 2 列也放不下 → 1 列（4 行）。 */
@container (max-width: 359px) {
  .rh-dev .rh-kv { grid-template-columns: minmax(0, 1fr); }
}
/* 容器查询需要卡片本身是容器。 */
.rh-dev { container-type: inline-size; }
.rh-fact-item { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.rh-fact-item .rh-fact-key { font-size: var(--rh-fs-label); color: var(--rh-text-3); }
.rh-fact-item .rh-fact-value {
  font-size: var(--rh-fs-body); font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: clip;
}
/* 键 / 值横排的那一版（设备页「当前指向」等单值行）。 */
.rh-fact { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; min-width: 0; }
.rh-fact-key { font-size: var(--rh-fs-label); color: var(--rh-text-3); white-space: nowrap; }
.rh-fact-value { font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
.rh-k { font-size: var(--rh-fs-label); color: var(--rh-text-3); }
.rh-v { font-size: var(--rh-fs-body); color: var(--rh-text); font-weight: 600; overflow-wrap: anywhere; margin-top: 2px; }
.rh-mono { font-family: var(--rh-mono); font-size: var(--rh-fs-mono); overflow-wrap: anywhere; }
.rh-muted { color: var(--rh-text-2); }
.rh-meta { margin: 6px 0 0; font-size: var(--rh-fs-label); color: var(--rh-text-3); overflow-wrap: anywhere; }

/* 列表行（客户端 / 设备 / 子账号） */
.rh-item {  display: flex; flex-direction: column; gap: 8px;
  box-sizing: border-box; min-width: 0; margin: 0 0 10px;
  padding: 14px 16px; border-radius: var(--rh-radius-sm);
  border: 1px solid var(--rh-border); border-left: 3px solid var(--rh-green);
  background: var(--rh-surface);
}
.rh-item.is-offline { border-left-color: var(--rh-border-strong); }
.rh-item.is-error { border-left-color: var(--rh-red); }
.rh-item.is-warning { border-left-color: var(--rh-orange); }
.rh-item.is-disabled { opacity: .45; }
.rh-item-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.rh-item-name { font-size: var(--rh-fs-h3); font-weight: 600; color: var(--rh-text); overflow-wrap: anywhere; }
.rh-item-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rh-item.is-grid .rh-item-actions { justify-content: flex-end; }
/* 「可信客户端」行：两个下拉框并排两列，等宽；撤销按钮靠右。 */
.rh-select-pair {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 8px;
  flex: 1 1 240px;
  min-width: 0;
}
.rh-select-pair .rh-select { width: 100%; min-width: 0; }
.rh-item-actions > .rh-btn { margin-left: auto; }
/* 「还有 N 台未显示 / 显示全部」：列表底部的轻量行。 */
.rh-list-more {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--rh-border);
}

/* 设备卡
 * 列数由可用宽度决定：每张卡至少要放下「图标 + 一行地址 + 状态 pill + 右侧内边距」
 * （约 360px），放不下就退到单列。用 auto-fit 而不是 auto-fill：单列时卡片铺满，
 * 不会在图省下一列的位置留空。 */
.rh-devgrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr));
  gap: var(--rh-gap);
}
.rh-dev {
  display: flex; flex-direction: column; gap: 8px; min-width: 0; box-sizing: border-box;
  background: var(--rh-surface); border: 1px solid var(--rh-border);
  border-radius: var(--rh-radius); padding: 14px 16px; box-shadow: var(--rh-shadow);
}
.rh-dev-top { display: flex; align-items: flex-start; gap: 10px; flex-wrap: wrap; }
.rh-dev-ico {
  width: 36px; height: 36px; border-radius: 10px; background: var(--rh-bg); flex: none;
  display: flex; align-items: center; justify-content: center; font-size: 17px;
}
/* 标题/地址优先占用整行剩余宽度；状态 pill 在换行时落到下一行，而不是挤压正文。 */
.rh-dev-meta { flex: 1 1 200px; min-width: 0; }
/* 标题与地址都必须能断行：窄列下 URL 不许按字符竖排。 */
.rh-dev-nm {
  font-size: var(--rh-fs-h3); font-weight: 700;
  overflow-wrap: anywhere; word-break: break-word; line-height: 1.35;
}
/* 副标题是「设备名 · 指纹」这类补充信息，单行省略即可，绝不折行。 */
.rh-dev-sub {
  font-size: var(--rh-fs-mono); color: var(--rh-text-3);
  overflow-wrap: normal; word-break: normal;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  margin-top: 2px;
}
/* 右上角状态 pill 不参与压缩，也不允许把标题挤成一条竖线。 */
.rh-dev-top > .rh-pill { flex: none; align-self: flex-start; margin-top: 2px; margin-left: auto; }
.rh-dev-foot { display: flex; align-items: center; gap: 8px; margin-top: auto; flex-wrap: wrap; }
.rh-dev.is-revoked .rh-dev-meta { opacity: .6; }
.rh-dev.is-offline .rh-dev-ico { filter: grayscale(1); }
.rh-dev.is-offline .rh-dev-nm { color: var(--rh-text-2); }

/* 统计 */
.rh-statgrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--rh-gap); }
.rh-stat {
  min-width: 0; box-sizing: border-box; padding: 16px 18px;
  background: var(--rh-surface); border: 1px solid var(--rh-border);
  border-radius: var(--rh-radius); box-shadow: var(--rh-shadow);
}
.rh-slbl { font-size: var(--rh-fs-label); color: var(--rh-text-3); margin-bottom: 8px; }
.rh-snum {
  font-family: var(--rh-mono); font-size: var(--rh-fs-stat); font-weight: 700;
  letter-spacing: -.5px; line-height: 1; color: var(--rh-text);
}
.rh-scap { font-size: var(--rh-fs-label); color: var(--rh-text-2); margin-top: 8px; }
.rh-chartgrid { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--rh-gap); }
.rh-chartbox {
  min-width: 0; box-sizing: border-box; padding: 16px 18px;
  background: var(--rh-surface); border: 1px solid var(--rh-border);
  border-radius: var(--rh-radius); box-shadow: var(--rh-shadow);
}
.rh-ct { font-size: var(--rh-fs-body); font-weight: 700; }
.rh-cs { font-size: var(--rh-fs-label); color: var(--rh-text-3); margin: 2px 0 12px; }
.rh-heat { display: grid; grid-template-columns: repeat(24, 1fr); gap: 3px; margin-top: 10px; }
.rh-heat i { aspect-ratio: 1; border-radius: 2px; background: var(--rh-border); }

/* 配置行 */
.rh-cfg {
  overflow: hidden; box-sizing: border-box;
  background: var(--rh-surface); border: 1px solid var(--rh-border);
  border-radius: var(--rh-radius); box-shadow: var(--rh-shadow);
}
.rh-cfg-row {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 14px 18px; border-top: 1px solid var(--rh-border); flex-wrap: wrap;
}
.rh-cfg-row:first-child { border-top: 0; }
.rh-cfg-label { min-width: 0; flex: 1 1 200px; }
.rh-cfg-title { font-size: var(--rh-fs-h3); font-weight: 600; color: var(--rh-text); }
.rh-cfg-desc { font-size: var(--rh-fs-label); color: var(--rh-text-3); margin-top: 2px; }
.rh-cfg-control { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }

/* 折叠区 */
.rh-collapse {
  margin: 0 0 12px; border: 1px solid var(--rh-border);
  border-radius: var(--rh-radius-sm); background: var(--rh-surface);
}
.rh-collapse > summary {
  padding: 12px 16px; font-size: var(--rh-fs-body); font-weight: 600;
  color: var(--rh-text-2); cursor: pointer; border-radius: var(--rh-radius-sm);
}
.rh-collapse > summary:hover { color: var(--rh-text); }
.rh-collapse > summary:focus-visible { outline: 2px solid var(--rh-blue); outline-offset: -2px; }
.rh-collapse-body { padding: 0 16px 14px; font-size: var(--rh-fs-label); color: var(--rh-text-2); }
.rh-collapse-body ul { margin: 0; padding: 0; list-style: none; }
.rh-collapse-body li { padding: 2px 0; overflow-wrap: anywhere; font-family: var(--rh-mono); }

/* 诊断网格 */
.rh-diag { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 20px; }
.rh-diag > div { min-width: 0; padding: 12px 0; border-bottom: 1px solid var(--rh-border); }
.rh-diag .rh-v { font-family: var(--rh-mono); font-size: var(--rh-fs-mono); font-weight: 400; overflow-wrap: anywhere; }

/* 日志 */
.rh-loglist { display: flex; flex-direction: column; gap: 2px; font-size: var(--rh-fs-label); }
.rh-logrow {
  display: grid; grid-template-columns: 68px 44px auto minmax(0, 1fr); gap: 8px;
  align-items: baseline; padding: 4px 0; border-top: 1px dashed var(--rh-border);
  color: var(--rh-text-2); min-width: 0;
}
.rh-logrow:first-child { border-top: 0; }
.rh-logtime { font-family: var(--rh-mono); color: var(--rh-text-3); }
.rh-loglevel { font-weight: 600; }
.rh-log-error .rh-loglevel { color: var(--rh-red); }
.rh-log-warn .rh-loglevel { color: var(--rh-orange); }
.rh-log-info .rh-loglevel { color: var(--rh-green); }
.rh-logtitle { color: var(--rh-text); font-weight: 500; }
.rh-logpath { font-family: var(--rh-mono); font-size: 11px; color: var(--rh-text-3); overflow-wrap: anywhere; }
.rh-logdetail { grid-column: 3 / -1; color: var(--rh-text-3); overflow-wrap: anywhere; }

/* 口令规则清单 */
.rh-rules {
  list-style: none; padding: 0; margin: 8px 0 0;
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px 16px;
  font-size: var(--rh-fs-label);
}
.rh-rules li { color: var(--rh-text-3); }
.rh-rules li[data-ok="true"] { color: var(--rh-green); }

/* 可复制的等宽值 */
.rh-codebox {
  display: block; box-sizing: border-box; width: 100%; overflow-wrap: anywhere;
  padding: 10px 14px; border-radius: var(--rh-radius-sm);
  background: var(--rh-bg); border: 1px solid var(--rh-border-strong);
  font-family: var(--rh-mono); font-size: var(--rh-fs-mono); color: var(--rh-text);
}
.rh-inline-code {
  font-family: var(--rh-mono); font-size: var(--rh-fs-mono);
  background: var(--rh-bg); border-radius: 4px; padding: 1px 5px; overflow-wrap: anywhere;
}
.rh-link {
  border: 0; background: transparent; padding: 0; cursor: pointer; font-family: inherit;
  font-size: inherit; color: var(--rh-blue); text-decoration: underline;
}

/* 内联二次确认 / 提权框 */
.rh-inline-panel {
  box-sizing: border-box; margin-top: 8px; padding: 12px 14px;
  border-radius: var(--rh-radius-sm); border: 1px solid var(--rh-orange);
  border-left: 3px solid var(--rh-orange); background: var(--rh-orange-bg);
}
.rh-inline-panel.is-danger {
  border-left-color: var(--rh-red); background: var(--rh-red-bg); border-color: var(--rh-red);
}
.rh-inline-panel .rh-input, .rh-inline-panel .rh-select { background: var(--rh-surface); }

/* 二维码（唯一允许的字面色值：白底黑模块，保证暗色下可扫） */
.rh-qr {
  display: block; flex: none; background: #FFFFFF; border-radius: 8px;
  border: 1px solid var(--rh-border); width: 120px; height: 120px;
}
.rh-qr.is-large { width: 216px; height: 216px; }
.rh-qr-wrap { display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap; }
.rh-qr-col { flex: 0 0 auto; display: flex; justify-content: flex-start; }
.rh-qr-copy { flex: 1 1 240px; min-width: 0; }
.rh-qr-placeholder {
  width: 216px; height: 216px; box-sizing: border-box; flex: none;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  border: 1px dashed var(--rh-border-strong); border-radius: var(--rh-radius);
  background: var(--rh-bg); color: var(--rh-text-3); font-size: var(--rh-fs-label);
  text-align: center; padding: 12px;
}
.rh-countdown { height: 6px; border-radius: 4px; background: var(--rh-border); overflow: hidden; margin-top: 6px; }
.rh-countdown > i { display: block; height: 100%; border-radius: 4px; background: var(--rh-strong); transition: width .4s ease; }
.rh-cold { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 10px; color: var(--rh-text-3); font-size: var(--rh-fs-label); }
.rh-dev .rh-kv { margin: 2px 0; }

/* ===== 响应式（同一 DOM：只调 padding / gap / 字号，不改结构）===== */
@media (max-width: 899px) {
  .rh-root h1, .rh-h1 { font-size: 20px; }
  .rh-card { padding: 16px; }
  .rh-shell { max-width: none; }
}
@media (max-width: 479px) {
  .rh-root h1, .rh-h1 { font-size: 18px; }
  .rh-card { padding: var(--rh-pad-mobile); margin-bottom: 14px; }
  .rh-section { margin-bottom: 14px; }
  .rh-snum { font-size: 24px; }
  .rh-statgrid { gap: 12px; }
  .rh-rules { grid-template-columns: minmax(0, 1fr); }
  .rh-qr-wrap { flex-direction: column; }
  .rh-qr { width: 100%; max-width: 200px; height: auto; aspect-ratio: 1; margin: 0 auto; }
  .rh-btn { min-height: 40px; height: auto; white-space: normal; }
  .rh-btn.is-small { min-height: 34px; }
  .rh-item-actions { width: 100%; }
  .rh-cfg-control { width: 100%; justify-content: flex-start; }
  .rh-input, .rh-select, .rh-textarea { font-size: 16px; height: 40px; }
  .rh-textarea { height: auto; }
  .rh-diag { grid-template-columns: minmax(0, 1fr); }
  .rh-heat { grid-template-columns: repeat(18, 1fr); }
  .rh-logrow { grid-template-columns: 68px minmax(0, 1fr); }
  .rh-logdetail { grid-column: 1 / -1; }
}
@media (hover: none) {
  .rh-btn { touch-action: manipulation; }
}
@media (prefers-reduced-motion: reduce) {
  .rh-btn, .rh-switch, .rh-switch::after, .rh-skeleton, .rh-spinner { transition: none; animation: none; }
}
`
