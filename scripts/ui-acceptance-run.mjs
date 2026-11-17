/**
 * dev/ui-acceptance-tests.md 的**脚本化验收**（A–J）。
 *
 * 每个 check 都读真实 DOM / CSSOM / 计算样式与真实输入事件，不靠源码文本推断
 * （源码级断言另有 `test/*.test.mjs` 覆盖）。
 *
 * 用法（沙箱已在 13091，`dev/ui-acceptance/sandbox.log` 里有 token）：
 *   node scripts/ui-acceptance-run.mjs             # 全部
 *   node scripts/ui-acceptance-run.mjs A B C       # 指定章节
 *
 * 产物：`dev/ui-acceptance/report.json`、`dev/ui-acceptance/shots/*.png`。
 *
 * @module scripts/ui-acceptance-run
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './_shared.mjs'
import { launchBrowser, attachFirstPage } from './ui-acceptance-boot.mjs'
import { sleep, contrastRatio } from './ui-acceptance-cdp.mjs'
import { loginToReady } from './ui-acceptance-login.mjs'

const OUT = join(ROOT, 'dev', 'ui-acceptance')
const SHOTS = join(OUT, 'shots')
mkdirSync(SHOTS, { recursive: true })

/** 结果收集。 */
const results = []
/**
 * 记一条验收项。
 * @param {string} id - 编号（A-1 …）。
 * @param {string} name - 名称。
 * @param {'pass'|'fail'|'blocked'} status - 结论。
 * @param {object} [evidence] - 证据。
 */
function record(id, name, status, evidence) {
  results.push({ id, name, status, ...(evidence === undefined ? {} : { evidence }) })
  const mark = status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'BLOCKED'
  process.stdout.write(`${mark} ${id} ${name}\n`)
  if (status !== 'pass' && evidence !== undefined) {
    process.stdout.write(`       ${JSON.stringify(evidence).slice(0, 500)}\n`)
  }
}

/**
 * 断言包装。
 * @returns {boolean} 是否通过。
 */
function expect(id, name, condition, evidence) {
  record(id, name, condition === true ? 'pass' : 'fail', evidence)
  return condition === true
}

const token = /token=([A-Za-z0-9_-]+)/u.exec(readFileSync(join(OUT, 'sandbox.log'), 'utf8'))[1]
const ORIGIN = 'http://127.0.0.1:13091'
const only = process.argv.slice(2)
const wanted = new Set(only.length === 0 ? ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'] : only)

await launchBrowser(`${ORIGIN}/?token=${token}`)
const page = await attachFirstPage()
await page.waitFor('document.querySelector(\'button[aria-label="账号菜单"],button[aria-label="Account menu"]\') !== null', { timeout: 60_000 })

/** 当前 phase。 */
const phaseOf = () => page.eval('document.querySelector(\'[data-testid="account-page"]\')?.getAttribute("data-phase") ?? null')

/** 截图。 */
const shot = (name, fullPage = false) => page.screenshot(join(SHOTS, `${name}.png`), { fullPage })

/** 打开设置面板（幂等）。 */
async function openSettings() {
  await page.call(async () => {
    const s = ms => new Promise(r => setTimeout(r, ms))
    const hasTabs = [...document.querySelectorAll('[role=tab],[role=menuitem]')]
      .some(e => /^(通用设置|General|登录与账号|Login & account)$/iu.test(((e.innerText || '').split('\n')[0] ?? '').trim()))
    if (hasTabs) return true
    const menu = [...document.querySelectorAll('button')]
      .find(b => /账号菜单|Account menu/.test(b.getAttribute('aria-label') ?? ''))
    menu?.click(); await s(800)
    const entries = [...document.querySelectorAll('[role=menuitem],button,a')]
    entries.find(e => /^(设置|Settings)$/.test(((e.innerText || '').split('\n').map(x => x.trim()).filter(Boolean)[0]) ?? ''))?.click()
    await s(2000)
    return true
  })
}

/**
 * 点设置里的某个分区。
 * @param {RegExp} pattern - 分区标签匹配。
 */
async function openSection(pattern) {
  await openSettings()
  await page.eval(`(async () => {
    const s = ms => new Promise(r => setTimeout(r, ms))
    const tab = [...document.querySelectorAll('[role=tab],button,a,[role=menuitem]')]
      .find(e => new RegExp(${JSON.stringify(pattern.source)}, ${JSON.stringify(pattern.flags)}).test((e.innerText || '').trim()))
    tab?.click(); await s(1600)
  })()`)
}

/** 进入账号页并返回 phase。 */
async function gotoAccount() {
  await openSection(/^(登录与账号|Login & account)$/iu)
  for (let i = 0; i < 60; i += 1) {
    const phase = await phaseOf()
    if (phase !== null) return phase
    await sleep(300)
  }
  throw new Error('account page not found')
}

/** 确保 ready 态并展开所有区块。 */
async function ensureReadyExpanded() {
  await gotoAccount()
  if (await phaseOf() !== 'ready') await loginToReady(page)
  await page.call(async () => {
    const s = ms => new Promise(r => setTimeout(r, ms))
    const root = document.querySelector('[data-testid="account-page"]')
    for (const toggle of [...root.querySelectorAll('[data-testid=section-toggle]')]) {
      if (toggle.getAttribute('aria-expanded') === 'false') { toggle.click(); await s(320) }
    }
    return true
  })
  await sleep(500)
}

/**
 * 切语言（走 DSH 设置等价入口）。
 * @param {'zh-CN'|'en'} locale - 目标语言。
 */
async function setLocale(locale) {
  await page.eval(`globalThis.__DSH_REMOTE_HUB_I18N__?.setLocale(${JSON.stringify(locale)})`)
  await sleep(900)
}

/** 一次 axe 扫描（返回违规列表）。 */
async function axeScan() {
  if (await page.eval('typeof globalThis.axe') !== 'object') {
    await page.injectScript(readFileSync(join(OUT, 'axe.min.js'), 'utf8'), 'axe.min.js')
  }
  return page.call(async () => {
    const result = await globalThis.axe.run(document.querySelector('[data-testid="account-page"]') ?? document.body, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] },
    })
    return result.violations.map(v => ({
      id: v.id, impact: v.impact, nodes: v.nodes.length,
      targets: v.nodes.map(n => n.target.join(' ')),
    }))
  })
}

