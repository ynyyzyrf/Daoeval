import { answerBatchLabel, type AnswerEvaluationBatch } from './ai-evaluation.ts'

/** Shared by the live report and exports; counts answers, not distinct test cases. */
export function summarizeAiReport(batch: AnswerEvaluationBatch) {
  const rows = batch.evaluations
  const results = rows.filter((item) => item.status === 'completed' && item.result)
  const meets = results.filter((item) => item.result!.verdict === 'meets').length
  const partial = results.filter((item) => item.result!.verdict === 'partial').length
  const doesNotMeet = results.filter((item) => item.result!.verdict === 'does_not_meet').length
  const uncertain = results.filter((item) => item.result!.verdict === 'uncertain').length
  const judged = meets + partial + doesNotMeet
  const failed = rows.filter((item) => item.status === 'failed').length
  const interrupted = rows.filter((item) => item.status === 'interrupted').length
  const pending = rows.filter((item) => item.status === 'pending' || item.status === 'running').length
  const skipped = rows.filter((item) => item.status === 'skipped').length
  const eligible = rows.length - rows.filter((item) => item.status === 'skipped' && !item.error?.startsWith('評分服務不可用')).length
  const complete = batch.status === 'completed' && judged === eligible && eligible > 0
  const inherited = results.filter((item) => item.inherited).length
  const errorCounts = new Map<string, number>()
  for (const row of rows) {
    if (!row.error) continue
    const reason = row.error.replace(/（已嘗試 \d+ 次）$/, '')
    errorCounts.set(reason, (errorCounts.get(reason) ?? 0) + 1)
  }
  return {
    batch, total: rows.length, eligible, completed: results.length, judged, meets, partial, doesNotMeet,
    uncertain, failed, interrupted, pending, skipped, complete, inherited, label: answerBatchLabel(batch),
    matchRateText: judged ? `${(100 * meets / judged).toFixed(1)}%` : '—',
    headline: `AI 評估完成 ${results.length}/${eligible} 條可送評回答：${meets} 條符合、${partial} 條部分符合、${doesNotMeet} 條不符合；${uncertain} 條無法判定、${failed} 條評估失敗、${interrupted} 條中斷、${pending} 條待完成、${skipped} 條未送評。${complete ? '' : '結果不完整，不能據此認定整批通過。'}`,
    errorGroups: [...errorCounts].map(([reason, count]) => ({ reason, count })),
  }
}

export type AiReportSummary = ReturnType<typeof summarizeAiReport>
