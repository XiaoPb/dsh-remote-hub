/**
 * 真机 Android 验证：通过 adb 转发浏览器 DevTools，驱动手机上的页面。
 *
 * 覆盖验收文档里**必须在真机上看**的项：
 *  - F-1 iOS/移动端输入框 ≥16px（软键盘不缩放）
 *  - D-1 物理窄屏无横向滚动
 *  - H-3/主题：手机深色模式下的对比度
 *  - I-1 中文界面在真机上正确
 *  - A-1 口令眼睛按钮的 accessible name
 *
 * 前置：`adb reverse tcp:13091 tcp:13091`、`adb forward tcp:9334 localabstract:browser_webview_devtools_remote_<pid>`
 * 或 `tcp:9335 localabstract:chrome_devtools_remote`。
 *
 * @module scripts/ui-acceptance-mobile
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { ROOT } from './_shared.mjs'
import { openPage, sleep, contrastRatio } from './ui-acceptance-cdp.mjs'
import { readTotpSecret, totp } from './ui-acceptance-login.mjs'

const ADB = process.env.ADB ?? 'E:\\Android\\Sdk\\platform-tools\\adb.exe'
const OUT = join(ROOT, 'dev', 'ui-acceptance')
const SHOTS = join(OUT, 'shots')
mkdirSync(SHOTS, { recursive: true })

const results = []
/** 记一条。 */
function record(id, name, status, evidence) {
  results.push({ id, name, status, ...(evidence === undefined ? {} : { evidence }) })
  process.stdout.write(`${status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'BLOCKED'} ${id} ${name}\n`)
  if (status !== 'pass' && evidence !== undefined) process.stdout.write(`       ${JSON.stringify(evidence).slice(0, 400)}\n`)
}

/** 真机截图（走 adb pull，字节安全）。 */
function adbShot(name) {
  const remote = `/sdcard/ui-acc-${name}.png`
  execFileSync(ADB, ['shell', 'screencap', '-p', remote], { timeout: 30_000 })
  const local = join(SHOTS, `phone-${name}.png`)
  // ⚠️ 不能用 `exec-out ... > file`：PowerShell 重定向会把 PNG 按文本编码写坏。
  execFileSync(ADB, ['pull', remote, local], { timeout: 60_000, stdio: 'ignore' })
  try {
    execFileSync(ADB, ['shell', `rm -f ${remote}`], { timeout: 15_000, stdio: 'ignore' })
  } catch {
    // 清理失败不影响结果
  }
  return local
}

const token = /token=([A-Za-z0-9_-]+)/u.exec(readFileSync(join(OUT, 'sandbox.log'), 'utf8'))[1]
// 手机上可能同时存在多个 WebView 页面目标：有的窗口句柄是 0 高（`innerHeight === 0`，
// 页面在物理上「无处渲染」，截图一片空白）。逐个探测，挑**视口高度正常**的那个驱动。
const targets = await (await fetch(`http://127.0.0.1:${process.env.DEVTOOLS_PORT ?? 9334}/json/list`)).json()
const pageTargets = targets.filter(item => item.type === 'page')
if (pageTargets.length === 0) throw new Error('no page target on the phone browser')
let page = null
const probe = []
for (const candidate of pageTargets) {
  const probePage = await openPage(candidate.webSocketDebuggerUrl)
  const size = await probePage.eval('({ w: innerWidth, h: innerHeight })').catch(() => ({ w: 0, h: 0 }))
  probe.push({ id: candidate.id, ...size })
  if (size.h > 200) { page = probePage; break }
  probePage.close()
}
process.stdout.write(`page targets: ${JSON.stringify(probe)}\n`)
if (page === null) {
  throw new Error(`no usable page target (all viewports collapsed): ${JSON.stringify(probe)}`)
}

