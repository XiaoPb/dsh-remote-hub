/**
 * 「信任的公网地址」（`publicAuthorities`）回归测试。
 *
 * ## 这个功能解决的真实故障
 *
 * 经 Cloudflare Tunnel 访问时，浏览器发来的 `Host` 是 `dsh.xiaopb.cn`。
 * 守卫的来源围栏（`host/src/fence.ts`）只放行两类 Host：
 *   1. 回环字面量（`127.0.0.1` / `::1` / `localhost`）
 *   2. `publicAuthorities` 里显式声明的 authority
 * 不声明 => `/remote-auth/status` 等所有接口 **403**，页面显示
 * 「authentication request failed (403) / 身份验证请求失败」。
 *
 * 在此之前只能改 `cordis.patch.yml` 再重启。本测试锁定「页面可读可写」的契约。
 *
 * ## 锁定什么
 *
 * 1. `publicAuthorities` 属于**冷字段**（重启生效），不是热字段；
 * 2. 服务端写入校验严格：拒绝通配符 / netloc 之外的写法 / 回环 / 私网；
 * 3. `restartPending` 用**内容**比较，不因数组引用不同而永远为 true；
 * 4. 客户端草稿校验与服务端规则一致；
 * 5. 页面区块存在且暴露稳定的 testid（验收脚本依赖）。
 *
 * @module test/public-authorities.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (relative) => readFileSync(join(ROOT, relative), 'utf8')

describe('publicAuthorities：配置键归类', () => {
  it('是冷字段（重启生效），不是热字段', () => {
    const source = read('host/src/runtime-config.ts')
    const cold = /CONFIG_COLD_WRITABLE_KEYS\s*=\s*\[([^\]]+)\]/u.exec(source)
    const hot = /CONFIG_WRITABLE_KEYS\s*=\s*\[([^\]]+)\]/u.exec(source)
    assert.ok(cold !== null, '必须能找到 CONFIG_COLD_WRITABLE_KEYS')
    assert.ok(hot !== null, '必须能找到 CONFIG_WRITABLE_KEYS')
    assert.match(cold[1], /'publicAuthorities'/u, 'publicAuthorities 必须在冷字段列表里')
    assert.doesNotMatch(hot[1], /'publicAuthorities'/u, 'publicAuthorities 不能是热字段')
  })

  it('装配时把覆盖值应用回 config（否则重启后仍是 YAML 的值）', () => {
    const source = read('host/src/plugin.ts')
    assert.match(
      source,
      /Array\.isArray\(cold\.publicAuthorities\)/u,
      'plugin.ts 必须把 overrides 里的 publicAuthorities 写回 config',
    )
  })

  it('快照暴露「当前生效值」，供页面区分「配置中 / 待重启」', () => {
    const source = read('host/src/plugin.ts')
    assert.match(source, /publicAuthoritiesApplied/u, '快照必须带 publicAuthoritiesApplied')
  })
})

describe('publicAuthorities：服务端写入校验', () => {
  const source = read('host/src/runtime-config.ts')

  it('复用 canonicalAuthority，不另写正则', () => {
    assert.match(source, /import \{[^}]*canonicalAuthority[^}]*\} from '\.\/config\.js'/u)
    assert.match(source, /function coercePublicAuthorities/u)
    assert.match(source, /canonicalAuthority\(raw\)/u)
  })

  it('拒绝通配符', () => {
    assert.match(source, /must not use wildcards/u)
  })

  it('拒绝回环地址（本来就无条件放行）', () => {
    assert.match(source, /is a loopback address and is always allowed/u)
  })

  it('拒绝私网地址', () => {
    assert.match(source, /is a private\/LAN address and is allowed by the LAN mode/u)
  })

  it('拒绝非数组与空项', () => {
    assert.match(source, /publicAuthorities must be an array/u)
    assert.match(source, /must not contain empty entries/u)
    assert.match(source, /items must be strings/u)
  })

  it('restartPending 用内容比较而不是引用比较', () => {
    // 旧实现用 `!==`：数组每次都是新引用，会导致「待重启」永远为真。
    assert.match(source, /function sameColdValue/u)
    assert.match(source, /Array\.isArray\(a\) && Array\.isArray\(b\)/u)
    assert.match(source, /!sameColdValue\(overrides\[key as ConfigColdKey\]/u)
  })
})

describe('publicAuthorities：客户端草稿校验与服务端规则一致', () => {
  const page = read('client/src/auth/AccountPage.tsx')

  it('导出 validateAuthorityDraft', () => {
    assert.match(page, /export function validateAuthorityDraft/u)
  })

  for (const [name, pattern] of [
    ['空输入', /accessErrEmpty/u],
    ['带 scheme', /accessErrScheme/u],
    ['带路径', /accessErrPath/u],
    ['通配符', /accessErrWildcard/u],
    ['回环', /accessErrLoopback/u],
    ['私网', /accessErrPrivate/u],
    ['重复', /accessErrDuplicate/u],
  ]) {
    it(`覆盖「${name}」这一种拒绝`, () => {
      assert.match(page, pattern)
    })
  }
})

describe('publicAuthorities：页面区块契约', () => {
  const page = read('client/src/auth/AccountPage.tsx')

  it('区块存在且可折叠，并挂在「身份与访问」页', () => {
    assert.match(page, /'data-testid': 'public-authorities-section'/u)
    assert.match(page, /const accessSection = React\.createElement\(Section/u)
    // 必须真的被渲染进页面（历史上出现过「定义了但没挂进树」）。
    assert.match(page, /clientsSection,\s*accessSection,/u)
  })

  it('暴露验收脚本依赖的 testid', () => {
    for (const id of [
      'access-list',
      'access-item',
      'access-item-pill',
      'access-input',
      'access-add',
      'access-remove',
      'access-empty',
      'access-saved',
      'access-pending-pill',
    ]) {
      assert.match(page, new RegExp(`'${id}'`, 'u'), `缺少 testid: ${id}`)
    }
  })

  it('保存后必须提示「重启后生效」（冷字段不能假装已生效）', () => {
    assert.match(page, /accessSavedNotice/u)
    assert.match(read('client/src/rhui/locales/zh-CN.ts'), /需要重启 DSH 后生效/u)
  })

  it('移除按钮的无障碍名包含具体地址（一排「移除」无法区分）', () => {
    assert.match(page, /ariaLabel: t\('accessRemoveLabel', \{ host \}\)/u)
  })
})

describe('「身份与访问」命名', () => {
  it('导航与页面标题都已改名', () => {
    const zh = read('client/src/rhui/locales/zh-CN.ts')
    assert.match(zh, /navAccountSettings: '身份与访问'/u)
    assert.match(zh, /pageTitle: '身份与访问'/u)
    assert.doesNotMatch(zh, /navAccountSettings: '登录与账号'/u, '不应残留旧名')
  })

  it('英文同步', () => {
    const en = read('client/src/rhui/locales/en.ts')
    assert.match(en, /navAccountSettings: 'Identity & access'/u)
    assert.match(en, /pageTitle: 'Identity & Access'/u)
  })

  it('副标题说明覆盖「账号 / 验证 / 访问来源」三类', () => {
    const zh = read('client/src/rhui/locales/zh-CN.ts')
    assert.match(zh, /pageHint: '账号、验证方式与访问来源'/u)
  })
})
