import { execFile } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { CaseInput, NormalizedTrial } from '../shared/types.ts'
import { businessRationale, judgementSentence, naBusinessHint, naBusinessLabel, trialFailureText } from '../shared/vocabulary.ts'
import { renderTokensCss } from '../shared/skin.ts'
import { computeMetrics, type MetricsResult } from './scoring.ts'
import { buildConclusion, caseVerdict, type Conclusion } from './conclusion.ts'
import { getExperiment, getRunSummary, pickMetricsRun } from './store.ts'
import { listAnswerEvaluations } from './ai-evaluation.ts'
import { ANSWER_VERDICTS, DIFFERENCE_KINDS } from '../shared/ai-evaluation.ts'
import { summarizeModelComparison, type ModelComparison } from '../shared/model-comparison.ts'
import { summarizeAiReport, type AiReportSummary } from '../shared/ai-report.ts'

const exec = promisify(execFile)

export interface ReportTrial {
  sourceTrial?: NormalizedTrial['sourceTrial']
  trialId: string
  input: string
  caseId: string
  caseName: string
  caseType: string
  repeatIndex: number
  status: string
  latencyMs: number
  score: { passed: boolean | null; rationale: string; dimension: string; method: string; checks: Array<{ kind: string; pass: boolean | null }> } | null
  toolCallsStatus: string
  traceStatus: string
  tokensStatus: string
  errorClass: string | null
  finalOutput: string | null
  expected: string
  judgement: string
  sessionId: string
}

export interface ReportBranch {
  role: string
  agentVersionId: string
  agentName: string
  agentVersionNo: number
  platformType: string
  versionInfo: Record<string, unknown>
  metrics: MetricsResult
  conclusion: Conclusion | null
  trials: ReportTrial[]
}

export interface ReportData {
  generatedAt: string
  aiEvaluation: AiReportSummary | null
  modelComparison: ModelComparison | null
  run: { id: string; status: string; source: string; startedAt: string; finishedAt: string | null; total: number; done: number; succeeded: number; failed: number; blocked: number } | null
  previousRun: { id: string; startedAt: string } | null
  legacyIncomplete: boolean
  experiment: {
    id: string
    name: string
    kind: string
    repeats: number
    status: string
    createdAt: string
    frozenAt: string
  }
  reproducible: {
    datasetVersionId: string
    scoringProfileVersionId: string
    repeats: number
    agentVersionIds: string[]
  }
  summary: {
    caseCount: number
    trialCount: number
    minSamples: number
    sampleWarning: boolean
    naReasons: Array<{ role: string; code: string; label: string; dimensions: string[] }>
  }
  cases: Array<Pick<CaseInput, 'id' | 'name' | 'type' | 'readWrite' | 'expected' | 'priority'> & { judgement: string }>
  branches: ReportBranch[]
}

function buildBranch(role: string, branch: { agentVersionId: string }, frozen: any, trials: any[], cases: CaseInput[], repeats: number): ReportBranch {
  const frozenBranch = frozen.branches.find((b: any) => b.agentVersionId === branch.agentVersionId)
  const config = frozenBranch?.config ?? {}
  const metrics = computeMetrics(
    cases,
    trials.map((t) => ({
      caseId: t.caseId,
      status: t.status,
      latencyMs: t.latencyMs,
      normalized: t.normalized as NormalizedTrial,
      scorePassed: t.score?.passed ?? null,
    })),
    repeats,
  )
  return {
    role,
    agentVersionId: branch.agentVersionId,
    agentName: config.name ?? branch.agentVersionId,
    agentVersionNo: frozenBranch?.agentVersionNo ?? 0,
    platformType: config.platformType ?? 'unknown',
    versionInfo: config.versionInfo ?? {},
    metrics,
    conclusion: null,
    trials: trials.map((t) => {
      const normalized = t.normalized as NormalizedTrial
      const caseInput = cases.find((item) => item.id === t.caseId)
      return {
        sourceTrial: normalized.sourceTrial,
        trialId: t.id,
        input: normalized.input ?? caseInput?.input ?? '',
        caseId: t.caseId,
        caseName: t.caseName,
        caseType: t.caseType,
        repeatIndex: t.repeatIndex,
        status: t.status,
        latencyMs: t.latencyMs,
        score: t.score
          ? { passed: t.score.passed, rationale: t.score.rationale, dimension: t.score.dimension, method: t.score.method, checks: (t.score.checks as Array<{ kind: string; pass: boolean | null }>).map((check) => ({ kind: check.kind, pass: check.pass })) }
          : null,
        toolCallsStatus: normalized.toolCalls.status,
        traceStatus: normalized.trace.status,
        tokensStatus: normalized.tokens.status,
        errorClass: normalized.error?.class ?? null,
        finalOutput: normalized.finalOutput,
        expected: caseInput?.expected ?? '',
        judgement: judgementSentence(caseInput?.judgement),
        sessionId: normalized.sessionId,
      }
    }),
  }
}

export function buildReport(experimentId: string, runId?: string, aiBatchId?: string): ReportData | null {
  const experiment = getExperiment(experimentId)
  if (!experiment) return null
  if (runId && !experiment.runs.some((item) => item.id === runId)) return null
  const selectedRunId = runId ?? pickMetricsRun(experimentId)?.id
  const run = selectedRunId && experiment.runs.some((item) => item.id === selectedRunId) ? getRunSummary(selectedRunId) : null
  const selectedExperiment = run ? getExperiment(experimentId, run.id)! : { ...experiment, trials: [] }
  const aiBatches = run ? listAnswerEvaluations(experimentId, run.id) : []
  const aiBatch = aiBatchId ? aiBatches.find((item) => item.id === aiBatchId) : aiBatches[0]
  if (aiBatchId && !aiBatch) return null
  const cases = selectedExperiment.frozen.dataset.cases as CaseInput[]
  const repeats = run?.repeats ?? selectedExperiment.frozen.repeats
  const minSamples = Number((selectedExperiment.frozen.scoring.thresholds as Record<string, number>).minSamples ?? 20)

  const branches = selectedExperiment.branches.map((branch) =>
    buildBranch(
      branch.role,
      { agentVersionId: branch.agent_version_id },
      selectedExperiment.frozen,
      selectedExperiment.trials.filter((t) => t.branchId === branch.id),
      cases,
      repeats,
    ),
  )

  // 與上一版比較：取同一實驗較早的一個有結果批次
  const previousRun = run ? experiment.runs.filter((item) => item.id !== run.id && item.done > 0).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0] ?? null : null
  const previousVerdicts = (() => {
    if (!previousRun) return null
    const previousTrials = getExperiment(experimentId, previousRun.id)?.trials ?? []
    const map = new Map<string, 'passed' | 'failed' | 'unknown'>()
    for (const caseInput of cases) {
      const caseTrials = previousTrials
        .filter((t) => t.caseId === caseInput.id)
        .map((t) => ({
          caseId: t.caseId,
          status: t.status,
          latencyMs: t.latencyMs,
          errorClass: (t.normalized as NormalizedTrial).error?.class ?? null,
          finalOutput: (t.normalized as NormalizedTrial).finalOutput,
          scorePassed: t.score?.passed ?? null,
        }))
      map.set(caseInput.id, caseVerdict(caseInput, caseTrials))
    }
    return map
  })()
  for (const branch of branches) {
    branch.conclusion = buildConclusion({
      cases,
      previous: previousVerdicts,
      repeats,
      trials: branch.trials.map((trial) => ({
        caseId: trial.caseId,
        status: trial.status,
        latencyMs: trial.latencyMs,
        errorClass: trial.errorClass,
        finalOutput: trial.finalOutput,
        scorePassed: trial.score?.passed ?? null,
      })),
    })
  }

  return {
    generatedAt: new Date().toISOString(),
    aiEvaluation: aiBatch ? summarizeAiReport(aiBatch) : null,
    modelComparison: selectedExperiment.branches.length > 1 ? summarizeModelComparison({experimentId,runId:run?.id??null,repeats:run?.repeats??repeats,
      branches:selectedExperiment.branches.map(b=>{const f=selectedExperiment.frozen.branches.find((f:any)=>f.agentVersionId===b.agent_version_id);return {id:b.id,versionId:b.agent_version_id,label:f?.versionName||f?.config.versionInfo.model||`v${f?.agentVersionNo??'?'}`,model:f?.config.versionInfo.model||'未記錄模型'}}),
      cases:cases.map(c=>({id:c.id,name:c.name,input:c.input,expected:c.expected})),
      trials:selectedExperiment.trials.map(t=>({id:t.id,branchId:t.branchId,caseId:t.caseId,repeatIndex:t.repeatIndex,status:t.status,latencyMs:t.latencyMs,output:t.normalized.finalOutput,error:t.normalized.error?.class??null,sourceTrial:t.normalized.sourceTrial})),batch:aiBatch??null,
    }):null,
    run,
    previousRun: previousRun ? { id: previousRun.id, startedAt: previousRun.startedAt } : null,
    legacyIncomplete: run?.source === 'legacy',
    experiment: {
      id: selectedExperiment.id,
      name: selectedExperiment.name,
      kind: selectedExperiment.kind,
      repeats,
      status: selectedExperiment.status,
      createdAt: selectedExperiment.createdAt,
      frozenAt: selectedExperiment.frozen.frozenAt,
    },
    reproducible: {
      datasetVersionId: selectedExperiment.frozen.dataset.versionId,
      scoringProfileVersionId: selectedExperiment.frozen.scoring.versionId,
      repeats,
      agentVersionIds: branches.map((b) => b.agentVersionId),
    },
    summary: {
      caseCount: cases.length,
      trialCount: selectedExperiment.trials.length,
      minSamples,
      sampleWarning: cases.length < minSamples,
      naReasons: branches.map((b) => ({
        role: b.role,
        code: b.metrics.naSummary.map((n) => n.code).join(','),
        label: b.metrics.naSummary.map((n) => `${naBusinessLabel(n.code)}（${n.dimensions.join('、')}）`).join('；'),
        dimensions: b.metrics.naSummary.flatMap((n) => n.dimensions),
      })),
    },
    cases: cases.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      readWrite: c.readWrite,
      expected: c.expected ?? '',
      judgement: judgementSentence(c.judgement),
      priority: c.priority,
    })),
    branches,
  }
}