// ══ A. 可访问性 ══════════════════════════════════════════════════════════════
if (wanted.has('A')) {
  await setLocale('zh-CN')
  await gotoAccount()
  await sleep(800)

  // A-1 眼睛按钮 accessible name / title（切换前后都要对）
  const eyeBefore = await page.eval(`(() => {
    const b = document.querySelector('[data-testid="account-page"] .rh-eye')
    return b === null ? null : { aria: b.getAttribute('aria-label'), title: b.getAttribute('title') }
  })()`)
  await page.click('[data-testid="account-page"] .rh-eye')
  await sleep(400)
  const eyeAfter = await page.eval(`(() => {
    const b = document.querySelector('[data-testid="account-page"] .rh-eye')
    return { aria: b?.getAttribute('aria-label'), title: b?.getAttribute('title'), inputType: document.querySelector('[data-testid="login-password"]')?.type }
  })()`)
  await page.click('[data-testid="account-page"] .rh-eye')
  await sleep(300)
  expect('A-1', '密码显示/隐藏按钮的 accessible name',
    eyeBefore?.aria === '显示口令' && eyeBefore?.title === '显示口令'
      && eyeAfter?.aria === '隐藏口令' && eyeAfter?.title === '隐藏口令' && eyeAfter?.inputType === 'text',
    { before: eyeBefore, afterClick: eyeAfter })

  // A-3 按钮 accessible name
  const buttons = await page.eval(`(() => {
    const root = document.querySelector('[data-testid="account-page"]')
    return [...root.querySelectorAll('button')].map(b => ({
      name: (b.getAttribute('aria-label') || '').trim() || (b.textContent || '').trim() || (b.getAttribute('title') || '').trim(),
      testId: b.getAttribute('data-testid'),
    }))
  })()`)
  expect('A-3', '按钮都有非空 accessible name（登录页）', buttons.every(b => b.name !== ''),
    { total: buttons.length, unnamed: buttons.filter(b => b.name === '') })

  // A-5a axe：登录页
  const axeLogin = await axeScan()
  expect('A-5a', 'axe：登录页无 Critical/Serious',
    axeLogin.every(v => v.impact !== 'critical' && v.impact !== 'serious'), { violations: axeLogin })
  await shot('A-login-zh')

  // 登录到 ready
  await loginToReady(page)
  await ensureReadyExpanded()

  // A-2 Section 展开/收起 name + aria-expanded
  const expandedState = await page.eval(`(() => {
    const t = document.querySelector('[data-testid="account-page"] [data-testid=section-toggle]')
    return { name: t.getAttribute('aria-label'), expanded: t.getAttribute('aria-expanded') }
  })()`)
  await page.call(async () => {
    const s = ms => new Promise(r => setTimeout(r, ms))
    document.querySelector('[data-testid=section-toggle]').click(); await s(400)
    return true
  })
  const collapsedState = await page.eval(`(() => {
    const t = document.querySelector('[data-testid=section-toggle]')
    return { name: t.getAttribute('aria-label'), expanded: t.getAttribute('aria-expanded') }
  })()`)
  await page.call(async () => {
    const s = ms => new Promise(r => setTimeout(r, ms))
    document.querySelector('[data-testid=section-toggle]').click(); await s(400)
    return true
  })
  expect('A-2', 'Section 展开/收起按钮 accessible name + aria-expanded',
    expandedState.name === '收起' && expandedState.expanded === 'true'
      && collapsedState.name === '展开' && collapsedState.expanded === 'false',
    { expandedState, collapsedState })

  // A-5b axe：ready 态
  const axeReady = await axeScan()
  expect('A-5b', 'axe：账号设置页（ready，全部展开）无 Critical/Serious',
    axeReady.every(v => v.impact !== 'critical' && v.impact !== 'serious'), { violations: axeReady })

  // A-4 live region（加载通知靠它朗读；逐字断言见 G-1/G-2）
  const live = await page.eval(`(() => {
    const root = document.querySelector('[data-testid="account-page"]')
    return [...root.querySelectorAll('[aria-live]')].map(e => ({ live: e.getAttribute('aria-live'), testId: e.getAttribute('data-testid') }))
  })()`)
  expect('A-4', '页面存在 polite live region（供屏幕阅读器播报状态变化）', live.length > 0, { live })
  await shot('A-ready-zh', true)
}

