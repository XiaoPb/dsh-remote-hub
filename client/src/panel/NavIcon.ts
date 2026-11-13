import React from 'react'

export interface NavIconProps {
  size?: number
  active?: boolean
  connected?: boolean
}

/** Read the installed carrier, not a stale persisted pairing card. */
export function isCloudNavigationConnected(globalObject: unknown = globalThis): boolean {
  const value = globalObject as {
    __DSH_REMOTE_HUB_CARRIER__?: { active?: boolean }
    __DSH_TRANSPORT__?: { streamBaseUrl?: string }
  }
  return value.__DSH_REMOTE_HUB_CARRIER__?.active === true
    && typeof value.__DSH_TRANSPORT__?.streamBaseUrl === 'string'
    && value.__DSH_TRANSPORT__.streamBaseUrl.length > 0
}

/** DSH-sized currentColor cloud; the status decoration is independent of selection. */
export function renderNavIcon(props: NavIconProps = {}): React.ReactNode {
  const size = typeof props.size === 'number' && props.size > 0 ? props.size : 20
  const connected = props.connected === true
  return React.createElement('svg', {
    'data-testid': 'remote-hub-nav-icon',
    'data-active': props.active === true || undefined,
    'data-connected': connected,
    width: size, height: size, viewBox: '0 0 24 24',
    fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
    strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
  },
  React.createElement('path', {
    d: 'M7 18a4.5 4.5 0 1 1 .6-8.96A5.5 5.5 0 0 1 18.2 10.7 3.8 3.8 0 0 1 17.5 18z',
  }),
  connected
    ? React.createElement('circle', {
      'data-testid': 'remote-hub-connected-dot', cx: 19.5, cy: 4.5, r: 3.2,
      fill: 'var(--dsw-alias-state-success-primary, #22c55e)',
      stroke: 'var(--dsw-alias-bg-layer-1, #fff)', strokeWidth: 1.5,
    })
    : React.createElement('path', { 'data-testid': 'remote-hub-disconnected-slash', d: 'M3 3 21 21' }))
}

export function RemoteHubNavIcon(props: NavIconProps): React.ReactNode {
  const [connected, setConnected] = React.useState(isCloudNavigationConnected)
  React.useEffect(() => {
    const update = (): void => setConnected(isCloudNavigationConnected())
    update()
    const timer = globalThis.setInterval(update, 1000)
    return () => globalThis.clearInterval(timer)
  }, [])
  return renderNavIcon({ ...props, connected })
}
