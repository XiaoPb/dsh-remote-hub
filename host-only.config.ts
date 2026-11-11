import { defineConfig } from 'tsdown'
import { fileURLToPath } from 'node:url'
const H = (p) => fileURLToPath(new URL(p, import.meta.url))
export default defineConfig([{ name:'h', entry:{ index:H('./.build/host/host/src/index.js') }, outDir:'lib', format:'esm', platform:'node', target:'es2024', dts:false, clean:false, alias:{'@core/':H('./.build/host/core/src/')}, deps:{ neverBundle:(s)=>s.startsWith('node:')||s.startsWith('@deepseek-ai/'), alwaysBundle:(s)=>!(s.startsWith('node:')||s.startsWith('@deepseek-ai/')) }, outputOptions:{ entryFileNames:'index.js' } }])