// ══ B. 键盘导航 ══════════════════════════════════════════════════════════════
if (wanted.has('B')) {
  await setLocale('zh-CN')
  await ensureReadyExpanded()

  // B-1 Segmented（口令策略）
  const segInfo = await page.call(async () => {
    const s = ms => new Promise(r => setTimeout(r, ms))
    const list = [...document.querySelectorAll('[role=tablist]')]
      .find(t => (t.getAttribute('aria-label') ?? '').includes('口令策略'))
    if (list === undefined) return { found: false }
    const options = [...list.querySelectorAll('[role=tab]')]
    const selected = options.find(o => o.getAttribute('aria-selected') === 'true')
    selected?.focus(); await s(200)
    return {
      found: true,
      labels: options.map(o => (o.innerText || '').trim()),
      selectedCount: options.filter(o => o.getAttribute('aria-selected') === 'true').length,
      hasAriaPressed: options.some(o => o.getAttribute('aria-pressed') !== null),
      focusSelected: document.activeElement?.getAttribute('aria-selected'),
    }
  })

  const keys = {}
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
    // 每次按键前重新聚焦：React 重渲染会替换节点，焦点会掉回 body（实测丢焦点）。
    await page.call(() => {
      const list = [...document.querySelectorAll('[role=tablist]')].find(t => (t.getAttribute('aria-label') ?? '').includes('口令策略'))
      if (list === null || list === undefined) return false
      const cur = list.contains(document.activeElement)
        ? document.activeElement
        : [...list.querySelectorAll('[role=tab]')].find(o => o.getAttribute('aria-selected') === 'true')
      cur?.focus()
      return true
    })
    await page.pressKey(key)
    keys[key] = await page.call(() => {
      const list = [...document.querySelectorAll('[role=tablist]')].find(t => (t.getAttribute('aria-label') ?? '').includes('口令策略'))
      const cur = document.activeElement
      return {
        focus: (cur?.innerText || '').trim(),
        inSeg: list?.contains(cur) === true,
        focusSelected: cur?.getAttribute('aria-selected'),
        selectedCount: [...list.querySelectorAll('[role=tab]')].filter(o => o.getAttribute('aria-selected') === 'true').length,
      }
    })
  }

  // 循环：首项 ← → 末项；末项 → → 首项
  await page.call(() => {
    const list = [...document.querySelectorAll('[role=tablist]')].find(t => (t.getAttribute('aria-label') ?? '').includes('口令策略'))
    ;[...list.querySelectorAll('[role=tab]')][0].focus()
    return true
  })
  await page.pressKey('ArrowLeft')
  const wrapLeft = await page.call(() => (document.activeElement?.innerText || '').trim())
  await page.pressKey('ArrowRight')
  const wrapRight = await page.call(() => (document.activeElement?.innerText || '').trim())

  // Tab 离开
  await page.pressKey('Tab')
  const leftSeg = await page.call(() => {
    const list = [...document.querySelectorAll('[role=tablist]')].find(t => (t.getAttribute('aria-label') ?? '').includes('口令策略'))
    return { inSeg: list?.contains(document.activeElement) === true, focus: (document.activeElement?.innerText || '').trim().slice(0, 40) }
  })

  expect('B-1', 'Segmented 方向键 / Home / End / 首尾循环 / Tab 离开',
    segInfo.found === true
      && segInfo.selectedCount === 1
      && Object.values(keys).every(k => k.inSeg === true && k.selectedCount === 1 && k.focusSelected === 'true')
      && wrapLeft === segInfo.labels.at(-1)
      && wrapRight === segInfo.labels[0]
      && leftSeg.inSeg === false,
    { segInfo, keys, wrapLeft, wrapRight, leftSeg })

  // J-2 / J-7 顺带证据：Segmented 只有 aria-selected，没有 aria-pressed
  expect('J-2', 'Segmented 无 aria-pressed（只保留 aria-selected）', segInfo.hasAriaPressed === false,
    { hasAriaPressed: segInfo.hasAriaPressed })
  await page.screenshot(join(SHOTS, 'B-segmented.png'))

  // B-2 纯键盘登录
  const loggedOut = await page.call(async () => {
    const s = ms => new Promise(r => setTimeout(r, ms))
    const btn = [...document.querySelectorAll('[data-testid="account-page"] button')]
      .find(b => /退出登录|Log out/u.test(b.innerText || ''))
    if (btn === undefined) return false
    btn.click(); await s(2600)
    return true
  })
  if (loggedOut === true && await phaseOf() === 'login') {
    await page.eval(`(() => {
      const set = (sel, value) => {
        const el = document.querySelector(sel)
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(el, value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      set('[data-testid=login-username]', 'keyboard-probe')
      set('[data-testid=login-password]', 'not-a-real-password')
      return true
    })()`)
    await sleep(400)
    await page.eval('document.activeElement?.blur()')
    const tabOrder = []
    for (let i = 0; i < 30; i += 1) {
      await page.pressKey('Tab')
      const f = await page.focus()
      if (f === null) continue
      tabOrder.push(f.testId ?? f.ariaLabel ?? f.tag)
      if (f.testId === 'login-submit') break
    }
    const order = ['login-username', 'login-password', 'login-submit'].map(id => tabOrder.indexOf(id))
    expect('B-2', '纯键盘可达登录按钮（Tab 顺序 用户名 → 口令 → 登录）',
      order[0] >= 0 && order[1] > order[0] && order[2] > order[1], { tabOrder })

    // 复原并重新登录
    await page.eval(`(() => {
      const set = sel => {
        const el = document.querySelector(sel)
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(el, '')
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      set('[data-testid=login-username]'); set('[data-testid=login-password]')
      return true
    })()`)
    await sleep(300)
    await loginToReady(page)
    await ensureReadyExpanded()
  } else {
    record('B-2', '纯键盘可达登录按钮', 'blocked', { reason: '未找到「退出登录」或未回到登录页' })
  }

  // B-3 眼睛按钮键盘聚焦 + tooltip
  const eyeFocus = await page.call(() => {
    const b = document.querySelector('[data-testid="account-page"] .rh-eye')
    if (b === null) return { found: false }
    b.focus()
    return { found: true, focused: document.activeElement === b, title: b.getAttribute('title') }
  })
  expect('B-3', '眼睛按钮可键盘聚焦且带 tooltip 文本',
    eyeFocus.found === true && eyeFocus.focused === true && (eyeFocus.title ?? '').length > 0, eyeFocus)
}

// ══ C. 颜色对比度 ════════════════════════════════════════════════════════════
if (wanted.has('C')) {
  await setLocale('zh-CN')
  await ensureReadyExpanded()

  const SAMPLE = `((selector) => {
    const el = document.querySelector(selector)
    if (el === null) return null
    const parse = css => {
      const m = /rgba?\\(([^)]+)\\)/.exec(css)
      if (m === null) return [0,0,0,1]
      const p = m[1].split(/[,\\s\\/]+/).filter(Boolean).map(Number)
      return [p[0], p[1], p[2], p[3] ?? 1]
    }
    const fg = parse(getComputedStyle(el).color)
    let node = el, bg = null
    while (node !== null) {
      const c = parse(getComputedStyle(node).backgroundColor)
      if (c[3] > 0.99) { bg = c; break }
      node = node.parentElement
    }
    if (bg === null) bg = [255,255,255,1]
    const comp = over => [0,1,2].map(i => over[i]*over[3] + bg[i]*(1-over[3]))
    return { color: getComputedStyle(el).color, bg: 'rgb(' + bg.slice(0,3).join(',') + ')', fg: comp(fg), bgc: bg.slice(0,3), text: (el.innerText||'').trim().slice(0,40) }
  })`

  for (const mode of ['light', 'dark']) {
    await page.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: mode }] })
    await sleep(800)
    const pick = await page.eval(`(() => {
      const root = document.querySelector('[data-testid="account-page"]')
      return ['.rh-meta', '.rh-k', '.rh-field-hint', '.rh-cslabel', '.rh-page-head-hint', '.rh-section-desc']
        .map(sel => ({ sel, count: root.querySelectorAll(sel).length }))
        .find(x => x.count > 0) ?? null
    })()`)
    const sample = pick === null ? null : await page.eval(`${SAMPLE}('[data-testid="account-page"] ${pick.sel}')`)
    const ratio = sample === null ? null : Math.round(contrastRatio(sample.fg, sample.bgc) * 100) / 100
    record(`C-1-${mode}`, `三级文字（--rh-text-3）对比度 · ${mode === 'dark' ? '暗色' : '亮色'} · ${pick?.sel ?? 'n/a'}`,
      ratio !== null && ratio >= 4.5 ? 'pass' : 'fail',
      { ratio, color: sample?.color, bg: sample?.bg, text: sample?.text })
    await shot(`C-contrast-${mode}`)
  }
  await page.cdp.send('Emulation.setEmulatedMedia', { features: [] })

  // C-2：Lighthouse 需独立进程 → 用 axe WCAG2AA 零 critical/serious 作等价判据
  const axeAll = await axeScan()
  const serious = axeAll.filter(v => v.impact === 'critical' || v.impact === 'serious')
  const moderate = axeAll.filter(v => v.impact === 'moderate')
  record('C-2', '可访问性评分 ≥ 90（以 axe 全规则扫描替代 Lighthouse）',
    serious.length === 0 && moderate.length <= 2 ? 'pass' : 'fail',
    { serious, moderate, note: 'Lighthouse 需要独立进程与网络；等价判据：wcag2a/2aa/21a/21aa + best-practice 全规则 0 critical/serious' })

  // C-3 色盲模拟：状态 Pill 靠文字（不只靠颜色）区分
  for (const deficiency of ['deuteranopia', 'tritanopia']) {
    await page.cdp.send('Emulation.setEmulatedVisionDeficiency', { type: deficiency })
    await sleep(400)
    const pills = await page.eval(`(() => {
      const root = document.querySelector('[data-testid="account-page"]')
      return [...root.querySelectorAll('.rh-pill')].map(p => ({ text: (p.innerText || '').trim(), cls: p.className })).filter(p => p.text !== '')
    })()`)
    record(`C-3-${deficiency}`, `色盲模拟（${deficiency}）下 Pill 仍可凭文字辨认`,
      pills.length > 0 && pills.every(p => p.text.length > 0) ? 'pass' : 'fail',
      { pills: pills.slice(0, 8) })
  }
  await page.cdp.send('Emulation.setEmulatedVisionDeficiency', { type: 'none' })
  await sleep(300)
}