// 冷启动：清掉浏览器侧会话，保证从「登录页」开始（否则会直接进 ready，
// 测不到输入框字号 / 口令眼睛按钮这些登录页才有的东西）。
await page.cdp.send('Network.enable')
await page.cdp.send('Network.clearBrowserCookies')
await page.navigate(`http://127.0.0.1:13091/?token=${token}`)
// ⚠️ 手机上不保证 readyState 变成 complete（某个长连接/预取会让它长期停在
// interactive）。判据改成「DSH 外壳按钮已出现」，比 readyState 更贴近真实可用。
await page.waitFor(`document.querySelector('button[aria-label]') !== null`, { timeout: 90_000 })
await sleep(4000)

const device = await page.call(() => ({
  ua: navigator.userAgent,
  viewport: { w: window.innerWidth, h: window.innerHeight },
  dpr: window.devicePixelRatio,
  lang: document.documentElement.lang,
  hasShell: document.querySelector('button[aria-label]') !== null,
}))
process.stdout.write(`device: ${JSON.stringify(device)}\n`)
adbShot('01-shell')

// 打开 设置 → 登录与账号
//
// ⚠️ 移动端侧栏默认**收起**：「账号菜单」按钮此时在屏幕外（实测 x = -272），
// 点击无效、菜单项也不渲染。必须先点「打开侧边栏」把侧栏展开。
const nav = await page.call(async () => {
  const s = ms => new Promise(r => setTimeout(r, ms))
  // 1) 展开侧栏（若已展开则不需要）
  const openBtn = [...document.querySelectorAll('button')]
    .find(b => /^(打开侧边栏|Open sidebar)$/u.test(b.getAttribute('aria-label') ?? ''))
  if (openBtn !== undefined) { openBtn.click(); await s(1500) }

  // 2) 账号菜单 → 设置
  const menu = [...document.querySelectorAll('button')].find(b => /账号菜单|Account menu/.test(b.getAttribute('aria-label') ?? ''))
  if (menu === undefined) return { menu: false }
  const rect = menu.getBoundingClientRect()
  if (rect.left < 0) return { menu: true, offscreen: Math.round(rect.left) }
  menu.click(); await s(1200)
  const entries = [...document.querySelectorAll('[role=menuitem],button,a')]
  const settings = entries.find(e => /^(设置|Settings)$/.test(((e.innerText || '').split('\n').map(x => x.trim()).filter(Boolean)[0]) ?? ''))
  if (settings === undefined) return { menu: true, settings: false }
  settings.click(); await s(2500)

  // 3) 设置里的「登录与账号」分区
  const tab = [...document.querySelectorAll('[role=tab],button,a,[role=menuitem]')]
    .find(e => /^(登录与账号|Login & account)$/iu.test(((e.innerText || '').split('\n')[0] ?? '').trim()))
  tab?.click(); await s(2500)
  const root = document.querySelector('[data-testid="account-page"]')
  return { menu: true, settings: true, tab: tab !== undefined, phase: root?.getAttribute('data-phase') ?? null }
})
process.stdout.write(`nav: ${JSON.stringify(nav)}\n`)
adbShot('02-account')

// 真机窄屏：横向滚动
const overflow = await page.call(() => {
  const root = document.querySelector('[data-testid="account-page"]')
  return {
    viewportW: window.innerWidth,
    docScrollWidth: document.documentElement.scrollWidth,
    horizontalScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
    rootWidth: root === null ? null : Math.round(root.getBoundingClientRect().width),
  }
})
record('M-D-1', '真机窄屏（' + device.viewport.w + 'px）无横向滚动',
  overflow.horizontalScroll === false ? 'pass' : 'fail', overflow)

