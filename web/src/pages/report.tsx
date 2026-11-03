import { useEffect, useMemo, useState } from 'react'
import { businessRationale, failureText, judgementSentence, trialFailureText, unknownReasonFor } from '../../../src/shared/vocabulary.ts'
import { ANSWER_VERDICTS } from '../../../src/shared/ai-evaluation.ts'
import { summarizeAiReport } from '../../../src/shared/ai-report.ts'
import { api, type Conclusion, type ExperimentDetail, type ExperimentSummary, type MetricsResponse } from '../api.ts'
import { DataTable, type Column } from '../components/DataTable.tsx'
import { Badge, Button, Drawer, EmptyState, ErrorState, Kbd, Notice, PageTitle, SkeletonBlock } from '../components/ui.tsx'
import { ModelComparisonView } from '../components/ModelComparison.tsx'
import { MetricCompare } from '../components/MetricCompare.tsx'
import { ReportOverview, type ReportPanel } from '../components/ReportOverview.tsx'
import { AnswerEvaluationDetail, AnswerEvaluationPanel, useAnswerEvaluations } from '../components/AnswerEvaluation.tsx'
import { formatAgentTime, formatDateTime } from '../lib/format.ts'
import { roleLabel } from '../lib/labels.ts'
import { navigate } from '../lib/router.ts'

type RowStatus = 'passed' | 'failed' | 'n/a' | 'blocked'

interface TrialRow {
  id: string
  caseName: string
  branchRole: string
  agentName: string
  repeatIndex: number
  status: RowStatus
  scoreText: string
  latencyMs: number
  executionStatus: string
  category: string
  categoryCode: string | null
  startedAt: string
  judgement: string
}

function trialStatus(trial: ExperimentDetail['trials'][number]): RowStatus {
  if (trial.normalized.status === 'blocked') return 'blocked'
  if (trial.normalized.status === 'failed') return 'failed'
  if (trial.score?.passed === true) return 'passed'
  if (trial.score?.passed === false) return 'failed'
  return 'n/a'
}

const STATUS_TEXT: Record<RowStatus, { text: string; tone: 'ok' | 'err' | 'warn' | 'muted' }> = {
  passed: { text: '通過', tone: 'ok' },
  failed: { text: '沒通過', tone: 'err' },
  blocked: { text: '被平台攔下', tone: 'warn' },
  'n/a': { text: '無法判斷', tone: 'muted' },
}

/* ================= 報告列表 ================= */

export function ReportListPage() {
  const [experiments, setExperiments] = useState<ExperimentSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    setError(null)
    api
      .experiments()
      .then(setExperiments)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  const columns: Array<Column<ExperimentSummary>> = [
    { key: 'name', title: '實驗', sortValue: (row) => row.name, render: (row) => <span>{row.name}</span> },
    { key: 'kind', title: '類型', render: (row) => <span className="mono">{row.kind}</span> },
    { key: 'trials', title: '樣本量', align: 'right', sortValue: (row) => row.trialCount, render: (row) => <span className="mono">{row.trialCount}</span> },
    {
      key: 'created',
      title: '建立時間',
      sortValue: (row) => row.createdAt,
      render: (row) => <span className="mono dim">{formatDateTime(row.createdAt)}</span>,
    },
    {
      key: 'action',
      title: '',
      align: 'right',
      render: (row) => (
        <Button size="sm" onClick={() => navigate(`/report/${row.id}`)}>
          生成報告
        </Button>
      ),
    },
  ]

  return (
    <div className="stack">
      <div className="page-head">
        <PageTitle lead="報告" sub="選擇實驗進入明細，點行右側同步更新" />
      </div>
      <div className="card" style={{ padding: 0 }}>
        <DataTable
          rows={experiments}
          columns={columns}
          rowKey={(row) => row.id}
          searchText={(row) => row.name}
          searchPlaceholder="搜尋實驗名稱"
          loading={loading}
          error={error}
          onRetry={load}
          onRowClick={(row) => navigate(`/report/${row.id}`)}
          emptyTitle="還沒有可生成報告的實驗"
          emptyDescription="先建立實驗並跑一批試驗。"
          emptyAction={<Button variant="primary" onClick={() => navigate('/experiments')}>前往實驗</Button>}
        />
      </div>
    </div>
  )
}

/* ================= 報告明細（列表＋明細） ================= */