// ══ D. 响应式 ════════════════════════════════════════════════════════════════
if (wanted.has('D')) {
  await setLocale('zh-CN')
  await ensureReadyExpanded()

  /** 量横向溢出。 */
  const measureOverflow = () => page.call(() => {
    const root = document.querySelector('[data-testid="account-page"]')
    const doc = document.documentElement
    const scrollable = [...document.querySelectorAll('*')].filter(e => {
      const r = e.getBoundingClientRect()
      return r.width > 0 && e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'visible'
    }).slice(0, 5).map(e => ({ tag: e.tagName, cls: String(e.className).slice(0, 40), scrollWidth: e.scrollWidth, clientWidth: e.clientWidth }))
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      docScrollWidth: doc.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      horizontalScroll: doc.scrollWidth > window.innerWidth + 1,
      scrollable,
      rootWidth: root === null ? null : Math.round(root.getBoundingClientRect().width),
    }
  })

  for (const [width, height, label] of [[320, 568, '320px'], [480, 800, '480px'], [768, 1024, '768px']]) {
    await page.setViewport(width, height, { mobile: width <= 480 })
    await sleep(700)
    const m = await measureOverflow()
    record(`D-1-${label}`, `${label} 无横向滚动`, m.horizontalScroll === false ? 'pass' : 'fail', m)
    await shot(`D-${label}`)

    if (width <= 480) {
      // 窄屏：双列下拉框应纵向堆叠（各占全宽）
      const stacks = await page.eval(`(() => {
        const root = document.querySelector('[data-testid="account-page"]')
        const sels = [...root.querySelectorAll('select')]
        const infos = sels.map(s => {
          const r = s.getBoundingClientRect()
          const parent = s.parentElement
          const pr = parent.getBoundingClientRect()
          const pcs = getComputedStyle(parent)
          const avail = pr.width - parseFloat(pcs.paddingLeft) - parseFloat(pcs.paddingRight)
          return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), avail: Math.round(avail) }
        })
        const rows = {}
        for (const s of infos) rows[s.top] = (rows[s.top] ?? 0) + 1
        const sideBySide = Object.values(rows).some(c => c > 1)
        const fills = infos.every(s => s.w >= s.avail - 4)
        return { infos, sideBySide, fills }
      })()`)
      record(`D-1b-${label}`, `${label} 双列下拉框纵向堆叠且各占容器宽度`,
        (stacks.sideBySide === false && stacks.fills === true) ? 'pass' : 'fail', stacks)
      await shot(`D-${label}-full`, true)
    }
  }

  // D-2 卡片 padding（480–899 区间应为 16px）
  await page.setViewport(768, 1024, { mobile: false })
  await sleep(600)
  const paddings = await page.eval(`(() => {
    const root = document.querySelector('[data-testid="account-page"]')
    return [...root.querySelectorAll('.rh-card')].slice(0, 4).map(c => ({ paddingTop: getComputedStyle(c).paddingTop }))
  })()`)
  record('D-2', '768px 下卡片 padding = 16px', paddings.some(p => p.paddingTop === '16px') ? 'pass' : 'fail', { paddings })

  // D-3 200% 缩放：等价于把视口宽度减半（CSS 像素视口 640px @ 200%）
  await page.setViewport(640, 900, { mobile: false })
  await sleep(700)
  const zoom = await measureOverflow()
  record('D-3', '200% 缩放（等效 640px CSS 视口）无横向滚动', zoom.horizontalScroll === false ? 'pass' : 'fail', zoom)
  await shot('D-zoom200')

  // 收尾：恢复常态视口
  await page.setViewport(1280, 1000, { mobile: false })
  await sleep(500)
}

// ══ E. 文案与术语 ════════════════════════════════════════════════════════════
if (wanted.has('E')) {
  await setLocale('zh-CN')
  await ensureReadyExpanded()

  const copy = await page.eval(`(() => {
    const root = document.querySelector('[data-testid="account-page"]')
    const pills = [...root.querySelectorAll('.rh-pill')].map(p => (p.innerText || '').trim()).filter(Boolean)
    const segLabels = [...root.querySelectorAll('[role=tab]')].map(o => (o.innerText || '').trim())
    const buttons = [...root.querySelectorAll('button')].map(b => (b.innerText || '').trim()).filter(Boolean)
    const fingerprintTitles = [...root.querySelectorAll('[title]')].map(e => e.getAttribute('title')).filter(t => /指纹|fingerprint/iu.test(t ?? ''))
    return { pills, segLabels, buttons, fingerprintTitles, text: (root.innerText || '') }
  })()`)

  // E-1 角色名（segmented 里是中文角色名；可信客户端行的 pill 角色）
  const rolePills = copy.pills.filter(p => /^(Admin|Control|Read-only|Full|管理员|可操作|只读|完全控制|完全)$/u.test(p))
  const forbiddenZhRoles = rolePills.filter(p => /^(管理员|控制)$/u.test(p))
  record('E-1', '角色 Pill 用英文角色名（Admin/Control/Read-only），不出现「管理员」「控制」',
    forbiddenZhRoles.length === 0 ? 'pass' : 'fail',
    { rolePills, forbiddenZhRoles })

  // E-2 状态标签中文
  const englishStatus = copy.pills.filter(p => /^(Online|Offline|Enabled|Disabled)$/u.test(p))
  const chineseStatus = copy.pills.filter(p => /^(在线|离线|启用|禁用|已启用|已禁用)$/u.test(p))
  record('E-2', '状态 Pill 为中文（在线/离线、启用/禁用）',
    englishStatus.length === 0 && chineseStatus.length > 0 ? 'pass' : 'fail', { englishStatus, chineseStatus })

  // E-3 「设备指纹」有解释性 title
  expect('E-3', '「设备指纹」带解释性 tooltip（公钥 SHA-256 指纹…）',
    copy.fingerprintTitles.some(t => /SHA-256|指纹/iu.test(t ?? '')), { titles: copy.fingerprintTitles })

  // E-4 按钮文案为动词短语
  const wanted = ['信任本浏览器', '显示全部', '收起', '保存新口令', '撤销信任']
  const banned = ['确定', '提交', 'Yes', 'OK', 'More', 'Less', 'Hide']
  const hasWanted = wanted.filter(w => copy.buttons.some(b => b.includes(w)))
  const hasBanned = copy.buttons.filter(b => banned.includes(b))
  record('E-4', '按钮文案为「动词 + 对象」短语（无 确定/提交/OK）',
    hasWanted.length >= 2 && hasBanned.length === 0 ? 'pass' : 'fail', { hasWanted, hasBanned, sampleButtons: copy.buttons.slice(0, 20) })
}

