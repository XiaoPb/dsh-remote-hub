/**
 * Build config for dsh-remote-hub.
 *
 * Pipeline（`npm run build`）：
 *   1. `tsc -p tsconfig.build.host.json`  → `.build/host/{core,host}/src/**\/*.js`
 *   2. `tsc -p tsconfig.build.client.json` → `.build/client/{core,client}/src/**\/*.js`
 *   3. `tsc -p tsconfig.types.json`        → `lib/types/**\/*.d.ts`
 *   4. `tsdown`（本文件）→ `lib/index.js`（ESM host）+ `lib/client.js`（CJS closure）
 *
 * **为什么先 tsc、再 tsdown**：`@Remote` 是标准 TC39 装饰器。tsdown 的
 * rolldown/oxc 会把装饰器**原样保留**在产物里（不是合法 JS，Node 直接崩），
 * 而 tsc 会把它降级成 `__esDecorate` 运行时调用 —— 这正是
 * `@deepseek-ai/dsh-typert-protocol` 的 `remoteMethods()` 读取 marker 所依赖的。
 * 所以 host 半边必须先经 tsc emit；tsdown 只负责打包与 CJS 闭包外壳。
 *
 * `@core/*` 别名指向**emit 后**的 core 目录（源码里的 `.js` 后缀已在 tsc emit
 * 时确定），因此两个产物各自内联同一份契约常量，零漂移。
 *
 * ## carrier 为什么必须打在 bundle 顶层
 *
 * 整个 client bundle 被包在 `__ModuleLoader__.load({ factory })` 的 **factory**
 * 里，而 factory 由 DSH 启动 cordis 时才调用。官方 `connection.apply()` 在同一次
 * 启动里**同步**读取 `__DSH_TRANSPORT__` 并闭包捕获 `fetch`。把 carrier 写在
 * factory 内，注入必然晚于捕获——CDP 时序探针实测：
 *
 * ```
 *  54ms  connection 读 __DSH_TRANSPORT__ → undefined
 * 125ms  carrier 才写入 transport        → 接管失效（页面 RPC 仍走本机）
 * ```
 *
 * 因此 carrier 单独打成 IIFE（`lib/carrier-boot.js`），并在 `lib/client.js` 的
 * banner 里**同步内联执行**——位置在 `__ModuleLoader__.load` 之前。
 *
 * @module dsh-remote-hub/tsdown
 */
import { defineConfig } from 'tsdown'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'


const PKG_ID = (
  JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')) as {
    name: string
  }
).name

const HOST_CORE = fileURLToPath(new URL('./.build/host/core/src/', import.meta.url))
const CLIENT_CORE = fileURLToPath(new URL('./.build/client/core/src/', import.meta.url))
const HOST_ENTRY = fileURLToPath(new URL('./.build/host/host/src/index.js', import.meta.url))
const CLIENT_ENTRY = fileURLToPath(new URL('./.build/client/client/src/index.js', import.meta.url))

/** `@core/x.js` → emit 后的 core 目录。 */
const aliasFor = (coreDir: string): Record<string, string> => ({ '@core/': coreDir })

const nodeExternal = (specifier: string): boolean =>
  specifier.startsWith('node:') || specifier.startsWith('@deepseek-ai/')

/** 浏览器侧：react / 官方包保持外部。 */
const browserExternal = (specifier: string): boolean =>
  specifier === 'react' || specifier.startsWith('react/')
  || specifier === 'react-dom' || specifier.startsWith('react-dom/')
  || specifier.startsWith('@deepseek-ai/')

/**
 * 读取构建好的 carrier IIFE，供 `lib/client.js` 的 banner 内联。
 *
 * 由 npm script 保证顺序（先打 carrier-boot，再打 client）。文件缺失时返回一段
 * 明确的注释，让产物仍然可加载（只是接管不生效），而不是让整个构建失败。
 * @returns 可直接嵌进 banner 的 JS 源码。
 */
function carrierBootSource(): string {
  const file = fileURLToPath(new URL('./lib/carrier-boot.js', import.meta.url))
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return '/* carrier-boot.js missing: run the carrier build step first */'
  }
}

