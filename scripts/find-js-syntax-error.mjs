import { readFileSync } from 'node:fs'

const html = readFileSync('.build/loginpage.html', 'utf8')
const match = /<script>([\s\S]*?)<\/script>/u.exec(html)
if (match === null) { console.log('no script'); process.exit(1) }
const js = match[1]

// 二分：找出最小前缀，使 new Function 仍然报错。
let failing = null
for (let end = 100; end <= js.length; end += 100) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(js.slice(0, end))
  } catch (error) {
    if (/Unexpected token/u.test(error.message)) {
      failing = end
      break
    }
  }
}

console.log('first failing prefix length:', failing)
if (failing !== null) {
  const snippet = js.slice(Math.max(0, failing - 300), failing + 60)
  console.log('--- 上下文 ---')
  console.log(snippet)
  // 定位第一处可疑的 `?`
  const lines = js.slice(0, failing).split('\n')
  console.log('--- 最后几行 ---')
  for (const line of lines.slice(-6)) console.log(JSON.stringify(line))
}
