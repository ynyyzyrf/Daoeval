import {db,newId,nowIso} from './db.ts'
import {getExperiment,getRunRow,insertRun,writeAudit} from './store.ts'

/** Assemble completed runs without calling models or modifying source records/frozen snapshots. */
export function composeCompletedRuns(experimentId: string, sourceRunIds: string[]): string {
  return db.transaction(() => {
    const target=getExperiment(experimentId)
    if(!target)throw new Error('目標實驗不存在')
    if(target.frozen.externalConditions.composition!=='reuse')throw new Error('目標實驗未宣告沿用來源結果')
    const previous=target.runs.find(r=>r.source==='composed')
    if(previous)return previous.id
    if(target.runs.length||target.trials.length)throw new Error('目標實驗已有其他執行，拒絕混合')
    if(new Set(sourceRunIds).size!==sourceRunIds.length)throw new Error('來源批次重複')
    const sources=sourceRunIds.map(id=>{
      const run=getRunRow(id);if(!run||run.status!=='completed')throw new Error('來源執行尚未完成')
      const detail=getExperiment(run.experiment_id,id)!
      if(detail.frozen.dataset.versionId!==target.frozen.dataset.versionId||detail.frozen.scoring.versionId!==target.frozen.scoring.versionId||run.repeats!==target.frozen.repeats)throw new Error('來源測試集、評分版本或重複次數不同')
      return {run,detail}
    })
    const mappings=target.branches.map(branch=>{
      const matches=sources.flatMap(s=>s.detail.branches.filter(b=>b.agent_version_id===branch.agent_version_id).map(b=>({...s,branch:b})))
      if(matches.length!==1)throw new Error('每個模型版本必須有唯一來源')
      const source=matches[0]
      const trials=source.detail.trials.filter(t=>t.branchId===source.branch.id)
      const required=target.frozen.dataset.cases.flatMap((c:any)=>Array.from({length:target.frozen.repeats},(_,i)=>`${c.id}:${i+1}`))
      const keys=trials.map(t=>`${t.caseId}:${t.repeatIndex}`)
      if(keys.length!==required.length||new Set(keys).size!==keys.length||required.some((key:string)=>!keys.includes(key))||trials.some(t=>!['succeeded','failed','blocked','interrupted'].includes(t.status)))throw new Error('來源調用不完整或重複，拒絕補造結果')
      return {target:branch,source,trials}
    })
    const runId=newId('run'),composedAt=nowIso(),all=mappings.flatMap(m=>m.trials)
    const startedAt=sources.map(s=>s.run.started_at).sort()[0]
    insertRun({id:runId,experiment_id:experimentId,source:'composed',status:'completed',total:all.length,concurrency:1,repeats:target.frozen.repeats,branch_ids:JSON.stringify(target.branches.map(b=>b.id)),started_at:startedAt})
    for(const mapping of mappings)for(const t of mapping.trials){
      const trialId=newId('trial')
      const sourceTrial={experimentId:mapping.source.detail.id,runId:mapping.source.run.id,trialId:t.id,branchId:t.branchId,executedAt:t.createdAt,composedAt}
      const normalized={...t.normalized,sourceTrial}
      db.prepare(`INSERT INTO trial (id,experiment_id,run_id,branch_id,agent_version_id,case_id,case_name,case_type,repeat_index,status,latency_ms,error_class,error_message,session_id,request_summary,normalized,http_status,created_at)
        SELECT ?,?,?,?,agent_version_id,case_id,case_name,case_type,repeat_index,status,latency_ms,error_class,error_message,session_id,? || '；原始請求：' || request_summary, ?,http_status,created_at FROM trial WHERE id=?`).run(trialId,experimentId,runId,mapping.target.id,`沿用來源 ${mapping.source.run.id} / ${t.id}`,JSON.stringify(normalized),t.id)
      const scores=db.prepare('SELECT id FROM score WHERE trial_id=?').all(t.id) as Array<{id:string}>
      for(const score of scores)db.prepare(`INSERT INTO score (id,trial_id,experiment_id,branch_id,case_id,dimension,method,passed,rationale,checks,created_at)
        SELECT ?,?,?,?,case_id,dimension,method,passed,rationale,checks,created_at FROM score WHERE id=?`).run(newId('score'),trialId,experimentId,mapping.target.id,score.id)
      db.prepare('INSERT INTO run_task (id,run_id,case_id,branch_id,repeat_index,trial_id,status,finished_at) VALUES (?,?,?,?,?,?,?,?)').run(newId('rtask'),runId,t.caseId,mapping.target.id,t.repeatIndex,trialId,t.status==='interrupted'?'failed':t.status,composedAt)
    }
    const succeeded=all.filter(t=>t.status==='succeeded').length,blocked=all.filter(t=>t.status==='blocked').length,failed=all.length-succeeded-blocked
    db.prepare('UPDATE run SET done=?,succeeded=?,failed=?,blocked=?,finished_at=? WHERE id=?').run(all.length,succeeded,failed,blocked,composedAt,runId)
    db.prepare('UPDATE experiment SET status=? WHERE id=?').run(failed?'partial_failed':'completed',experimentId)
    writeAudit({actor:'local',action:'run.compose',targetType:'run',targetId:runId,detail:{experimentId,sourceRunIds,trials:all.length,modelCalls:0},method:'CLI',path:'compose-completed-runs'})
    return runId
  })()
}
