/**
 * 敏感写入审批（0.2.6 / D-16）与密钥掩码的回归测试。
 *
 * 两条红线必须由测试守住：
 * 1. **审批卡、审计、诊断里永远没有明文 API Key**；
 * 2. **没人应答就不放行**（fail-closed），不因为超时而静默通过。
 *
 * @module test/sensitive-approval.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const mod = await import('../lib/index.js')

const {
  APPROVAL_REQUIRED_ENDPOINTS,
  SECRET_BEARING_ENDPOINTS,
  redactSecrets,
  maskSecret,
  collectSecretValues,
  containsNoSecret,
  REDACTED,
} = mod

const API_KEY = 'sk-proj-ZZZZabcd1234EFGH5678ijkl'

/** 收集投递到流里的帧（替代真实 StreamEngine）。 */
function makeStreams() {
  const frames = []
  return {
    frames,
    enqueue(deviceId, frame) { frames.push({ deviceId, frame }) },
  }
}

const config = { approvalBridgeTimeoutMs: 5_000, bridgeApprovals: true }

describe('maskSecret', () => {
  it('保留可识别前缀与末 4 位，中间打码', () => {
    const masked = maskSecret(API_KEY)
    assert.ok(masked.startsWith('sk-'), masked)
    // 真正的断言：末 4 位 == 原密钥末 4 位（`'ijkl'.slice(-4)` 恒等于自己，是假断言）
    assert.equal(masked.endsWith(API_KEY.slice(-4)), true, `${masked} 应以 ${API_KEY.slice(-4)} 结尾`)
    assert.ok(masked.includes('****'))
    assert.equal(masked.includes(API_KEY), false)
  })

  it('过短的密钥完全隐藏', () => {
    assert.equal(maskSecret('short'), REDACTED)
  })
})

describe('redactSecrets', () => {
  it('按字段名掩码，且不修改入参', () => {
    const payload = { refs: [{ name: 'DEEPSEEK_API_KEY', value: API_KEY }], apiKey: API_KEY }
    const copy = JSON.parse(JSON.stringify(payload))
    const safe = redactSecrets(payload)
    assert.deepEqual(payload, copy, '入参不能被修改')
    const text = JSON.stringify(safe)
    assert.equal(text.includes(API_KEY), false, '掩码后不得出现明文：' + text)
    assert.ok(text.includes('DEEPSEEK_API_KEY'), '引用名要保留，owner 才知道改的是哪一项')
  })

  it('未知字段名但值像凭据的也掩码', () => {
    const safe = redactSecrets({ whatever: API_KEY })
    assert.equal(JSON.stringify(safe).includes(API_KEY), false)
  })

  it('嵌套对象与数组递归处理', () => {
    const safe = redactSecrets({ a: { b: [{ token: API_KEY }] } })
    assert.equal(JSON.stringify(safe).includes(API_KEY), false)
  })

  it('普通文本不被误伤', () => {
    const safe = redactSecrets({ provider: 'deepseek', model: 'deepseek-chat', maxTokens: 4096 })
    assert.deepEqual(safe, { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 4096 })
  })
})

describe('collectSecretValues / containsNoSecret', () => {
  it('能找出载荷里的明文密钥，并断言文本不含它', () => {
    const payload = { credentials: { apiKey: API_KEY }, note: 'hello' }
    const secrets = collectSecretValues(payload)
    assert.ok(secrets.includes(API_KEY))
    assert.equal(containsNoSecret(`audit ${API_KEY}`, secrets), false)
    assert.equal(containsNoSecret('audit clean', secrets), true)
  })
})

describe('审批清单', () => {
  it('敏感写入都在 APPROVAL_REQUIRED_ENDPOINTS 里', () => {
    for (const endpoint of SECRET_BEARING_ENDPOINTS) {
      assert.ok(APPROVAL_REQUIRED_ENDPOINTS.includes(endpoint), `${endpoint} must require approval`)
    }
    for (const endpoint of ['credentials/set', 'settings/update', 'pluginManager/installBundle']) {
      assert.ok(APPROVAL_REQUIRED_ENDPOINTS.includes(endpoint), endpoint)
    }
  })

  it('只读目录不需要审批', () => {
    for (const endpoint of ['credentials/describe', 'settings/describe', 'llm/listProviders', 'session/list']) {
      assert.equal(APPROVAL_REQUIRED_ENDPOINTS.includes(endpoint), false, endpoint)
    }
  })
})

