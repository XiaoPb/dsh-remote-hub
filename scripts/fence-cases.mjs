/**
 * The six fence combinations + two forwarded-header spoof pairs (ROADMAP A1-2).
 * Shared by `scripts/fence.mjs` and `test/fence.test.mjs` so the acceptance
 * script and the unit test can never drift.
 *
 * `checkSource` contract (host/src/fence.ts):
 *   checkSource({ headers }, { publicAuthorities, protocol }) → { ok } | { ok:false, reason }
 *   ok:true ⇒ HTTP 200; ok:false ⇒ HTTP 403.
 *
 * No real socket, no DSH runtime: only plain header objects.
 * @module scripts/fence-cases.mjs
 */

export const PUBLIC_AUTHORITIES = ['hub.example.com']
export const LOOPBACK_HOST = '127.0.0.1:8443'
export const PUBLIC_HOST = 'hub.example.com'

/** One baseline case: name, headers, options, expected HTTP status. */
export const FENCE_CASES = Object.freeze([
  {
    name: 'host-loopback-no-origin',
    headers: { host: LOOPBACK_HOST },
    options: { publicAuthorities: PUBLIC_AUTHORITIES },
    expected: 200,
  },
  {
    name: 'host-public-declared',
    headers: { host: PUBLIC_HOST, origin: 'https://hub.example.com' },
    options: { publicAuthorities: PUBLIC_AUTHORITIES, protocol: 'https:' },
    expected: 200,
  },
  {
    name: 'host-public-undeclared',
    headers: { host: 'evil.example.com' },
    options: { publicAuthorities: PUBLIC_AUTHORITIES },
    expected: 403,
  },
  {
    name: 'origin-null',
    headers: { host: PUBLIC_HOST, origin: 'null' },
    options: { publicAuthorities: PUBLIC_AUTHORITIES, protocol: 'https:' },
    expected: 403,
  },
  {
    name: 'origin-cross-authority',
    headers: { host: PUBLIC_HOST, origin: 'https://evil.example.com' },
    options: { publicAuthorities: PUBLIC_AUTHORITIES, protocol: 'https:' },
    expected: 403,
  },
  {
    name: 'sec-fetch-site-cross-site',
    headers: { host: PUBLIC_HOST, 'sec-fetch-site': 'cross-site' },
    options: { publicAuthorities: PUBLIC_AUTHORITIES, protocol: 'https:' },
    expected: 403,
  },
])

/** Forged forwarding headers; verdict must equal the baseline, case by case. */
export const SPOOF_HEADERS = Object.freeze([
  { name: 'x-forwarded-for-spoof', headers: { 'x-forwarded-for': '127.0.0.1', 'true-client-ip': '127.0.0.1' } },
  { name: 'cf-connecting-ip-spoof', headers: { 'cf-connecting-ip': '127.0.0.1', 'true-client-ip': '127.0.0.1' } },
])

/** Map a `checkSource` verdict to an HTTP status. */
export function verdictStatus(verdict) {
  return verdict?.ok === true ? 200 : 403
}

/**
 * A minimal static reference implementation of the three-segment fence, used
 * ONLY when `lib/index.js` does not export `checkSource`. It is a real
 * implementation (not a canned verdict), so drift in the contract is still
 * caught the moment the export appears.
 */
export function checkSourceFallback(req, options) {
  const first = value => (typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined)
  const canonical = entry => {
    let parsed
    try {
      parsed = new URL(`http://${entry}`)
    } catch {
      return undefined
    }
    if (parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/' || parsed.search !== '') return undefined
    const port = parsed.port !== '' ? parsed.port : new URL(`https://${entry}`).port
    const text = port === '' ? parsed.hostname : `${parsed.hostname}:${port}`
    return text === entry.toLowerCase() ? text : undefined
  }
  const authorityOf = (host, protocol) => {
    let parsed
    try {
      parsed = new URL(`${protocol}//${host}`)
    } catch {
      return undefined
    }
    return parsed.port === '' ? parsed.hostname : `${parsed.hostname}:${parsed.port}`
  }
  const isLoopbackHostname = hostname => hostname === 'localhost'
    || hostname === '[::1]' || hostname === '::1'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(hostname)

  const rawHost = first(req.headers.host)
  if (rawHost === undefined) return { ok: false, reason: 'missing Host' }
  const protocol = options.protocol ?? 'http:'
  const canon = canonical(rawHost)
  const host = authorityOf(rawHost, protocol)
  if (canon === undefined || host === undefined) return { ok: false, reason: 'Host is not a bare authority' }
  const loopback = isLoopbackHostname(host.split(':')[0] ?? '')
  const declared = options.publicAuthorities.some(entry => canonical(entry) === canon)
  if (!loopback && !declared) return { ok: false, reason: 'Host is not allowed' }
  if (first(req.headers['sec-fetch-site']) === 'cross-site') return { ok: false, reason: 'cross-site request' }
  const origin = first(req.headers.origin)
  if (origin !== undefined) {
    if (origin === 'null') return { ok: false, reason: 'opaque Origin' }
    let originUrl
    try {
      originUrl = new URL(origin)
    } catch {
      return { ok: false, reason: 'unparsable Origin' }
    }
    if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') {
      return { ok: false, reason: 'Origin scheme is not http(s)' }
    }
    if (authorityOf(originUrl.host, originUrl.protocol) !== host) {
      return { ok: false, reason: 'Origin does not match Host authority' }
    }
  }
  return { ok: true }
}
