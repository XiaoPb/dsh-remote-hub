import fs from 'node:fs'
const asar = 'D:/Apps/DSH/resources/app.asar'
const fd = fs.openSync(asar, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(4)
const hb = Buffer.alloc(headerSize)
fs.readSync(fd, hb, 0, headerSize, 8)
const start = hb.indexOf('{"files"')
if (start < 0) throw new Error('header json not found')
const end = hb.lastIndexOf('}')
const json = JSON.parse(hb.toString('utf8', start, end + 1))
const base = 8 + headerSize
const walk = (node, prefix = '', out = []) => {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (child.files) walk(child, p, out)
    else out.push({ path: p, size: child.size, offset: Number(child.offset) })
  }
  return out
}
const all = walk(json)
console.log('total files:', all.length)
const want = all.filter(f => /package\.json$/.test(f.path) && /dsh-(web-app|base|desktop-host)\//.test(f.path))
for (const w of want) console.log('pkg:', w.path)
const ymls = all.filter(f => /(cordis\.patch|patch)\.ya?ml$/i.test(f.path) && /dsh-(web-app|base)/.test(f.path))
for (const y of ymls) console.log('yml:', y.path, y.size)
const readFile = (entry) => {
  const buf = Buffer.alloc(entry.size)
  fs.readSync(fd, buf, 0, entry.size, base + entry.offset)
  return buf.toString('utf8')
}
for (const y of ymls) {
  const text = readFile(y)
  if (/gateway|connection|remoteAccess/i.test(text)) {
    console.log('=== MATCH', y.path)
    console.log(text.split('\n').filter(l => /gateway|connection|remote-access|remoteAccess|typert/i.test(l)).slice(0, 20).join('\n'))
  }
}
fs.closeSync(fd)
