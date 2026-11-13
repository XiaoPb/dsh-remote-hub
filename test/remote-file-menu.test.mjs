import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerAlias } from './panel-alias-loader.mjs'
await registerAlias()
// 云端路径 UI 自 0.3.0 起内置在 client/src/paths；测试与其他 client 测试一样
// 读 tsc 产物（.build/client），避免在 node 里直接解析 .tsx。
const { quoteRemoteFile } = await import('../.build/client/client/src/paths/files.js')
const { pathRpc } = await import('../.build/client/client/src/paths/context.js')
test('cloud references retain whitespace paths without local upload conversion', () => {
 assert.equal(quoteRemoteFile('src/main.ts'),'@src/main.ts')
 assert.equal(quoteRemoteFile('资料/说明 文档.md'),'@"资料/说明 文档.md"')
 assert.equal(quoteRemoteFile('x"y.txt'),'@"x\\"y.txt"')
})
test('cloud file browser uses target session resource and preserves cancellation', async () => {
 const abort=new AbortController()
 let seen
 const context={fetch:async(url,init)=>{seen={url,body:JSON.parse(init.body),signal:init.signal};return new Response(JSON.stringify({result:{ok:true,value:{path:'',entries:[{name:'check.txt',type:'file'}],truncated:false}}}),{status:200})}}
 const value=await pathRpc(context,'workspaceFiles/list',{workspaceFileScopeId:'session-test',path:'.'},abort.signal)
 assert.equal(seen.url,'api/workspaceFiles/list')
 assert.deepEqual(seen.body.payload.args,{workspaceFileScopeId:'session-test',path:'.'})
 assert.equal(seen.signal,abort.signal)
 assert.equal(value.entries[0].name,'check.txt')
 await assert.rejects(()=>pathRpc(context,'workspaceFiles/delete',{}),/Unsupported/)
})
