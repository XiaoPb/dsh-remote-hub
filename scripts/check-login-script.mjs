import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const html = readFileSync('.build/loginpage.html', 'utf8')
const match = /<script>([\s\S]*?)<\/script>/u.exec(html)
if (match === null) { console.log('no script'); process.exit(1) }
writeFileSync('.build/loginpage-script.js', match[1], 'utf8')

// 用 node 真实解析（--check 对 ESM 会报错，这里包成一个函数体再检查）。
const wrapped = `(function(){\n${match[1]}\n})`
writeFileSync('.build/loginpage-wrapped.js', wrapped, 'utf8')

const result = spawnSync(process.execPath, ['--check', '.build/loginpage-wrapped.js'], { encoding: 'utf8' })
console.log('exit:', result.status)
console.log(result.stderr.split('\n').slice(0, 14).join('\n'))
