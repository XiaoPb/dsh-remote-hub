/**
 * 公共 UI 组件（纯函数式 `React.createElement` 封装，不引入组件库）。
 *
 * 约束（`test/rh-design-system.test.mjs` 守门）：
 * - 组件内**不得**出现字面色值，样式类一律 `rh-` 前缀且只引用 `var(--rh-*)`；
 * - 不新增 CSS 变量；不写非标准字号（`font-size` 只出现在 `tokens.ts`）；
 * - 每个可交互组件覆盖 default / hover / active / disabled / loading（见 `tokens.ts`）。
 *
 * 组件只做渲染，**不带业务状态**：所有值与回调由调用方给出。
 *
 * @module dsh-remote-hub/client/rhui/components
 */
import React from 'react'

/** 把条件类名拼成 `className`。 */
export function cx(...names: readonly (string | false | null | undefined)[]): string {
  return names.filter((name): name is string => typeof name === 'string' && name !== '').join(' ')
}

/** 透传测试属性（页面 testid 由调用方决定，组件不做映射）。 */
export type Testable = { 'data-testid'?: string }

// ── Card ─────────────────────────────────────────────────────────────────────

/** 卡片属性。 */
export interface CardProps extends Testable {
  /** `danger` = 红色描边（危险操作容器）。 */
  tone?: 'default' | 'danger'
  /** 去掉内边距（内部自己分行渲染时用）。 */
  flush?: boolean
  /** 薄卡片（设备行等）。 */
  className?: string
  children?: React.ReactNode
  /** 任意附加 DOM 属性（`data-*` / `id` 等）。 */
  [key: `data-${string}`]: unknown
}

/**
 * 卡片容器（design-system §6.4）。
 * @param props - 卡片属性。
 * @returns 卡片节点。
 */
export function Card({ tone = 'default', flush = false, className, children, ...rest }: CardProps): React.ReactElement {
  return React.createElement('div', {
    ...rest,
    className: cx('rh-card', tone === 'danger' && 'is-danger', flush && 'is-flush', className),
  }, children)
}

// ── Section ──────────────────────────────────────────────────────────────────

/** 区块属性（design-system §6.5）：卡片容器 + 标题行 + 描述行 + 内容区。 */
export interface SectionProps extends Testable {
  title: React.ReactNode
  /** 标题右侧操作区。 */
  actions?: React.ReactNode
  /** 标题下方的说明行。 */
  desc?: React.ReactNode
  /** 是否套一层卡片（设置页用；设备页区块自带卡片时可关掉）。 */
  card?: boolean
  /**
   * 可收起：标题右上角出现展开/收起按钮，内容默认收起（摘要行仍在）。
   * 设置页的每个卡片都用这个，避免一屏塞满。
   */
  collapsible?: boolean
  /** 当前是否已展开（受控；`collapsible` 时由页面状态决定）。 */
  expanded?: boolean
  /** 展开 / 收起回调（受控时必给）。 */
  onToggle?: () => void
  /** 收起时在标题行右侧显示的摘要（如「2 个客户端」「已启用」）。 */
  summary?: React.ReactNode
  tone?: 'default' | 'danger'
  className?: string
  children?: React.ReactNode
  [key: `data-${string}`]: unknown
}

/**
 * 设置页/设备页区块。
 * @param props - 区块属性。
 * @returns 区块节点。
 */
