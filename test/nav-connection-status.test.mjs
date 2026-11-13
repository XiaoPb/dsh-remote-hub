import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerAlias } from './panel-alias-loader.mjs'
await registerAlias()
const { renderNavIcon, isCloudNavigationConnected } = await import('../.build/client/client/src/panel/NavIcon.js')
function child(tree, id) { return [tree.props.children].flat().find(x => x?.props?.['data-testid'] === id) }
test('connected cloud shows green top-right dot and no slash', () => {
 const icon=renderNavIcon({connected:true,size:24,active:false})
 assert.equal(icon.props.width,24)
 assert.ok(child(icon,'remote-hub-connected-dot'))
 assert.equal(child(icon,'remote-hub-disconnected-slash'),undefined)
 assert.equal(child(icon,'remote-hub-connected-dot').props.cx,19.5)
})
test('local cloud shows slash independently of selected sidebar state', () => {
 const icon=renderNavIcon({active:true})
 assert.ok(child(icon,'remote-hub-disconnected-slash'))
 assert.equal(child(icon,'remote-hub-connected-dot'),undefined)
})
test('saved pairing alone does not report an active cloud', () => {
 assert.equal(isCloudNavigationConnected({}),false)
 assert.equal(isCloudNavigationConnected({__DSH_REMOTE_HUB_CARRIER__:{active:false},__DSH_TRANSPORT__:{streamBaseUrl:'http://example.test'}}),false)
 assert.equal(isCloudNavigationConnected({__DSH_REMOTE_HUB_CARRIER__:{active:true},__DSH_TRANSPORT__:{streamBaseUrl:'http://example.test'}}),true)
})
