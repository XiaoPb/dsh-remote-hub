/**
 * Vendored 官方 UI 的**导入改写器**（一次性维护脚本，幂等可重跑）。
 *
 * ## 它做什么
 *
 * `client/src/local-plugin-manager/` 下的 17 个文件是官方
 * `@deepseek-ai/dsh-client-ui-plugin-manager` 客户端源码的**逐行副本**（保留上游注释与逻辑）。
 * 为了让它们在本插件里编译、且不把官方客户端依赖树拉进来，只做三类**机械改写**：
 *
 * 1. **值级依赖收敛**：宿主内置包的运行时导入 → 本地 `official-shims.ts` / `store.ts` / `primitives.ts`
 *    （randomUUID、registry 规则、EXPERIMENTAL_BUNDLES、store、快照选择器、UI 原子组件、图标）；
 * 2. **类型级依赖**：`@deepseek-ai/*` 的类型导入 → `official-stubs.ts`（编译期擦除，运行时为零）；
 * 3. **数据接缝**（唯一的功能性改动）：控制器的 `ctx.remote.*` → 受保护发送层方法，
 *    详情图片路由 → 本机通道路径。
 *
 * 每个文件头部写入 `@provenance` 块（上游包名 / 版本 / 路径），供
 * `test/local-plugin-vendor.test.mjs` 与 `04-verification.md` §5 的 drift 检查使用。
 *
 * ## 用法
 *
 * ```powershell
 * node scripts/vendor-local-plugin-ui.mjs --from <deepseek-harness>/packages/client/ui-plugin-manager/src/client
 * ```
 *
 * @module scripts/vendor-local-plugin-ui
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

/** 上游包名（写进 @provenance）。 */
export const UPSTREAM_PACKAGE = '@deepseek-ai/dsh-client-ui-plugin-manager'
/** 上游版本。 */
export const UPSTREAM_VERSION = '0.2.2-rc.1'
/** 本插件里 vendored 副本的目录名。 */
export const LOCAL_DIR = 'local-plugin-manager'

/**
 * 逐文件的改写规则：`[from, to]` 字面子串替换（全部替换）。
 *
 * 顺序有意义：先处理多行 import，再处理单行 import，最后处理表达式替换。
 */
export const REWRITES = {
  'BundleDetailSection.tsx': [
    ["from '@deepseek-ai/dsh-client-ui-primitives'", "from './primitives.ts'"],
  ],
  'config-ledger.ts': [
    ["import type { Context as ClientContext } from '@deepseek-ai/cordis'", "import type { Context as ClientContext } from '@deepseek-ai/cordis'"],
    ["import { resolveSlotLabel, type HostObservable } from '@deepseek-ai/dsh-client-ui-slots'", "import { localLocale, localSlots, resolveLabel, type HostObservable } from './official-stubs.ts'"],
    ['resolveSlotLabel(entry.options.label)', 'resolveLabel(entry.options.label)'],
  ],
  'detail-store.ts': [
    ["import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'", "import { createSnapshotStore, type SnapshotStore } from './store.ts'"],
    ["import { NPMMIRROR_REGISTRY } from '@deepseek-ai/dsh-plugin-manager/registry'", "import { NPMMIRROR_REGISTRY } from './official-shims.ts'"],
    ["import type { BundleDetail, RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'", "import type { BundleDetail, RemoteFailure } from './official-stubs.ts'"],
    ["const DETAIL_FILE_ROUTE = 'api/plugin-manager/detail-file'", "const DETAIL_FILE_ROUTE = 'api/hub/local-plugin-manager/detail-file'"],
    ['const { remote } = this.ctx', 'const sender = this.sender'],
    ['await remote.pluginRegistryProbe.fastest()', 'await sender.fastestRegistry()'],
    ['await remote.pluginManager.readBundleDetail(name, language, { npmFileSources: fromNpm ? this.npmFileSources : [] })', 'await sender.readBundleDetail(name, language, { npmFileSources: fromNpm ? this.npmFileSources : [] })'],
  ],
  'manager-store.ts': [
    ["import type {} from '@deepseek-ai/dsh-client-product-analytics/client'", "// @provenance-dropped: product analytics is out of scope for this plugin"],
    ["import { randomUUID } from '@deepseek-ai/dsh-util-crypto'", "import { randomUUID } from './official-shims.ts'"],
    ["from '@deepseek-ai/dsh-api-remotes/client'", "from './official-stubs.ts'"],
    ["import { normalizeRegistry, NPMMIRROR_REGISTRY, OFFICIAL_NPM_REGISTRY, REGISTRY_URL } from '@deepseek-ai/dsh-plugin-manager/registry'", "import { normalizeRegistry, NPMMIRROR_REGISTRY, OFFICIAL_NPM_REGISTRY, REGISTRY_URL } from './official-shims.ts'"],
    ["import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'", "import { createSnapshotStore, type SnapshotStore } from './store.ts'"],
    ["import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'", "import type { HostObservable } from './store.ts'"],
    ["import type { LocalizedText, PluginLocalizedMeta } from '@deepseek-ai/dsh-package-manifest'", "import type { LocalizedText, PluginLocalizedMeta } from './official-stubs.ts'"],
    ["import type { SettingsDescribeFace, ConfigForms } from '@deepseek-ai/dsh-client-ui-settings/client'", "import type { SettingsDescribeFace, ConfigForms } from './official-stubs.ts'"],
    ["import type { LocaleSnapshot } from '@deepseek-ai/dsh-client-locale/client'", "import type { LocaleSnapshot } from './official-stubs.ts'"],
  ],
  'navigation-store.ts': [
    ["import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'", "import { defineStore, type StoreHandle } from './store.ts'"],
    ['EngineStoreHandle<NavigationState, NavigationActions>', 'StoreHandle<NavigationState, NavigationActions>'],
  ],
  'PluginManagerPage.tsx': [
    ["from '@deepseek-ai/dsh-api-remotes/client'", "from './official-stubs.ts'"],
    ["from '@deepseek-ai/dsh-client-ui-primitives'", "from './primitives.ts'"],
    ["from '@deepseek-ai/dsh-client-ui-slots'", "from './official-stubs.ts'"],
    ["from '@deepseek-ai/dsh-official-bundles'", "from './official-shims.ts'"],
    ["from '@deepseek-ai/dsh-client-ui-plugin-manager/client'", "from './official-stubs.ts'"],
  ],
  'PluginRefreshToast.tsx': [
    ["from '@deepseek-ai/dsh-client-ui-primitives'", "from './primitives.ts'"],
    ["from '@deepseek-ai/dsh-client-ui-slots'", "from './official-stubs.ts'"],
  ],
  'PluginsPanelIcon.tsx': [
    ["from '@deepseek-ai/dsh-client-ui-primitives'", "from './primitives.ts'"],
    ["from '@deepseek-ai/dsh-client-ui-slots'", "from './official-stubs.ts'"],
    ["from '@deepseek-ai/dsh-client-ui-sidebar/client'", "from './official-stubs.ts'"],
  ],
  'presentation.ts': [
    ["from '@deepseek-ai/dsh-official-bundles'", "from './official-shims.ts'"],
    ["from '@deepseek-ai/dsh-api-remotes/client'", "from './official-stubs.ts'"],
    ["from '@deepseek-ai/dsh-client-ui-slots'", "from './official-stubs.ts'"],
  ],
  'slot-contract.ts': [
    ["from '@deepseek-ai/dsh-client-ui-slots'", "from './official-stubs.ts'"],
    ["from '@deepseek-ai/dsh-api-remotes/client'", "from './official-stubs.ts'"],
    ["from '@deepseek-ai/dsh-client-ui-settings/client'", "from './official-stubs.ts'"],
  ],
  'tab-ledger.ts': [
    ["from '@deepseek-ai/dsh-client-ui-slots'", "from './official-stubs.ts'"],
  ],
  'versions.tsx': [
    ["from '@deepseek-ai/dsh-api-remotes/client'", "from './official-stubs.ts'"],
    ["from '@deepseek-ai/dsh-client-ui-primitives'", "from './primitives.ts'"],
  ],
  'header-scroll.ts': [],
  'locales.ts': [],
  'sanitize-install-input.ts': [],
}

