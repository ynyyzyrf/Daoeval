import { useEffect, useRef, useState } from 'react'
import { ANSWER_VERDICTS, DIFFERENCE_KINDS, answerBatchLabel, canRetryAnswerEvaluation, type AnswerEvaluationBatch } from '../../../src/shared/ai-evaluation.ts'
import { api, type ExperimentDetail } from '../api.ts'
import { formatDateTime } from '../lib/format.ts'
import { navigate } from '../lib/router.ts'
import { Badge, Button, Notice } from './ui.tsx'
import './AnswerEvaluation.css'

export function useAnswerEvaluations(experimentId: string, runId: string | null) {
  const [batches, setBatches] = useState<AnswerEvaluationBatch[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const running = batches.some((item) => item.status === 'running')
  useEffect(() => {
    const token = ++generation.current
    setBatches([]); setSelectedId(null); setError(null); setBusy(false)
    if (runId) api.answerEvaluations(experimentId, runId).then((values) => { if (token === generation.current) setBatches(values) }).catch((e: Error) => { if (token === generation.current) setError(e.message) })
    return () => { generation.current += 1 }
  }, [experimentId, runId])
  useEffect(() => {
    if (!running || !runId) return
    let stopped = false
    let fetching = false
    const timer = window.setInterval(async () => {
      if (fetching || document.visibilityState === 'hidden') return
      fetching = true
      try { const values = await api.answerEvaluations(experimentId, runId); if (!stopped) { setBatches(values); setError(null) } }
      catch (e) { if (!stopped) setError((e as Error).message) }
      finally { fetching = false }
    }, 2000)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [experimentId, runId, running])
  const start = async (retryBatchId?: string) => {
    if (!runId) return
    const token = generation.current
    setBusy(true); setError(null)
    try {
      const started = await api.startAnswerEvaluation(experimentId, runId, retryBatchId)
      const values = await api.answerEvaluations(experimentId, runId)
      if (token === generation.current) { setBatches(values); setSelectedId(started.batchId) }
    } catch (e) { if (token === generation.current) setError((e as Error).message) }
    finally { if (token === generation.current) setBusy(false) }
  }
  return { batches, batch: batches.find((item) => item.id === selectedId) ?? batches[0] ?? null, setSelectedId, error, busy, running, start }
}

export function AnswerEvaluationPanel({ state, detail, runId }: {
  state: ReturnType<typeof useAnswerEvaluations>; detail: ExperimentDetail; runId: string | null
}) {
  const batch = state.batch
  const eligible = detail.trials.filter((trial) => trial.status === 'succeeded' && trial.normalized.finalOutput?.trim() && detail.frozen.dataset.cases.find((item) => item.id === trial.caseId)?.expected.trim()).length
  const completed = batch?.evaluations.filter((item) => item.status === 'completed') ?? []
  const judged = completed.filter((item) => item.result?.verdict !== 'uncertain')
  const passed = judged.filter((item) => item.result?.verdict === 'meets').length
  const runActive = detail.runs.some((item) => item.id === runId && (item.status === 'running' || item.status === 'paused'))
  const failures = batch?.evaluations.filter((item) => item.status === 'failed' || item.status === 'interrupted') ?? []
  const retryCount = batch?.evaluations.filter(canRetryAnswerEvaluation).length ?? 0
  const inherited = batch?.evaluations.filter((item) => item.inherited).length ?? 0
  const failureReasons = new Map<string, number>()
  for (const item of failures) {
    const reason = item.error?.replace(/（已嘗試 \d+ 次）$/, '') ?? '未記錄失敗原因'
    failureReasons.set(reason, (failureReasons.get(reason) ?? 0) + 1)
  }
  return <section className="answer-evaluation-panel">
    <div className="spread"><div><strong>AI 回答差距評估</strong><div className="sm muted">獨立於規則評分，不改動原分數；只評估已有回答。</div></div><div className="row">{batch && retryCount > 0 && <Button loading={state.busy} disabled={!runId || state.running || runActive} onClick={() => void state.start(batch.id)}>僅補評失敗 {retryCount} 條</Button>}<Button loading={state.busy} disabled={!runId || !eligible || state.running || runActive} onClick={() => void state.start()}>{state.running ? 'AI 評估中…' : batch ? '重新評估全部' : 'AI 評估回答'}</Button></div></div>
    <p className="sm muted">本批有 {eligible} 條回答可送評。完整評估會將問題、參考回答及實際回答傳送至目前設定的模型，產生 API 用量。<button type="button" className="answer-evaluation-link" onClick={() => navigate('/models')}>管理評估模型</button></p>
    {batch && retryCount > 0 && <p className="sm muted">僅補評失敗會使用此批次的 {batch.model}，保留已完成結果，只送出剩餘 {retryCount} 條；會產生補評用量。</p>}
    {!eligible && <p className="sm muted">需要調用成功、實際回答及參考回答；失敗或無回答的項目不作語義評分。</p>}
    {state.error && <Notice tone="err">{state.error}</Notice>}
    {batch && <>
      {batch.sourceBatchId && <p className="sm muted">補評批次：沿用 {inherited} 條已完成結果，只重送失敗／中斷項目；使用來源模型，會產生補評用量。沿用結果保留原完成批次的提示版本，可沿補評來源回溯。</p>}
      <div className="row sm"><Badge tone={batch.status === 'running' ? 'info' : batch.status === 'interrupted' || failures.length > 0 ? 'warn' : 'muted'}>{answerBatchLabel(batch)}</Badge><span>{batch.providerName} · {batch.model} · {formatDateTime(batch.createdAt)}</span><span className="muted">{batch.promptVersion}</span></div>
      <div className="row sm answer-evaluation-counts"><span>完成評估 {completed.length}/{batch.evaluations.length}</span><span>符合 {passed}/{judged.length} 可判定回答</span><span>無法判定 {completed.length - judged.length}</span><span>評估失敗／中斷 {batch.evaluations.filter((item) => item.status === 'failed' || item.status === 'interrupted').length}</span><span>未送評 {batch.evaluations.filter((item) => item.status === 'skipped').length}</span></div>
      <p className="sm muted">點選下方試驗，在右側查看 AI 差距分析。未完成及無法判定的項目不計入符合比例。</p>
      {failureReasons.size > 0 && <details><summary className="sm muted">原始錯誤詳情（{failures.length} 條）</summary><ul className="sm muted">{[...failureReasons].map(([reason, count]) => <li key={reason}>{count} 條：{reason}</li>)}</ul></details>}
    </>}
    {state.batches.length > 1 && <details><summary className="sm muted">評估歷史（{state.batches.length} 次）</summary><div className="answer-evaluation-history">{state.batches.map((item) => <button key={item.id} type="button" aria-pressed={batch?.id === item.id} onClick={() => state.setSelectedId(item.id)}>{formatDateTime(item.createdAt)} · {item.providerName} · {item.model} · {answerBatchLabel(item)}</button>)}</div></details>}
  </section>
}

export function AnswerEvaluationDetail({ batch, trialId, reference }: { batch: AnswerEvaluationBatch | null; trialId: string; reference: string }) {
  const item = batch?.evaluations.find((value) => value.trialId === trialId)
  return <>
    <div><div className="detail-section-label">參考回答</div><div className="detail-box">{reference || '（未設定參考回答）'}</div></div>
    <div><div className="detail-section-label">AI 差距分析</div>
      {item?.inherited ? <div className="sm muted">沿用來源批次已完成的評估結果，本次沒有重送</div> : item && item.attempts > 0 && <div className="sm muted">已嘗試 {item.attempts} 次（每條最多 2 次）</div>}
      {!item ? <div className="detail-box dim">尚未評估這條回答，可在上方啟動 AI 評估。</div>
        : !item.result ? <div className="detail-box">{item.status === 'pending' ? '等待 AI 評估' : item.status === 'running' ? 'AI 評估中…' : item.error ?? '未完成評估'}</div>
          : <div className="detail-box stack-3">
            <div><Badge tone={item.result.verdict === 'meets' ? 'ok' : item.result.verdict === 'uncertain' ? 'muted' : 'warn'}>{ANSWER_VERDICTS[item.result.verdict]}</Badge></div><p>{item.result.summary}</p>
            {item.result.differences.map((difference, index) => <div key={index} className="answer-difference"><strong>{DIFFERENCE_KINDS[difference.kind]}</strong>{difference.referenceQuote && <div><span className="muted">參考：</span><blockquote>{difference.referenceQuote}</blockquote></div>}{difference.actualQuote && <div><span className="muted">實際：</span><blockquote>{difference.actualQuote}</blockquote></div>}<p>{difference.explanation}</p></div>)}
            {item.result.suggestions.length > 0 && <div><strong>修正／確認建議</strong><ul>{item.result.suggestions.map((text, index) => <li key={index}>{text}</li>)}</ul></div>}
            <span className="xs muted">AI 輔助判斷，參考回答本身仍需由負責人確認。</span>
          </div>}
    </div>
  </>
}