function renderModelComparison(data: ModelComparison | null) {
  if (!data) return ''
  const time = (ms: number | null) => ms === null ? '—' : `${Number((ms / 1000).toFixed(2))} 秒`
  const rows = [
    ['執行結果', ...data.branches.map(b => `成功 ${b.succeeded}；失敗／中斷 ${b.failed}；攔截 ${b.blocked}；待完成 ${b.pending}；預計 ${b.expected}`)],
    ['AI 評估進度', ...data.branches.map(b => `${b.completed}/${b.eligible} 條可送評；異常 ${b.evaluationFailed}；處理中 ${b.evaluationPending}；未評 ${b.notEvaluated}`)],
    ['AI 回答品質', ...data.branches.map(b => `符合 ${b.verdicts.meets}；部分符合 ${b.verdicts.partial}；不符合 ${b.verdicts.does_not_meet}；無法判定 ${b.verdicts.uncertain}`)],
    ['已判定符合率', ...data.branches.map(b => `${b.matchRate===null?'—':(b.matchRate*100).toFixed(1)+'%'}（${b.verdicts.meets}/${b.judged} 條可判定回答）`)],
    ['成功回答平均／P95', ...data.branches.map(b => `${time(b.avgMs)}／${time(b.p95Ms)}；樣本 ${b.latencySamples}`)],
    ['調用超時', ...data.branches.map(b => String(b.timeouts))],
    ['相對基準', ...data.branches.map((b,i) => i===0?'比較基準':`改善 ${b.paired.improved}；退步 ${b.paired.regressed}；無變化 ${b.paired.same}；不可比較 ${b.paired.unavailable}`)],
  ]
  return `<section class="report-section" id="model-comparison"><h2>模型／版本對比</h2><p>AI 評審：${escapeHtml(data.judge??'尚未評估')}；同一案例、同一重複序號配對。各組覆蓋不同時不以總比例判定勝負；無法判定另列。耗時只計成功調用，不含 AI 評審。${data.batchId&&!data.pairingAvailable?'所選補評批次沿用歷史結果，暫不計改善／退步。':''}</p><table><thead><tr><th>指標</th>${data.branches.map(b=>`<th>${escapeHtml(b.label)}<br/>${escapeHtml(b.model)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(value=>`<td>${escapeHtml(value)}</td>`).join('')}</tr>`).join('')}</tbody></table>${data.cases.map(c=>`<h3>${escapeHtml(c.name)} · 第 ${c.repeatIndex} 次</h3><p>共同輸入：${escapeHtml(c.input)}</p><p>參考答案：${escapeHtml(c.expected)}</p><table><thead><tr>${data.branches.map(b=>`<th>${escapeHtml(b.label)}</th>`).join('')}</tr></thead><tbody><tr>${c.cells.map(cell=>`<td><p>${escapeHtml(cell.result?ANSWER_VERDICTS[cell.result.verdict]:cell.trial?.status==='succeeded'?'未評估／評估異常':cell.trial?'調用未成功':'待執行')} · ${escapeHtml(time(cell.trial?.latencyMs??null))}${cell.trial?.status==='succeeded'?'':'（等待）'}</p><p class="muted">${cell.trial?.sourceTrial ? `沿用來源：${escapeHtml(cell.trial.sourceTrial.runId)} / ${escapeHtml(cell.trial.sourceTrial.trialId)}；原始時間：${escapeHtml(cell.trial.sourceTrial.executedAt)}` : ''}</p><p style="white-space:pre-wrap">${escapeHtml(cell.trial?.output??'尚無可用回答')}</p><p>${escapeHtml(cell.result?.summary??'')}</p>${cell.result?.differences.map(d=>`<p>${escapeHtml(d.explanation)}<br/>參考：${escapeHtml(d.referenceQuote)}<br/>回答：${escapeHtml(d.actualQuote)}</p>`).join('')??''}${cell.result?.suggestions.map(s=>`<p>${escapeHtml(s)}</p>`).join('')??''}</td>`).join('')}</tr></tbody></table>`).join('')}</section>`
}

function escapeHtml(text: unknown): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function pct(value: number | null): string {
  if (value === null || value === undefined) return '—'
  return `${Math.round(value * 100)}%`
}

function pctOne(value: number | null): string {
  if (value === null || value === undefined) return '—'
  return `${(value * 100).toFixed(1)}%`
}

function ciLine(ci: { low: number; high: number } | null): string {
  return ci ? `95% CI ${(ci.low * 100).toFixed(1)}–${(ci.high * 100).toFixed(1)}` : ''
}

const ROLE_LABELS: Record<string, string> = { baseline: '基準組', experiment: '對照組', slow: '慢分支' }

function reportDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date) + '（UTC+8）'
}

function shortId(id: string): string {
  return id.replace(/^[a-zA-Z]+_/u, '').slice(0, 8)
}

