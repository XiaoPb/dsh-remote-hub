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
    deps: {
      neverBundle: (specifier: string) =>
        specifier === 'react' || specifier.startsWith('react/')
        || specifier === 'react-dom' || specifier.startsWith('react-dom/')
        || specifier.startsWith('@deepseek-ai/'),
      alwaysBundle: (specifier: string) =>
        specifier !== 'react' && !specifier.startsWith('react/')
        && specifier !== 'react-dom' && !specifier.startsWith('react-dom/')
        && !specifier.startsWith('@deepseek-ai/'),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      // Window guard first: the desktop host's node half imports this file while
      // scanning the plugin manifest (no `window` there), and a bare
      // `window.__ModuleLoader__` reference crashes that import — which the boot
      // surfaces as "entry did not activate". In the browser the shell seeds
      // window.__ModuleLoader__ before loading this bundle, so the shim is inert.
      banner:
        'if (typeof window === "undefined") { globalThis.window = { __ModuleLoader__: { load(bundle) { globalThis.__DSH_REMOTE_HUB_BUNDLE__ = bundle; } } }; }\n'
        + 'if (typeof globalThis.process === "undefined") { globalThis.process = { env: {}, platform: "browser", argv: [] }; }\n'
        + `window.__ModuleLoader__.load({ id: ${JSON.stringify(PKG_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
