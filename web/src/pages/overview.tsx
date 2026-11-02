import { useEffect, useState } from 'react'
import { errorClassLabel } from '../../../src/shared/types.ts'
import { api, type ExperimentDetail, type MetricsResponse, type Overview } from '../api.ts'
import { Badge, Button, Card, Dot, EmptyState, ErrorState, PageTitle, SkeletonBlock, StatBand } from '../components/ui.tsx'
import { formatDateTime } from '../lib/format.ts'
import { experimentKindLabel, roleLabel } from '../lib/labels.ts'
import { navigate } from '../lib/router.ts'

interface ReportInfo {
  id: string
  name: string
  cases: number
  trials: number
  naDimensions: number
  failed: number
  blocked: number
}

type PassRates = Record<string, number | null>

function passRate(metrics: MetricsResponse): number | null {
  let passed = 0
  let total = 0
  for (const branch of metrics.branches) {
    for (const dimension of branch.metrics.dimensionResults) {
      if (dimension.na) continue
      passed += dimension.passedCases
      total += dimension.totalCases
    }
  }
  return total > 0 ? passed / total : null
}

function fatalCategory(item: Overview['recentFailures']['items'][number]): string {
  if (item.status === 'blocked') return '只讀攔截'
  return item.errorClass ? errorClassLabel(item.errorClass) : '規則未命中'
}

