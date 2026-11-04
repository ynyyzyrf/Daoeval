import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import { summarizeAiReport } from '../src/shared/ai-report.ts'
import type { AnswerEvaluationBatch } from '../src/shared/ai-evaluation.ts'

const server = await createServer({ server: { middlewareMode: true } })
const { ReportOverview } = await server.ssrLoadModule('/src/components/ReportOverview.tsx')
const batch = {
  id: 'batch', status: 'completed', model: 'judge', evaluations: Array.from({ length: 200 }, (_, i) => ({
    id: String(i), trialId: String(i), caseName: String(i), attempts: 2,
    status: i < 111 ? 'completed' : i === 111 ? 'failed' : 'skipped',
    result: i < 111 ? { verdict: 'partial', summary: '差距', differences: [], suggestions: [] } : null,
    error: i === 111 ? '[truncated_response] 截斷' : i > 111 ? '受測調用未成功，不進行回答評估' : null,
  })),
} as AnswerEvaluationBatch
const html = renderToStaticMarkup(<ReportOverview
  detail={{ name: '測試', frozen: { branches: [], dataset: { cases: [] } }, runs: [], trials: [] } as any}
  metrics={null} runId={null} conclusion={null} ai={summarizeAiReport(batch)}
  state={{ busy: false, running: false, error: null } as any}
  onRunChange={() => {}} onOpen={() => {}} onEvidence={() => {}} onExport={() => {}}
/>).replace(/<[^>]+>/g, '')
assert.match(html, /全批 200 條試驗/)
assert.match(html, /已評估 111/)
assert.match(html, /評估異常 1/)
assert.match(html, /未送評 88/)
assert.match(html, /待評估 0/)
console.log('PASS report summary accounts for all 200 trials, including evaluation failures and unavailable answers')
await server.close()
