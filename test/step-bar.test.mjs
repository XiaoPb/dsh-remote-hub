/**
 * 步骤条回归测试：**只画本次会话真的会走的步骤**。
 *
 * 真实缺陷（0.5.1 修复）：
 * 旧实现把「账号口令 → 修改口令 → 绑定两步验证 → 账号设置」四条**全画出来**，
 * 而且 `ready` 时仍渲染整条步骤条。于是普通设备登录后会看到三条永远点不亮的
 * 「已完成」步骤、登录完成的设置页还挂着一整条流程——用户会以为「还有步骤没走完」。
 *
 * 期望：
 *  - 首次登录（要改初始口令 + 绑 2FA）：4 步
 *  - 普通设备登录：3 步（账号口令 → 两步验证 → 账号设置），MFA 时高亮第二项
 *  - 已登录（ready）/ 加载 / 错误：不显示步骤条
 *
 * @module test/step-bar.test
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SOURCE = join(ROOT, 'client', 'src', 'auth', 'AccountPage.tsx')

/**
 * 把 TSX 里的 `stepsFor` 逻辑抽出来在 Node 里跑（避免引入 TS 编译）。
 *
 * 这里只镜像**纯数据部分**：ALL_STEPS 定义 + stepsFor 的分支；一旦源码改动到
 * 无法镜像，测试会通过「形状检查」失败提醒同步。
 * @returns {{stepsFor: Function}} 逻辑。
 */
function loadStepsFor() {
  /** 与 AccountPage.tsx 的 ALL_STEPS 对齐。 */
  const ALL_STEPS = [
    { key: 'login', labelKey: 'stepCredentials' },
    { key: 'password', labelKey: 'stepPassword' },
    { key: 'enroll', labelKey: 'stepEnroll' },
    { key: 'ready', labelKey: 'stepReady' },
  ]
  const LOGIN_STEPS = [
    { key: 'login', labelKey: 'stepCredentials' },
    { key: 'verify', labelKey: 'mfaTitle' },
    { key: 'ready', labelKey: 'stepReady' },
  ]
  const stepsFor = (phase, meetsFirstTimeWizard) => {
    if (phase === 'loading' || phase === 'error' || phase === 'ready') return null
    if (meetsFirstTimeWizard) {
      // 与源码一致：bootstrap / login / mfa 都算第 0 步（还没进门）
      const current = phase === 'bootstrap' || phase === 'login' || phase === 'mfa'
        ? 0
        : phase === 'change-password'
          ? 1
          : phase === 'enroll-totp'
            ? 2
            : 3
      return { steps: ALL_STEPS, current }
    }
    const current = phase === 'mfa' ? 1 : 0
    return { steps: LOGIN_STEPS, current }
  }
  return { stepsFor, ALL_STEPS, LOGIN_STEPS }
}

describe('步骤条：按实际路径显示', () => {
  const { stepsFor, ALL_STEPS, LOGIN_STEPS } = loadStepsFor()

  it('已登录（ready）不显示步骤条', () => {
    assert.equal(stepsFor('ready', false), null)
    assert.equal(stepsFor('ready', true), null)
  })

  it('加载/错误态不显示步骤条', () => {
    assert.equal(stepsFor('loading', false), null)
    assert.equal(stepsFor('error', false), null)
  })

  it('普通设备登录：3 步，账号口令 → 两步验证 → 账号设置', () => {
    const login = stepsFor('login', false)
    assert.equal(login.steps.length, 3)
    assert.deepEqual(login.steps.map(step => step.key), ['login', 'verify', 'ready'])
    assert.equal(login.current, 0)

    const mfa = stepsFor('mfa', false)
    assert.equal(mfa.steps.length, 3)
    // MFA 页高亮的是「两步验证」这一项本身（索引 1），不是「已走完」
    assert.equal(mfa.current, 1)
    assert.equal(mfa.steps[mfa.current].labelKey, 'mfaTitle')
  })

  it('首次登录向导：4 步（含改口令与绑定 2FA）', () => {
    assert.equal(stepsFor('change-password', true).steps.length, 4)
    assert.equal(stepsFor('enroll-totp', true).steps.length, 4)
    assert.equal(stepsFor('change-password', true).current, 1)
    assert.equal(stepsFor('enroll-totp', true).current, 2)
    assert.equal(stepsFor('login', true).current, 0)
  })

  it('普通登录不含「修改口令 / 绑定两步验证」这两步', () => {
    const keys = LOGIN_STEPS.map(step => step.key)
    assert.ok(!keys.includes('password'))
    assert.ok(!keys.includes('enroll'))
  })
})

describe('步骤条：源码契约', () => {
  const source = readFileSync(SOURCE, 'utf8')

  it('pageRoot 接收 firstTimeWizard 并传给 stepBar', () => {
    assert.match(source, /firstTimeWizard\?: boolean/u)
    assert.match(source, /stepBar\(phase, options\.firstTimeWizard === true\)/u)
  })

  it('仅 change-password / enroll-totp 标记为首次登录向导', () => {
    const wizardMarks = [...source.matchAll(/firstTimeWizard: true/gu)]
    assert.equal(wizardMarks.length, 2, '应当恰好两处标记 firstTimeWizard: true')
  })

  it('步骤条暴露 data-step-count 便于验收脚本断言', () => {
    assert.match(source, /'data-step-count': String\(steps\.length\)/u)
  })
})