export default defineConfig([
  {
    name: 'dsh-remote-hub/lib',
    entry: { index: HOST_ENTRY },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    alias: aliasFor(HOST_CORE),
    deps: { neverBundle: nodeExternal, alwaysBundle: (s: string) => !nodeExternal(s) },
    outputOptions: { entryFileNames: 'index.js' },
  },
  {
    // 第一段：carrier 独立 IIFE（bundle 顶层执行）。必须先于 client 打包。
    name: 'dsh-remote-hub/carrier-boot',
    entry: { 'carrier-boot': fileURLToPath(new URL('./.build/client/client/src/carrier-entry.js', import.meta.url)) },
    outDir: 'lib',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
    codeSplitting: false,
    alias: aliasFor(CLIENT_CORE),
    deps: { neverBundle: (specifier: string) => specifier.startsWith('@deepseek-ai/') },
    outputOptions: {
      entryFileNames: 'carrier-boot.js',
      name: '__DSH_REMOTE_HUB_CARRIER_BOOT__',
      banner: 'if (typeof globalThis.process === "undefined") { globalThis.process = { env: {}, platform: "browser", argv: [] }; }\n',
    },
  },
  {
    name: 'dsh-remote-hub/client',
    entry: { client: CLIENT_ENTRY },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
    codeSplitting: false,
    alias: aliasFor(CLIENT_CORE),
    // `*.module.css` 由 `scripts/copy-client-css.mjs` 预编译成 `.css.mjs`（rolldown 1.2 已移除
    // CSS 打包能力，且 tsdown 自带 css-guard），产物里只出现普通的相对 import。
    //
    // ⚠️ 必须用 `external` 而不是 `neverBundle`：tsdown 把 `neverBundle` 解释成
    // 「never bundle = 一律 external」的判定函数，相对路径也会被误判成 external，
    // 于是 `require("css-modules.js")` 这类裸名被留在了 bundle 里（2026-11-14 实测）。
    // `external` 是纯 allowlist：只外置明确列出的框架包，其余（含所有相对路径）全部内联。
    deps: { external: browserExternal },
    outputOptions: {
      entryFileNames: 'client.js',
      // Window guard first: the desktop host's node half imports this file while
      // scanning the plugin manifest (no `window` there), and a bare
      // `window.__ModuleLoader__` reference crashes that import — which the boot
      // surfaces as "entry did not activate". In the browser the shell seeds
      // window.__ModuleLoader__ before loading this bundle, so the shim is inert.
      banner:
        // factory 的 require 只有在 factory 被调用时才存在。这里把 load 包一层：
        // 调用 factory 前先把它收到的 require 记到全局，`apply()` 之后就能用
        // （本地插件页凭它取官方 @deepseek-ai/dsh-client-ui-primitives 的 MarkdownText）。
        'const __dshHubLoad = window.__ModuleLoader__ && window.__ModuleLoader__.load;\n'
        + 'if (typeof __dshHubLoad === "function") {\n'
        + '  window.__ModuleLoader__.load = (bundle) => __dshHubLoad({ ...bundle, factory: (require) => {\n'
        + '    globalThis.__DSH_REMOTE_HUB_REQUIRE__ = require;\n'
        + '    return bundle.factory(require);\n'
        + '  } });\n'
        + '}\n'
        + 'if (typeof window === "undefined") { globalThis.window = { __ModuleLoader__: { load(bundle) { globalThis.__DSH_REMOTE_HUB_BUNDLE__ = bundle; } } }; }\n'
        + 'if (typeof globalThis.process === "undefined") { globalThis.process = { env: {}, platform: "browser", argv: [] }; }\n'
        // ⚠️ carrier 内联在 **bundle 顶层**（factory 之外），见文件头注释的时序说明。
        + '/* ===== carrier boot: bundle top-level, BEFORE the plugin factory ===== */\n'
        + carrierBootSource()
        + '\n/* ===== plugin factory ===== */\n'
        + `window.__ModuleLoader__.load({ id: ${JSON.stringify(PKG_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