export function OverviewPage() {
  const [data, setData] = useState<Overview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<ReportInfo | null>(null)
  const [passRates, setPassRates] = useState<PassRates>({})

  const load = () => {
    setError(null)
    api
      .overview()
      .then((overview) => {
        setData(overview)
        const recentExperiments = overview.recentExperiments.slice(0, 6)
        void Promise.all(
          recentExperiments.map(async (experiment) => {
            try {
              return [experiment.id, passRate(await api.metrics(experiment.id))] as const
            } catch {
              return [experiment.id, null] as const
            }
          }),
        ).then((rates) => setPassRates(Object.fromEntries(rates)))

        const latest = overview.recentExperiments[0]
        if (!latest) {
          setReport(null)
          return
        }
        void Promise.all([
          api.experiment(latest.id) as Promise<ExperimentDetail>,
          api.metrics(latest.id) as Promise<MetricsResponse>,
        ])
          .then(([detail, metrics]) => {
            const branch = metrics.branches[0]?.metrics
            setReport({
              id: latest.id,
              name: latest.name,
              cases: detail.frozen.dataset.cases.length,
              trials: detail.trials.length,
              naDimensions: branch ? branch.dimensionResults.filter((d) => d.na).length : 0,
              failed: detail.trials.filter((t) => t.status === 'failed').length,
              blocked: detail.trials.filter((t) => t.status === 'blocked').length,
            })
          })
          .catch(() => setReport(null))
      })
      .catch((e: Error) => setError(e.message))
  }

  useEffect(load, [])

  if (error) {
    return (
      <Card>
        <ErrorState message={error} onRetry={load} />
      </Card>
    )
  }

  if (!data) {
    return (
      <div className="stack">
        <SkeletonBlock height={60} />
        <SkeletonBlock height={220} />
      </div>
    )
  }

  const empty = data.counts.agents === 0 && data.counts.experiments === 0
  const verdict = report
    ? report.failed > 0
      ? { tone: 'err' as const, text: '本輪有失敗案例，先看失敗分類再判斷' }
      : report.naDimensions > 0
        ? { tone: 'warn' as const, text: '有維度不可評，結論需配合 N/A 原因閱讀' }
        : { tone: 'ok' as const, text: '本輪沒有失敗案例，可直接進入報告' }
    : null
  const failures = data.recentFailures

  return (
    <div className="stack">
      <PageTitle lead="評測概況" sub="接入、測試、對照與報告的當前狀態" />

      <StatBand
        items={[
          { label: '已接入 Agent', value: data.counts.agents, unit: '個' },
          { label: '測試集', value: data.counts.testSets, unit: '個' },
          { label: '實驗', value: data.counts.experiments, unit: '個' },
          { label: '累計試驗', value: data.counts.trials, unit: '次' },
        ]}
      />

      {empty ? (
        <Card>
          <EmptyState
            title="還沒有接入任何 Agent"
            description="先接入第一個 Agent，再建立測試集與實驗。整個流程不需要寫程式。"
            action={
              <Button variant="primary" onClick={() => navigate('/agents/new')}>
                接入第一個 Agent
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <div className="grid-2" style={{ alignItems: 'start' }}>
            <Card
              title="最近報告（前 6 個實驗）"
              subtitle="通過率取各維度已評分案例加總，N/A 不計入"
              actions={
                <Button size="sm" onClick={() => navigate('/experiments')}>
                  全部實驗
                </Button>
              }
            >
              {data.recentExperiments.length === 0 ? (
                <EmptyState title="還沒有實驗" description="建立實驗需要已發佈的測試集版本與 Agent 版本。" />
              ) : (
                <table className="data">
                  <thead>
                    <tr>
                      <th>實驗</th>
                      <th>類型</th>
                      <th className="right">樣本量</th>
                      <th className="right">通過率</th>
                      <th className="right">最後更新</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentExperiments.map((exp) => (
                      <tr key={exp.id} className="clickable" onClick={() => navigate(`/experiments/${exp.id}`)}>
                        <td>{exp.name}</td>
                        <td>{experimentKindLabel(exp.kind)}</td>
                        <td className="right mono">{exp.trialCount}</td>
                        <td className="right mono dim">
                          {passRates[exp.id] === null || passRates[exp.id] === undefined
                            ? 'N/A'
                            : `${(passRates[exp.id]! * 100).toFixed(1)}%`}
                        </td>
                        <td className="right mono dim">{formatDateTime(exp.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            <div className="stack">
              <Card
                title="最近報告"
                actions={
                  report ? (
                    <Button size="sm" variant="primary" onClick={() => navigate(`/report/${report.id}`)}>
                      進入報告
                    </Button>
                  ) : undefined
                }
              >
                {!report ? (
                  <EmptyState title="還沒有報告" description="跑完一批試驗後，這裡會顯示最近一次的結論。" />
                ) : (
                  <div className="stack-2">
                    <div className="spread">
                      <span style={{ color: 'var(--ink)', fontWeight: 600 }}>{report.name}</span>
                      <span className="mono dim">
                        樣本 {report.cases} 條 · {report.trials} 次試驗
                      </span>
                    </div>
                    {verdict && (
                      <span className="row-tight">
                        <Dot tone={verdict.tone} />
                        <span className="sm">{verdict.text}</span>
                      </span>
                    )}
                    <div className="row">
                      <Badge tone={report.failed > 0 ? 'warn' : 'ok'}>
                        {report.failed > 0 ? '部分失敗' : '已完成'}
                      </Badge>
                      <span className="dim sm">
                        N/A 維度 {report.naDimensions} 個 · 失敗 {report.failed} 次 · 攔截 {report.blocked} 次
                      </span>
                    </div>
                  </div>
                )}
              </Card>

              <Card title="待處理（全站）" subtitle="全站累計，含歷史批次與已中斷執行">
                <div className="attention-list">
                  <div className="attention-row">
                    <span className="mono attention-num">{data.attention.notRun}</span>
                    <span className="muted">未執行的實驗</span>
                    {data.attention.notRun > 0 && (
                      <Button size="sm" variant="ghost" onClick={() => navigate('/experiments')}>
                        去看
                      </Button>
                    )}
                  </div>
                  <div className="attention-row">
                    <Dot tone={data.attention.failedTrials > 0 ? 'err' : 'dim'} />
                    <span className="mono attention-num">{data.attention.failedTrials}</span>
                    <span className="muted">失敗試驗</span>
                  </div>
                  <div className="attention-row">
                    <Dot tone={data.attention.blockedTrials > 0 ? 'warn' : 'dim'} />
                    <span className="mono attention-num">{data.attention.blockedTrials}</span>
                    <span className="muted">只讀攔截</span>
                  </div>
                </div>
              </Card>
            </div>
          </div>

          <Card
            title="最近失敗案例（最近一次報告）"
            actions={
              failures.experimentId ? (
                <Button size="sm" onClick={() => navigate(`/report/${failures.experimentId}`)}>
                  看完整報告
                </Button>
              ) : undefined
            }
          >
            {!failures.experimentId ? (
              <EmptyState title="還沒有可分析的報告" description="跑完一批試驗後，這裡會列出失敗與攔截案例。" />
            ) : failures.items.length === 0 ? (
              <div className="row-tight">
                <Dot tone="ok" />
                <span className="sm">最近一次報告（{failures.experimentName}）沒有失敗或攔截案例。</span>
              </div>
            ) : (
              <>
                <div className="page-sub" style={{ marginBottom: 8 }}>
                  取自最近一次報告「{failures.experimentName}」，共 {failures.total} 條問題案例
                  {failures.total > failures.items.length ? `，顯示最近 ${failures.items.length} 條` : ''}
                </div>
                <table className="data">
                  <thead>
                    <tr>
                      <th>案例</th>
                      <th>分支</th>
                      <th>錯誤分類</th>
                      <th className="right">時間</th>
                    </tr>
                  </thead>
                  <tbody>
                    {failures.items.map((item) => (
                      <tr
                        key={item.trialId}
                        className="clickable"
                        onClick={() => navigate(`/report/${failures.experimentId}?trial=${item.trialId}`)}
                      >
                        <td>
                          <span className="row-tight">
                            <Dot tone={item.status === 'blocked' ? 'warn' : 'err'} />
                            <span>{item.caseName}</span>
                          </span>
                        </td>
                        <td className="mono">{roleLabel(item.branchRole)}</td>
                        <td className="mono dim" title={item.errorClass ?? undefined}>
                          {fatalCategory(item)}
                        </td>
                        <td className="right mono dim">{formatDateTime(item.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </Card>
        </>
      )}
    </div>
  )
}