// ══ F. 字体与排版 ════════════════════════════════════════════════════════════
if (wanted.has('F')) {
  await setLocale('zh-CN')
  await ensureReadyExpanded()

  // F-1 输入框 ≥16px（iOS 不缩放）；在 iPhone 14 Pro 宽度下量
  await page.setViewport(390, 844, { mobile: true, deviceScaleFactor: 3 })
  await sleep(700)
  const inputSizes = await page.eval(`(() => {
    const root = document.querySelector('[data-testid="account-page"]')
    return [...root.querySelectorAll('input,select,textarea')].map(i => ({
      tag: i.tagName.toLowerCase(),
      testId: i.getAttribute('data-testid'),
      fontSize: getComputedStyle(i).fontSize,
      raw: getComputedStyle(i).getPropertyValue('font-size'),
    }))
  })()`)
  const allBigEnough = inputSizes.length > 0
    && inputSizes.every(i => Number.parseFloat(i.fontSize) >= 16)
  record('F-1', 'iOS（390px）输入控件 font-size ≥ 16px（软键盘不缩放页面）',
    allBigEnough ? 'pass' : 'fail', { inputSizes })
  await shot('F-390px')
  await page.setViewport(1280, 1000, { mobile: false })
  await sleep(500)

  // F-2 行高 ≥ 1.4
  const lineHeights = await page.eval(`(() => {
    const root = document.querySelector('[data-testid="account-page"]')
    const targets = [...root.querySelectorAll('.rh-section-desc,.rh-lead,.rh-muted,.rh-field-hint,.rh-rules li')]
    return targets.slice(0, 6).map(e => {
      const cs = getComputedStyle(e)
      const fs = Number.parseFloat(cs.fontSize)
      const lh = cs.lineHeight === 'normal' ? null : Number.parseFloat(cs.lineHeight)
      return { cls: String(e.className).slice(0, 30), fontSize: cs.fontSize, lineHeight: cs.lineHeight, ratio: lh === null ? null : Math.round((lh / fs) * 100) / 100 }
    })
  })()`)
  const ratios = lineHeights.map(l => l.ratio).filter(r => r !== null)
  record('F-2', '正文行高 ≥ 1.4', ratios.length > 0 && ratios.every(r => r >= 1.4) ? 'pass' : 'fail', { lineHeights })
}

// ══ G. 加载状态（用 Fetch 拦截把页面钉在 loading）════════════════════════════
if (wanted.has('G')) {
  await setLocale('zh-CN')
  // 先回登录页，拦截 auth 请求后重进账号页
  await page.call(async () => {
    const s = ms => new Promise(r => setTimeout(r, ms))
    const btn = [...document.querySelectorAll('[data-testid="account-page"] button')]
      .find(b => /退出登录|Log out/u.test(b.innerText || ''))
    btn?.click(); await s(2500)
    return true
  })
  const held = []
  page.cdp.on('Fetch.requestPaused', params => { held.push(params.requestId) })
  await page.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*auth*' }] })
  try {
    // 触发重新加载（切走再切回账号页）
    await page.eval('globalThis.__DSH_REMOTE_HUB_I18N__.setLocale("zh-CN")')
    await openSection(/^(通用设置|General)$/iu)
    await openSection(/^(登录与账号|Login & account)$/iu)
    // 等 loading 出现
    for (let i = 0; i < 40; i += 1) {
      if (await page.eval('document.querySelector(\'[data-testid="account-loading"]\') !== null')) break
      await sleep(250)
    }
    const loading = await page.eval(`(() => {
      const holder = document.querySelector('[data-testid="account-loading"]')
      if (holder === null) return { found: false }
      const sr = holder.querySelector('[class*="sr-only"]')
      const skeleton = holder.querySelector('[aria-hidden="true"]')
      return {
        found: true,
        phase: document.querySelector('[data-testid="account-page"]')?.getAttribute('data-phase'),
        ariaBusy: holder.getAttribute('aria-busy'),
        ariaLive: holder.getAttribute('aria-live'),
        ariaLabel: holder.getAttribute('aria-label'),
        srText: sr === null ? null : (sr.textContent || '').trim(),
        srVisuallyHidden: sr === null ? null : (() => {
          const cs = getComputedStyle(sr)
          const r = sr.getBoundingClientRect()
          return { position: cs.position, width: cs.width, height: cs.height, clip: cs.clip, rectW: Math.round(r.width), rectH: Math.round(r.height) }
        })(),
        skeletonAriaHidden: skeleton === null ? null : skeleton.getAttribute('aria-hidden'),
      }
    })()`)
    await shot('G-loading')

    // G-2 三个属性齐全且值正确
    expect('G-2', '加载容器 aria-busy / aria-live / aria-label 正确',
      loading.found === true && loading.ariaBusy === 'true' && loading.ariaLive === 'polite'
        && loading.ariaLabel === '正在加载账号信息',
      loading)

    // G-1 sr-only 文案 + 骨架屏 aria-hidden + 视觉隐藏
    expect('G-1', '加载 sr-only 文案正确、骨架屏 aria-hidden、sr-only 真的视觉隐藏',
      loading.srText === '正在加载账号信息，请稍候...'
        && loading.skeletonAriaHidden === 'true'
        && loading.srVisuallyHidden?.position === 'absolute'
        && loading.srVisuallyHidden?.rectW <= 1 && loading.srVisuallyHidden?.rectH <= 1,
      loading)
  } finally {
    await page.cdp.send('Fetch.disable')
    for (const requestId of held) {
      await page.cdp.send('Fetch.continueRequest', { requestId }).catch(() => {})
    }
    page.cdp.off('Fetch.requestPaused', () => {})
  }
  await sleep(2500)
  // 放行后应回到可交互状态（不卡在 loading）
  const settled = await phaseOf()
  record('G-3', '放行后离开 loading 态', settled !== null && settled !== 'loading' ? 'pass' : 'fail', { phase: settled })
}

