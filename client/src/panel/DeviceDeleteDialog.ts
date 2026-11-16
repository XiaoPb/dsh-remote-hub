/**
 * 删除设备确认框（design-system §6.9：遮罩 `rgba(0,0,0,.4)` + blur 2px，
 * 弹窗最大 480px、圆角 `--rh-radius`、内边距 24px）。
 *
 * 无障碍：`role="dialog"` + `aria-modal` + 标题/描述关联；Esc 取消，Tab 在
 * 弹窗内循环；挂载时焦点落在「取消」（危险操作不抢默认焦点）。
 *
 * @module dsh-remote-hub/client/panel/DeviceDeleteDialog
 */
import React from 'react'

import { Button, Notice, ThemeStyle } from '../rhui/index.js'
import { RH_CSS } from '../rhui/tokens.js'
import { t } from '../rhui/i18n.js'

/**
 * 确认框。
 * @param props - 文案与回调。
 * @returns 对话框节点。
 */
export function DeviceDeleteDialog(props: { message: string; onConfirm(): void; onCancel(): void }): React.ReactNode {
  const cancel = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    cancel.current?.focus()
    return () => previous?.focus()
  }, [])
  return React.createElement('div', {
    'data-rh-scope': '',
    style: {
      position: 'fixed', inset: 0, zIndex: 12000, display: 'grid', placeItems: 'center',
      background: 'var(--rh-mask)', backdropFilter: 'blur(2px)', padding: 20,
    },
  },
  ThemeStyle(RH_CSS),
  React.createElement('section', {
    role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'rh-delete-title', 'aria-describedby': 'rh-delete-description',
    'data-testid': 'device-delete-dialog',
    className: 'rh-card',
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') props.onCancel()
      if (event.key === 'Tab') {
        const buttons = Array.from(event.currentTarget.querySelectorAll('button'))
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
        event.preventDefault()
        buttons[(at + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus()
      }
    },
    style: { width: 'min(480px,100%)', padding: 24, margin: 0, borderRadius: 'var(--rh-radius)', boxShadow: 'var(--rh-shadow-lg)' },
  },
  React.createElement('h2', {
    id: 'rh-delete-title',
    className: 'rh-section-title',
    style: { margin: '0 0 12px' },
  }, t('deleteDeviceTitle')),
  React.createElement('div', { id: 'rh-delete-description' },
    React.createElement(Notice, { tone: 'warning' },
      React.createElement('span', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, props.message))),
  React.createElement('footer', { className: 'rh-row', style: { justifyContent: 'flex-end', marginTop: 20 } },
    React.createElement(Button, { ref: cancel, variant: 'ghost', onClick: props.onCancel }, t('deleteDeviceCancel')),
    React.createElement(Button, { 'data-testid': 'device-delete-confirm', variant: 'danger', onClick: props.onConfirm }, t('deleteDeviceConfirm')))))
}