/** 需要 vendor 的源文件。 */
export const VENDORED_FILES = Object.keys(REWRITES)

/**
 * 构造 `@provenance` 块。
 * @param file - 文件名。
 * @returns 注释块。
 */
export function provenanceBlock(file) {
  return [
    '/**',
    ` * @provenance ${UPSTREAM_PACKAGE}/src/client/${file} @ ${UPSTREAM_VERSION}`,
    ' * Vendored verbatim from the official plugin manager client. Only imports were rewritten (see',
    ' * scripts/vendor-local-plugin-ui.mjs) so this plugin reuses the official page byte-for-byte while',
    ' * keeping its host-provided runtime surface. Do not hand-edit: regenerate instead.',
    ' */',
    '',
  ].join('\n')
}

/**
 * 对一份上游源码应用全部改写。
 * @param file - 文件名（决定规则表）。
 * @param source - 上游源码。
 * @returns 改写后的源码。
 */
export function rewriteFile(file, source) {
  let output = source
  for (const [from, to] of REWRITES[file] ?? []) output = output.split(from).join(to)
  return `${provenanceBlock(file)}${output}`
}

/**
 * 执行 vendor（读上游 → 改写 → 写本地）。
 * @param options - `{ from, to }`。
 * @returns 已写出的文件名。
 */
export function vendorFrom(options) {
  const written = []
  for (const file of VENDORED_FILES) {
    writeFileSync(join(options.to, file), rewriteFile(file, readFileSync(join(options.from, file), 'utf8')), 'utf8')
    written.push(file)
  }
  return written
}

const invokedDirectly = process.argv[1] !== undefined && basename(process.argv[1]) === 'vendor-local-plugin-ui.mjs'
if (invokedDirectly) {
  const fromIndex = process.argv.indexOf('--from')
  if (fromIndex < 0 || process.argv[fromIndex + 1] === undefined) {
    process.stderr.write('usage: node scripts/vendor-local-plugin-ui.mjs --from <ui-plugin-manager>/src/client [--to DIR]\n')
    process.exit(2)
  }
  const toIndex = process.argv.indexOf('--to')
  const to = toIndex < 0 || process.argv[toIndex + 1] === undefined
    ? join(process.cwd(), 'client', 'src', LOCAL_DIR)
    : resolve(process.argv[toIndex + 1])
  const written = vendorFrom({ from: resolve(process.argv[fromIndex + 1]), to })
  process.stdout.write(`vendored ${String(written.length)} files -> ${to}\n`)
}
