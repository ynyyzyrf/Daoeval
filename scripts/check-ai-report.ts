import assert from 'node:assert/strict'
import type { AnswerEvaluationBatch } from '../src/shared/ai-evaluation.ts'

const { summarizeAiReport } = await import('../src/shared/ai-report.ts')
const batch = {
  id: 'batch-a', runId: 'run-a', experimentId: 'exp-a', status: 'completed', model: 'model-a',
  providerName: '評估服務', endpoint: 'https://example.test/chat/completions', promptVersion: 'v1',
  createdAt: '2026-11-02T06:34:25Z', finishedAt: '2026-11-02T07:00:19Z',
  evaluations: Array.from({ length: 50 }, (_, index) => ({
    id: `eval-${index}`, trialId: `trial-${index}`, caseName: `用例 ${index}`, attempts: 1,
    status: index < 15 ? 'completed' : index < 43 ? 'failed' : 'skipped',
    result: index < 15 ? { verdict: index < 6 ? 'meets' : index < 10 ? 'partial' : index < 14 ? 'does_not_meet' : 'uncertain', summary: '評估摘要', differences: [], suggestions: [] } : null,
    error: index < 15 ? null : index < 43 ? '評估失敗' : '受測調用未成功，不進行回答評估',
  })),
} as AnswerEvaluationBatch
const summary = summarizeAiReport(batch)
assert.deepEqual([summary.total, summary.eligible, summary.completed, summary.judged, summary.meets, summary.partial, summary.doesNotMeet, summary.uncertain, summary.failed, summary.skipped], [50, 43, 15, 14, 6, 4, 4, 1, 28, 7])
assert.equal(summary.matchRateText, '42.9%')
assert.equal(summary.complete, false)
assert.match(summary.headline, /15\/43/u)
assert.match(summary.headline, /28/u)
assert.match(summary.headline, /結果不完整/u)
assert.equal(summary.batch.id, 'batch-a')
assert.equal(summarizeAiReport({ ...batch, evaluations: batch.evaluations.slice(15) }).matchRateText, '—')
console.log('PASS AI report counts, eligible denominator, incomplete-result warning and batch identity')