export function ReportDetailPage({ id, trialId }: { id: string; trialId?: string }) {
  const [detail, setDetail] = useState<ExperimentDetail | null>(null)
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null)
  const [viewRunId, setViewRunId] = useState<string | null>(null)
  const aiEvaluation = useAnswerEvaluations(id, viewRunId)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(trialId ?? null)
  const [filter, setFilter] = useState<'all' | RowStatus>('all')
  const [reportView, setReportView] = useState<'comparison'|'details'>('comparison')
  const [showFilters, setShowFilters] = useState(false)
  const [panel, setPanel] = useState<ReportPanel | 'trial' | null>(null)
  useEffect(() => {
    if (panel) document.querySelector<HTMLElement>('.report-page [role="dialog"]')?.focus()
  }, [panel])
  useEffect(() => {
    if (panel === 'trial') document.querySelector('.report-trial-drawer .drawer-body')?.scrollTo({ top: 0 })
  }, [panel, selectedId])

  const load = async (requestedRunId: string | null = viewRunId) => {
    setError(null)
    try {
      const initialDetail = await api.experiment(id)
      const selectedRunId = requestedRunId ?? initialDetail.selectedRunId ?? initialDetail.runs[0]?.id ?? null
      const [detailData, metricsData] = await Promise.all([
        selectedRunId ? api.experiment(id, selectedRunId) : Promise.resolve(initialDetail),
        api.metrics(id, selectedRunId ?? undefined),
      ])
      setDetail(detailData)
      setMetrics(metricsData)
      setViewRunId(selectedRunId)
      setSelectedId(trialId ?? null)
      setPanel(trialId && detailData.trials.some((item) => item.id === trialId) ? 'trial' : null)
    } catch (e) {
      setError((e as Error).message)
      setMetrics(null)
    }
  }

  useEffect(() => {
    void load(null)
  }, [id, trialId])

  useEffect(() => {
    const onToggle = () => setShowFilters((open) => !open)
    window.addEventListener('aeval:filter-toggle', onToggle)
    return () => window.removeEventListener('aeval:filter-toggle', onToggle)
  }, [])

  const rows: TrialRow[] = useMemo(() => {
    if (!detail) return []
    return detail.trials
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((trial) => {
      const branch = detail.branches.find((b) => b.id === trial.branchId)
      const frozenBranch = detail.frozen.branches.find((b) => b.agentVersionId === branch?.agent_version_id)
      const status = trialStatus(trial)
      const code = trial.normalized.error?.class ?? null
      const caseInput = detail.frozen.dataset.cases.find((item) => item.id === trial.caseId)
      // 原因按判定類型取詞，不要一律寫成「回答沒提到關鍵資訊」
      const category =
        status === 'blocked'
          ? '權限被拒，沒有送出'
          : status === 'n/a'
            ? unknownReasonFor(caseInput?.judgement).text
            : trialFailureText(trial.score?.checks, code, trial.score?.passed ?? null) ?? '—'
      return {
        id: trial.id,
        caseName: trial.caseName,
        branchRole: branch ? roleLabel(branch.role) : '—',
        agentName: frozenBranch?.config.name ?? '—',
        repeatIndex: trial.repeatIndex,
        status,
        scoreText: status === 'blocked' || status === 'n/a' ? '—' : trial.score?.passed === true ? '1.00' : '0.00',
        latencyMs: trial.latencyMs,
        executionStatus: trial.normalized.status,
        category,
        categoryCode: code,
        startedAt: trial.createdAt,
        judgement: judgementSentence(caseInput?.judgement),
      }
    })
  }, [detail])

  if (error) {
    return (
      <div className="content-inner">
        <ErrorState message={error} onRetry={load} />
      </div>
    )
  }

  if (!detail) {
    return (
      <div className="content-inner stack-3">
        <SkeletonBlock height={24} width="30%" />
        <SkeletonBlock height={300} />
      </div>
    )
  }

  const counts = {
    failed: rows.filter((r) => r.status === 'failed').length,
    blocked: rows.filter((r) => r.status === 'blocked').length,
    na: rows.filter((r) => r.status === 'n/a').length,
    passed: rows.filter((r) => r.status === 'passed').length,
  }
  const visible = filter === 'all' ? rows : rows.filter((row) => row.status === filter)
  const preferTrace = (row: TrialRow): boolean => {
    const t = detail.trials.find((x) => x.id === row.id)
    return Boolean(t && t.normalized.trace.status !== 'unavailable')
  }
  const selected =
    visible.find((row) => row.id === selectedId) ??
    visible.find(preferTrace) ??
    visible[0] ??
    rows[0] ??
    null
  const trial = detail.trials.find((t) => t.id === selected?.id)
  const selectedIndex = visible.findIndex((row) => row.id === selected?.id)
  const failure = (() => {
    if (!trial) return null
    if (selected?.status === 'n/a') {
      const caseInput = detail.frozen.dataset.cases.find((item) => item.id === trial.caseId)
      const unknown = unknownReasonFor(caseInput?.judgement)
      return { text: unknown.text, owner: unknown.owner, hint: '這是平台的能力缺口，不是 Agent 的問題' }
    }
    const code = trial.normalized.error?.class ?? null
    const text = trialFailureText(trial.score?.checks, code, trial.score?.passed ?? null)
    if (!text) return null
    const mapped = failureText(code, trial.score?.passed ?? null)
    return { text, owner: mapped?.owner ?? 'agent', hint: mapped?.hint ?? '' }
  })()
  const caseCount = detail.frozen.dataset.cases.length
  const branchCount = detail.branches.length
  const conclusion: Conclusion | null = metrics?.branches[0]?.conclusion ?? null
  const aiReport = aiEvaluation.batch?.runId === viewRunId ? summarizeAiReport(aiEvaluation.batch) : null

  const traceSteps: Array<{ time: string; text: string; key?: boolean }> = (() => {
    const value = trial?.normalized.trace.value as { steps?: Array<{ step?: number; action?: string; ms?: number }> } | null
    if (!value) return []
    if (Array.isArray(value.steps)) {
      return value.steps.map((step, index) => ({
        time: typeof step.ms === 'number' ? String(step.ms) : '—',
        text: `${step.action ?? 'step'}`,
        key: index === value.steps!.length - 1,
      }))
    }
    return [{ time: '—', text: '有執行紀錄，但沒有步驟明細', key: true }]
  })()

  const exportParams = new URLSearchParams()
  if (viewRunId) exportParams.set('runId', viewRunId)
  if (aiReport) exportParams.set('aiBatchId', aiReport.batch.id)
  const exportQuery = exportParams.size ? `?${exportParams}` : ''
  const trialDetails = (
    <div className="trial-detail-content">
          {!selected || !trial ? (
            <EmptyState title="選一條試驗" description="點左側任一行。" />
          ) : (
            <>
              <div>
                <div className="detail-section-label">案例</div>
                <div className="trial-case-title">{selected.caseName}</div>
                <div className="trial-case-meta">
                  {selected.branchRole} · {selected.agentName} · 重複 {selected.repeatIndex}/{detail.frozen.repeats}
                </div>
              </div>

              <div title="不含 AI 評審時間。Oumi 優先使用遠端回傳的起止時間，缺少時採本地量測；失敗時顯示等待耗時。">
                <div className="detail-section-label">{trial.normalized.status === 'succeeded' ? '回答耗時' : '等待耗時'}</div>
                <div>{formatAgentTime(selected.latencyMs, trial.normalized.status)}</div>
              </div>
              <div>
                <div className="detail-section-label">輸入</div>
                <div className="detail-box">{trial.normalized.input || '（空）'}</div>
              </div>

              <div>
                <div className="detail-section-label">輸出</div>
                <div className="detail-box">{trial.normalized.finalOutput ?? '（無輸出）'}</div>
              </div>

              <AnswerEvaluationDetail batch={aiEvaluation.batch} trialId={trial.id} reference={detail.frozen.dataset.cases.find((item) => item.id === trial.caseId)?.expected ?? ''} />

              <div>
                <div className="detail-section-label">判定</div>
                {selected.judgement ? <div className="detail-box">{selected.judgement}</div> : <div className="detail-box dim">這條用例沒有設定判定方式</div>}
              </div>

              <div>
                <div className="detail-section-label">為什麼沒通過</div>
                {failure ? (
                  <div className="detail-box">
                    <div className="failure-line">
                      <strong>{failure.text}</strong>
                      <span className={`tag owner-${failure.owner}`}>{failure.owner === 'agent' ? 'Agent 的問題' : '平台／設定的問題'}</span>
                    </div>
                    <div className="muted xs">{failure.hint}</div>
                  </div>
                ) : (
                  <div className="detail-box dim">這條沒有失敗</div>
                )}
              </div>

              <div>
                <div className="detail-section-label">判定依據</div>
                <div className="detail-box">
                  {trial.score ? businessRationale(trial.score.rationale, trial.score.passed, trial.normalized.error?.class ?? null) : '這條還沒有判定結果'}
                </div>
              </div>

              <div>
                <div className="detail-section-label">執行過程</div>
                {traceSteps.length === 0 ? (
                  <div className="detail-box dim">這個 Agent 沒有提供執行過程紀錄</div>
                ) : (
                  <div className="detail-box" style={{ padding: '6px 8px' }}>
                    {traceSteps.map((step, index) => (
                      <div key={index} className={`trace-line ${step.key ? 'key' : ''}`}>
                        <span className="trace-time">{step.time}</span>
                        <span className="trace-text">{step.text}</span>
                      </div>
                    ))}
                    <div className="trace-line">
                      <span className="trace-time">{selected.latencyMs}</span>
                      <span className="trace-text">結束 · HTTP {trial.normalized.httpStatus ?? '—'}</span>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

    </div>
  )
  const openTrial = (trialId: string) => { setSelectedId(trialId); setPanel('trial') }
  const moveTrial = (step: number) => {
    const next = visible[selectedIndex + step]
    if (next) openTrial(next.id)
  }
  const focusEvidence = (trialId?: string) => {
    if (trialId) { setFilter('all'); openTrial(trialId); return }
    setPanel(null)
    setReportView('details')
    requestAnimationFrame(() => document.querySelector('.report-page .workbench-list')?.scrollIntoView({ block: 'nearest' }))
  }

  return (
    <div className="workbench-page report-page">
      <div className="workbench-head">
        <ReportOverview detail={detail} metrics={metrics} runId={viewRunId} conclusion={conclusion} ai={aiReport} state={aiEvaluation}
          onRunChange={(runId) => void load(runId)} onOpen={setPanel} onEvidence={() => focusEvidence()}
          onExport={(format) => window.open(`/api/experiments/${id}/export.${format}${exportQuery}`, '_blank', 'noopener')} />
        {detail.branches.length > 1 && <div className="model-report-tabs" aria-label="報告視圖"><Button size="sm" aria-pressed={reportView === 'comparison'} onClick={() => setReportView('comparison')}>模型／版本對比</Button><Button size="sm" aria-pressed={reportView === 'details'} onClick={() => setReportView('details')}>測試明細</Button></div>}
      </div>
      {detail.branches.length > 1 && reportView === 'comparison' ? <div className="workbench-body model-report-body"><ModelComparisonView key={viewRunId} detail={detail} batch={aiEvaluation.batch}/></div> : <div className="workbench-body">
      <section className="workbench-list">
        <div className="list-head">
          <div>
            <span className="list-title">{rows.length} 次試驗</span>
            <span className="list-sub">
              {caseCount} 案例 × {branchCount} 分支
            </span>
          </div>
          <Button size="sm" variant="ghost" aria-expanded={showFilters} onClick={() => setShowFilters(!showFilters)}>篩選{filter !== 'all' ? ' · 已啟用' : ''}</Button>
        </div>

        {showFilters && (
          <div className="filter-row">
            {(
              [
                ['all', `全部 ${rows.length}`],
                ['failed', `失敗 ${counts.failed}`],
                ['blocked', `攔截 ${counts.blocked}`],
                ['n/a', `無法判斷 ${counts.na}`],
                ['passed', `通過 ${counts.passed}`],
              ] as Array<[typeof filter, string]>
            ).map(([key, label]) => (
              <button key={key} type="button" className={`chip ${filter === key ? 'active' : ''}`} onClick={() => setFilter(key)}>
                {label}
              </button>
            ))}
          </div>
        )}

        <div className="list-body">
          <table className="data">
            <thead>
              <tr>
                <th>案例</th>
                <th>分支</th>
                <th>規則判定</th>
                <th className="right">規則分數</th>
                <th className="right" title="回答耗時；失敗時為等待耗時，不含 AI 評審時間">Agent 耗時</th>
                <th>原因</th>
                <th>AI 評估</th>
                <th className="right">開始</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr
                  key={row.id}
                  className={`clickable ${selected?.id === row.id ? 'selected' : ''}`}
                  onClick={() => openTrial(row.id)}
                >
                  <td><button type="button" className="report-trial-open" onClick={(event) => { event.stopPropagation(); openTrial(row.id) }} aria-haspopup="dialog">{row.caseName}</button></td>
                  <td className="mono">{row.branchRole}</td>
                  <td>
                    <Badge tone={STATUS_TEXT[row.status].tone}>{STATUS_TEXT[row.status].text}</Badge>
                  </td>
                  <td className="right mono">{row.scoreText}</td>
                  <td className="right mono" style={{ whiteSpace: 'nowrap' }}>{formatAgentTime(row.latencyMs, row.executionStatus)}</td>
                  <td className="mono dim" title={row.categoryCode ?? undefined}>
                    {row.category}
                  </td>
                  <td className="sm">{(() => {
                    const evaluation = aiEvaluation.batch?.evaluations.find((item) => item.trialId === row.id)
                    return evaluation?.result ? ANSWER_VERDICTS[evaluation.result.verdict] : evaluation?.status === 'running' ? '評估中' : evaluation?.status === 'pending' ? '等待中' : evaluation?.status === 'skipped' ? '未送評' : evaluation ? '未完成評估' : '未評估'
                  })()}</td>
                  <td className="right mono dim">{row.startedAt.slice(11, 19)}</td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <EmptyState title="還沒有試驗" description="跑一批試驗後再看報告。" />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="list-foot">
          <span>
            {rows.length} 次試驗 · {counts.failed} 沒通過 · {counts.blocked} 被攔下 · {counts.na} 無法判斷
          </span>
          <span className="hints">
            <span><Kbd>⌘K</Kbd> 指令</span>
            <span><Kbd>⌘↵</Kbd> 執行</span>
            <span><Kbd>ESC</Kbd> 取消</span>
          </span>
        </div>
      </section>


      </div>}
      {panel && <Drawer
        className={panel === 'trial' ? 'report-trial-drawer' : ''}
        title={panel === 'trial' ? '試驗明細' : panel === 'ai' ? 'AI 評估詳情與歷史' : panel === 'quality' ? 'AI 回答差距與改善重點' : '規則判定與分組比較'}
        onClose={() => setPanel(null)}
        footer={panel === 'trial' ? <div className="report-trial-navigation">
          <span>{selectedIndex + 1} / {visible.length} 次試驗</span>
          <Button size="sm" disabled={selectedIndex <= 0} onClick={() => moveTrial(-1)}>上一條</Button>
          <Button size="sm" disabled={selectedIndex >= visible.length - 1} onClick={() => moveTrial(1)}>下一條</Button>
        </div> : undefined}
      >
        {panel === 'trial' && <><p className="trial-detail-id">{selected?.id ?? '—'}</p>{trialDetails}</>}
        {panel === 'ai' && <><AnswerEvaluationPanel state={aiEvaluation} detail={detail} runId={viewRunId} />{aiReport && <Button onClick={() => setPanel('quality')}>查看回答差距與改善建議</Button>}</>}
        {panel === 'quality' && (aiReport ? <>
          <p className="sm muted">依所選 AI 批次列出前 5 條有差距或需確認的回答；點選後在測試明細查看原文證據。</p>
          {aiReport.batch.evaluations.filter((item) => item.status === 'completed' && item.result && item.result.verdict !== 'meets').slice(0, 5).map((item) => <article className="report-insight" key={item.id}>
            <div className="spread"><strong>{item.caseName}</strong><Button size="sm" onClick={() => focusEvidence(item.trialId)}>查看原文證據</Button></div>
            <p>{item.result!.summary}</p>{item.result!.suggestions.length > 0 && <ul className="sm muted">{item.result!.suggestions.map((suggestion, index) => <li key={index}>{suggestion}</li>)}</ul>}
          </article>)}
          {!aiReport.batch.evaluations.some((item) => item.status === 'completed' && item.result && item.result.verdict !== 'meets') && <p className="sm muted">目前沒有已取得的差距分析；未完成或失敗的評估仍需另行確認。</p>}
        </> : <p>尚未取得 AI 評估結果。</p>)}
        {panel === 'rules' && <>
          {conclusion && <><p>{conclusion.headline}</p><p className="sm muted">{conclusion.sampleText}</p><p className="sm muted">{conclusion.deltaText}</p></>}
          <Notice>規則判定使用用例口徑；AI 回答品質使用可判定回答口徑。無法判斷不等於 Agent 回答失敗。</Notice>
          {metrics && metrics.branches.length >= 2 && <><h3>各組規則對比</h3>{metrics.run?.source === 'legacy' && <Notice tone="warn">歷史批次：數字可能不完整</Notice>}<MetricCompare metrics={metrics} repeats={detail.frozen.repeats} /></>}
        </>}
      </Drawer>}
    </div>
  )
}

export type { Badge }