export function Section({
  title,
  actions,
  desc,
  card = true,
  collapsible = false,
  expanded = true,
  onToggle,
  summary,
  tone = 'default',
  className,
  children,
  ...rest
}: SectionProps): React.ReactElement {
  // 标题 / 描述 / 操作区里经常直接塞组件元素（`Pill` / `Button` / `Segmented`）。
  // 用 Fragment 包住即可在**渲染树**里原地展开，页面渲染函数仍是纯函数
  // （不实例化子组件），测试也能按 `data-testid` 直接找到它们。
  const open = !collapsible || expanded
  const toggle = collapsible
    ? React.createElement('button', {
      type: 'button',
      className: 'rh-section-toggle',
      'data-testid': 'section-toggle',
      'aria-expanded': open ? 'true' : 'false',
      title: open ? '收起' : '展开',
      'aria-label': open ? '收起' : '展开',
      onClick: () => { onToggle?.() },
    }, React.createElement('span', { className: 'rh-caret', 'aria-hidden': 'true' }))
    : null
  const head = React.createElement('div', { className: 'rh-section-head' },
    React.createElement('h2', { className: 'rh-section-title' },
      React.createElement(React.Fragment, null, title)),
    React.createElement('div', { className: 'rh-section-actions' },
      // 收起时把摘要露出来（如「2 个客户端」），展开时换成操作区。
      collapsible && !open && summary !== undefined && summary !== null
        ? React.createElement('span', { className: 'rh-section-summary' }, summary)
        : null,
      open && actions !== undefined && actions !== null
        ? React.createElement(React.Fragment, null, actions)
        : null,
      toggle))
  const body = React.createElement(React.Fragment, null,
    head,
    open
      ? React.createElement(React.Fragment, null,
        desc === undefined || desc === null
          ? null
          : React.createElement('p', { className: 'rh-section-desc' }, React.createElement(React.Fragment, null, desc)),
        children === undefined || children === null
          ? null
          : React.createElement('div', { className: 'rh-section-body' }, React.createElement(React.Fragment, null, children)))
      : null)
  return React.createElement(card ? 'section' : 'div', {
    ...rest,
    className: cx(
      'rh-section',
      card && 'is-card',
      card && 'rh-card',
      collapsible && 'is-collapsible',
      collapsible && !open && 'is-collapsed',
      tone === 'danger' && 'is-danger',
      className,
    ),
    ...(collapsible ? { 'data-collapsed': open ? 'false' : 'true' } : {}),
  }, body)
}

// ── Button ───────────────────────────────────────────────────────────────────

/** 按钮变体（design-system §6.1）。 */
export type ButtonVariant = 'primary' | 'default' | 'danger' | 'ghost'

/** 按钮属性。 */
export interface ButtonProps extends Testable {
  variant?: ButtonVariant
  size?: 'small' | 'default' | 'large'
  loading?: boolean
  disabled?: boolean
  block?: boolean
  /** 选中态（用于 segmented 组成员或可切换按钮）。 */
  selected?: boolean
  type?: 'button' | 'submit'
  title?: string
  /** 无障碍名称（图标按钮必填，design-system §10.7）。 */
  ariaLabel?: string
  /** 布局微调（只允许 `margin*` / `width` 这类不涉及色值字号的项）。 */
  style?: React.CSSProperties
  /** 焦点管理用（确认框默认焦点落在「取消」）。 */
  ref?: React.Ref<HTMLButtonElement>
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  children?: React.ReactNode
  [key: `data-${string}`]: unknown
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'is-primary',
  default: '',
  danger: 'is-danger',
  ghost: 'is-ghost',
}

/**
 * 按钮：loading 时在文字前加 spinner，宽度保持（不跳变）。
 * @param props - 按钮属性。
 * @returns 按钮节点。
 */
export function Button({
  variant = 'default',
  size = 'default',
  loading = false,
  disabled = false,
  block = false,
  selected = false,
  type = 'button',
  title,
  ariaLabel,
  style,
  ref,
  onClick,
  children,
  ...rest
}: ButtonProps): React.ReactElement {
  const busy = loading || disabled
  return React.createElement('button', {
    // 顺序有意固定：`data-testid` 直连 `disabled` 是既有测试断言
    // （`/data-testid="change-password-apply" disabled/`），其余属性其后。
    ...rest,
    disabled: busy,
    'aria-busy': loading ? 'true' : undefined,
    className: cx(
      'rh-btn',
      VARIANT_CLASS[variant],
      size === 'small' && 'is-small',
      size === 'large' && 'is-large',
      block && 'is-block',
      selected && 'is-selected',
    ),
    type,
    ...(ref === undefined || ref === null ? {} : { ref }),
    ...(title === undefined ? {} : { title }),
    ...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel }),
    ...(style === undefined ? {} : { style }),
    ...(onClick === undefined ? {} : { onClick }),
  },
  loading
    ? React.createElement(React.Fragment, null,
      React.createElement('span', { className: 'rh-spinner', 'aria-hidden': 'true' }),
      children)
    : children)
}

