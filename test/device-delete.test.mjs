import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeviceStore, createTokenService } from '../lib/index.js'
test('deleting device records requires revocation and cannot leave a valid bearer', async () => {
 const dir=await mkdtemp(join(tmpdir(),'rh-delete-'))
 try {
  const store=await createDeviceStore(join(dir,'devices.json'))
  const tokens=createTokenService({devices:store})
  const issued=await tokens.issue({label:'test',role:'control'})
  assert.ok(await tokens.verify(issued.token))
  await assert.rejects(()=>store.removeRevoked(issued.device.deviceId),/revoke/)
  let notified=false
  tokens.onRevoked(id=>{notified=id===issued.device.deviceId})
  await tokens.revoke(issued.device.deviceId)
  assert.equal(notified,true)
  assert.equal(await store.removeRevoked(issued.device.deviceId),true)
  assert.equal(await tokens.verify(issued.token),null)
  const reopened=await createDeviceStore(join(dir,'devices.json'))
  assert.equal(reopened.list().length,0)
  assert.equal(await reopened.removeRevoked(issued.device.deviceId),false)
 } finally { await rm(dir,{recursive:true,force:true}) }
})
