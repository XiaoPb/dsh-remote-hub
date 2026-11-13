import React from 'react'

export function DeviceDeleteDialog(props: { message: string; onConfirm(): void; onCancel(): void }): React.ReactNode {
  const cancel = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    cancel.current?.focus()
    return () => previous?.focus()
  }, [])
  return React.createElement('div', { style: { position: 'fixed', inset: 0, zIndex: 12000, display: 'grid', placeItems: 'center', background: 'var(--dsw-alias-bg-mask-1)', padding: 20 } },
    React.createElement('section', {
      role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'rh-delete-title', 'aria-describedby': 'rh-delete-description', 'data-testid': 'device-delete-dialog',
      onKeyDown: (event: React.KeyboardEvent) => {
        if (event.key === 'Escape') props.onCancel()
        if (event.key === 'Tab') {
          const buttons = Array.from(event.currentTarget.querySelectorAll('button'))
          const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
          event.preventDefault()
          buttons[(at + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus()
        }
      },
      style: { width: 'min(460px,100%)', padding: 24, borderRadius: 'var(--dsw-radius-xl)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', boxShadow: 'var(--dsw-shadow-lv3)', boxSizing: 'border-box', fontFamily: 'var(--dsw-font-family)' },
    },
    React.createElement('h2', { id: 'rh-delete-title', style: { fontSize: 18, margin: '0 0 12px' } }, '删除设备 / Delete device'),
    React.createElement('p', { id: 'rh-delete-description', style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 14, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' } }, props.message),
    React.createElement('footer', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 } },
      React.createElement('button', { ref: cancel, type: 'button', onClick: props.onCancel, style: { padding: '8px 14px', borderRadius: 'var(--dsw-radius-sm)', border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'inherit', cursor: 'pointer' } }, '取消 / Cancel'),
      React.createElement('button', { type: 'button', 'data-testid': 'device-delete-confirm', onClick: props.onConfirm, style: { padding: '8px 14px', borderRadius: 'var(--dsw-radius-sm)', border: '1px solid var(--dsw-alias-state-error-primary)', background: 'transparent', color: 'var(--dsw-alias-state-error-primary)', cursor: 'pointer' } }, '确认删除 / Delete'))))
}