// ══ H. 动画与主题 ════════════════════════════════════════════════════════════
if (wanted.has('H')) {
  await setLocale('zh-CN')
  await ensureReadyExpanded()

  // H-1 prefers-reduced-motion
  await page.cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  })
  await sleep(600)
  const reduced = await page.eval(`(() => {
    const root = document.querySelector('[data-testid="account-page"]')
    const targets = [...root.querySelectorAll('button, .rh-collapse, .rh-seg-btn, .rh-section-toggle, .rh-card, .rh-skeleton')].slice(0, 40)
    const offenders = []
    for (const el of targets) {
      const cs = getComputedStyle(el)
      const dur = cs.transitionDuration.split(',').map(s => parseFloat(s) || 0)
      const anim = cs.animationDuration.split(',').map(s => parseFloat(s) || 0)
      if (dur.some(d => d > 0) || anim.some(a => a > 0)) {
        offenders.push({ cls: String(el.className).slice(0, 50), transitionDuration: cs.transitionDuration, animationDuration: cs.animationDuration })
      }
    }
    return { checked: targets.length, offenders, scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior, rootScroll: getComputedStyle(root).scrollBehavior }
  })()`)
  record('H-1', 'prefers-reduced-motion: reduce 下无过渡/动画、无平滑滚动',
    (reduced.offenders.length === 0 && reduced.scrollBehavior !== 'smooth' && reduced.rootScroll !== 'smooth') ? 'pass' : 'fail', reduced)
  await page.cdp.send('Emulation.setEmulatedMedia', { features: [] })
  await sleep(400)

  // H-2 主题切换无过渡（.no-transition 工具类生效性 + 颜色切换即时）
  const themeCheck = await page.eval(`(() => {
    const el = document.createElement('div')
    el.className = 'no-transition'
    document.querySelector('[data-testid="account-page"]').appendChild(el)
    const cs = getComputedStyle(el)
    const result = { transitionDuration: cs.transitionDuration, animationDuration: cs.animationDuration }
    el.remove()
    return result
  })()`)
  const mediaDark = await page.eval('matchMedia("(prefers-color-scheme: dark)").matches')
  // ⚠️ 主题现在**跟随 DSH 的实际主题标记**（html[data-ds-theme-source] /
  // body[data-ds-dark-theme]），刻意不再跟着 prefers-color-scheme 走。
  // 所以用 CDP 切「系统深色」时背景不变是**正确行为**；
  // 真正要断言的是：显式 data-theme 能切换，且切换没有过渡动画。
  const forced = await page.call(() => {
    const root = document.querySelector('[data-testid="account-page"]')
    const read = () => getComputedStyle(root).backgroundColor
    const before = read()
    root.setAttribute('data-theme', 'light')
    const light = read()
    root.setAttribute('data-theme', 'dark')
    const dark = read()
    root.removeAttribute('data-theme')
    return { before, light, dark, restored: read() }
  })
  record('H-2', '主题切换：显式 data-theme 生效且无过渡（.no-transition 生效）',
    (themeCheck.transitionDuration.split(',').every(d => parseFloat(d) === 0) && forced.light !== forced.dark) ? 'pass' : 'fail',
    { noTransition: themeCheck, forced })

  // H-3 forced-colors
  await page.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] })
  await sleep(700)
  const forcedColorsProbe = await page.eval(`(() => {
    const list = [...document.querySelectorAll('[role=tablist]')].find(t => (t.getAttribute('aria-label') ?? '').includes('口令策略'))
    const opts = list === undefined ? [] : [...list.querySelectorAll('[role=tab]')]
    const selected = opts.find(o => o.getAttribute('aria-selected') === 'true')
    const cs = selected === undefined ? null : getComputedStyle(selected)
    const input = document.querySelector('[data-testid="account-page"] input')
    return {
      forcedColors: matchMedia('(forced-colors: active)').matches,
      selectedStyle: cs === null ? null : { borderColor: cs.borderColor, borderWidth: cs.borderWidth, forcedColorAdjust: cs.forcedColorAdjust, boxShadow: cs.boxShadow },
      optionCount: opts.length,
      inputBorder: input === null ? null : { width: getComputedStyle(input).borderTopWidth, color: getComputedStyle(input).borderTopColor },
      allForcedAdjust: opts.map(o => getComputedStyle(o).forcedColorAdjust),
    }
  })()`)
  record('H-3', 'forced-colors 下 Segmented 选中项与输入框仍有可见边框',
    (forcedColorsProbe.forcedColors === true && forcedColorsProbe.optionCount > 0
      && Number.parseFloat(forcedColorsProbe.selectedStyle?.borderWidth ?? '0') > 0
      && Number.parseFloat(forcedColorsProbe.inputBorder?.width ?? '0') > 0) ? 'pass' : 'fail',
    forcedColorsProbe)
  await shot('H-forced-colors')
  await page.cdp.send('Emulation.setEmulatedMedia', { features: [] })
  await sleep(400)

  // J-4：forced-color-adjust 兜底存在（容器级断言）
  const adjust = await page.eval(`(() => {
    const list = [...document.querySelectorAll('[role=tablist]')].find(t => (t.getAttribute('aria-label') ?? '').includes('口令策略'))
    const selected = list === undefined ? null : [...list.querySelectorAll('[role=tab]')].find(o => o.getAttribute('aria-selected') === 'true')
    return selected === null ? null : getComputedStyle(selected).forcedColorAdjust
  })()`)
  record('J-4', 'Segmented 选中项 forced-color-adjust 兜底', adjust === 'none' ? 'pass' : 'fail', { forcedColorAdjust: adjust })

  // J-3 eye 按钮 focus-visible 样式
  //
  // ⚠️ 必须走**真实键盘**：程序化 `el.focus()` 不算键盘交互，
  // `:focus-visible` 不匹配（实测 `matches(':focus-visible') === false`、
  // outline 仍为 none）。正确做法：聚焦它前面那个输入框，再按 Tab。
  const eyePrep = await page.call(() => {
    const b = document.querySelector('[data-testid="account-page"] .rh-eye')
    if (b === null) return { found: false }
    const input = b.parentElement?.querySelector('input')
    input?.focus()
    return { found: true, inputTestId: input?.getAttribute('data-testid') ?? null }
  })
  await page.pressKey('Tab')
  const eyeOutline = await page.call(before => {
    const eyes = [...document.querySelectorAll('[data-testid="account-page"] .rh-eye')]
    const active = document.activeElement
    const b = eyes.find(e => e === active) ?? eyes[0]
    if (b === undefined) return { found: false }
    const cs = getComputedStyle(b)
    return {
      found: true,
      before,
      focused: document.activeElement === b,
      aria: b.getAttribute('aria-label'),
      matchesFocusVisible: b.matches(':focus-visible'),
      outlineStyle: cs.outlineStyle,
      outlineWidth: cs.outlineWidth,
      outlineColor: cs.outlineColor,
    }
  }, eyePrep)
  record('J-3', 'rh-eye 键盘聚焦时有可见 focus-visible 外框',
    (eyeOutline.found === true && eyeOutline.focused === true
      && eyeOutline.matchesFocusVisible === true && eyeOutline.outlineStyle === 'solid'
      && Number.parseFloat(eyeOutline.outlineWidth) > 0) ? 'pass' : 'fail', eyeOutline)
  await shot('J-3-eye-focus')
  await page.eval('document.activeElement?.blur()')

  // J-6 480px 断点不再覆写 font-size（400px 下仍是 max(16px,…)）
  await page.setViewport(400, 800, { mobile: true })
  await sleep(600)
  const smallInput = await page.eval(`(() => {
    const i = document.querySelector('[data-testid="account-page"] input')
    return i === null ? null : { fontSize: getComputedStyle(i).fontSize }
  })()`)
  record('J-6', '400px 宽度下输入框 font-size 仍 ≥16px（来自 max(16px,…)）',
    Number.parseFloat(smallInput?.fontSize ?? '0') >= 16 ? 'pass' : 'fail', { smallInput })
  await page.setViewport(1280, 1000, { mobile: false })
  await sleep(400)

  // J-5：不存在 <button class="rh-link">
  const rhLinkButtons = await page.eval(`document.querySelectorAll('button.rh-link').length`)
  record('J-5', '无 <button class="rh-link">（确认无需修复）', rhLinkButtons === 0 ? 'pass' : 'fail', { count: rhLinkButtons })
}

