import { mkdir, cp } from 'node:fs/promises'
import { rolldown } from 'rolldown'
const root = new URL('../companions/remote-paths/', import.meta.url)
const out = new URL('lib/', root)
await mkdir(out, { recursive: true })
await cp(new URL('src/index.js', root), new URL('index.js', out))
const bundle = await rolldown({
  input: new URL('src/client.js', root).pathname.replace(/^\/(\w:)/, '$1'),
  external: ['react'],
})
await bundle.write({
  file: new URL('client.js', out).pathname.replace(/^\/(\w:)/, '$1'),
  format: 'cjs',
  banner: 'if (typeof window !== "undefined") window.__ModuleLoader__.load({ id: "@xiaopb/dsh-remote-paths", factory: (require) => {',
  intro: 'var module = { exports: {} }; var exports = module.exports;',
  footer: 'return module.exports; } });',
})
await bundle.close()
console.log('remote-paths companion browser bundle complete')