export function renderReportHtml(data: ReportData): string {
  const roleLabel = (role: string) => ROLE_LABELS[role] ?? role
  const dimRows = data.branches[0]?.metrics.dimensionResults ?? []
  const conclusion = data.branches[0]?.conclusion ?? null
  const ai = data.aiEvaluation
  const trialById = new Map(data.branches.flatMap((branch) => branch.trials).map((trial) => [trial.trialId, trial]))
  const aiSection = ai ? `<section class="report-section" id="ai-evaluation">
    <div class="section-head"><span class="section-no">AI</span><h2>AI 回答評估與差距分析</h2><p>${escapeHtml(ai.label)}</p></div>
    <p class="scope-note">模型：${escapeHtml(ai.batch.providerName)} · ${escapeHtml(ai.batch.model)}；評估時間：${escapeHtml(reportDate(ai.batch.createdAt))}；評估批次：${escapeHtml(ai.batch.id)}；評分提示版本：${escapeHtml(ai.batch.promptVersion)}</p>
    ${ai.batch.sourceBatchId ? `<p class="scope-note">補評來源：${escapeHtml(ai.batch.sourceBatchId)}；沿用 ${ai.inherited} 條已完成結果，保留原完成批次的提示版本，可沿補評來源回溯；本批提示版本用於重新送評的項目。</p>` : ''}
    <p>${escapeHtml(ai.headline)}</p>
    <p class="table-note">已判定回答符合率 ${escapeHtml(ai.matchRateText)}，分母為 ${ai.judged} 條可判定回答；全批 ${ai.total} 次回答，無法判定、評估失敗及未送評均另列，不據此推算整批通過率。</p>
    ${ai.errorGroups.length ? `<h3>未完成原因</h3><ul>${ai.errorGroups.map((item) => `<li>${item.count} 條：${escapeHtml(item.reason)}</li>`).join('')}</ul>` : ''}
    <details class="ai-question-index"><summary>查看全部 ${ai.total} 題的評估摘要</summary><div class="table-scroll"><table><caption>AI 逐題評估結果</caption><thead><tr><th>用例</th><th>AI 判定</th><th>差距摘要／未完成原因</th></tr></thead><tbody>${ai.batch.evaluations.map((item, index) => `<tr><td><button type="button" class="question-jump" data-question-jump="${index}">${escapeHtml(item.caseName)}</button></td><td>${escapeHtml(item.status === 'completed' && item.result ? ANSWER_VERDICTS[item.result.verdict] : item.status === 'skipped' ? '未送評' : item.status === 'pending' || item.status === 'running' ? '待完成' : '評估未完成')}</td><td>${escapeHtml(item.result?.summary ?? item.error ?? '尚無結果')}</td></tr>`).join('')}</tbody></table></div></details>
    <h3>回答差距、原文證據與改善建議</h3>
    <div class="question-viewer" data-question-viewer>
    <div class="question-controls" hidden>
      <label><span>題目</span><select data-question-select>${ai.batch.evaluations.map((item, index) => `<option value="${index}">${index + 1}. ${escapeHtml(item.caseName)} · ${escapeHtml(item.status === 'completed' && item.result ? ANSWER_VERDICTS[item.result.verdict] : item.status === 'skipped' ? '未送評' : '評估未完成')}</option>`).join('')}</select></label>
      <div class="question-navigation"><button type="button" data-question-prev aria-label="上一題" title="上一題"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg></button><span data-question-position role="status" aria-live="polite"></span><button type="button" data-question-next aria-label="下一題" title="下一題"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 6 6 6-6 6"/></svg></button></div>
    </div>
    ${ai.batch.evaluations.map((item, index) => {
      const trial = trialById.get(item.trialId)
      const result = item.result
      return `<article class="ev question-page" data-question-index="${index}"><div class="ev-head"><strong>${escapeHtml(item.caseName)}</strong><span class="tag">${escapeHtml(result ? ANSWER_VERDICTS[result.verdict] : item.status === 'skipped' ? '未送評' : item.status === 'pending' || item.status === 'running' ? '待完成' : '評估未完成')}${item.inherited ? ' · 沿用來源結果' : ''}</span></div>
        <p>${escapeHtml(result?.summary ?? item.error ?? '尚無評估結果')}</p><p><strong>問題：</strong>${escapeHtml(trial?.input ?? '')}</p>
        <div class="ev-pair"><div><span class="muted">參考回答</span>${escapeHtml(trial?.expected ?? '')}</div><div><span class="muted">實際回答</span>${escapeHtml(trial?.finalOutput ?? '')}</div></div>
        ${(result?.differences ?? []).map((difference) => `<div class="limitations"><strong>${escapeHtml(DIFFERENCE_KINDS[difference.kind])}</strong><p>${escapeHtml(difference.explanation)}</p>${difference.referenceQuote ? `<p>參考原文：${escapeHtml(difference.referenceQuote)}</p>` : ''}${difference.actualQuote ? `<p>回答原文：${escapeHtml(difference.actualQuote)}</p>` : ''}</div>`).join('')}
        ${result?.suggestions.length ? `<p><strong>改善／確認建議</strong></p><ul>${result.suggestions.map((suggestion) => `<li>${escapeHtml(suggestion)}</li>`).join('')}</ul>` : ''}</article>`
    }).join('') || '<p>此批尚無回答評估紀錄。</p>'}
    <div class="question-controls question-footer" hidden><div class="question-navigation"><button type="button" data-question-prev aria-label="上一題" title="上一題"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg></button><span data-question-position role="status" aria-live="polite"></span><button type="button" data-question-next aria-label="下一題" title="下一題"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 6 6 6-6 6"/></svg></button></div></div>
    </div>
  </section>` : ''
  const reportId = `EV-${shortId(data.experiment.id).toUpperCase()}${data.run ? `-${shortId(data.run.id).toUpperCase()}` : ''}${ai ? `-AI${shortId(ai.batch.id).toUpperCase()}` : ''}`
  const mainBranch = data.branches[0]
  const allTrials = data.branches.flatMap((branch) => branch.trials)
  const callSucceeded = allTrials.filter((trial) => trial.status === 'succeeded').length
  const callFailed = allTrials.filter((trial) => trial.status === 'failed').length
  const callBlocked = allTrials.filter((trial) => trial.status === 'blocked').length
  const answerGaps = ai ? ai.partial + ai.doesNotMeet : 0
  const executiveTitle = ai
    ? ai.judged === 0 ? '尚無可判定的 AI 評估結果'
      : answerGaps > 0 ? `已判定 ${ai.judged} 條回答，${ai.meets} 條符合、${answerGaps} 條仍有差距`
      : `已判定的 ${ai.judged} 條回答均符合要求`
    : conclusion?.headline ?? '尚無可判定的評測結果'
  const executiveDetail = ai
    ? `${ai.partial} 條部分符合、${ai.doesNotMeet} 條不符合；${ai.uncertain} 條無法判定、${ai.failed + ai.interrupted + ai.pending} 條評估未完成、${ai.skipped} 條未送評。${ai.complete && ai.skipped === 0 ? '本評估批次的全部回答均已判定。' : '符合率僅反映已判定回答，不能視為整批通過率。'}`
    : '以下保留規則判定口徑；尚未完成的評分不視為通過。'
  const executiveMetrics = ai ? [
    { label: 'AI 已判定回答符合率', value: ai.matchRateText, sub: `${ai.meets} / ${ai.judged} 條已判定回答`, tone: answerGaps > 0 ? 'attention' : '' },
    { label: '需要改善的回答', value: String(answerGaps), sub: `部分符合 ${ai.partial} · 不符合 ${ai.doesNotMeet}`, tone: answerGaps > 0 ? 'attention' : '' },
    { label: '調用成功率', value: pctOne(allTrials.length ? callSucceeded / allTrials.length : null), sub: `${callSucceeded} / ${allTrials.length} 次執行；失敗 ${callFailed}、攔截 ${callBlocked}`, tone: callFailed + callBlocked > 0 ? 'attention' : '' },
  ].map((cell) => `<div class="kpi ${cell.tone}"><div class="kpi-label">${escapeHtml(cell.label)}</div><div class="kpi-value">${escapeHtml(cell.value)}</div><div class="kpi-sub">${escapeHtml(cell.sub)}</div></div>`).join('') : ''
  const aiDistribution = ai && ai.total > 0 ? `<div class="distribution executive-distribution">
    <div class="distribution-head"><strong>全批回答結果分布 · ${ai.total} 次</strong><span>未完成及未送評均保留在總數內</span></div>
    <div class="distribution-bar" role="img" aria-label="${escapeHtml(`${ai.meets} 條符合、${ai.partial} 條部分符合、${ai.doesNotMeet} 條不符合、${ai.uncertain} 條無法判定、${ai.total - ai.completed} 條未完成或未送評`)}">${[
      { count: ai.meets, cls: 'bar-pass' }, { count: ai.partial, cls: 'bar-partial' },
      { count: ai.doesNotMeet, cls: 'bar-fail' }, { count: ai.uncertain, cls: 'bar-uncertain' },
      { count: ai.total - ai.completed, cls: 'bar-unknown' },
    ].map((part) => `<span class="${part.cls}" style="width:${100 * part.count / ai.total}%"></span>`).join('')}</div>
    <div class="legend"><span class="legend-pass">符合 ${ai.meets}</span><span class="legend-partial">部分符合 ${ai.partial}</span><span class="legend-fail">不符合 ${ai.doesNotMeet}</span><span class="legend-uncertain">無法判定 ${ai.uncertain}</span><span class="legend-unknown">未完成／未送評 ${ai.total - ai.completed}</span></div>
  </div>` : ''
  const branchNames = data.branches.map((branch) => `${roleLabel(branch.role)}：${branch.agentName} v${branch.agentVersionNo}`).join('；')
  const judgementMethods = [...new Set(data.cases.map((item) => item.judgement).filter(Boolean))].join('；')
  const failedCases = conclusion ? conclusion.judgedCases - conclusion.passedCases : 0
  const resultDistribution = conclusion && conclusion.totalCases > 0
    ? `<div class="distribution">
        <div class="distribution-head"><span>用例判定分布</span><div class="legend"><span class="legend-pass">通過 ${conclusion.passedCases}</span><span class="legend-fail">未通過 ${failedCases}</span><span class="legend-unknown">尚無判定 ${conclusion.unknownCases}</span></div></div>
        <div class="distribution-bar" aria-label="${escapeHtml(`共 ${conclusion.totalCases} 條用例；通過 ${conclusion.passedCases} 條、未通過 ${failedCases} 條、尚無判定 ${conclusion.unknownCases} 條`)}">
          <span class="bar-pass" style="width:${100 * conclusion.passedCases / conclusion.totalCases}%"></span><span class="bar-fail" style="width:${100 * failedCases / conclusion.totalCases}%"></span><span class="bar-unknown" style="width:${100 * conclusion.unknownCases / conclusion.totalCases}%"></span>
        </div>
      </div>`
    : ''

  const numberCells = (ai ? [
    { label: 'AI 已判定回答符合率', value: ai.matchRateText, sub: `${ai.meets} / ${ai.judged} 條可判定回答；全批 ${ai.total} 次` },
    { label: '評估來源', value: ai.batch.model, sub: `${ai.batch.providerName} · ${reportDate(ai.batch.createdAt)}` },
  ] : [
    { label: '規則整體通過率', value: conclusion?.passRateText ?? '—', sub: conclusion ? `共 ${conclusion.totalCases} 條；已判定 ${conclusion.judgedCases} 條、未判定 ${conclusion.unknownCases} 條` : '還沒有可判斷的結果' },
    { label: '樣本量與可信度', value: `${data.summary.caseCount} 條用例 · ${data.summary.trialCount} 次`, sub: conclusion?.sampleText ?? '' },
    { label: '與上一版比', value: conclusion?.deltaText ?? '第一次執行', sub: data.previousRun ? `上一版跑於 ${reportDate(data.previousRun.startedAt)}` : '' },
  ])
    .map((cell) => `<div class="kpi"><div class="kpi-label">${escapeHtml(cell.label)}</div><div class="kpi-value">${escapeHtml(cell.value)}</div><div class="kpi-sub">${escapeHtml(cell.sub)}</div></div>`)
    .join('')

  const evidence = conclusion && conclusion.evidence.length > 0
    ? conclusion.evidence
        .map(
          (item) => `<article class="ev">
      <div class="ev-head"><strong>${escapeHtml(item.caseName)}</strong>${item.regressed ? '<span class="tag warn-tag">比上一版退步</span>' : ''}<span class="tag">${escapeHtml(item.owner === 'agent' ? '歸類：Agent 端' : '歸類：平台／設定')}</span></div>
      ${item.judgement ? `<div class="ev-judge">${escapeHtml(item.judgement)}</div>` : ''}
      <div class="ev-reason">${escapeHtml(item.reason ?? '沒有跑出結果')}${item.hint ? ` · ${escapeHtml(item.hint)}` : ''}</div>
      <div class="ev-pair">
        <div><span class="muted">期望表現</span>${escapeHtml(item.expected || '未提供期望內容')}</div>
        <div><span class="muted">實際結果</span>${escapeHtml(item.actual || '未取得回覆內容')}</div>
      </div>
    </article>`,
        )
        .join('')
    : '<p class="muted">本批次未列出失敗案例；完整判定狀態見摘要及附錄。</p>'

  const unknownLine = (() => {
    const main = data.branches[0]
    if (!main || main.metrics.naSummary.length === 0) return ''
    const total = main.metrics.naSummary.reduce((sum, item) => sum + item.dimensions.length, 0)
    const detail = main.metrics.naSummary.map((item) => `${naBusinessLabel(item.code)}（${item.dimensions.join('、')}）`).join('；')
    return `本批有 ${total} 項無法判斷：${detail}`
  })()

  const unknownHints = (() => {
    const main = data.branches[0]
    if (!main) return [] as string[]
    const seen = new Set<string>()
    const lines: string[] = []
    for (const item of main.metrics.naSummary) {
      const hint = naBusinessHint(item.code)
      if (!hint || seen.has(hint)) continue
      seen.add(hint)
      lines.push(hint)
    }
    return lines
  })()

  const hasDelta = data.branches.length >= 2
  const deltaCell = (base: number | null, exp: number | null): string => {
    if (base === null || exp === null) return '<td><span class="muted">—</span></td>'
    const diff = (exp - base) * 100
    if (Math.abs(diff) < 0.05) return '<td><span class="muted">持平</span></td>'
    const good = diff > 0
    return `<td><span class="${good ? 'delta-up' : 'delta-down'}">${good ? '改善 +' : '退步 '}${Math.abs(diff).toFixed(1)} 個百分點</span></td>`
  }

  const dimensionTable = `
  <table class="dimension-table">
    <thead><tr><th>能力項目</th>${data.branches.map((b) => `<th>${escapeHtml(roleLabel(b.role))}<br><span class="muted">${escapeHtml(b.agentName)}</span></th>`).join('')}${hasDelta ? '<th>改善／退步</th>' : ''}</tr></thead>
    <tbody>
      ${dimRows
        .map((dim) => {
          const cells = data.branches
            .map((b) => {
              const d = b.metrics.dimensionResults.find((x) => x.key === dim.key)
              if (!d) return '<td>—</td>'
              if (d.na) return `<td><span class="muted">無法判定</span><br><span class="muted">${escapeHtml(naBusinessLabel(d.naCode ?? ''))}</span></td>`
              return `<td><strong class="num">${pctOne(d.value)}</strong><br><span class="muted">${ciLine(d.ci)}</span></td>`
            })
            .join('')
          const first = data.branches[0]!.metrics.dimensionResults.find((x) => x.key === dim.key)
          const second = data.branches[1]?.metrics.dimensionResults.find((x) => x.key === dim.key)
          const delta = hasDelta
            ? first && second && !first.na && !second.na
              ? deltaCell(first.value, second.value)
              : '<td><span class="muted">—</span></td>'
            : ''
          return `<tr><td>${escapeHtml(dim.label)}</td>${cells}${delta}</tr>`
        })
        .join('')}
      <tr><td>單次成功率</td>${data.branches
        .map((b) => {
          const m = b.metrics
          return `<td><strong class="num">${pctOne(m.stability.singleSuccessRate)}</strong><br><span class="muted">${ciLine(m.stability.singleSuccessRateCi)}</span></td>`
        })
        .join('')}${hasDelta ? deltaCell(data.branches[0]!.metrics.stability.singleSuccessRate, data.branches[1]!.metrics.stability.singleSuccessRate) : ''}</tr>
      <tr><td>重複執行全部成功比例</td>${data.branches
        .map((b) =>
          data.experiment.repeats === 1
            ? '<td><span class="muted">每條僅執行 1 次，無法評估重複穩定度</span></td>'
            : `<td><strong class="num">${pct(b.metrics.stability.repeatAllSuccessRatio)}</strong><br><span class="muted">每條跑 ${data.experiment.repeats} 次</span></td>`,
        )
        .join('')}${hasDelta ? (data.experiment.repeats === 1 ? '<td><span class="muted">—</span></td>' : deltaCell(data.branches[0]!.metrics.stability.repeatAllSuccessRatio, data.branches[1]!.metrics.stability.repeatAllSuccessRatio)) : ''}</tr>
      <tr><td>回應時間</td>${data.branches
        .map((b) => `<td>平均 <span class="num">${b.metrics.efficiency.avgLatencyMs ?? '—'}</span> ms<br>P95 <span class="num">${b.metrics.efficiency.p95LatencyMs ?? '—'}</span> ms</td>`)
        .join('')}${hasDelta ? '<td><span class="muted">—</span></td>' : ''}</tr>
      <tr><td>用量<br><span class="muted">平均每次</span></td>${data.branches
        .map((b) => {
          const r = b.metrics.resources
          const v = (n: number | null) => (n === null ? '未提供' : String(n))
          return `<td><span class="muted">送進去 ${v(r.promptTokens)}<br>收回來 ${v(r.completionTokens)}<br>合計 ${v(r.totalTokens)}</span></td>`
        })
        .join('')}${hasDelta ? '<td><span class="muted">—</span></td>' : ''}</tr>
      <tr><td>平台攔截次數</td>${data.branches
        .map((b) => `<td>${b.metrics.blockedCount} 次</td>`)
        .join('')}${hasDelta ? '<td><span class="muted">—</span></td>' : ''}</tr>
    </tbody>
  </table>`

  const trialRows = data.branches
    .flatMap((b) => b.trials.map((t) => ({ branch: roleLabel(b.role), t })))
    .map(({ branch, t }) => {
      const failureTextValue = trialFailureText(t.score?.checks, t.errorClass, t.score?.passed ?? null)
      const result = t.score ? (t.score.passed === null ? '未判定' : t.score.passed ? '通過' : '未通過') : '未判定'
      const rationale = businessRationale(t.score?.rationale ?? '', t.score?.passed ?? null, t.errorClass)
      const resultTone = t.score?.passed === true ? 'passed' : t.score?.passed === false ? 'failed' : 'unknown'
      return `<tr><td class="nowrap">${escapeHtml(branch)}</td><td>${escapeHtml(t.caseName)}</td><td class="judge-cell">${escapeHtml(t.judgement || '—')}</td><td>#${t.repeatIndex}</td><td class="nowrap"><span class="result ${resultTone}">${result}</span></td><td class="nowrap"><span class="num">${t.latencyMs}</span> ms</td><td class="nowrap" title="${escapeHtml(t.errorClass ?? '')}">${escapeHtml(failureTextValue ?? '—')}</td><td class="muted">${escapeHtml(rationale)}</td></tr>`
    })
    .join('')

  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>評測報告 · ${escapeHtml(data.experiment.name)}</title>
<style>
${renderTokensCss()}
  /* A document-first layout shared by offline HTML and paginated A4 output. */
  :root { --doc-navy: #203b56; --doc-ink: #243342; --doc-muted: #5e6b78; --doc-rule: #cbd3dc; --doc-soft: #f2f5f8; }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; scroll-padding-top: 24px; }
  body { margin: 0; background: #e8ecf0; color: var(--doc-ink); font: 14px/1.8 "Segoe UI", "Microsoft JhengHei", "PingFang TC", "Microsoft YaHei", sans-serif; font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased; }
  a { color: inherit; text-decoration: none; }
  a:hover { text-decoration: underline; }
  a:focus-visible, .table-scroll:focus-visible { outline: 2px solid var(--doc-navy); outline-offset: 4px; }
  .report { max-width: 1080px; margin: 40px auto; padding: 40px 64px 32px; background: #fff; border-top: 6px solid var(--doc-navy); }
  .document-line { display: flex; justify-content: space-between; align-items: center; gap: 16px; color: var(--doc-muted); font-size: 11px; padding-bottom: 16px; border-bottom: 1px solid var(--doc-rule); }
  .wordmark { color: var(--doc-navy); font-size: 19px; font-weight: 700; letter-spacing: .02em; }
  .document-line .report-number { text-align: right; overflow-wrap: anywhere; }
  .report-header { padding: 32px 0 0; }
  h1 { margin: 0; color: var(--doc-navy); font-family: Georgia, "Microsoft JhengHei", "Microsoft YaHei", serif; font-size: 34px; font-weight: 700; line-height: 1.4; letter-spacing: .04em; }
  .report-subtitle { margin: 10px 0 24px; color: var(--doc-ink); font-size: 19px; font-weight: 500; line-height: 1.6; overflow-wrap: anywhere; }
  .document-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 32px; margin: 0; padding: 16px 0; border-top: 1px solid var(--doc-rule); border-bottom: 1px solid var(--doc-rule); font-size: 12px; }
  .document-meta > div { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 12px; }
  dt { color: var(--doc-muted); }
  dd { margin: 0; overflow-wrap: anywhere; }
  .contents { display: flex; flex-wrap: wrap; gap: 4px 22px; margin: 14px 0 0; color: var(--doc-muted); font-size: 11px; }
  .contents strong { color: var(--doc-navy); font-weight: 600; }
  h2 { margin: 0; color: var(--doc-navy); font-size: 20px; font-weight: 600; line-height: 1.5; }
  h3 { margin: 0 0 6px; color: var(--doc-navy); font-size: 13px; font-weight: 600; }
  p { margin: 0; }
  .muted { color: var(--doc-muted); }
  .report-section { margin-top: 32px; min-width: 0; }
  .section-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 16px; padding-bottom: 9px; border-bottom: 2px solid var(--doc-navy); }
  .section-no { color: var(--doc-navy); font-family: Georgia, serif; font-size: 20px; line-height: 1; }
  .section-head p { margin-left: auto; color: var(--doc-muted); font-size: 11px; text-align: right; }
  .conclusion { padding: 16px 20px; background: var(--doc-soft); border-left: 3px solid var(--doc-navy); }
  .headline { color: var(--doc-ink); font-size: 15px; line-height: 1.9; }
  .scope-note, .table-note { margin-top: 10px; color: var(--doc-muted); font-size: 11px; line-height: 1.8; }
  .numbers { display: grid; grid-template-columns: 1fr 1fr 1.15fr; margin-top: 20px; padding-bottom: 18px; border-bottom: 1px solid var(--doc-rule); }
  .kpi { min-width: 0; padding: 0 20px; }
  .kpi:first-child { padding-left: 0; }
  .kpi:last-child { padding-right: 0; }
  .kpi + .kpi { border-left: 1px solid var(--doc-rule); }
  .kpi-label { color: var(--doc-muted); font-size: 12px; }
  .kpi-value { margin-top: 8px; color: var(--doc-navy); font-size: 18px; font-weight: 600; line-height: 1.6; overflow-wrap: anywhere; }
  .kpi:first-child .kpi-value { font-size: 32px; line-height: 1.2; }
  .kpi:last-child .kpi-value { font-size: 14px; }
  .kpi-sub { margin-top: 6px; color: var(--doc-muted); font-size: 11px; line-height: 1.8; }
  .distribution { margin-top: 16px; }
  .distribution-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 16px; color: var(--doc-muted); font-size: 11px; }
  .legend { display: flex; flex-wrap: wrap; gap: 16px; }
  .legend span::before { display: inline-block; content: ''; width: 7px; height: 7px; margin-right: 6px; }
  .legend-pass::before, .bar-pass { background: #2e7561; }
  .legend-fail::before, .bar-fail { background: #a94c4c; }
  .legend-unknown::before, .bar-unknown { background: #c8d0d9; }
  .distribution-bar { display: flex; height: 9px; margin-top: 8px; background: var(--doc-soft); overflow: hidden; }
  .distribution-bar > span { height: 100%; }
  .warn { margin-top: 14px; padding: 10px 14px; border-left: 3px solid #9d7948; background: #faf7f0; color: #71532e; font-size: 12px; }
  .table-scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; line-height: 1.8; }
  caption { padding: 0 0 8px; text-align: left; color: var(--doc-muted); font-size: 11px; }
  th { color: var(--doc-navy); background: var(--doc-soft); font-size: 11px; font-weight: 600; text-align: left; }
  th, td { padding: 10px 12px; border-bottom: 1px solid var(--doc-rule); vertical-align: top; overflow-wrap: anywhere; }
  .scope-table th { width: 120px; }
  .scope-table { border-top: 1px solid var(--doc-rule); }
  .dimension-table { min-width: 520px; }
  .dimension-table th:not(:first-child), .dimension-table td:not(:first-child) { text-align: right; }
  .dimension-table td:first-child { font-weight: 500; }
  .dimension-table .num { font-size: 14px; font-weight: 600; }
  .ev { margin-top: 20px; padding-bottom: 20px; border-bottom: 1px solid var(--doc-rule); overflow-wrap: anywhere; }
  .ev-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px 12px; padding-left: 10px; border-left: 3px solid var(--doc-navy); }
  .ev-head strong { margin-right: auto; font-size: 14px; color: var(--doc-navy); }
  .tag { font-size: 11px; color: var(--doc-muted); }
  .warn-tag { color: #9a3f3f; }
  .ev-judge { margin-top: 8px; color: var(--doc-muted); font-size: 11px; }
  .ev-reason { margin-top: 6px; font-size: 12px; }
  .ev-pair { display: grid; grid-template-columns: 1fr 1fr; margin-top: 12px; border-top: 1px solid var(--doc-rule); border-bottom: 1px solid var(--doc-rule); font-size: 12px; }
  .ev-pair > div { padding: 12px; white-space: pre-wrap; }
  .ev-pair > div + div { border-left: 1px solid var(--doc-rule); }
  .ev-pair .muted { display: block; margin-bottom: 6px; color: var(--doc-navy); font-size: 11px; font-weight: 600; }
  .limitations { margin-top: 18px; }
  .na-list { color: var(--doc-muted); font-size: 12px; line-height: 1.9; }
  .trial-table { min-width: 900px; table-layout: fixed; }
  .trial-table th:nth-child(1) { width: 7%; }
  .trial-table th:nth-child(2) { width: 16%; }
  .trial-table th:nth-child(3) { width: 18%; }
  .trial-table th:nth-child(4) { width: 6%; }
  .trial-table th:nth-child(5) { width: 10%; }
  .trial-table th:nth-child(6) { width: 10%; }
  .trial-table th:nth-child(7) { width: 13%; }
  .trial-table th:nth-child(8) { width: 20%; }
  .trial-table td:nth-child(4), .trial-table td:nth-child(6), .trial-table th:nth-child(4), .trial-table th:nth-child(6) { text-align: right; }
  .trial-table td:nth-child(2) { font-weight: 500; }
  .num { font-family: inherit; font-variant-numeric: tabular-nums; }
  .result { font-size: 11px; font-weight: 600; }
  .passed, .delta-up { color: #2e7561; }
  .failed, .delta-down { color: #9a3f3f; }
  .unknown { color: var(--doc-muted); }
  .meta { display: grid; grid-template-columns: 132px minmax(0, 1fr); font-size: 12px; border-top: 1px solid var(--doc-rule); }
  .meta span { padding: 9px 12px; border-bottom: 1px solid var(--doc-rule); overflow-wrap: anywhere; }
  .meta span:nth-child(odd) { color: var(--doc-muted); background: var(--doc-soft); }
  .footer { display: flex; justify-content: space-between; gap: 24px; margin-top: 32px; padding-top: 12px; border-top: 2px solid var(--doc-navy); color: var(--doc-muted); font-size: 10px; }
  .footer p { max-width: 68em; }
  .footer strong { color: var(--doc-navy); white-space: nowrap; }
  .report { margin-top: 24px; padding-top: 24px; }
  .document-line { padding-bottom: 10px; }
  .report-header { padding-top: 18px; }
  .report-header h1 { font-size: 22px; letter-spacing: .01em; }
  .report-subtitle { margin: 6px 0 0; font-size: 16px; }
  #summary { margin-top: 22px; }
  #summary > .section-head { margin-bottom: 12px; }
  .executive-conclusion { padding: 18px 22px; }
  .executive-conclusion h3 { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 12px; }
  .summary-status { color: #805428; font-weight: 500; }
  .executive-conclusion .headline { font-size: 25px; font-weight: 600; line-height: 1.55; }
  .executive-detail { margin-top: 8px; font-size: 12px; color: var(--doc-muted); }
  .executive-metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); margin-top: 24px; padding-bottom: 20px; }
  .executive-metrics .kpi { padding: 0 16px; }
  .executive-metrics .kpi:first-child { padding-left: 0; }
  .executive-metrics .kpi:last-child { padding-right: 0; }
  .executive-metrics .kpi .kpi-value { font-family: "Segoe UI", sans-serif; font-size: 38px; font-weight: 600; line-height: 1.3; letter-spacing: -.03em; }
  .executive-metrics .attention .kpi-value { color: #9a3f3f; }
  .executive-metrics .kpi-sub { min-height: 3.6em; }
  .executive-distribution .distribution-bar { height: 14px; margin: 10px 0; }
  .executive-distribution .legend { gap: 8px 18px; font-size: 11px; color: var(--doc-muted); }
  .bar-partial, .legend-partial::before { background: #b18a47; }
  .bar-uncertain, .legend-uncertain::before { background: #71859a; }
  .priority-findings { margin-top: 20px; padding: 14px 0; border-top: 1px solid var(--doc-rule); border-bottom: 1px solid var(--doc-rule); font-size: 12px; }
  .priority-findings p + p { margin-top: 5px; }
  .priority-findings a { color: var(--doc-navy); text-decoration: underline; text-underline-offset: 3px; }
  .document-control { margin-top: 24px; }
  .ai-question-index { margin: 18px 0; }
  .ai-question-index > summary { cursor: pointer; color: var(--doc-navy); font-size: 13px; padding: 10px 0; }
  .question-controls { margin: 16px 0; padding: 8px 0; gap: 16px; align-items: center; }
  .question-controls:not([hidden]) { display: flex; }
  .question-navigation { display: flex; align-items: center; gap: 4px; flex-shrink: 0; padding: 4px; background: #f1f4f7; border-radius: 8px; order: 1; }
  .question-controls button { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; padding: 0; background: #fff; border: 1px solid #e2e7ec; color: var(--doc-navy); border-radius: 6px; cursor: pointer; transition: background-color .15s, border-color .15s; }
  .question-controls button:hover:not(:disabled) { background: #e5edf4; border-color: #a8b9ca; }
  .question-controls button:disabled { color: #b1bac4; background: transparent; border-color: transparent; cursor: default; }
  .question-controls button:focus-visible, .question-controls select:focus-visible, .question-jump:focus-visible { outline: 2px solid var(--doc-navy); outline-offset: 3px; }
  .question-controls [data-question-position] { min-width: 68px; color: var(--doc-ink); font-size: 12px; font-weight: 600; text-align: center; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .question-controls label { display: flex; align-items: center; flex: 1; min-width: 0; margin: 0; padding-left: 14px; gap: 12px; border: 1px solid #d9e1e8; border-radius: 8px; background: #fff; }
  .question-controls label > span { font-size: 12px; color: var(--doc-muted); flex-shrink: 0; }
  .question-controls select { flex: 1; min-width: 0; width: 100%; padding: 11px 12px 11px 0; border: 0; background: transparent; font: inherit; font-size: 13px; color: var(--doc-navy); text-overflow: ellipsis; cursor: pointer; border-radius: 8px; }
  .question-controls label:focus-within { border-color: var(--doc-navy); }
  .question-footer { justify-content: flex-end; padding-top: 12px; border-top: 1px solid var(--doc-rule); }
  @media screen and (max-width: 560px) {
    .question-controls { flex-wrap: wrap; gap: 8px; }
    .question-controls label { flex-basis: 100%; }
    .question-navigation { margin-left: auto; }
    .question-controls select { font-size: 12px; }
  }
  .question-jump { padding: 0; border: 0; background: none; color: var(--doc-navy); font: inherit; text-align: left; text-decoration: underline; cursor: pointer; }
  .question-viewer.is-interactive .question-page[hidden] { display: none; }
  .question-page > p { overflow-wrap: anywhere; }
  @page {
    size: A4; margin: 16mm 15mm 19mm;
    @bottom-left { content: "Daoeval · AI Agent 評測報告"; font: 8pt "Microsoft JhengHei", sans-serif; color: #5e6b78; border-top: .5pt solid #cbd3dc; padding-top: 3mm; }
    @bottom-right { content: "第 " counter(page) " 頁 / 共 " counter(pages) " 頁"; font: 8pt "Microsoft JhengHei", sans-serif; color: #5e6b78; border-top: .5pt solid #cbd3dc; padding-top: 3mm; }
  }
  @media print {
    .question-controls, .ai-question-index { display: none !important; }
    .question-viewer.is-interactive .question-page[hidden] { display: block !important; }
    html { scroll-behavior: auto; }
    body { background: #fff; color: #243342; font-size: 9pt; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
    .report { max-width: none; margin: 0; padding: 5mm 0 0; border-top-width: 4px; }
    .executive-conclusion { padding: 3mm 4mm; }
    .executive-conclusion .headline { font-size: 17pt; }
    .executive-detail { font-size: 8pt; }
    .executive-metrics { margin-top: 4mm; padding-bottom: 3mm; }
    .executive-metrics .kpi { padding: 0 3mm; }
    .numbers.executive-metrics .kpi .kpi-value { font-size: 25pt; }
    .executive-distribution, .priority-findings { break-inside: avoid; }
    .priority-findings { font-size: 8pt; margin-top: 4mm; padding: 3mm 0; }
    .document-control { margin-top: 4mm; }
    .contents { display: none; }
    .report-header { padding-top: 7mm; }
    h1 { font-size: 24pt; }
    .report-subtitle { font-size: 14pt; margin-bottom: 5mm; }
    .document-line { padding-bottom: 3mm; font-size: 8pt; }
    .document-meta { font-size: 8pt; padding: 3mm 0; }
    h2 { font-size: 14pt; break-after: avoid; }
    h3 { break-after: avoid; }
    .section-no { font-size: 14pt; }
    .report-section { margin-top: 7mm; }
    .section-head { margin-bottom: 4mm; break-after: avoid; }
    .section-head p { font-size: 8pt; }
    .conclusion { padding: 3mm 4mm; break-inside: avoid; }
    .headline { font-size: 10pt; }
    .numbers { margin-top: 4mm; padding-bottom: 4mm; break-inside: avoid; }
    .kpi { padding: 0 4mm; }
    .kpi-label, .kpi-sub { font-size: 8pt; }
    .kpi-value { font-size: 12pt; }
    .kpi:first-child .kpi-value { font-size: 24pt; }
    .kpi:last-child .kpi-value { font-size: 10pt; }
    .distribution { break-inside: avoid; }
    .table-scroll { overflow: visible; }
    .dimension-table, .trial-table { min-width: 0; }
    table { font-size: 8.5pt; }
    th { font-size: 8pt; }
    th, td { padding: 2.5mm 2mm; }
    thead { display: table-header-group; }
    tr { break-inside: avoid; }
    #findings, #ai-evaluation { break-before: page; }
    .ev { break-inside: avoid; padding-bottom: 2mm; margin-top: 3mm; }
    .ev-head { break-after: avoid; }
    .ev-head strong { font-size: 10pt; }
    .ev-pair { font-size: 8.5pt; margin-top: 2mm; }
    .ev-pair > div { padding: 2mm; }
    .ev-judge, .ev-reason { display: inline; line-height: 1.8; }
    .ev-reason::before { content: " · "; }
    .ev-pair .muted, .ev-judge, .ev-reason, .tag { font-size: 8pt; }
    .appendix-trials, #reproducibility { break-before: page; }
    .trial-table { font-size: 7.5pt; }
    .trial-table th, .result { font-size: 7.5pt; }
    .trial-table th, .trial-table td { padding: 2mm 1.5mm; line-height: 1.65; }
    .meta { font-size: 8pt; }
    .meta span { padding: 2mm 3mm; }
    .footer { font-size: 8pt; }
  }
  @media screen and (max-width: 760px) {
    .report { margin: 12px; padding: 24px; border-top-width: 4px; }
    .executive-conclusion { padding: 14px; }
    .executive-conclusion .headline { font-size: 20px; }
    .numbers.executive-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .executive-metrics .kpi, .executive-metrics .kpi:first-child, .executive-metrics .kpi:last-child { padding: 12px 8px; }
    .executive-metrics .kpi + .kpi { border-top: 0; border-left: 0; }
    .executive-metrics .kpi:nth-child(n+3) { grid-column: 1 / -1; border-top: 1px solid var(--doc-rule); }
    .executive-metrics .kpi:nth-child(even) { border-left: 1px solid var(--doc-rule); }
    .executive-metrics .kpi .kpi-value { font-size: 30px; }
    .document-line { align-items: flex-start; }
    .wordmark { font-size: 16px; }
    .report-number { font-size: 10px; }
    .report-header { padding-top: 24px; }
    h1 { font-size: 26px; }
    .report-subtitle { font-size: 17px; }
    .document-meta { grid-template-columns: 1fr; }
    .numbers { grid-template-columns: 1fr; padding: 0; }
    .kpi, .kpi:first-child, .kpi:last-child { padding: 14px 0; }
    .kpi + .kpi { border-left: 0; border-top: 1px solid var(--doc-rule); }
    .section-head { flex-wrap: wrap; }
    .section-head p { width: 100%; margin-left: 0; text-align: left; }
    .ev-pair { grid-template-columns: 1fr; }
    .ev-pair > div + div { border-left: 0; border-top: 1px solid var(--doc-rule); }
    .scope-table th { width: 88px; }
    .meta { grid-template-columns: 92px minmax(0, 1fr); }
    .meta span { padding: 8px; }
    .footer { display: block; }
    .footer strong { display: block; margin-top: 8px; }
  }
</style></head>
<body>
  <main class="report">
  <div class="document-line"><span class="wordmark">Daoeval</span><span class="report-number">評測與驗證文件<br>報告編號 ${escapeHtml(reportId)}</span></div>
  <header class="report-header">
    <h1>AI Agent 評測報告</h1>
    <p class="report-subtitle">${escapeHtml(data.experiment.name)}</p>
  </header>
  ${data.legacyIncomplete ? '<p class="warn">資料完整性提示：本批次建立於執行歸屬功能上線前，歷史統計可能不完整。</p>' : ''}

  <section class="report-section" id="summary" aria-label="評測結論">
    <div class="section-head"><span class="section-no" aria-hidden="true">01</span><h2>評測摘要</h2></div>
    <div class="conclusion executive-conclusion"><h3>${ai ? 'AI 回答評估結論' : '規則評分結論'}<span class="summary-status">${ai ? ai.judged === 0 ? '待判定' : answerGaps > 0 ? '存在回答差距' : '已判定回答均符合' : '規則判定'}</span></h3><p class="headline">${escapeHtml(executiveTitle)}</p><p class="executive-detail">${escapeHtml(executiveDetail)}</p></div>

    <div class="numbers${ai ? ' executive-metrics' : ''}">${ai ? executiveMetrics : numberCells}</div>
    ${aiDistribution}
    ${ai ? `<div class="priority-findings"><h3>重點關注</h3><p><strong>回答品質：</strong>${answerGaps > 0 ? `${ai.partial} 條部分符合、${ai.doesNotMeet} 條不符合。<a href="#ai-evaluation">查看逐題差距與改善建議 →</a>` : ai.judged > 0 ? '已判定回答未見實質差距；未判定項目仍需另行確認。' : '尚無可判定結果，應先完成評估。'}</p><p><strong>執行與覆蓋：</strong>調用失敗 ${callFailed} 次、攔截 ${callBlocked} 次；AI 評估另有 ${ai.skipped} 次未送評、${ai.failed + ai.interrupted + ai.pending} 次未完成。<a href="#trials">查看執行明細 →</a></p></div>` : ''}
    ${ai ? '<p class="scope-note">摘要口徑：所選 AI 評估批次的全部回答，含本執行批次的各分組。規則指標見「能力表現」。</p>' : mainBranch ? `<p class="scope-note">摘要口徑：${escapeHtml(roleLabel(mainBranch.role))} · ${escapeHtml(mainBranch.agentName)} v${mainBranch.agentVersionNo}。其他分組結果見「能力表現」。</p>` : ''}
    ${ai ? `<details><summary>規則評分摘要</summary><p>${escapeHtml(conclusion?.headline ?? '尚無規則判定')}</p>${resultDistribution}</details>` : resultDistribution}
    ${data.summary.sampleWarning ? `<p class="warn">樣本限制：${data.summary.caseCount} 條用例低於建議的 ${data.summary.minSamples} 條，結論應審慎解讀。</p>` : ''}
  </section>

  <div class="document-control">
    <dl class="document-meta">
      <div><dt>受測 Agent</dt><dd>${escapeHtml(mainBranch ? `${mainBranch.agentName} v${mainBranch.agentVersionNo}` : '未指定')}</dd></div>
      <div><dt>生成時間</dt><dd>${escapeHtml(reportDate(data.generatedAt))}</dd></div>
      <div><dt>評測規模</dt><dd>${data.summary.caseCount} 條用例 / ${data.summary.trialCount} 次執行</dd></div>
      <div><dt>執行批次</dt><dd>${escapeHtml(data.run ? shortId(data.run.id).toUpperCase() : '未指定')}</dd></div>
    </dl>
    <nav class="contents" aria-label="報告目錄"><strong>報告內容</strong><a href="#summary">01 評測摘要</a>${ai ? '<a href="#ai-evaluation">AI 回答評估</a>' : ''}<a href="#method">02 範圍與方法</a><a href="#capabilities">03 能力表現</a><a href="#findings">04 規則問題證據</a><a href="#trials">附錄 A 用例明細</a><a href="#reproducibility">附錄 B 版本資訊</a></nav>
  </div>

  ${renderModelComparison(data.modelComparison)}
  ${aiSection}
  <section class="report-section" id="method">
    <div class="section-head"><span class="section-no" aria-hidden="true">02</span><h2>評測範圍與方法</h2></div>
    <table class="scope-table"><caption>表 1　評測設定與判定口徑</caption><tbody>
      <tr><th scope="row">受測範圍</th><td>${escapeHtml(branchNames || '未指定受測 Agent')}</td></tr>
      <tr><th scope="row">樣本與執行</th><td>${data.summary.caseCount} 條用例，每條設定重複 ${data.reproducible.repeats} 次；本批次已記錄 ${data.summary.trialCount} 次執行。</td></tr>
      <tr><th scope="row">用例判定方式</th><td>${escapeHtml(judgementMethods || '未提供判定方式')}。${ai ? '本報告納入所選 AI 評估批次的判定、差距證據與建議；規則評分獨立保留。' : '本報告展示規則評分結果。'}未完成的 AI／人工評分不視為已通過。</td></tr>
      <tr><th scope="row">統計與解讀</th><td>「單次成功率」反映調用執行狀態；「規則整體通過率」反映用例判定，兩者口徑不同。尚無判定的用例以未判定呈現，不視為 0 分；判定不完整時，整體通過率暫不提供。區間標記為 95% 信賴區間。</td></tr>
    </tbody></table>
  </section>

  <section class="report-section" id="capabilities">
    <div class="section-head"><span class="section-no" aria-hidden="true">03</span><h2>各項能力表現</h2></div>
    <div class="table-scroll" role="region" aria-label="各項能力表現" tabindex="0">${dimensionTable.replace('<table class="dimension-table">', '<table class="dimension-table"><caption>表 2　能力、執行穩定度與資源表現</caption>')}</div>
    ${unknownLine ? `<div class="limitations"><h3>評測限制與資料缺口</h3><p class="na-list">${escapeHtml(unknownLine)}${unknownHints.length ? `<br>${unknownHints.map((hint) => escapeHtml(hint)).join('；')}` : ''}</p></div>` : ''}
    <p class="table-note">註：能力比例依各項可判定樣本計算；缺少判定依據或未覆蓋的項目保留為「無法判斷」。回應時間單位為毫秒（ms）；P95 為第 95 百分位數。</p>
  </section>

  <section class="report-section" id="findings">
    <div class="section-head"><span class="section-no" aria-hidden="true">04</span><h2>問題案例與證據</h2><p>失敗案例摘錄 ${conclusion?.evidence.length ?? 0} 條</p></div>
    <p class="table-note">以下列出摘要分組的代表性失敗案例，依期望表現、實際結果及判定依據對照。完整執行結果見附錄 A。</p>
    ${evidence}
  </section>

  <section class="report-section appendix-trials" id="trials">
    <div class="section-head"><span class="section-no" aria-hidden="true">A</span><h2>用例執行明細</h2><p>共 ${data.summary.trialCount} 次執行</p></div>
    <div class="table-scroll" role="region" aria-label="全部用例明細" tabindex="0"><table class="trial-table">
      <caption>表 A-1　全部用例明細（${data.summary.trialCount} 次）</caption>
      <thead><tr><th>分組</th><th>用例</th><th>判定方式</th><th>次數</th><th>結果</th><th>耗時</th><th>原因</th><th>判定依據</th></tr></thead>
      <tbody>${trialRows}</tbody>
    </table></div>
  </section>

  <section class="report-section" id="reproducibility">
    <div class="section-head"><span class="section-no" aria-hidden="true">B</span><h2>版本與可重現資訊</h2></div>
    <div class="meta">
      <span>實驗編號</span><span>${escapeHtml(data.experiment.id)}</span>
      <span>執行批次編號</span><span>${escapeHtml(data.run?.id ?? '未指定')}</span>
      <span>測試集版本</span><span>${escapeHtml(data.reproducible.datasetVersionId)}</span>
      <span>評分規則版本</span><span>${escapeHtml(data.reproducible.scoringProfileVersionId)}</span>
      <span>每條重複次數</span><span>${data.reproducible.repeats} 次</span>
      <span>被測 Agent 版本</span><span>${escapeHtml(data.branches.map((b) => `${b.agentName} v${b.agentVersionNo}（${b.agentVersionId}）`).join('；'))}</span>
      <span>設定凍結時間</span><span>${escapeHtml(reportDate(data.experiment.frozenAt))}</span>
    </div>
  </section>

  <footer class="footer"><p>本報告由 Daoeval 依指定批次資料自動生成，僅反映所列樣本與評測設定。相同版本及設定可用於重跑比較，AI 回覆與評分結果仍可能波動。報告中的未判定項目應補齊評分後再作完整解讀。</p><strong>Daoeval · 評測報告</strong></footer>
  </main>
<script>
(() => {
  const viewer = document.querySelector('[data-question-viewer]');
  if (!viewer) return;
  const pages = Array.from(viewer.querySelectorAll('[data-question-index]'));
  if (!pages.length) return;
  const controls = viewer.querySelector('.question-controls');
  const previous = Array.from(viewer.querySelectorAll('[data-question-prev]'));
  const next = Array.from(viewer.querySelectorAll('[data-question-next]'));
  const select = controls.querySelector('[data-question-select]');
  const positions = viewer.querySelectorAll('[data-question-position]');
  let current = 0;
  function show(index, scroll) {
    if (!Number.isInteger(index) || index < 0 || index >= pages.length) return;
    current = index;
    pages.forEach((page, i) => { page.hidden = i !== current; });
    select.value = String(current);
    positions.forEach((position) => { position.textContent = (current + 1) + ' / ' + pages.length; position.setAttribute('aria-label', '第 ' + (current + 1) + ' 題，共 ' + pages.length + ' 題'); });
    previous.forEach((button) => { button.disabled = current === 0; });
    next.forEach((button) => { button.disabled = current === pages.length - 1; });
    if (scroll) controls.scrollIntoView({ block: 'start' });
  }
  previous.forEach((button) => button.addEventListener('click', () => show(current - 1, true)));
  next.forEach((button) => button.addEventListener('click', () => show(current + 1, true)));
  select.addEventListener('change', () => show(Number(select.value), false));
  const index = document.querySelector('.ai-question-index');
  if (index) index.addEventListener('click', (event) => {
    const button = event.target.closest('[data-question-jump]');
    if (!button) return;
    show(Number(button.dataset.questionJump), true);
    index.open = false;
    select.focus({ preventScroll: true });
  });
  viewer.addEventListener('keydown', (event) => {
    if (!event.target.closest('.question-controls')) return;
    if (event.target === select || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowLeft' && current > 0) { event.preventDefault(); show(current - 1, true); }
    if (event.key === 'ArrowRight' && current < pages.length - 1) { event.preventDefault(); show(current + 1, true); }
  });
  viewer.classList.add('is-interactive');
  viewer.querySelectorAll('.question-controls').forEach((bar) => { bar.hidden = false; });
  show(0, false);
})();
</script>
</body></html>`
}

let edgePath: string | null | undefined

function findEdge(): string | null {
  if (edgePath !== undefined) return edgePath
  const candidates = [
    process.env.AEVAL_BROWSER_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ]
  edgePath = candidates.find((p): p is string => typeof p === 'string' && existsSync(p)) ?? null
  return edgePath
}

/** 用 Chromium/Edge/Chrome 的 headless print-to-pdf 生成 PDF；找不到瀏覽器時回傳 null */
export async function renderReportPdf(html: string): Promise<Buffer | null> {
  const browser = findEdge()
  if (!browser) return null
  const dir = mkdtempSync(join(tmpdir(), 'aeval-report-'))
  const htmlPath = join(dir, 'report.html')
  const pdfPath = join(dir, 'report.pdf')
  writeFileSync(htmlPath, html, 'utf8')
  try {
    await exec(
      browser,
      [
        '--headless=new',
        // Container isolation replaces Chromium's sandbox only when explicitly enabled.
        ...(process.env.AEVAL_BROWSER_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--no-pdf-header-footer',
        `--user-data-dir=${join(dir, 'profile')}`,
        `--print-to-pdf=${pdfPath}`,
        `file:///${htmlPath.replace(/\\/g, '/')}`,
      ],
      { timeout: 60000 },
    )
    if (!existsSync(pdfPath)) return null
    return readFileSync(pdfPath)
  } catch {
    return null
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 臨時檔清理失敗不影響匯出結果
    }
  }
}
