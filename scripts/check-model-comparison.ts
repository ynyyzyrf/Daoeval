import assert from 'node:assert/strict'
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {summarizeModelComparison,modelComparisonIssues,type ComparisonInput} from '../src/shared/model-comparison.ts'
import type {AgentConfig} from '../src/shared/types.ts'
import type {AnswerEvaluationBatch} from '../src/shared/ai-evaluation.ts'
mkdirSync('.tmp',{recursive:true});process.env.AEVAL_DATA_DIR=mkdtempSync(join(process.cwd(),'.tmp','model-comparison-'))
const {db,migrate}=await import('../src/server/db.ts');migrate()
const store=await import('../src/server/store.ts');const {startRun,getRun}=await import('../src/server/runner.ts')
const {buildReport,renderReportHtml,renderReportPdf}=await import('../src/server/report.ts');const {buildApp}=await import('../src/server/app.ts')
const app=await buildApp();const originalFetch=globalThis.fetch
const validation={ok:true,checkedAt:new Date().toISOString(),latencyMs:1,httpStatus:200}
const config:AgentConfig={name:'同一 Agent',platformType:'custom_http',endpoint:'https://mock.invalid/agent',authType:'none',requestTemplate:{method:'POST',headers:{},body:{input:'{{input}}',model:'m1',system:'fixed prompt'}},responseMap:{outputPath:'answer'},allowWrite:false,versionInfo:{model:'m1',versionName:'模型一',promptVersion:'p1'}}
try{
 const a=store.createAgent(config,null,validation)
 const b=store.updateAgent(a.id,{...config,requestTemplate:{...config.requestTemplate,body:{...(config.requestTemplate.body as any),model:'m2'}},versionInfo:{...config.versionInfo,model:'m2',versionName:'模型二'}},null,validation)
 const c=store.updateAgent(a.id,{...config,requestTemplate:{...config.requestTemplate,body:{...(config.requestTemplate.body as any),model:'m3'}},versionInfo:{...config.versionInfo,model:'m3',versionName:'模型三'}},null,validation)
 const ids=[a.versionId,b.versionId,c.versionId];const branches=ids.map((id,i)=>({role:i===0?'baseline':`candidate_${i}`,agentVersionId:id}))
 const scoring=store.ensureDefaultScoringProfileVersion()
 const set=store.createTestSet({name:'模型比較測試集',cases:[1,2].map(i=>({name:`案例 ${i}`,type:'basic_qa',input:`question-${i}`,expected:'reference <script>alert(1)</script>',scoringRubric:'內容正確',timeoutMs:1000,priority:'high',readWrite:'read'}))})
 const dataset=store.publishTestSet(set,scoring)
 const input={name:'三模型測試',kind:'A' as const,datasetVersionId:dataset.versionId,scoringProfileVersionId:scoring,repeats:1,branches,externalConditions:{comparisonMode:'models'}}
 const exp=store.createExperiment(input);assert.equal(exp.ok,true);if(!exp.ok)throw new Error('creation failed')
 assert.equal(store.createExperiment({...input,branches:[branches[0],branches[0]]}).ok,false)
 assert.ok(modelComparisonIssues([{agentId:a.id,config},{agentId:a.id,config:{...config,versionInfo:{model:'label-only'}}}]).length)
 assert.ok(modelComparisonIssues([{agentId:a.id,config},{agentId:'other',config}]).some(x=>x.includes('同一個')))
 assert.ok(modelComparisonIssues([{agentId:a.id,config},{agentId:a.id,config:{...config,versionInfo:{model:'m2',promptVersion:'different'}}}]).some(x=>x.includes('Prompt')))
 const seen:string[]=[]
 globalThis.fetch=(async (_url:any,init:any)=>{const body=JSON.parse(init.body);seen.push(body.model);return new Response(JSON.stringify({answer:`answer-${body.model}-${body.input}`}))}) as typeof fetch
 const run=startRun(exp.experimentId,{repeats:2,concurrency:2})
 for(let i=0;i<500&&getRun(run.id)?.status==='running';i++)await new Promise(r=>setTimeout(r,10))
 assert.equal(getRun(run.id)?.status,'completed');assert.equal(seen.length,12);for(const model of ['m1','m2','m3'])assert.equal(seen.filter(x=>x===model).length,4)
 const detail=store.getExperiment(exp.experimentId,run.id)!
 db.prepare("INSERT INTO ai_evaluation_batch (id,experiment_id,run_id,status,model,prompt_version,created_at,provider_name,api_endpoint) VALUES (?,?,?,'completed','judge','p1',?,'Mock Judge','https://mock.invalid')").run('batch',exp.experimentId,run.id,new Date().toISOString())
 for(const [i,t] of detail.trials.entries()){
  const model=t.normalized.configVersion.versionInfo.model
  const result={verdict:model==='m1'?'partial':model==='m2'?'meets':'uncertain',summary:`judge ${model}`,differences:[],suggestions:[]}
  db.prepare("INSERT INTO ai_evaluation (id,batch_id,trial_id,case_name,status,input,result) VALUES (?,'batch',?,?,'completed','{}',?)").run(`eval-${i}`,t.id,t.caseName,JSON.stringify(result))
 }
 const report=buildReport(exp.experimentId,run.id,'batch')!
 assert.equal(report.modelComparison?.branches.length,3)
 assert.equal(report.modelComparison?.cases.length,4,'Actual run repeats override experiment default')
 assert.equal(report.modelComparison?.branches[1].paired.improved,4)
 assert.equal(report.modelComparison?.branches[2].paired.unavailable,4)
 const html=renderReportHtml(report);assert.ok(html.includes('模型／版本對比'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>alert(1)</script>'))
 if(process.env.AEVAL_CHECK_PDF==='1') {
  mkdirSync('.tmp/model-comparison-ui',{recursive:true})
  writeFileSync('.tmp/model-comparison-ui/export.html',html)
  const pdf=await renderReportPdf(html)
  assert.ok(pdf?.subarray(0,5).toString()==='%PDF-')
  writeFileSync('.tmp/model-comparison-ui/export.pdf',pdf!)
 }
 assert.equal(buildReport(exp.experimentId,'wrong-run','batch'),null)
 assert.equal(report.reproducible.repeats,2)
 const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'admin',password:'admin'}});const cookie=login.cookies.map(x=>`${x.name}=${x.value}`).join('; ')
 const get=async(url:string)=>(await app.inject({method:'GET',url,headers:{cookie}})).json()
 const fixture={detail:await get(`/api/experiments/${exp.experimentId}?runId=${run.id}`),metrics:await get(`/api/experiments/${exp.experimentId}/metrics?runId=${run.id}`),agents:await get('/api/agents'),datasets:await get('/api/dataset-versions'),scoring:await get('/api/scoring-profile-versions'),batches:await get(`/api/experiments/${exp.experimentId}/answer-evaluations?runId=${run.id}`)}
 assert.equal(fixture.metrics.repeats,2)
 writeFileSync('.tmp/model-comparison-fixture.json',JSON.stringify(fixture))
 const pure:ComparisonInput={experimentId:'exp',runId:'run',repeats:2,branches:[{id:'a',versionId:'v1',label:'A',model:'m1'},{id:'b',versionId:'v2',label:'B',model:'m2'}],cases:[{id:'q',name:'Q',input:'Q',expected:'R'}],trials:[{id:'t1',branchId:'a',caseId:'q',repeatIndex:1,status:'succeeded',latencyMs:1000,output:'R',error:null},{id:'t2',branchId:'b',caseId:'q',repeatIndex:1,status:'failed',latencyMs:90000,output:null,error:'timeout'}],batch:null}
 const summary=summarizeModelComparison(pure);assert.equal(summary.branches[1].avgMs,null);assert.equal(summary.branches[1].timeouts,1);assert.equal(summary.branches[1].pending,1);assert.equal(summary.branches[1].paired.unavailable,2)
 pure.batch={id:'x',experimentId:'wrong',runId:'run',evaluations:[{trialId:'t1',status:'completed',result:{verdict:'meets'}}]} as AnswerEvaluationBatch
 assert.equal(summarizeModelComparison(pure).branches[0].completed,0)
 pure.batch={id:'inherited',experimentId:'exp',runId:'run',sourceBatchId:'previous',evaluations:[{id:'ev',trialId:'t1',caseName:'Q',status:'completed',result:{verdict:'meets',summary:'same',differences:[],suggestions:[]},error:null,attempts:1,inherited:true}],status:'completed',model:'judge',providerName:'Judge',endpoint:'https://mock.invalid',promptVersion:'p2',createdAt:'',finishedAt:''}
 assert.equal(summarizeModelComparison(pure).pairingAvailable,false)
 assert.equal(summarizeModelComparison(pure).branches[1].paired.unavailable,2)
 const {composeCompletedRuns}=await import('../src/server/compose-run.ts')
 const d=store.updateAgent(a.id,{...config,requestTemplate:{...config.requestTemplate,body:{...(config.requestTemplate.body as any),model:'instruct'}},versionInfo:{...config.versionInfo,model:'instruct',versionName:'Instruct'}},null,validation)
 const single=store.createExperiment({...input,name:'Instruct 補跑',branches:[{role:'baseline',agentVersionId:d.versionId}],externalConditions:{comparisonMode:'single'}})
 assert.ok(single.ok);if(!single.ok)throw new Error('single creation failed')
 const run2=startRun(single.experimentId,{repeats:2,concurrency:2})
 for(let i=0;i<500&&getRun(run2.id)?.status==='running';i++)await new Promise(r=>setTimeout(r,10))
 assert.equal(getRun(run2.id)?.status,'completed')
 const combined=store.createExperiment({...input,name:'四模型來源彙整',repeats:2,branches:[{role:'baseline',agentVersionId:d.versionId},...ids.map((id,i)=>({role:`candidate_${i+1}`,agentVersionId:id}))],externalConditions:{comparisonMode:'models',composition:'reuse'}})
 assert.ok(combined.ok);if(!combined.ok)throw new Error('combined creation failed')
 const beforeCalls=seen.length,beforeSource=JSON.stringify(store.getExperiment(exp.experimentId,run.id))
 assert.throws(()=>composeCompletedRuns(combined.experimentId,['missing']),/尚未完成/)
 const combinedRun=composeCompletedRuns(combined.experimentId,[run.id,run2.id])
 assert.equal(seen.length,beforeCalls,'composition must not call models')
 const assembled=store.getExperiment(combined.experimentId,combinedRun)!
 assert.equal(assembled.trials.length,16);assert.equal(assembled.runs[0].source,'composed')
 assert.equal(assembled.runs[0].done,16)
 const composedReport=buildReport(combined.experimentId,combinedRun)!
 assert.ok(composedReport.modelComparison?.cases.every(c=>c.cells.every(cell=>cell.trial?.sourceTrial?.trialId)))
 assert.ok(composedReport.branches.every(b=>b.trials.every(t=>t.sourceTrial?.trialId)))
 assert.ok(renderReportHtml(composedReport).includes('沿用來源：'))
 assert.ok(assembled.trials.every(t=>t.normalized.sourceTrial?.trialId))
 const copied=assembled.trials[0]
 const originalRequest=(db.prepare('SELECT request_summary FROM trial WHERE id=?').get(copied.normalized.sourceTrial!.trialId) as {request_summary:string}).request_summary
 assert.ok((db.prepare('SELECT request_summary FROM trial WHERE id=?').get(copied.id) as {request_summary:string}).request_summary.includes(originalRequest),'original conversation/request references are retained')
 assert.equal(JSON.stringify(store.getExperiment(exp.experimentId,run.id)),beforeSource,'source records and snapshots remain unchanged')
 assert.equal(composeCompletedRuns(combined.experimentId,[run.id,run2.id]),combinedRun,'retrying assembly is idempotent')
 assert.equal(store.getExperiment(combined.experimentId,combinedRun)!.trials.length,16)
 assert.equal((db.prepare('SELECT COUNT(*) AS n FROM ai_evaluation_batch WHERE experiment_id=?').get(combined.experimentId) as {n:number}).n,0,'old AI results are not inherited into the combined report')
 console.log('PASS four-model composition with provenance, source immutability, idempotency, no duplicate calls or inherited judge results; three-model execution and routing, model-only guards, actual repeats, per-branch AI, pairing, uncertainty, missing trials, successful-only timings, timeout separation, batch isolation, HTML escaping, export data')
}finally{globalThis.fetch=originalFetch;await app.close();db.close()}
