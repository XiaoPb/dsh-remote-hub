/**
 * 发布一致性门禁：版本号在三个「不会自动同步」的地方必须一致。
 *
 * 发布时最容易出错、且一旦错了很难回滚的是版本漂移：
 *   · `package.json` / 伴生包 `companions/remote-paths/package.json` 版本不一致；
 *   · `README.md` / `README.en.md` / `docs/DESIGN.md` / `cordis.patch.yml` 里写死的版本号过期；
 *   · tag 与 `package.json` 版本对不上（release.yml 也会再验一次，这里是本地/CI 的同一把尺）。
 *
 * 用法：
 *   node scripts/release-check.mjs             # 只做一致性校验
 *   node scripts/release-check.mjs --tag v0.2.5  # 额外断言 tag ↔ version
 *
 * @module scripts/release-check
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** @param {string} path - 相对仓库根的路径。 */
function read(path) {
  try {
    return readFileSync(join(ROOT, path), 'utf8')
  } catch {
    return ''
  }
}

/** @type {string[]} */
const failures = []
let checks = 0

/**
 * 记录一条断言。
 * @param {string} name - 断言名。
 * @param {boolean} ok - 是否通过。
 * @param {string} detail - 失败原因。
 */
function check(name, ok, detail) {
  checks += 1
  if (!ok) failures.push(`${name}: ${detail}`)
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  ← ${detail}`}\n`)
}

const pkg = JSON.parse(read('package.json'))
const version = String(pkg.version)
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u

check('version-semver', semver.test(version), `package.json version "${version}" is not SemVer`)

// 0.3.0：云端路径 UI 已内置，仓库里**不应**再有伴生 workspace 包。
// 曾经这里断言「伴生包版本与主包一致」；现在改成断言它确实不存在，
// 防止有人把 companinons 悄悄加回来导致版本再次分叉。
const companionsDir = read('companions/remote-paths/package.json')
check(
  'cloud-paths-inlined',
  companionsDir === '' && pkg.workspaces === undefined,
  'companions/remote-paths must be gone (cloud paths are built into this package)',
)

// 文档里写死的版本号（"v0.2.5" / "**Current release: `0.2.5`**"）。
/** @type {Array<[string, RegExp]>} */
const versionedDocs = [
  ['README.md', /v(\d+\.\d+\.\d+)/u],
  ['README.en.md', /v(\d+\.\d+\.\d+)/u],
  ['docs/DESIGN.md', /\*\*Version:\*\*\s*(\d+\.\d+\.\d+)/u],
]
for (const [file, pattern] of versionedDocs) {
  const text = read(file)
  if (text === '') {
    check(`doc-present: ${file}`, false, `${file} is missing`)
    continue
  }
  const match = pattern.exec(text)
  check(
    `doc-version: ${file}`,
    match !== null && match[1] === version,
    `${file} declares ${match?.[1] ?? 'no version'}, expected ${version}`,
  )
}

// 中英 README 必须互相链接（发布文档的双语入口约定）。
const zhReadme = read('README.md')
const enReadme = read('README.en.md')
check('readme-cross-link: zh→en', /README\.en\.md/u.test(zhReadme), 'README.md must link README.en.md')
check('readme-cross-link: en→zh', /\(README\.md\)/u.test(enReadme), 'README.en.md must link README.md')

// CHANGELOG 必须已有当前版本的条目，避免「发了版却没有记录」。
const changelog = read('CHANGELOG.md')
check(
  'changelog-entry',
  changelog.includes(`## [${version}]`),
  `CHANGELOG.md has no "## [${version}]" entry`,
)

// 文档引用的发布流程文件必须真实存在。
// 安全声明必须两份 README 都有：Full 放开之后，这是用户唯一的前置提醒。
check(
  'security-notice: README.md',
  /## ⚠️ 安全声明/u.test(zhReadme) && /远程代码执行/u.test(zhReadme),
  'README.md must carry the security declaration (remote code execution / full pairing)',
)
check(
  'security-notice: README.en.md',
  /## ⚠️ Security notice/u.test(enReadme) && /remote code execution/u.test(enReadme),
  'README.en.md must carry the security notice',
)
check(
  'security-notice: docs/DEPLOY.md',
  /安全声明/u.test(read('docs/DEPLOY.md')),
  'docs/DEPLOY.md must carry the security declaration',
)
check(
  'security-notice: docs/API-MATRIX.md',
  /安全声明/u.test(read('docs/API-MATRIX.md')),
  'docs/API-MATRIX.md must carry the security warning',
)

check('docs-release-present', read('docs/RELEASE.md') !== '', 'docs/RELEASE.md is missing')

// 可选：tag ↔ version
const tagFlag = process.argv.indexOf('--tag')
if (tagFlag >= 0) {
  const tag = process.argv[tagFlag + 1] ?? ''
  check('tag-matches-version', tag === `v${version}`, `tag "${tag}" != v${version}`)
}

process.stdout.write(`\n${checks - failures.length}/${checks} release checks passed (version ${version})\n`)
if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`assertion failed: ${failure}\n`)
  process.exit(1)
}