// ── Field / Input / Textarea ─────────────────────────────────────────────────

/** 字段容器属性（label + hint + error + 控件）。 */
export interface FieldProps {
  label: React.ReactNode
  hint?: React.ReactNode
  error?: React.ReactNode
  /** 控件的 id（与 label 的 htmlFor 对齐）。 */
  htmlFor?: string
  children?: React.ReactNode
  className?: string
}

/**
 * 表单字段（design-system §6.2）。
 * @param props - 字段属性。
 * @returns 字段节点。
 */
export function Field({ label, hint, error, htmlFor, children, className }: FieldProps): React.ReactElement {
  return React.createElement('div', { className: cx('rh-field', className) },
    React.createElement('label', htmlFor === undefined ? { className: 'rh-field-label' } : { className: 'rh-field-label', htmlFor },
      React.createElement(React.Fragment, null, label)),
    React.createElement(React.Fragment, null, children),
    error === undefined || error === null || error === false
      ? null
      : React.createElement('span', { className: 'rh-field-error', role: 'alert' }, React.createElement(React.Fragment, null, error)),
    hint === undefined || hint === null || hint === false
      ? null
      : React.createElement('span', { className: 'rh-field-hint' }, React.createElement(React.Fragment, null, hint)))
}

/** 输入框属性。 */
export interface InputProps extends Testable {
  type?: string
  value: string
  placeholder?: string
  autoComplete?: string
  inputMode?: 'text' | 'numeric' | 'url' | 'email' | 'decimal' | 'tel' | 'search' | 'none'
  mono?: boolean
  error?: boolean
  /** 一次性验证码样式（大号等宽居中）。 */
  otp?: boolean
  disabled?: boolean
  readOnly?: boolean
  maxLength?: number
  min?: number
  max?: number
  /** 口令显示/隐藏切换按钮。 */
  reveal?: boolean
  ariaLabel?: string
  title?: string
  onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void
  autoFocus?: boolean
  name?: string
}

/**
 * 口令输入框（含显示/隐藏切换）。
 *
 * 为什么单独成组件：`renderAccountPage` 等渲染函数是**纯函数**（测试直接调用它
 * 拿元素树，不挂载 React），而显示/隐藏切换需要状态，所以带状态的部分必须
 * 收敛到一个 hooks 组件里，而不是在纯函数里 `React.useState`。
 */
export interface PasswordInputProps extends Omit<InputProps, 'type' | 'reveal'> {
  /** 口令不可见时的类型（默认 `password`；MFA 等用 `text`）。 */
  type?: string
}

/**
 * 口令/敏感输入框 + 眼睛按钮。
 * @param props - 输入框属性。
 * @returns 输入框节点。
 */
export function PasswordInput({ type = 'password', ...rest }: PasswordInputProps): React.ReactElement {
  const [shown, setShown] = React.useState(false)
  return React.createElement('span', { className: 'rh-input-wrap' },
    React.createElement('input', {
      ...rest,
      type: shown ? 'text' : type,
      className: cx('rh-input', rest.mono && 'is-mono', rest.error && 'is-error', rest.otp && 'is-otp'),
      ...(rest.ariaLabel === undefined ? {} : { 'aria-label': rest.ariaLabel }),
    }),
    React.createElement('button', {
      type: 'button',
      className: 'rh-eye',
      'aria-label': shown ? '隐藏口令' : '显示口令',
      title: shown ? '隐藏口令' : '显示口令',
      onClick: () => { setShown(current => !current) },
    }, shown ? '🙈' : '👁'))
}

/**
 * 输入框（受控）。
 *
 * 纯函数：**不带任何 hooks**（渲染函数可能不在 React 渲染期被调用）。
 * 需要显示/隐藏切换时用 {@link PasswordInput}。
 * @param props - 输入框属性。
 * @returns 输入框节点。
 */