// 真机 F-1 / A-1：必须在**登录页**（或任何带口令框的页）采样。
// ready 态没有 input，先取，若没有就回登录页取。
const sampleLoginFields = async () => page.call(() => {
  const root = document.querySelector('[data-testid="account-page"]')
  if (root === null) return { inputs: [], eye: null, phase: null }
  return {
    phase: root.getAttribute('data-phase'),
    inputs: [...root.querySelectorAll('input,select,textarea')].map(i => ({
      testId: i.getAttribute('data-testid'), tag: i.tagName.toLowerCase(),
      fontSize: getComputedStyle(i).fontSize,
    })),
    eye: (() => {
      const b = root.querySelector('.rh-eye')
      return b === null ? null : { aria: b.getAttribute('aria-label'), title: b.getAttribute('title') }
    })(),
  }
})
let loginFields = await sampleLoginFields()
if (loginFields.inputs.length === 0 || loginFields.eye === null) {
  // 重新导航回登录页采样（真机上点「退出登录」不可靠：按钮可能在未展开的区块里）
  await page.cdp.send('Network.clearBrowserCookies')
  await page.navigate(`http://127.0.0.1:13091/?token=${token}`)
  await page.waitFor('document.readyState === "complete"', { timeout: 60_000 })
  await sleep(5000)
  await page.call(async () => {
    const s = ms => new Promise(r => setTimeout(r, ms))
    const openBtn = [...document.querySelectorAll('button')].find(b => /^(打开侧边栏|Open sidebar)$/u.test(b.getAttribute('aria-label') ?? ''))
    if (openBtn) { openBtn.click(); await s(1200) }
    const menu = [...document.querySelectorAll('button')].find(b => /账号菜单/.test(b.getAttribute('aria-label') ?? ''))
    menu?.click(); await s(1200)
    ;[...document.querySelectorAll('[role=menuitem],button,a')].find(e => /^(设置|Settings)$/.test(((e.innerText || '').split('\n').map(x => x.trim()).filter(Boolean)[0]) ?? ''))?.click(); await s(2500)
    ;[...document.querySelectorAll('[role=tab],button,a,[role=menuitem]')].find(e => /^(登录与账号|Login & account)$/iu.test(((e.innerText || '').split('\n')[0] ?? '').trim()))?.click(); await s(2500)
    return true
  })
  loginFields = await sampleLoginFields()
  adbShot('01b-login')
}
const inputs = loginFields.inputs
record('M-F-1', '真机输入控件 font-size ≥ 16px（移动端软键盘不缩放）',
  inputs.length > 0 && inputs.every(i => Number.parseFloat(i.fontSize) >= 16) ? 'pass' : 'fail', { phase: loginFields.phase, inputs })

// 真机 A-1：眼睛按钮 accessible name
const eye = loginFields.eye
record('M-A-1', '真机口令眼睛按钮有可访问名',
  eye !== null && (eye.aria ?? '').length > 0 ? 'pass' : 'fail', { eye })

// 真机 I-1：中文（若 DSH 语言是中文）
record('M-I-1', '真机界面语言与 DSH 设置一致',
  device.lang.startsWith('zh') ? 'pass' : 'blocked',
  { htmlLang: device.lang, note: '真机读取的是 DSH 自己的 <html lang>' })