describe('createSensitiveApprovalGate', () => {
  it('不在清单里的 endpoint 直接放行', async () => {
    const streams = makeStreams()
    const gate = mod.createSensitiveApprovalGate({ streams, config })
    const decision = await gate.check({ deviceId: 'dev1', role: 'full', endpoint: 'session/list', payload: {} })
    assert.deepEqual(decision, { allowed: true, reason: 'not-required' })
    assert.equal(streams.frames.length, 0)
  })

  it('审批卡只含掩码后的密钥', async () => {
    const streams = makeStreams()
    const gate = mod.createSensitiveApprovalGate({ streams, config })
    const pending = gate.check({
      deviceId: 'dev1',
      role: 'full',
      endpoint: 'credentials/set',
      payload: { refs: { DEEPSEEK_API_KEY: API_KEY } },
    })
    await new Promise(resolve => { setTimeout(resolve, 10) })
    assert.equal(streams.frames.length, 1)
    const frame = streams.frames[0].frame
    const text = JSON.stringify(frame)
    assert.equal(text.includes(API_KEY), false, '审批卡泄露明文：' + text)
    assert.ok(text.includes('sk-****'), '应保留可识别前缀与末 4 位')
    assert.equal(frame.toolName, 'remote-hub:credentials/set')

    // 手动结束，避免测试挂住
    gate.answer({ deviceId: 'dev1', requestId: frame.requestId, outcome: 'rejected' })
    await pending
    gate.dispose()
  })

  it('owner 批准后放行，并在窗口内复用批准', async () => {
    const streams = makeStreams()
    const gate = mod.createSensitiveApprovalGate({ streams, config })
    const request = { deviceId: 'dev1', role: 'full', endpoint: 'credentials/set', payload: { key: API_KEY } }
    const pending = gate.check(request)
    await new Promise(resolve => { setTimeout(resolve, 10) })
    gate.answer({ deviceId: 'dev1', requestId: streams.frames[0].frame.requestId, outcome: 'allowed-once' })
    assert.deepEqual(await pending, { allowed: true, reason: 'approved' })

    const again = await gate.check(request)
    assert.deepEqual(again, { allowed: true, reason: 'cached' })
    assert.equal(streams.frames.length, 1, '同一载荷不应重复打扰 owner')
    gate.dispose()
  })

  it('owner 拒绝则拒绝，且不缓存拒绝', async () => {
    const streams = makeStreams()
    const gate = mod.createSensitiveApprovalGate({ streams, config })
    const request = { deviceId: 'dev1', role: 'full', endpoint: 'settings/update', payload: { key: API_KEY } }
    const pending = gate.check(request)
    await new Promise(resolve => { setTimeout(resolve, 10) })
    gate.answer({ deviceId: 'dev1', requestId: streams.frames[0].frame.requestId, outcome: 'rejected' })
    assert.deepEqual(await pending, { allowed: false, reason: 'rejected' })

    // 再调一次必须重新发起审批（不能被上次的拒绝或缓存放过）
    const pending2 = gate.check(request)
    await new Promise(resolve => { setTimeout(resolve, 10) })
    assert.equal(streams.frames.length, 2, '拒绝不得被缓存')
    gate.answer({ deviceId: 'dev1', requestId: streams.frames[1].frame.requestId, outcome: 'rejected' })
    assert.deepEqual(await pending2, { allowed: false, reason: 'rejected' })
    gate.dispose()
  })

  it('没人应答 → 超时拒绝（fail-closed）', async () => {
    const streams = makeStreams()
    const gate = mod.createSensitiveApprovalGate({
      streams,
      config: { approvalBridgeTimeoutMs: 30, bridgeApprovals: true },
    })
    const decision = await gate.check({ deviceId: 'dev1', role: 'full', endpoint: 'credentials/set', payload: { key: API_KEY } })
    assert.deepEqual(decision, { allowed: false, reason: 'timeout' })
    gate.dispose()
  })

  it('审批桥被关闭 → 直接拒绝', async () => {
    const streams = makeStreams()
    const gate = mod.createSensitiveApprovalGate({ streams, config: { ...config, bridgeApprovals: false } })
    const decision = await gate.check({ deviceId: 'dev1', role: 'full', endpoint: 'credentials/set', payload: { key: API_KEY } })
    assert.deepEqual(decision, { allowed: false, reason: 'bridge-disabled' })
    assert.equal(streams.frames.length, 0)
    gate.dispose()
  })

  it('别的设备不能替 owner 作答', async () => {
    const streams = makeStreams()
    const gate = mod.createSensitiveApprovalGate({ streams, config: { approvalBridgeTimeoutMs: 200, bridgeApprovals: true } })
    const pending = gate.check({ deviceId: 'dev1', role: 'full', endpoint: 'credentials/set', payload: { key: API_KEY } })
    await new Promise(resolve => { setTimeout(resolve, 10) })
    const requestId = streams.frames[0].frame.requestId
    assert.equal(gate.answer({ deviceId: 'dev2', requestId, outcome: 'allowed-once' }), false, '别的设备不得批准')
    assert.equal(gate.answer({ deviceId: 'dev1', requestId, outcome: 'unavailable' }), false, 'unavailable 不是合法答复')
    gate.answer({ deviceId: 'dev1', requestId, outcome: 'cancelled' })
    assert.deepEqual(await pending, { allowed: false, reason: 'cancelled' })
    gate.dispose()
  })

  it('审计行不含明文密钥', async () => {
    const streams = makeStreams()
    const rows = []
    const gate = mod.createSensitiveApprovalGate({
      streams,
      config: { approvalBridgeTimeoutMs: 30, bridgeApprovals: true },
      onAudit: row => { rows.push(row) },
    })
    await gate.check({ deviceId: 'dev1', role: 'full', endpoint: 'credentials/set', payload: { key: API_KEY } })
    assert.ok(rows.length > 0)
    const text = JSON.stringify(rows)
    assert.equal(text.includes(API_KEY), false, '审计泄露明文：' + text)
    gate.dispose()
  })
})