export function Input({
  type = 'text',
  mono = false,
  error = false,
  otp = false,
  ariaLabel,
  ...rest
}: InputProps): React.ReactElement {
  return React.createElement('input', {
    ...rest,
    type,
    className: cx('rh-input', mono && 'is-mono', error && 'is-error', otp && 'is-otp'),
    ...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel }),
  })
}

/** 多行输入属性。 */
export interface TextareaProps extends Testable {
  value: string
  placeholder?: string
  mono?: boolean
  rows?: number
  disabled?: boolean
  readOnly?: boolean
  ariaLabel?: string
  onChange?: (event: React.ChangeEvent<HTMLTextAreaElement>) => void
}

/**
 * 多行输入（受控）。
 * @param props - 多行输入属性。
 * @returns 节点。
 */
export function Textarea({ mono = false, ariaLabel, ...rest }: TextareaProps): React.ReactElement {
  return React.createElement('textarea', {
    ...rest,
    className: cx('rh-textarea', mono && 'is-mono'),
    ...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel }),
  })
}

/** 下拉选择属性。 */
export interface SelectProps extends Testable {
  value: string
  options: readonly { value: string; label: string }[]
  disabled?: boolean
  ariaLabel?: string
  error?: boolean
  onChange?: (event: React.ChangeEvent<HTMLSelectElement>) => void
}

/**
 * 原生下拉（保留原生语义与键盘操作；角色选择优先用 {@link Segmented}）。
 * @param props - 下拉属性。
 * @returns 节点。
 */
export function Select({ value, options, disabled, ariaLabel, error, onChange, ...rest }: SelectProps): React.ReactElement {
  return React.createElement('select', {
    ...rest,
    value,
    disabled,
    className: cx('rh-select', error && 'is-error'),
    ...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel }),
    ...(onChange === undefined ? {} : { onChange }),
  }, options.map(option => React.createElement('option', { key: option.value, value: option.value }, option.label)))
}

// ── Pill ─────────────────────────────────────────────────────────────────────

/** 状态标签语义（design-system §6.3）。 */
export type PillTone = 'online' | 'offline' | 'error' | 'warning' | 'neutral' | 'info' | 'purple'

/** 状态标签属性。 */
export interface PillProps extends Testable {
  tone: PillTone
  /** 是否渲染前置圆点。 */
  dot?: boolean
  children?: React.ReactNode
  [key: `data-${string}`]: unknown
}

const PILL_CLASS: Record<PillTone, string> = {
  online: 'is-online',
  offline: 'is-offline',
  error: 'is-error',
  warning: 'is-warning',
  neutral: 'is-neutral',
  info: 'is-info',
  purple: 'is-purple',
}

/**
 * 胶囊状态标签。
 * @param props - 标签属性。
 * @returns 节点。
 */
export function Pill({ tone, dot = false, children, ...rest }: PillProps): React.ReactElement {
  return React.createElement('span', { ...rest, className: cx('rh-pill', PILL_CLASS[tone]) },
    dot ? React.createElement('span', { className: 'rh-dot' }) : null,
    children)
}

// ── Notice ───────────────────────────────────────────────────────────────────

/** 通知语义（design-system §6.7）。 */
export type NoticeTone = 'success' | 'error' | 'warning' | 'info'

/** 通知属性。 */
export interface NoticeProps extends Testable {
  tone?: NoticeTone
  /** 无角色时默认 `role="status"` + `aria-live="polite"`；`alert` 用于错误。 */
  role?: 'alert' | 'status'
  children?: React.ReactNode
}

const NOTICE_CLASS: Record<NoticeTone, string> = {
  success: 'is-success',
  error: 'is-error',
  warning: 'is-warning',
  info: '',
}

/**
 * 提示条：状态变化由 `aria-live="polite"` 通知屏幕阅读器（design-system §10.4）。
 * @param props - 通知属性。
 * @returns 节点。
 */
export function Notice({ tone = 'info', role, children, ...rest }: NoticeProps): React.ReactElement {
  const resolved = role ?? (tone === 'error' ? 'alert' : 'status')
  return React.createElement('div', {
    ...rest,
    className: cx('rh-notice', NOTICE_CLASS[tone]),
    role: resolved,
    'aria-live': resolved === 'alert' ? 'assertive' : 'polite',
  }, children)
}

