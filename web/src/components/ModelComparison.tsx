import { useMemo, useState } from 'react'
import { summarizeModelComparison, type ModelComparison } from '../../../src/shared/model-comparison.ts'
import { ANSWER_VERDICTS, DIFFERENCE_KINDS, type AnswerEvaluationBatch } from '../../../src/shared/ai-evaluation.ts'
import type { ExperimentDetail } from '../api.ts'
import { Badge, Button, Drawer, EmptyState, Notice } from './ui.tsx'
import { formatAgentTime } from '../lib/format.ts'
import './ModelComparison.css'

export function comparisonForDetail(detail: ExperimentDetail, batch: AnswerEvaluationBatch | null) {
  return summarizeModelComparison({ experimentId: detail.id, runId: detail.selectedRunId, repeats: detail.runs.find(r=>r.id===detail.selectedRunId)?.repeats ?? detail.frozen.repeats,
    branches: detail.branches.map(b=>{const frozen=detail.frozen.branches.find(f=>f.agentVersionId===b.agent_version_id);return {id:b.id,versionId:b.agent_version_id,label:frozen?.versionName || frozen?.config.versionInfo.model || `v${frozen?.agentVersionNo ?? '?'}`,model:frozen?.config.versionInfo.model || '未記錄模型'}}),
    cases: detail.frozen.dataset.cases.map(c=>({id:c.id,name:c.name,input:c.input,expected:c.expected})),
    trials:detail.trials.map(t=>({id:t.id,branchId:t.branchId,caseId:t.caseId,repeatIndex:t.repeatIndex,status:t.status,latencyMs:t.latencyMs,output:t.normalized.finalOutput,error:t.normalized.error?.class??null,sourceTrial:t.normalized.sourceTrial})),batch,
  })
}
function cellLabel(cell: ModelComparison['cases'][number]['cells'][number]) {
  if (!cell.trial || ['pending','running'].includes(cell.trial.status)) return '待執行／執行中'
  if (cell.trial.status === 'blocked') return '已攔截'
  if (cell.trial.status !== 'succeeded') return cell.trial.error === 'timeout' ? '調用超時' : '調用失敗／中斷'
  if (cell.result) return ANSWER_VERDICTS[cell.result.verdict]
  if (cell.evaluation && ['failed','interrupted'].includes(cell.evaluation.status)) return '評估異常'
  if (cell.evaluation && ['pending','running'].includes(cell.evaluation.status)) return '評估中'
  return '未評估'
}
const seconds=(ms:number|null)=>ms===null?'—':`${Number((ms/1000).toFixed(2))} 秒`
export function ModelComparisonView({ detail, batch }: { detail: ExperimentDetail; batch: AnswerEvaluationBatch|null }) {
  const data=useMemo(()=>comparisonForDetail(detail,batch),[detail,batch])
  const [selected,setSelected]=useState<string|null>(null)
  const [filter,setFilter]=useState('all')
  const [search,setSearch]=useState('')
  const visible=data.cases.filter(c=>(!search || `${c.name} ${c.input}`.toLowerCase().includes(search.toLowerCase())) && (filter==='all'||c.changes.some(x=>x.change===filter)))
  const chosen=data.cases.find(c=>`${c.id}:${c.repeatIndex}`===selected)
  return <section className="model-comparison" aria-label="模型分組對比報告">
    <div className="model-comparison-heading"><div><h2>模型表現對比</h2><p className="sm muted">同一批次、同一測試集 · {data.branches.length} 組 · {detail.frozen.dataset.cases.length} 題 · 基準：{data.branches[0]?.label}</p></div></div>
    <p className="sm muted">AI 評審：{data.judge ?? '尚未選擇評估批次'}。各組使用所選的同一評估批次；補評批次可能沿用舊評估提示，詳情見評估歷史。</p>
    {detail.frozen.externalConditions.composition === 'reuse' && <Notice>{detail.frozen.externalConditions.sourceDescription} 各回答保留來源執行及原始時間；AI 品質以同一新評估批次重評。</Notice>}
    {detail.frozen.externalConditions.comparisonMode === 'models' && <Notice>已核對本地版本除模型外配置一致；遠端 Agent 的 Prompt、Skill 與知識庫仍需在測試期間保持不變。</Notice>}
    {data.batchId && !data.pairingAvailable && <Notice tone="warn">所選補評批次沿用歷史評估結果，無法確認所有回答使用同一評估提示版本，因此暫不計改善／退步。可重新完整評估後比較。</Notice>}
    <div className="model-comparison-scroll" tabIndex={0} aria-label="各模型指標，可橫向捲動"><table className="data model-summary-table"><thead><tr><th>指標</th>{data.branches.map((b,i)=><th key={b.id}>{b.label}<span className="sm muted">{i===0?'基準組':'對比組'} · {b.model}</span></th>)}</tr></thead><tbody>
      <tr><th>執行結果</th>{data.branches.map(b=><td key={b.id}>成功 {b.succeeded} · 失敗／中斷 {b.failed}<br/><span className="sm muted">攔截 {b.blocked} · 待完成 {b.pending} · 預計 {b.expected}</span></td>)}</tr>
      <tr><th>AI 評估進度</th>{data.branches.map(b=><td key={b.id}>{b.completed} / {b.eligible} 條可送評回答<br/><span className="sm muted">異常 {b.evaluationFailed} · 處理中 {b.evaluationPending} · 未評 {b.notEvaluated}</span></td>)}</tr>
      <tr><th>AI 回答品質</th>{data.branches.map(b=><td key={b.id}>符合 {b.verdicts.meets} · 部分符合 {b.verdicts.partial}<br/>不符合 {b.verdicts.does_not_meet} · 無法判定 {b.verdicts.uncertain}</td>)}</tr>
      <tr><th>已判定符合率</th>{data.branches.map(b=><td key={b.id}>{b.matchRate===null?'—':`${(b.matchRate*100).toFixed(1)}%`}<span className="sm muted">{b.verdicts.meets} / {b.judged} 條可判定回答；非全批通過率</span></td>)}</tr>
      <tr><th>回答平均 / P95</th>{data.branches.map(b=><td key={b.id}>{seconds(b.avgMs)} / {seconds(b.p95Ms)}<span className="sm muted">只計 {b.latencySamples} 條成功調用；不含 AI 評審</span></td>)}</tr>
      <tr><th>調用超時次數</th>{data.branches.map(b=><td key={b.id}>{b.timeouts}</td>)}</tr>
      <tr><th>相對基準逐題變化</th>{data.branches.map((b,i)=><td key={b.id}>{i===0?'比較基準':<>改善 {b.paired.improved} · 退步 {b.paired.regressed}<br/><span className="sm muted">無變化 {b.paired.same} · 不可比較 {b.paired.unavailable}</span></>}</td>)}</tr>
    </tbody></table></div>
    <p className="sm muted">逐題按相同案例與重複序號配對，比較「符合 ＞ 部分符合 ＞ 不符合」；無法判定與未完成另列，不算回答失敗。各組評估覆蓋不同時，不以總比例直接判定勝負。耗時沿用既有量測口徑，不是首字時間。</p>
    <div className="model-comparison-filters"><input aria-label="搜尋對比案例" placeholder="搜尋案例或問題" value={search} onChange={e=>setSearch(e.target.value)}/><select aria-label="對比結果篩選" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部題目</option><option value="improved">有改善</option><option value="regressed">有退步</option><option value="same">有無變化</option><option value="unavailable">有不可比較</option></select></div>
    <div className="model-comparison-scroll" tabIndex={0} aria-label="逐題模型對比"><table className="data"><thead><tr><th>案例／重複序號</th>{data.branches.map(b=><th key={b.id}>{b.label}</th>)}</tr></thead><tbody>{visible.map(c=><tr key={`${c.id}:${c.repeatIndex}`}><td><button className="report-trial-open" type="button" onClick={()=>setSelected(`${c.id}:${c.repeatIndex}`)} aria-haspopup="dialog">{c.name} · 第 {c.repeatIndex} 次</button></td>{c.cells.map(cell=><td key={cell.branchId}>{cellLabel(cell)}<span className="sm muted">{cell.trial ? formatAgentTime(cell.trial.latencyMs,cell.trial.status):'—'}</span></td>)}</tr>)}</tbody></table></div>
    {!visible.length && <EmptyState title="沒有符合條件的題目" description="調整篩選或搜尋，查看其他案例。"/>}
    {chosen && <Drawer title="同題模型回答對比" className="model-answer-drawer" onClose={()=>setSelected(null)}><h3>{chosen.name} · 第 {chosen.repeatIndex} 次</h3><div className="detail-section-label">共同輸入</div><div className="detail-box">{chosen.input}</div><details><summary>參考答案</summary><div className="detail-box">{chosen.expected||'未提供'}</div></details><div className="model-answers">{chosen.cells.map((cell,i)=><article className="model-answer" key={cell.branchId}><h3>{data.branches[i].label}</h3><p className="sm muted">接口模型：{data.branches[i].model}</p><Badge tone={cell.result?.verdict==='meets'?'ok':cell.result?.verdict==='does_not_meet'?'err':'muted'}>{cellLabel(cell)}</Badge><p className="sm">Agent 耗時：{cell.trial?formatAgentTime(cell.trial.latencyMs,cell.trial.status):'—'}</p><>{cell.trial?.sourceTrial && <details><summary>沿用結果的來源</summary><p className="sm">來源批次：{cell.trial.sourceTrial.runId}<br/>來源試驗：{cell.trial.sourceTrial.trialId}<br/>原始記錄時間：{cell.trial.sourceTrial.executedAt}</p></details>}</><div className="detail-section-label">實際回答</div><div className="detail-box">{cell.trial?.output||'尚無可用回答'}</div>{cell.result && <><h4>AI 評估依據</h4><p>{cell.result.summary}</p>{cell.result.differences.map((d,j)=><div key={j}><strong>{DIFFERENCE_KINDS[d.kind]}</strong><p>{d.explanation}</p><blockquote>參考：{d.referenceQuote||'—'}<br/>回答：{d.actualQuote||'—'}</blockquote></div>)}{cell.result.suggestions.length>0&&<><h4>改善建議</h4><ul>{cell.result.suggestions.map((s,j)=><li key={j}>{s}</li>)}</ul></>}</>}{(cell.trial?.error||cell.evaluation?.error)&&<details><summary>異常詳情</summary><p>{cell.trial?.error}</p><p>{cell.evaluation?.error}</p></details>}</article>)}</div></Drawer>}
  </section>
}
