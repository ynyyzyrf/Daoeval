import { execFile } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { CaseInput, NormalizedTrial } from '../shared/types.ts'
import { businessRationale, judgementSentence, naBusinessHint, naBusinessLabel, trialFailureText } from '../shared/vocabulary.ts'
import { renderTokensCss } from '../shared/skin.ts'
import { splitTitle } from '../shared/text.ts'
import { computeMetrics, type MetricsResult } from './scoring.ts'
import { buildConclusion, caseVerdict, type Conclusion } from './conclusion.ts'
import { getExperiment, getRunSummary, pickMetricsRun } from './store.ts'

const exec = promisify(execFile)

export interface ReportTrial {
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

export function buildReport(experimentId: string, runId?: string): ReportData | null {
  const experiment = getExperiment(experimentId)
  if (!experiment) return null
  const selectedRunId = runId ?? pickMetricsRun(experimentId)?.id
  const run = selectedRunId && experiment.runs.some((item) => item.id === selectedRunId) ? getRunSummary(selectedRunId) : null
  const selectedExperiment = run ? getExperiment(experimentId, run.id)! : { ...experiment, trials: [] }
  const cases = selectedExperiment.frozen.dataset.cases as CaseInput[]
  const repeats = selectedExperiment.frozen.repeats
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

function shortId(id: string): string {
  return id.replace(/^[a-zA-Z]+_/u, '').slice(0, 8)
}

export function renderReportHtml(data: ReportData): string {
  const roleLabel = (role: string) => ROLE_LABELS[role] ?? role
  const dimRows = data.branches[0]?.metrics.dimensionResults ?? []
  const conclusion = data.branches[0]?.conclusion ?? null

  const numberCells = [
    { label: '通過率', value: conclusion?.passRateText ?? '—', sub: conclusion ? `${conclusion.passedCases} / ${conclusion.judgedCases} 條用例` : '還沒有可判斷的結果' },
    { label: '樣本量與可信度', value: `${data.summary.caseCount} 條用例 · ${data.summary.trialCount} 次`, sub: conclusion?.sampleText ?? '' },
    { label: '與上一版比', value: conclusion?.deltaText ?? '第一次執行', sub: data.previousRun ? `上一版跑於 ${data.previousRun.startedAt}` : '' },
  ]
    .map((cell) => `<div class="kpi"><div class="kpi-label">${escapeHtml(cell.label)}</div><div class="kpi-value">${escapeHtml(cell.value)}</div><div class="kpi-sub">${escapeHtml(cell.sub)}</div></div>`)
    .join('')

  const evidence = conclusion && conclusion.evidence.length > 0
    ? conclusion.evidence
        .map(
          (item) => `<div class="ev">
      <div class="ev-head"><strong>${escapeHtml(item.caseName)}</strong>${item.regressed ? '<span class="tag warn-tag">比上一版退步</span>' : ''}<span class="tag owner-${item.owner ?? 'platform'}">${escapeHtml(item.owner === 'agent' ? 'Agent 的問題' : '平台／設定的問題')}</span></div>
      ${item.judgement ? `<div class="ev-judge">${escapeHtml(item.judgement)}</div>` : ''}
      <div class="ev-reason">${escapeHtml(item.reason ?? '沒有跑出結果')}${item.hint ? ` · ${escapeHtml(item.hint)}` : ''}</div>
      <div class="ev-pair">
        <div><span class="muted">期望</span>${escapeHtml(item.expected || '（沒填期望答案）')}</div>
        <div><span class="muted">實際</span>${escapeHtml(item.actual || '（沒有回覆內容）')}</div>
      </div>
    </div>`,
        )
        .join('')
    : '<div class="muted">這批沒有失敗的用例。</div>'

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
  <table>
    <thead><tr><th>能力項目</th>${data.branches.map((b) => `<th>${escapeHtml(roleLabel(b.role))}<br><span class="muted">${escapeHtml(b.agentName)}</span></th>`).join('')}${hasDelta ? '<th>改善／退步</th>' : ''}</tr></thead>
    <tbody>
      ${dimRows
        .map((dim) => {
          const cells = data.branches
            .map((b) => {
              const d = b.metrics.dimensionResults.find((x) => x.key === dim.key)
              if (!d) return '<td>—</td>'
              if (d.na) return `<td><span class="muted">這項無法判斷</span><br><span class="muted">${escapeHtml(naBusinessLabel(d.naCode ?? ''))}</span></td>`
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
      <tr><td>每次都成功的比例</td>${data.branches
        .map((b) =>
          data.experiment.repeats === 1
            ? '<td><span class="muted">只跑 1 次，看不出穩定度</span></td>'
            : `<td><strong class="num">${pct(b.metrics.stability.repeatAllSuccessRatio)}</strong><br><span class="muted">每條跑 ${data.experiment.repeats} 次</span></td>`,
        )
        .join('')}${hasDelta ? (data.experiment.repeats === 1 ? '<td><span class="muted">—</span></td>' : deltaCell(data.branches[0]!.metrics.stability.repeatAllSuccessRatio, data.branches[1]!.metrics.stability.repeatAllSuccessRatio)) : ''}</tr>
      <tr><td>回應速度</td>${data.branches
        .map((b) => `<td>平均 <span class="num">${b.metrics.efficiency.avgLatencyMs ?? '—'}</span> ms<br>最慢 5% 為 <span class="num">${b.metrics.efficiency.p95LatencyMs ?? '—'}</span> ms</td>`)
        .join('')}${hasDelta ? '<td><span class="muted">—</span></td>' : ''}</tr>
      <tr><td>用量<br><span class="muted">平均每次</span></td>${data.branches
        .map((b) => {
          const r = b.metrics.resources
          const v = (n: number | null) => (n === null ? '未提供' : String(n))
          return `<td><span class="muted">送進去 ${v(r.promptTokens)}<br>收回來 ${v(r.completionTokens)}<br>合計 ${v(r.totalTokens)}</span></td>`
        })
        .join('')}${hasDelta ? '<td><span class="muted">—</span></td>' : ''}</tr>
      <tr><td>被平台攔下的次數</td>${data.branches
        .map((b) => `<td>${b.metrics.blockedCount} 次</td>`)
        .join('')}${hasDelta ? '<td><span class="muted">—</span></td>' : ''}</tr>
    </tbody>
  </table>`

  const trialRows = data.branches
    .flatMap((b) => b.trials.map((t) => ({ branch: roleLabel(b.role), t })))
    .map(({ branch, t }) => {
      const failureTextValue = trialFailureText(t.score?.checks, t.errorClass, t.score?.passed ?? null)
      const result = t.score ? (t.score.passed === null ? '這項無法判斷' : t.score.passed ? '通過' : '沒通過') : '這項無法判斷'
      const rationale = businessRationale(t.score?.rationale ?? '', t.score?.passed ?? null, t.errorClass)
      return `<tr><td class="nowrap">${escapeHtml(branch)}</td><td>${escapeHtml(t.caseName)}</td><td class="judge-cell">${escapeHtml(t.judgement || '—')}</td><td>#${t.repeatIndex}</td><td class="nowrap">${result}</td><td class="nowrap"><span class="num">${t.latencyMs}</span> ms</td><td class="nowrap" title="${escapeHtml(t.errorClass ?? '')}">${escapeHtml(failureTextValue ?? '—')}</td><td class="muted">${escapeHtml(rationale)}</td></tr>`
    })
    .join('')

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>評測報告 · ${escapeHtml(data.experiment.name)}</title>
<style>
${renderTokensCss()}
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 36px; background: #ffffff; color: var(--ink-2); font-family: var(--f-ui); font-size: var(--fs-body); line-height: var(--lh-body); font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased; }
  h1 { font-size: var(--fs-page); line-height: var(--lh-page); font-weight: 600; margin: 0; color: var(--ink); }
  h2 { font-size: var(--fs-title); font-weight: 600; color: var(--ink); margin: 24px 0 8px; }
  .crumb { font-size: var(--fs-xs); color: var(--dim); margin-bottom: 6px; }
  .sub { font-size: var(--fs-xs); color: var(--dim); margin-top: 2px; }
  .muted { color: var(--dim); }
  .headline { font-size: var(--fs-page); line-height: 1.35; font-weight: 600; color: var(--ink); margin: 18px 0 16px; max-width: 46em; }
  .numbers { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border: 1px solid var(--line-2); border-radius: var(--r-card); overflow: hidden; }
  .kpi { padding: 14px 16px; }
  .kpi + .kpi { border-left: 1px solid var(--line-2); }
  .kpi-label { font-size: var(--fs-xs); color: var(--dim); font-weight: 500; }
  .kpi-value { font-size: 22px; font-weight: 400; color: var(--ink); margin-top: 4px; }
  .kpi-sub { font-size: var(--fs-xs); color: var(--dim); margin-top: 4px; }
  .ev { border: 1px solid var(--line-2); border-radius: var(--r-card); padding: 12px 14px; margin-bottom: 10px; }
  .ev-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .ev-head strong { color: var(--ink); font-weight: 600; }
  .tag { font-size: var(--fs-xs); padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line-2); }
  .owner-agent { color: #8a2020; background: #fdf2f2; border-color: #f3d0d0; }
  .owner-platform { color: #6b5300; background: #fff8e6; border-color: #f2d69a; }
  .warn-tag { color: #8a2020; }
  .ev-judge { font-size: var(--fs-xs); color: var(--dim); margin-top: 6px; }
  .ev-reason { margin-top: 6px; color: var(--ink-2); }
  .ev-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 8px; font-size: var(--fs-xs); }
  .ev-pair > div { background: #f7f8f9; border-radius: 6px; padding: 8px 10px; }
  .ev-pair .muted { display: block; margin-bottom: 3px; }
  .meta { display: grid; grid-template-columns: 130px 1fr; gap: 4px 12px; font-size: var(--fs-xs); background: #f7f8f9; border-radius: var(--r-card); padding: 12px; margin-top: 10px; }
  .meta span:nth-child(odd) { color: var(--dim); }
  .warn { background: rgba(242,201,76,.16); color: var(--ink-2); padding: 8px 10px; border-radius: var(--r-pill); margin-top: 10px; font-size: var(--fs-xs); }
  .na-list { background: #f7f8f9; border-radius: var(--r-card); padding: 10px 12px; font-size: var(--fs-xs); color: var(--muted); margin-top: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: var(--fs-body); }
  th { text-align: left; font-size: var(--fs-xs); font-weight: 400; color: var(--dim); padding: 6px 12px; border-bottom: 1px solid var(--line-2); }
  td { padding: 8px 12px; border-bottom: 1px solid var(--line-2); color: var(--ink-2); vertical-align: top; }
  td.nowrap { white-space: nowrap; }
  td.judge-cell { min-width: 260px; }
  .num { font-family: var(--f-mono); font-variant-numeric: tabular-nums; }
  .delta-up { color: var(--green); }
  .delta-down { color: var(--red); }
  .footer { margin-top: 16px; color: var(--dim); font-size: var(--fs-xs); }
  @media print { body { padding: 10mm; } }
  @media (max-width: 640px) { .numbers { grid-template-columns: 1fr; } .kpi + .kpi { border-left: 0; border-top: 1px solid var(--line-2); } .ev-pair { grid-template-columns: 1fr; } }
</style></head>
<body>
  <div class="crumb">${escapeHtml(data.experiment.name)} · ${escapeHtml(data.branches[0] ? roleLabel(data.branches[0].role) : '報告')}</div>
  <h1>${escapeHtml(splitTitle(data.experiment.name).lead)} <b>${escapeHtml(splitTitle(data.experiment.name).strong ?? '')}</b></h1>
  <div class="sub">產出時間 ${escapeHtml(data.generatedAt)}${data.branches[0] ? ` · 被測 Agent ${escapeHtml(data.branches[0].agentName)} v${data.branches[0].agentVersionNo}` : ''}</div>
  ${data.legacyIncomplete ? '<div class="warn">歷史批次：這批試驗建立於執行歸屬功能上線前，數字可能不完整</div>' : ''}

  <div class="headline">${escapeHtml(conclusion?.headline ?? '這批還沒有可判斷的結果')}</div>
  <div class="numbers">${numberCells}</div>
  ${data.summary.sampleWarning ? `<div class="warn">樣本偏少：${data.summary.caseCount} 條用例低於建議的 ${data.summary.minSamples} 條，結論要保守看。</div>` : ''}

  <h2>這些用例沒通過</h2>
  ${evidence}

  ${unknownLine ? `<h2>這批哪些項目測不了</h2><div class="na-list">${escapeHtml(unknownLine)}${unknownHints.length ? `<br>${unknownHints.map((hint) => escapeHtml(hint)).join('；')}` : ''}</div>` : ''}

  <h2>各項能力表現</h2>
  ${dimensionTable}

  <h2>全部用例明細（${data.summary.trialCount} 次）</h2>
  <table>
    <thead><tr><th>分組</th><th>用例</th><th>判定</th><th>第幾次</th><th>結果</th><th>耗時</th><th>原因</th><th>依據</th></tr></thead>
    <tbody>${trialRows}</tbody>
  </table>

  <h2>可重現資訊</h2>
  <div class="meta">
    <span>測試集版本</span><span>v${escapeHtml(shortId(data.reproducible.datasetVersionId))}</span>
    <span>評分規則版本</span><span>v${escapeHtml(shortId(data.reproducible.scoringProfileVersionId))}</span>
    <span>每條重複次數</span><span>${data.reproducible.repeats} 次</span>
    <span>被測 Agent 版本</span><span>${escapeHtml(data.branches.map((b) => `${b.agentName} v${b.agentVersionNo}`).join(' / '))}</span>
    <span>凍結時間</span><span>${escapeHtml(data.experiment.frozenAt)}</span>
  </div>

  <div class="footer">本報告由 Daoeval 生成。同樣的測試集版本、評分規則版本、Agent 版本與重複次數，重新跑一次會得到同一結果。「這項無法判斷」不計入通過率，也不當成 0 分。</div>
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