// ── Toggle ───────────────────────────────────────────────────────────────────

/** 开关属性（design-system §6.6）。 */
export interface ToggleProps extends Testable {
  checked: boolean
  label?: React.ReactNode
  disabled?: boolean
  onChange?: (checked: boolean) => void
}

/**
 * 开关。
 * @param props - 开关属性。
 * @returns 节点。
 */
export function Toggle({ checked, label, disabled = false, onChange, ...rest }: ToggleProps): React.ReactElement {
  return React.createElement('button', {
    ...rest,
    type: 'button',
    role: 'switch',
    'aria-checked': checked ? 'true' : 'false',
    ...(typeof label === 'string' ? { 'aria-label': label } : {}),
    className: 'rh-toggle',
    disabled,
    onClick: () => { onChange?.(!checked) },
  },
  React.createElement('span', { className: 'rh-switch', 'aria-hidden': 'true' }),
  typeof label === 'string' ? null : label)
}

// ── Segmented ────────────────────────────────────────────────────────────────

/** 分段控件选项。 */
export interface SegmentedOption<T extends string> {
  value: T
  label: string
  /** 选项自身的 data-testid（测试按钮级断言依赖）。 */
  testId?: string
  disabled?: boolean
}

/** 分段控件属性。 */
export interface SegmentedProps<T extends string> extends Testable {
  options: readonly SegmentedOption<T>[]
  value: T
  disabled?: boolean
  ariaLabel?: string
  onChange: (value: T) => void
}

/**
 * 分段选择（角色 / 口令策略 / 网络模式）。
 *
 * 每个选项渲染成 `<button role="tab">`，支持方向键导航（ARIA Tabs Pattern）。
 * 保留按钮级 testid 与 `data-selected`（现有测试按 `data-testid="policy-strong" data-selected="true"` 断言）。
 *
 * 键盘导航：
 * - Tab 进入后，方向键（Left/Right/Up/Down）在选项间移动
 * - Home/End 跳到首尾
 * - 选中项 tabindex="0"，其余 tabindex="-1"（roving tabindex）
 *
 * @param props - 分段控件属性。
 * @returns 节点。
 */
export function Segmented<T extends string>({
  options,
  value,
  disabled = false,
  ariaLabel,
  onChange,
  ...rest
}: SegmentedProps<T>): React.ReactElement {
  const handleKeyDown = (event: React.KeyboardEvent, currentIndex: number): void => {
    let nextIndex = currentIndex

    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault()
        nextIndex = (currentIndex + 1) % options.length
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault()
        nextIndex = (currentIndex - 1 + options.length) % options.length
        break
      case 'Home':
        event.preventDefault()
        nextIndex = 0
        break
      case 'End':
        event.preventDefault()
        nextIndex = options.length - 1
        break
      default:
        return
    }

    // 跳过禁用选项
    let attempts = 0
    while (options[nextIndex]?.disabled === true && attempts < options.length) {
      nextIndex = (nextIndex + 1) % options.length
      attempts++
    }

    if (options[nextIndex]?.disabled !== true) {
      onChange(options[nextIndex].value)
      // 聚焦到新选中的按钮
      const target = event.currentTarget.parentElement?.children[nextIndex] as HTMLElement | undefined
      target?.focus()
    }
  }

  return React.createElement('div', {
    ...rest,
    className: 'rh-seg',
    role: 'tablist',
    ...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel }),
  }, options.map((option, index) => {
    const active = option.value === value
    // 同一组里多个选项共享一个 testid 时（如设备筛选的 `filter`），
    // 既要有共同 testid，也要让选项本身可分辨 → 共同 testid 之外带 `data-index`。
    return React.createElement('button', {
      key: option.value ?? index,
      type: 'button',
      className: 'rh-seg-btn',
      role: 'tab',
      // 顺序有意固定：测试按 `data-testid="policy-strong" data-selected="true"` 的
      // 相邻顺序断言选中态，改顺序会破坏既有契约。
      ...(option.testId === undefined ? {} : { 'data-testid': option.testId }),
      'data-selected': active ? 'true' : 'false',
      ...(option.value === undefined ? {} : { 'data-value': option.value }),
      'aria-selected': active ? 'true' : 'false',
      tabIndex: active ? 0 : -1,
      disabled: disabled || option.disabled === true,
      onClick: () => { onChange(option.value) },
      onKeyDown: (e) => { handleKeyDown(e, index) },
    }, option.label)
  }))
}