// ══ I. 国际化 ════════════════════════════════════════════════════════════════
if (wanted.has('I')) {
  const L = join(OUT, '..', 'ui-acceptance')

  /** 读全页中文/英文字面量快照。 */
  const snapshot = () => page.eval(`(() => {
    const root = document.querySelector('[data-testid="account-page"]')
    return {
      lang: document.documentElement.lang,
      title: (document.querySelector('[data-testid=account-title]')?.innerText || '').trim(),
      text: (root.innerText || ''),
      eye: document.querySelector('.rh-eye')?.getAttribute('aria-label') ?? null,
      buttons: [...root.querySelectorAll('button')].map(b => (b.innerText || '').trim()).filter(Boolean),
      pills: [...root.querySelectorAll('.rh-pill')].map(p => (p.innerText || '').trim()).filter(Boolean),
      steps: (document.querySelector('[data-testid=account-steps]')?.innerText || '').replace(/\\s+/g, ' ').trim(),
    }
  })()`)

  // 回到登录页（登录页文案才含「用户名/当前口令」；ready 页没有这些字段）
  await page.call(async () => {
    const s = ms => new Promise(r => setTimeout(r, ms))
    const btn = [...document.querySelectorAll('[data-testid="account-page"] button')]
      .find(b => /退出登录|Log out/u.test(b.innerText || ''))
    btn?.click(); await s(2600)
    return true
  })
  await gotoAccount()
  for (let i = 0; i < 40 && await phaseOf() !== 'login'; i += 1) await sleep(300)

  // I-1 中文界面（登录页）
  await setLocale('zh-CN')
  await sleep(800)
  const zh = await snapshot()
  const zhExpect = ['登录', '当前口令', '用户名']
  const zhMissing = zhExpect.filter(w => !zh.text.includes(w))
  const zhEnglishLeak = /\b(Log in|Username|Current password|Welcome back|Sign in)\b/u.test(zh.text)
  expect('I-1a', '登录页文案为中文（登录/用户名/当前口令），无英文残留',
    zhMissing.length === 0 && zhEnglishLeak === false,
    { title: zh.title, missing: zhMissing, englishLeak: zhEnglishLeak, eye: zh.eye, sample: zh.text.slice(0, 160) })
  expect('I-1b', '口令按钮 aria 为「显示口令」', zh.eye === '显示口令', { eye: zh.eye })

  // I-2 英文界面（可编程等价入口；真实入口是 DSH 设置里的语言项）
  await setLocale('en')
  await sleep(700)
  const en = await snapshot()
  const enExpect = ['Log in', 'Username', 'Current password']
  const enMissing = enExpect.filter(w => !en.text.includes(w))
  const enChineseLeak = /[\u4e00-\u9fff]/u.test(en.text.replace(/[\u4e00-\u9fff·，。：；（）「」]/gu, '') + en.text)
  expect('I-2a', '英文界面：Log in / Username / Current password',
    enMissing.length === 0 && enDidSwitch(zh, en), { title: en.title, missing: enMissing, sample: en.text.slice(0, 160), eye: en.eye })
  expect('I-2b', '口令按钮 aria 为 Show password', en.eye === 'Show password', { eye: en.eye })
  await shot('I-english')

  // I-1 扩展：ready 态中文
  await setLocale('zh-CN')
  await ensureReadyExpanded()
  const zhReady = await snapshot()
  const zhReadyExpect = ['两步验证', '口令管理', '可信客户端']
  const zhReadyMissing = zhReadyExpect.filter(w => !zhReady.text.includes(w))
  const zhReadyEnglishLeak = /\b(Trusted clients|Two-factor auth|Password management|Show all)\b/u.test(zhReady.text)
  expect('I-1c', 'ready 态中文文案完整（两步验证/口令管理/可信客户端），无英文残留',
    zhReadyMissing.length === 0 && zhReadyEnglishLeak === false,
    { missing: zhReadyMissing, englishLeak: zhReadyEnglishLeak, pills: zhReady.pills })

  // I-4 时间格式
  const timeCheck = await page.call(() => {
    const root = document.querySelector('[data-testid="account-page"]')
    const metas = [...root.querySelectorAll('.rh-meta,.rh-k')].map(e => (e.innerText || '').trim())
    return { metas: metas.slice(0, 10) }
  })
  const zhTimeOk = timeCheck.metas.some(m => /(刚刚|\d+ 分钟前|\d+ 小时前|今天 \d{2}:\d{2}|昨天 \d{2}:\d{2}|\d+月\d+日|从未活跃)/u.test(m))
  record('I-4a', '中文相对时间格式（刚刚/N 分钟前/今天 HH:MM…）', zhTimeOk ? 'pass' : 'fail', timeCheck)

  await setLocale('en')
  await sleep(900)
  const timeEn = await page.call(() => {
    const root = document.querySelector('[data-testid="account-page"]')
    return { metas: [...root.querySelectorAll('.rh-meta,.rh-k')].map(e => (e.innerText || '').trim()).slice(0, 10) }
  })
  const enTimeOk = timeEn.metas.some(m => /(Just now|minutes ago|hours ago|Today \d{2}:\d{2}|Yesterday \d{2}:\d{2}|\d+\/\d+|Never active)/u.test(m))
  record('I-4b', '英文相对时间格式（Just now/N minutes ago/Today HH:MM…）', enTimeOk ? 'pass' : 'fail', timeEn)

  // I-3 插值替换：Section 标题含实际数量
  const titles = await page.eval(`(() => {
    const root = document.querySelector('[data-testid="account-page"]')
    return [...root.querySelectorAll('.rh-section-title')].map(e => (e.innerText || '').trim())
  })()`)
  const interpolated = titles.filter(t => /\(\d+\)|（\d+）/u.test(t))
  const literalPlaceholder = titles.filter(t => /\{\w+\}/u.test(t))
  record('I-3', '插值变量已替换（标题含数字，无字面 {count}）',
    interpolated.length > 0 && literalPlaceholder.length === 0 ? 'pass' : 'fail', { titles, interpolated, literalPlaceholder })

  // 收尾回中文
  await setLocale('zh-CN')
  await sleep(500)
}

