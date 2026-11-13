/**
 * 密钥掩码与敏感写入门禁的回归测试。
 *
 * 0.3.1 起 **取消逐次 owner 审批**（用户要求 Full 完全放开、直接生效），
 * 但两条红线必须继续由测试守住：
 * 1. **审计、诊断、审批帧里永远没有明文 API Key**；
 * 2. 审批机制与常量保留，且「清单为空 ⇒ 直接放行」这个短路是**显式**的，
 *    将来要恢复逐次审批只需往 `APPROVAL_REQUIRED_ENDPOINTS` 加一条。
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

describe('审批清单（0.3.1 起为空）', () => {
  it('不再有任何逐次审批：Full 直接生效', () => {
    assert.deepEqual([...APPROVAL_REQUIRED_ENDPOINTS], [], '审批清单必须为空')
    for (const endpoint of ['credentials/set', 'settings/update', 'pluginManager/installBundle', 'pluginMarket/setIndexes']) {
      assert.equal(APPROVAL_REQUIRED_ENDPOINTS.includes(endpoint), false, `${endpoint} 不该再要求审批`)
      assert.equal(mod.requiresApproval(endpoint), false, `${endpoint} 不该再要求审批`)
    }
  })

  it('密钥类 endpoint 仍然登记，供审计与掩码使用', () => {
    for (const endpoint of ['credentials/set', 'settings/update']) {
      assert.ok(SECRET_BEARING_ENDPOINTS.includes(endpoint), `${endpoint} 仍需掩码`)
    }
  })
})

describe('createSensitiveApprovalGate（机制保留，当前无人被拦）', () => {
  it('清单为空时，写入类 endpoint 也直接放行且不打扰 owner', async () => {
    const streams = makeStreams()
    const gate = mod.createSensitiveApprovalGate({ streams, config })
    for (const endpoint of ['credentials/set', 'settings/update', 'pluginManager/installBundle', 'session/list']) {
      const decision = await gate.check({ deviceId: 'dev1', role: 'full', endpoint, payload: { key: API_KEY } })
      assert.deepEqual(decision, { allowed: true, reason: 'not-required' }, endpoint)
    }
    assert.equal(streams.frames.length, 0, '不应再向 owner 投递审批卡')
    gate.dispose()
  })

  it('未知 requestId 不会被误认作待答审批', () => {
    const gate = mod.createSensitiveApprovalGate({ streams: makeStreams(), config })
    assert.equal(gate.answer({ deviceId: 'dev1', requestId: 'nope', outcome: 'allowed-once' }), false)
    gate.dispose()
  })
})
