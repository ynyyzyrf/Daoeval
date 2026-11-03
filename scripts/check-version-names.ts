import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync} from 'node:fs'
import {join} from 'node:path'
import type {AgentConfig} from '../src/shared/types.ts'
mkdirSync('.tmp',{recursive:true})
process.env.AEVAL_DATA_DIR=mkdtempSync(join(process.cwd(),'.tmp','version-name-check-'))
const {db,migrate}=await import('../src/server/db.ts')
const store=await import('../src/server/store.ts')
const {buildApp}=await import('../src/server/app.ts')
migrate()
const config:AgentConfig={name:'版本命名測試',platformType:'custom_http',endpoint:'http://127.0.0.1:9',authType:'none',requestTemplate:{method:'POST',headers:{},body:{input:'{{input}}'}},responseMap:{outputPath:'answer'},allowWrite:false,versionInfo:{model:'api-model',versionName:'自訂方案名稱'}}
const created=store.createAgent(config,null,{ok:true,checkedAt:new Date().toISOString(),latencyMs:1,httpStatus:200})
const snapshot=(db.prepare('SELECT snapshot FROM agent_version WHERE id=?').get(created.versionId) as {snapshot:string}).snapshot
assert.equal(store.listAgents()[0].versions[0].versionName,'自訂方案名稱')
assert.equal(store.listAgents()[0].versions[0].model,'api-model')
// Simulate an existing database, then test migration backfill and repeated startup.
db.exec('ALTER TABLE agent_version DROP COLUMN version_name')
migrate()
assert.equal(store.listAgentVersions(created.id)[0].versionName,'自訂方案名稱')
const app=await buildApp()
try {
 const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'admin',password:'admin'}})
 const cookie=login.cookies.map(x=>`${x.name}=${x.value}`).join('; ')
 const url=`/api/agents/${created.id}/versions/${created.versionId}/name`
 assert.equal((await app.inject({method:'PATCH',url,payload:{versionName:'blocked'}})).statusCode,401)
 for(const versionName of ['', ' ', 'x'.repeat(121),42,null]) assert.equal((await app.inject({method:'PATCH',url,headers:{cookie},payload:{versionName}})).statusCode,400)
 assert.equal((await app.inject({method:'PATCH',url:url.replace(created.id,'other-agent'),headers:{cookie},payload:{versionName:'wrong owner'}})).statusCode,400)
 const renamed=await app.inject({method:'PATCH',url,headers:{cookie},payload:{versionName:' metis · Prompt v1 '}})
 assert.equal(renamed.statusCode,200)
 assert.equal(renamed.json().versionName,'metis · Prompt v1')
 migrate()
 assert.equal(store.listAgentVersions(created.id)[0].versionName,'metis · Prompt v1')
 assert.equal((db.prepare('SELECT snapshot FROM agent_version WHERE id=?').get(created.versionId) as {snapshot:string}).snapshot,snapshot)
 assert.throws(()=>db.prepare("UPDATE agent_version SET snapshot='{}' WHERE id=?").run(created.versionId),/快照不可變更/)
 assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='agent.version.rename'").get() as {n:number}).n,1)
 const next=store.updateAgent(created.id,{...config,versionInfo:{model:'second-model'}},null,{ok:true,checkedAt:new Date().toISOString(),latencyMs:1,httpStatus:200})
 assert.equal(store.listAgentVersions(created.id).find(v=>v.id===next.versionId)?.versionName,'second-model')
 console.log('PASS migration, custom/default names, API auth and validation, ownership, audit, immutable snapshots, idempotency')
}finally{await app.close();db.close()}
