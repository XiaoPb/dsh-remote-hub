import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
const src = readFileSync(new URL('../companions/remote-paths/src/client.js', import.meta.url), 'utf8')
test('remote path companion only registers cloud slots and avoids hardssh/native collision', () => {
  assert.match(src, /if \(!cloudPathContext\(\)\) return/)
  assert.match(src, /ctx\.commandUi\.register/)
  assert.match(src, /name: 'cloud-file'/)
  assert.match(src, /priority: -2/)
  assert.match(src, /conversation\.hero\.workspace\.directoryFlow/)
  assert.match(src, /sidebar\.workspaces\.directoryFlow/)
  assert.match(src, /listDirectory|directoryPicker\/list/)
  assert.match(src, /remote-permission-close/)
  assert.match(src, /className: 'rhp-button rhp-primary'/)
})