// 登录到 ready（真机流程）
//
// ⚠️ 真机（小米浏览器 / Android WebView）里不能复用桌面的 `page.typeInto`
// （它依赖 CDP Input.insertText 打到聚焦元素，在 WebView 里偶发不生效）；
// 这里用「原生 value setter + input 事件」驱动受控输入，并把 TOTP 现算填进去。
let loginInfo = null
try {
  const phaseNow = await page.call(() => document.querySelector('[data-testid="account-page"]')?.getAttribute('data-phase') ?? null)
  if (phaseNow !== 'ready') {
    if (phaseNow === 'login') {
      await page.call((user, pass) => {
        const set = (sel, value) => {
          const el = document.querySelector(sel)
          if (el === null) return
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
          setter.call(el, value)
          el.dispatchEvent(new Event('input', { bubbles: true }))
        }
        set('[data-testid=login-username]', user)
        set('[data-testid=login-password]', pass)
        return true
      }, process.env.UI_TEST_USERNAME ?? 'demo', process.env.UI_TEST_PASSWORD ?? 'UiAcceptance!2026')
      await sleep(400)
      await page.eval('document.querySelector(\'[data-testid=login-submit]\')?.click()')
      for (let i = 0; i < 40; i += 1) {
        const now = await page.call(() => document.querySelector('[data-testid="account-page"]')?.getAttribute('data-phase') ?? null)
        if (now !== 'login') break
        await sleep(300)
      }
    }
    const phaseMfa = await page.call(() => document.querySelector('[data-testid="account-page"]')?.getAttribute('data-phase') ?? null)
    if (phaseMfa === 'mfa') {
      const info = readTotpSecret()
      if (info !== null) {
        await page.call(code => {
          const el = document.querySelector('[data-testid=mfa-code]')
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
          setter.call(el, code)
          el.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        }, totp(info.secret))
        await sleep(400)
        await page.eval('document.querySelector(\'[data-testid=mfa-submit]\')?.click()')
        await sleep(5000)
      }
    }
  }
  loginInfo = await page.call(() => ({
    phase: document.querySelector('[data-testid="account-page"]')?.getAttribute('data-phase') ?? null,
  }))
} catch (error) {
  loginInfo = { error: String(error).slice(0, 200) }
}
process.stdout.write(`login: ${JSON.stringify(loginInfo)}\n`)
await sleep(2000)
adbShot('03-ready')

if (loginInfo?.phase === 'ready') {
  // 真机 ready 态：滚动容器 + 语义色对比度
  const ready = await page.call(() => {
    const root = document.querySelector('[data-testid="account-page"]')
    const parse = css => { const m = /rgba?\(([^)]+)\)/.exec(css); if (!m) return [0,0,0,1]; const p = m[1].split(/[,\s\/]+/).filter(Boolean).map(Number); return [p[0],p[1],p[2],p[3] ?? 1] }
    const sample = el => {
      if (!el) return null
      const fg = parse(getComputedStyle(el).color)
      let n = el, bg = null
      while (n) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0.99) { bg = c; break } n = n.parentElement }
      if (!bg) bg = [255,255,255,1]
      const comp = v => [0,1,2].map(i => v[i]*v[3] + bg[i]*(1-v[3]))
      return { text: (el.innerText||'').trim().slice(0, 20), fg: comp(fg), bgc: bg.slice(0, 3) }
    }
    return {
      phase: root?.getAttribute('data-phase'),
      horizontalScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
      onlinePill: sample(root.querySelector('.rh-pill.is-online')),
      stepDone: sample(root.querySelector('.rh-step.is-done .rh-step-label')),
      meta: sample(root.querySelector('.rh-meta, .rh-k, .rh-section-desc')),
      tabs: [...root.querySelectorAll('[role=tablist]')].length,
    }
  })
  process.stdout.write(`ready: ${JSON.stringify(ready)}\n`)
  const ratios = ['onlinePill', 'stepDone', 'meta'].map(k => ready[k] === null ? null : Math.round(contrastRatio(ready[k].fg, ready[k].bgc) * 100) / 100).filter(r => r !== null)
  record('M-C-1', '真机 ready 态语义色/三级文字对比度 ≥ 4.5:1',
    ratios.length > 0 && ratios.every(r => r >= 4.5) ? 'pass' : 'fail', { ratios, ready })
  record('M-D-2', '真机 ready 态无横向滚动',
    ready.horizontalScroll === false ? 'pass' : 'fail', { horizontalScroll: ready.horizontalScroll })

  // 真机：展开全部区块后再测一次
  await page.call(async () => {
    const s = ms => new Promise(r => setTimeout(r, ms))
    const root = document.querySelector('[data-testid="account-page"]')
    for (const t of [...root.querySelectorAll('[data-testid=section-toggle]')]) {
      if (t.getAttribute('aria-expanded') === 'false') { t.click(); await s(400) }
    }
    return true
  })
  await sleep(1500)
  const expanded = await page.call(() => ({
    horizontalScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
    docScrollWidth: document.documentElement.scrollWidth,
    viewportW: window.innerWidth,
  }))
  record('M-D-3', '真机展开全部区块后仍无横向滚动',
    expanded.horizontalScroll === false ? 'pass' : 'fail', expanded)
  adbShot('04-expanded')
}

