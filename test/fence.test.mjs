import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  FENCE_CASES,
  PATHS,
  SPOOF_HEADERS,
  checkSourceFallback,
  fn,
  read,
  testLoadLib,
  verdictStatus,
} from './_helpers.mjs'

const mod = await testLoadLib()
const checkSource = fn(mod, 'checkSource') ?? checkSourceFallback

test('fence: six combinations produce the mandated 200/403 verdicts', () => {
  const fenceSrc = read(PATHS.fenceSrc)
  // Three segments are declared in source (always asserted, even with a
  // dynamic export — this is the "upgrade DSH: re-verify" contract).
  assert.match(fenceSrc, /publicAuthorities/u)
  assert.match(fenceSrc, /sec-fetch-site/u)
  assert.match(fenceSrc, /cross-site/u)
  assert.match(fenceSrc, /origin/u)
  assert.match(fenceSrc, /'null'|"null"/u)

  for (const item of FENCE_CASES) {
    const verdict = checkSource({ headers: item.headers }, item.options)
    assert.equal(
      verdictStatus(verdict), item.expected,
      `${item.name}: got ${verdictStatus(verdict)}, verdict=${JSON.stringify(verdict)}`,
    )
  }
})

test('fence: forged forwarding headers never change any baseline verdict', () => {
  for (const spoof of SPOOF_HEADERS) {
    for (const item of FENCE_CASES) {
      const baseline = checkSource({ headers: item.headers }, item.options)
      const forged = checkSource(
        { headers: { ...item.headers, ...spoof.headers } },
        item.options,
      )
      assert.equal(verdictStatus(forged), verdictStatus(baseline), `${spoof.name}/${item.name}`)
      assert.equal(forged.ok, baseline.ok, `${spoof.name}/${item.name} ok flag`)
    }
  }
})

test('fence: source does not read x-forwarded-* / cf-connecting-ip / true-client-ip', () => {
  const code = read(PATHS.fenceSrc)
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '')
  for (const name of ['x-forwarded-for', 'cf-connecting-ip', 'true-client-ip']) {
    assert.doesNotMatch(code, new RegExp(`headers\\s*\\[\\s*['"\`]${name}['"\`]`, 'u'))
    assert.doesNotMatch(code, new RegExp(`header\\s*\\(\\s*req\\s*,\\s*['"\`]${name}['"\`]`, 'u'))
  }
})

test('fence: extra loopback / non-canonical Host cases', () => {
  const allowed = { publicAuthorities: ['hub.example.com'] }
  assert.equal(verdictStatus(checkSource({ headers: { host: '127.0.0.1:8443' } }, allowed)), 200)
  assert.equal(verdictStatus(checkSource({ headers: { host: 'localhost:8443' } }, allowed)), 200)
  assert.equal(verdictStatus(checkSource({ headers: { host: 'hub.example.com:8443' } }, allowed)), 403)
  assert.equal(verdictStatus(checkSource({ headers: {} }, allowed)), 403)
})

test('fence: allowPrivateOrigin accepts private-address Origin in LAN mode', () => {
  // LAN mode simulates the real scenario: allowPrivate + allowPrivateOrigin
  const lanOptions = { publicAuthorities: [], protocol: 'https:', allowPrivate: true, allowPrivateOrigin: true }
  
  // Baseline: private Host without allowPrivateOrigin → cross-authority Origin rejected
  const baselineOpts = { publicAuthorities: [], protocol: 'https:', allowPrivate: true }
  const privateOrigin = { host: '192.168.0.17:8443', origin: 'http://127.0.0.1:13091' }
  assert.equal(verdictStatus(checkSource({ headers: privateOrigin }, baselineOpts)), 403, 'baseline: cross-authority private Origin rejected without allowPrivateOrigin')

  // With allowPrivateOrigin: private Origin accepted
  assert.equal(verdictStatus(checkSource({ headers: privateOrigin }, lanOptions)), 200, 'allowPrivateOrigin: private Origin accepted')

  // Same-authority Origin still works
  const sameOrigin = { host: '192.168.0.17:8443', origin: 'https://192.168.0.17:8443' }
  assert.equal(verdictStatus(checkSource({ headers: sameOrigin }, lanOptions)), 200, 'allowPrivateOrigin: same-authority Origin accepted')

  // Non-private cross-authority Origin still rejected
  const crossOrigin = { host: '192.168.0.17:8443', origin: 'https://evil.example.com' }
  assert.equal(verdictStatus(checkSource({ headers: crossOrigin }, lanOptions)), 403, 'allowPrivateOrigin: cross-authority public Origin still rejected')

  // localhost Origin
  const localhostOrigin = { host: '192.168.0.17:8443', origin: 'http://localhost:3091' }
  assert.equal(verdictStatus(checkSource({ headers: localhostOrigin }, lanOptions)), 200, 'allowPrivateOrigin: localhost Origin accepted')

  // 10.x private range
  const privateRange10 = { host: '192.168.0.17:8443', origin: 'http://10.0.1.5:8080' }
  assert.equal(verdictStatus(checkSource({ headers: privateRange10 }, lanOptions)), 200, 'allowPrivateOrigin: 10.x Origin accepted')

  // 172.16-31.x private range
  const privateRange172 = { host: '192.168.0.17:8443', origin: 'http://172.20.0.1:9000' }
  assert.equal(verdictStatus(checkSource({ headers: privateRange172 }, lanOptions)), 200, 'allowPrivateOrigin: 172.16-31.x Origin accepted')

  // 192.168.x private range (different subnet)
  const privateRange192 = { host: '192.168.0.17:8443', origin: 'http://192.168.1.100:5000' }
  assert.equal(verdictStatus(checkSource({ headers: privateRange192 }, lanOptions)), 200, 'allowPrivateOrigin: 192.168.x Origin accepted')
})
