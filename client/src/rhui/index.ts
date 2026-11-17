/**
 * 设计系统出口：token / 样式表 / 公共组件 / 语义化文案与格式化助手。
 *
 * 页面（`client/src/panel/*`、`client/src/auth/*`）只从这里取 UI 基础件，
 * 不各自复制 token 或样式（design-system §11「扩展规则」）。
 *
 * @module dsh-remote-hub/client/rhui
 */
export {
  RH_CSS, RH_TOKEN_CSS
} from './tokens.js'
export { t, detectLocale, getLocale, setLocale, type Locale, type LocaleKey } from './i18n.js'
export { QrCode, type QrCodeProps } from './qr-code.js'
export {
  Button,
  Card,
  CodeBox,
  Collapse,
  EmptyState,
  Field,
  Input,
  KeyValue,
  Notice,
  PasswordInput,
  Pill,
  Section,
  Segmented,
  Select,
  Skeleton,
  Textarea,
  ThemeStyle,
  Toggle,
  cx,
  type ButtonProps,
  type ButtonVariant,
  type CardProps,
  type EmptyStateProps,
  type FieldProps,
  type InputProps,
  type NoticeProps,
  type NoticeTone,
  type PasswordInputProps,
  type PillProps,
  type PillTone,
  type SegmentedOption,
  type SegmentedProps,
  type SectionProps,
  type SelectProps,
  type TextareaProps,
  type Testable,
  type ToggleProps,
} from './components.js'
export {
  authErrorText,
  authErrorTextMap,
  formatDateTime,
  formatRelative,
  formatRole,
  formatRoleCeiling,
  roleOptions,
  roleOptionLabel,
  shortRoleLabel,
} from './format.js'