// ── Skeleton / EmptyState ────────────────────────────────────────────────────

/** 骨架屏属性。 */
export interface SkeletonProps {
  /** 行数（默认 3）。 */
  lines?: number
  /** 每行的宽度（默认 60% / 90% / 40% 循环）。 */
  widths?: readonly string[]
}

/**
 * 加载占位（design-system §6.8）。
 * @param props - 骨架属性。
 * @returns 节点。
 */
export function Skeleton({ lines = 3, widths }: SkeletonProps): React.ReactElement {
  const defaultWidths = ['60%', '90%', '40%']
  return React.createElement('div', { 'aria-hidden': 'true' },
    Array.from({ length: lines }, (_, index) => React.createElement('div', {
      key: index,
      className: 'rh-skeleton',
      style: { width: widths?.[index] ?? defaultWidths[index % defaultWidths.length] },
    })))
}

/** 空状态属性。 */
export interface EmptyStateProps extends Testable {
  icon?: React.ReactNode
  title: React.ReactNode
  desc?: React.ReactNode
  action?: React.ReactNode
}

/**
 * 空状态。
 * @param props - 空状态属性。
 * @returns 节点。
 */
export function EmptyState({ icon, title, desc, action, ...rest }: EmptyStateProps): React.ReactElement {
  return React.createElement('div', { ...rest, className: 'rh-empty' },
    icon === undefined || icon === null ? null : React.createElement('div', { className: 'rh-empty-ic' }, icon),
    React.createElement('div', { className: 'rh-empty-title' }, title),
    desc === undefined || desc === null ? null : React.createElement('p', { className: 'rh-empty-desc' }, desc),
    action)
}

// ── 布局助手 ─────────────────────────────────────────────────────────────────

/** 键值对网格（诊断 / 统计明细）。 */
export function KeyValue({ items, ...rest }: {
  items: readonly { key: React.ReactNode; value: React.ReactNode; testId?: string }[]
  [key: `data-${string}`]: unknown
}): React.ReactElement {
  return React.createElement('div', { ...rest, className: 'rh-kv' },
    items.map((item, index) => React.createElement('div', { key: index },
      React.createElement('div', { className: 'rh-k' }, item.key),
      React.createElement('div', {
        className: 'rh-v',
        ...(item.testId === undefined ? {} : { 'data-testid': item.testId }),
      }, item.value))))
}

/** 可复制的等宽值块。 */
export function CodeBox({ large = false, children, ...rest }: {
  large?: boolean
  children?: React.ReactNode
  [key: `data-${string}`]: unknown
  [key: string]: unknown
}): React.ReactElement {
  return React.createElement('code', {
    ...rest,
    className: cx('rh-codebox', large && 'is-large'),
  }, children)
}

/** 折叠区（诊断 / 日志 / 高级参数）。 */
export function Collapse({ summary, open = false, children, ...rest }: {
  summary: React.ReactNode
  open?: boolean
  children?: React.ReactNode
  [key: `data-${string}`]: unknown
  [key: string]: unknown
}): React.ReactElement {
  const { open: _open, ...props } = { open, ...rest }
  return React.createElement('details', { ...props, className: 'rh-collapse', ...(_open ? { open: true } : {}) },
    React.createElement('summary', null, summary),
    React.createElement('div', { className: 'rh-collapse-body' }, children))
}

/**
 * 设计系统 `<style>` 节点（幂等注入到页面根容器；同名内容浏览器只解析一次）。
 * @returns `<style data-rh-theme>`。
 */
export function ThemeStyle(css: string): React.ReactElement {
  return React.createElement('style', { key: 'rh-theme', 'data-rh-theme': '' }, css)
}