// 真机深色模式：用 DevTools 媒体模拟（手机系统夜览在部分 ROM 上不向 WebView 传播
// `prefers-color-scheme`，实测 `cmd uimode night yes` 后 matchMedia 仍为 false）。
// 模拟的是**同一个媒体查询**，渲染与对比度计算都在真机像素上完成。
try {
  await page.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
  await sleep(2000)
  const dark = await page.call(() => {
    const parse = css => { const m = /rgba?\(([^)]+)\)/.exec(css); if (!m) return [0,0,0,1]; const p = m[1].split(/[,\s\/]+/).filter(Boolean).map(Number); return [p[0],p[1],p[2],p[3] ?? 1] }
    const root = document.querySelector('[data-testid="account-page"]')
    const sample = el => {
      if (!el) return null
      const fg = parse(getComputedStyle(el).color)
      let n = el, bg = null
      while (n) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0.99) { bg = c; break } n = n.parentElement }
      if (!bg) bg = [23,25,29,1]
      const comp = v => [0,1,2].map(i => v[i]*v[3] + bg[i]*(1-v[3]))
      return { text: (el.innerText||'').trim().slice(0, 18), fg: comp(fg), bgc: bg.slice(0, 3) }
    }
    return {
      matchesDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
      rootBg: root === null ? null : getComputedStyle(root).backgroundColor,
      onlinePill: sample(root?.querySelector('.rh-pill.is-online')),
      stepDone: sample(root?.querySelector('.rh-step.is-done .rh-step-label')),
      desc: sample(root?.querySelector('.rh-section-desc')),
      k: sample(root?.querySelector('.rh-k')),
    }
  })
  const ratios = {}
  for (const key of ['onlinePill', 'stepDone', 'desc', 'k']) {
    if (dark[key] !== null) ratios[key] = Math.round(contrastRatio(dark[key].fg, dark[key].bgc) * 100) / 100
  }
  process.stdout.write(`dark: ${JSON.stringify({ matchesDark: dark.matchesDark, rootBg: dark.rootBg, ratios })}\n`)
  record('M-H-1', '真机深色模式生效（root 背景切到深色）',
    dark.matchesDark === true && /23, 25, 29|31, 34, 40/.test(dark.rootBg ?? '') ? 'pass' : 'fail',
    { matchesDark: dark.matchesDark, rootBg: dark.rootBg })
  record('M-H-2', '真机深色模式语义色对比度 ≥ 4.5:1',
    Object.keys(ratios).length > 0 && Object.values(ratios).every(r => r >= 4.5) ? 'pass' : 'fail',
    { ratios, sample: { pill: dark.onlinePill, step: dark.stepDone } })
  adbShot('05-dark')
  await page.cdp.send('Emulation.setEmulatedMedia', { features: [] })
  await sleep(1200)
} catch (error) {
  record('M-H-1', '真机深色模式', 'blocked', { error: String(error).slice(0, 200) })
}

const summary = {
  total: results.length,
  pass: results.filter(r => r.status === 'pass').length,
  fail: results.filter(r => r.status === 'fail').length,
  blocked: results.filter(r => r.status === 'blocked').length,
  device,
}
const { writeFileSync } = await import('node:fs')
writeFileSync(join(OUT, 'report-mobile.json'), JSON.stringify({ summary, results }, null, 2))
process.stdout.write(`\n${JSON.stringify(summary, null, 2)}\n`)
page.close()