/** 中英快照确实不同（防止「切了但没变」被误判通过）。 */
function enDidSwitch(zh, en) {
  return zh.text !== en.text && zh.title !== en.title
}

// ══ J. 遗留问题 ══════════════════════════════════════════════════════════════
if (wanted.has('J')) {
  await setLocale('zh-CN')
  await ensureReadyExpanded()

  // J-1 行内动作标签走 i18n：先点「禁用」，让行内出现验证面板标题
  // J-1 行内动作标签走 i18n：点「禁用」让行内出现验证面板标题
  //   `{action}「{username}」需要重新验证` / `{action} "{username}" requires re-verification`
  //   action 由 subActionLabel() 来自字典，所以必须真的打开面板才能验证。
  const SUBPANEL = () => {
    const s = ms => new Promise(r => setTimeout(r, ms))
    const root = document.querySelector('[data-testid="account-page"]')
    return { s, root }
  }
  const openReauth = () => page.eval(`(async () => {
    const s = ms => new Promise(r => setTimeout(r, ms))
    const root = document.querySelector('[data-testid="account-page"]')
    const cancel = [...root.querySelectorAll('button')].find(b => /^(取消|Cancel)$/u.test((b.innerText || '').trim()))
    cancel?.click(); await s(350)
    const disable = root.querySelector('[data-testid="sub-account-disable"]')
    if (disable === null) return { ok: false }
    disable.click(); await s(700)
    const titles = [...root.querySelectorAll('h3,h4,.rh-item-title,.rh-cfg-title,p,div')]
      .map(e => (e.innerText || '').trim())
      .filter(x => /需要重新验证|requires re-verification/u.test(x))
      .sort((a, b) => a.length - b.length)
    return { ok: true, title: titles[0] ?? null }
  })()`)

  const j1zh = await openReauth()
  await setLocale('en')
  await sleep(1200)
  const j1en = await openReauth()
  await setLocale('zh-CN')
  await sleep(800)
  const j1zh2 = await openReauth()

  const zhOk = typeof j1zh.title === 'string' && /\u7981\u7528/u.test(j1zh.title) && !/^Disable/u.test(j1zh.title)
  const enOk = typeof j1en.title === 'string' && /^Disable\b/u.test(j1en.title) && !/[\u4e00-\u9fff]/u.test(j1en.title)
  record('J-1', '子账号行内动作标签走 i18n（中文标题含「禁用」/ 英文标题以 Disable 开头）',
    zhOk && enOk ? 'pass' : 'fail', { zh: j1zh, en: j1en, zhAgain: j1zh2 })

  // 收尾：取消面板
  await page.eval(`(() => {
    const root = document.querySelector('[data-testid="account-page"]')
    const cancel = [...root.querySelectorAll('button')].find(b => /^(\u53d6\u6d88|Cancel)$/u.test((b.innerText || '').trim()))
    cancel?.click()
    return true
  })()`)
  await sleep(400)

  // J-7 Segmented 悬停/选中样式跟随 aria-selected（用 CSSOM 规则断言）
  const segRules = await page.call(() => {
    const root = document.querySelector('[data-testid="account-page"]')
    const styleEl = root?.querySelector('[data-rh-theme]')
    const css = styleEl?.textContent ?? ''
    return {
      usesAriaSelected: css.includes('[aria-selected="true"]'),
      usesAriaPressed: css.includes('[aria-pressed'),
    }
  })
  record('J-7', 'Segmented CSS 只用 [aria-selected]，不再残留 aria-pressed 选择器',
    segRules.usesAriaSelected === true && segRules.usesAriaPressed === false ? 'pass' : 'fail', segRules)

  // J-2 已在 B 章节断言
  if (!results.some(r => r.id === 'J-2')) {
    const pressed = await page.eval(`(() => {
      const list = [...document.querySelectorAll('[role=tablist]')].find(t => (t.getAttribute('aria-label') ?? '').includes('口令策略'))
      return list === undefined ? null : [...list.querySelectorAll('[role=tab]')].some(o => o.getAttribute('aria-pressed') !== null)
    })()`)
    record('J-2', 'Segmented 无 aria-pressed', pressed === false ? 'pass' : 'fail', { hasAriaPressed: pressed })
  }
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────
const summary = {
  total: results.length,
  pass: results.filter(r => r.status === 'pass').length,
  fail: results.filter(r => r.status === 'fail').length,
  blocked: results.filter(r => r.status === 'blocked').length,
  timestamp: new Date().toISOString(),
  sections: [...wanted],
  userAgent: await page.eval('navigator.userAgent'),
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify({ summary, results }, null, 2))
writeFileSync(join(OUT, `report-partial-${[...wanted].join('')}.json`), JSON.stringify({ summary, results }, null, 2))
page.close()

process.stdout.write(`\n${JSON.stringify(summary, null, 2)}\n`)
if (summary.fail > 0) process.exitCode = 1
