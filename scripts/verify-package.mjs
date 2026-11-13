/**
 * 发布包内容契约自检（CI 与 `npm pack` 的 prepack 共用）。
 *
 * 断言的是「装到用户机器上真正需要的东西都在，开发期的东西都不在」：
 *   1. package.json 的关键字段（名字 / 导出 / dsh 声明 / engines）形状正确；
 *   2. `files` 白名单覆盖了运行期必需产物（lib 三个入口 + bin + patch）；
 *   3. 构建产物实际存在（缺产物时提示先 build，而不是给出含糊的 ENOENT）；
 *   4. 开发目录不会被 `files` 白名单放进包里。
 *
 * 纯 node 内置模块，无第三方依赖；只用 `npm pack --dry-run --json` 读真实产物清单。
 *
 * 用法：`node scripts/verify-package.mjs [--no-pack]`
 *
 * @module scripts/verify-package
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** @type {string[]} */
const failures = []
let checks = 0

/**
 * 记录一条断言。
 * @param {string} name - 断言名（日志里逐行出现）。
 * @param {boolean} ok - 是否通过。
 * @param {string} detail - 失败时给出的原因。
 */
function check(name, ok, detail) {
  checks += 1
  if (!ok) failures.push(`${name}: ${detail}`)
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}\n`)
}

// ---------- 1. package.json 形状 ----------
check('package-name', pkg.name === '@xiaopb/dsh-remote-hub', `unexpected name ${String(pkg.name)}`)
check('package-private-false', pkg.private !== true, 'package must stay publishable (private !== true)')

const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
check('package-version-semver', semver.test(String(pkg.version)), `version ${String(pkg.version)} is not SemVer`)
check('package-license', pkg.license === 'MIT', 'license must be MIT')

const engines = pkg.engines ?? {}
check('engines-node', engines.node === '>=24.9.0', `engines.node must be >=24.9.0, got ${String(engines.node)}`)
check(
  'engines-dsh-upper-bound',
  typeof engines.dsh === 'string' && engines.dsh.includes('<0.3.0-0'),
  'engines.dsh must carry the <0.3.0-0 upper bound',
)
check(
  'compatibility-mirror',
  pkg.dsh?.compatibility?.dsh === engines.dsh,
  'dsh.compatibility.dsh must mirror engines.dsh',
)

check('dsh-manifest-version', pkg.dsh?.manifestVersion === 1, 'dsh.manifestVersion must be 1')
check('dsh-bundle-patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch must be ./cordis.patch.yml')
check('dsh-client-platform', pkg.dsh?.client?.platform === 'web', 'dsh.client.platform must be web')
check('dsh-client-inject', Array.isArray(pkg.dsh?.client?.inject), 'dsh.client.inject must be an array')

check('exports-main', pkg.exports?.['.']?.default === './lib/index.js', 'exports["."].default must be ./lib/index.js')
check('exports-client', pkg.exports?.['./client']?.default === './lib/client.js', 'exports["./client"].default must be ./lib/client.js')
check(
  'types-entry',
  typeof pkg.types === 'string' && pkg.types.startsWith('lib/types/'),
  'types must point into lib/types/',
)
check('main-entry', pkg.main === 'lib/index.js', 'main must be lib/index.js')

const bin = pkg.bin ?? {}
check('bin-pair-cli', bin['dsh-remote-hub-pair'] === 'bin/dsh-remote-hub-pair.mjs', 'pair CLI bin entry is missing')

// 运行期依赖必须收敛：宿主提供的包走 peerDependencies，不能混进 dependencies。
check(
  'no-host-packages-in-deps',
  !Object.keys(pkg.dependencies ?? {}).some(name => name.startsWith('@deepseek-ai/')),
  'DSH host packages must be peer dependencies, not runtime dependencies',
)
check(
  'peer-cordis-optional',
  pkg.peerDependencies?.['@deepseek-ai/cordis'] !== undefined
    && pkg.peerDependenciesMeta?.['@deepseek-ai/cordis']?.optional === true,
  '@deepseek-ai/cordis must be an optional peer dependency',
)

// ---------- 2. files 白名单 ----------
const files = Array.isArray(pkg.files) ? pkg.files : []
const requiredEntries = [
  'lib/index.js',
  'lib/client.js',
  'bin/dsh-remote-hub-pair.mjs',
  'cordis.patch.yml',
]
for (const entry of requiredEntries) {
  check(`files-whitelist: ${entry}`, files.includes(entry), `"${entry}" must be listed in package.json files`)
}
check(
  'files-whitelist: lib/types',
  files.some(entry => entry.startsWith('lib/types')),
  'type declarations (lib/types/**) must be listed in files',
)

// ---------- 3. 构建产物确实存在 ----------
for (const artifact of ['lib/index.js', 'lib/client.js', 'lib/carrier-boot.js', 'cordis.patch.yml', 'bin/dsh-remote-hub-pair.mjs']) {
  check(`artifact-present: ${artifact}`, existsSync(join(ROOT, artifact)), `${artifact} is missing — run \`pnpm run build\` first`)
}

// ---------- 4. 开发内容不会进包 ----------
const manifestText = JSON.stringify({ files, exports: pkg.exports, main: pkg.main, bin: pkg.bin })
for (const devDir of ['test/', 'scripts/', 'docs/', '.github/', 'dev/', 'node_modules/']) {
  check(
    `dev-content-excluded: ${devDir}`,
    !files.some(entry => entry.startsWith(devDir)) && !manifestText.includes(`"${devDir}`),
    `${devDir} must never be shipped`,
  )
}

// ---------- 5. 真实打包清单（可选，--no-pack 跳过） ----------
if (!process.argv.includes('--no-pack')) {
  // prepack 会把本脚本的输出混进 stdout，因此取 `--json` 之后的第一段 JSON。
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: { ...process.env, npm_config_loglevel: 'warn' },
  })
  if (packed.status !== 0) {
    check('pack-dry-run', false, `npm pack --dry-run failed: ${(packed.stderr ?? '').trim().slice(0, 400)}`)
  } else {
    let listed = []
    try {
      // stdout 里混有 prepack（本脚本）的输出，从首个 JSON 数组起点截取。
      const raw = packed.stdout ?? ''
      const start = raw.search(/^[[]\s*$/mu) >= 0 ? raw.search(/^[[]\s*$/mu) : raw.indexOf('[')
      const parsed = JSON.parse(raw.slice(start))
      listed = (parsed[0]?.files ?? []).map(file => file.path)
    } catch (error) {
      check('pack-dry-run-json', false, `unparseable npm pack output: ${String(error)}`)
    }
    if (listed.length > 0) {
      check('pack-contains-entry', listed.includes('lib/index.js'), 'lib/index.js missing from tarball')
      check('pack-contains-client', listed.includes('lib/client.js'), 'lib/client.js missing from tarball')
      check('pack-contains-patch', listed.includes('cordis.patch.yml'), 'cordis.patch.yml missing from tarball')
      const leaked = listed.filter(path => /^(test|scripts|docs|dev|\.github|node_modules)\//u.test(path))
      check('pack-no-dev-leak', leaked.length === 0, `dev paths leaked into the tarball: ${leaked.slice(0, 5).join(', ')}`)
      process.stdout.write(`    tarball files: ${listed.length}\n`)
    }
  }
}

process.stdout.write(`\n${checks - failures.length}/${checks} package checks passed\n`)
if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`assertion failed: ${failure}\n`)
  process.exit(1)
}
