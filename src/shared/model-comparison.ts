import type { AgentConfig } from './types.ts'
import type { AnswerEvaluationBatch } from './ai-evaluation.ts'

/** Model-only experiments must actually route to different models, not just change labels. */
export function modelComparisonIssues(versions: Array<{ agentId: string; config: AgentConfig }>): string[] {
  const issues: string[] = []
  if (versions.length < 2) issues.push('模型對比至少需要兩個版本')
  if (new Set(versions.map(v => v.agentId)).size !== 1) issues.push('模型對比必須使用同一個 Agent 的版本')
  const routes: string[] = []
  const signature = (config: AgentConfig) => {
    const c = structuredClone(config) as AgentConfig & Record<string, unknown>
    delete c.agentId; delete c.versionNo; delete c.createdAt
    delete c.versionInfo.model; delete c.versionInfo.versionName
    if (c.targeting) { routes.push(c.targeting.providerId || ''); delete c.targeting.providerId }
    else {
      const body = c.requestTemplate.body
      if (body && typeof body === 'object' && !Array.isArray(body) && typeof (body as Record<string, unknown>).model === 'string') {
        routes.push(String((body as Record<string, unknown>).model)); delete (body as Record<string, unknown>).model
      } else routes.push('')
    }
    const stable = (x: unknown): unknown => Array.isArray(x) ? x.map(stable) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k,stable(v)])) : x
    return JSON.stringify(stable(c))
  }
  if (new Set(versions.map(v => signature(v.config))).size > 1) issues.push('除了模型外，Prompt、接入目標、工具、知識庫與其他配置也有差異；請改用一般版本對比或先統一配置')
  if (routes.some(r => !r)) issues.push('尚未指定可執行的模型路由：Oumi 需 providerId，自訂 HTTP 需 Body.model')
  if (new Set(routes).size !== routes.length) issues.push('模型路由重複，修改模型名稱並不會切換實際模型')
  return issues
}

export interface ComparisonInput {
  experimentId: string; runId: string | null; repeats: number
  branches: Array<{ id: string; versionId: string; label: string; model: string }>
  cases: Array<{ id: string; name: string; input: string; expected: string }>
  trials: Array<{ id: string; branchId: string; caseId: string; repeatIndex: number; status: string; latencyMs: number; output: string | null; error: string | null; sourceTrial?: { experimentId: string; runId: string; trialId: string; executedAt: string } }>
  batch: AnswerEvaluationBatch | null
}
export function summarizeModelComparison(input: ComparisonInput) {
  const batch = input.batch?.experimentId === input.experimentId && input.batch.runId === input.runId ? input.batch : null
  const pairingAvailable = Boolean(batch) && !(batch?.sourceBatchId && batch.evaluations.some(e => e.inherited))
  const evaluations = new Map((batch?.evaluations ?? []).map(e => [e.trialId, e]))
  const cases = input.cases.flatMap(c => Array.from({length: input.repeats}, (_,i) => {
    const cells = input.branches.map(branch => {
      const matches = input.trials.filter(t => t.branchId === branch.id && t.caseId === c.id && t.repeatIndex === i+1)
      const trial = matches.length === 1 ? matches[0] : null
      const evaluation = trial ? evaluations.get(trial.id) ?? null : null
      const result = trial?.status === 'succeeded' && evaluation?.status === 'completed' ? evaluation.result : null
      return { branchId: branch.id, trial, evaluation, result }
    })
    const base = cells[0]?.result
    const rank = { meets: 2, partial: 1, does_not_meet: 0, uncertain: -1 }
    const changes = cells.slice(1).map(cell => {
      const a = base ? rank[base.verdict] : -1, b = cell.result ? rank[cell.result.verdict] : -1
      return { branchId: cell.branchId, change: !pairingAvailable || a < 0 || b < 0 ? 'unavailable' as const : b > a ? 'improved' as const : b < a ? 'regressed' as const : 'same' as const }
    })
    return { ...c, repeatIndex: i+1, cells, changes }
  }))
  const branches = input.branches.map(branch => {
    const cells = cases.map(c => c.cells.find(x => x.branchId === branch.id)!)
    const trials = cells.flatMap(c => c.trial ? [c.trial] : [])
    const succeeded = trials.filter(t => t.status === 'succeeded')
    const successfulTimes = succeeded.map(t => t.latencyMs).filter(Number.isFinite).sort((a,b) => a-b)
    const results = cells.flatMap(c => c.result ? [c.result] : [])
    const verdicts = { meets: 0, partial: 0, does_not_meet: 0, uncertain: 0 }
    results.forEach(r => verdicts[r.verdict]++)
    const judged = results.length - verdicts.uncertain
    const eligible = cells.filter(c => c.trial?.status === 'succeeded' && c.trial.output?.trim() && input.cases.find(x => x.id === c.trial!.caseId)?.expected.trim()).length
    const pending = cells.filter(c => c.trial?.status === 'pending' || c.trial?.status === 'running' || !c.trial).length
    return { ...branch, expected: cases.length, succeeded: succeeded.length, failed: trials.filter(t => t.status === 'failed' || t.status === 'interrupted').length, blocked: trials.filter(t => t.status === 'blocked').length, pending,
      timeouts: trials.filter(t => t.error === 'timeout').length, completed: results.length, eligible,
      evaluationFailed: cells.filter(c => c.evaluation && ['failed','interrupted'].includes(c.evaluation.status)).length,
      evaluationPending: cells.filter(c => c.evaluation && ['pending','running'].includes(c.evaluation.status)).length,
      notEvaluated: Math.max(0, eligible - results.length - cells.filter(c => c.evaluation && ['failed','interrupted','pending','running'].includes(c.evaluation.status)).length),
      verdicts, judged, matchRate: judged ? verdicts.meets / judged : null,
      avgMs: successfulTimes.length ? successfulTimes.reduce((a,b)=>a+b,0)/successfulTimes.length : null,
      p95Ms: successfulTimes.length ? successfulTimes[Math.ceil(successfulTimes.length*.95)-1] : null, latencySamples: successfulTimes.length,
      paired: cases.reduce((acc,c) => { const change=c.changes.find(x=>x.branchId===branch.id)?.change; if(change)acc[change]++; return acc }, {improved:0,regressed:0,same:0,unavailable:0}),
    }
  })
  return { pairingAvailable, runId: input.runId, batchId: batch?.id ?? null, judge: batch ? `${batch.providerName} · ${batch.model} · ${batch.promptVersion}` : null, branches, cases }
}
export type ModelComparison = ReturnType<typeof summarizeModelComparison>
