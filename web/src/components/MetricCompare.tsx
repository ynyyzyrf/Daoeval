import { NA_BUSINESS_HINTS, NA_BUSINESS_LABELS } from '../../../src/shared/vocabulary.ts'
import type { DimensionResult, MetricsResponse } from '../api.ts'
import { roleLabel } from '../lib/labels.ts'

interface MetricCompareProps {
  metrics: MetricsResponse
  repeats: number
}

function formatPct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`
}

function formatCi(ci: { low: number; high: number } | null): string | null {
  return ci ? `95% CI ${(ci.low * 100).toFixed(1)}–${(ci.high * 100).toFixed(1)}` : null
}

function metricCell(metric: DimensionResult | undefined) {
  if (!metric || metric.na) {
    return <span className="sm muted">這項無法判斷</span>
  }
  return (
    <>
      <div>{formatPct(metric.value)}</div>
      <div className="xs muted">{formatCi(metric.ci)}</div>
    </>
  )
}

function naReasonSummary(dimensions: DimensionResult[]) {
  const groups = new Map<string, { code: string; reason: string; dimensions: string[] }>()
  for (const dimension of dimensions) {
    if (!dimension.na) continue
    const code = dimension.naCode ?? 'unknown'
    const group = groups.get(code) ?? {
      code,
      reason: dimension.naCode ? NA_BUSINESS_LABELS[dimension.naCode as keyof typeof NA_BUSINESS_LABELS] ?? '這項無法判斷' : '這項無法判斷',
      dimensions: [],
    }
    if (!group.dimensions.includes(dimension.label)) group.dimensions.push(dimension.label)
    groups.set(code, group)
  }
  return [...groups.values()]
}

function stabilityCell(value: number | null, ci: { low: number; high: number } | null) {
  if (value === null) return <span className="sm muted">這項無法判斷</span>
  return (
    <>
      <div>{formatPct(value)}</div>
      <div className="xs muted">{formatCi(ci)}</div>
    </>
  )
}

function delta(base: number | null, experiment: number | null) {
  if (base === null || experiment === null) return <span className="delta-flat">—</span>
  const points = (experiment - base) * 100
  if (Math.abs(points) < 0.05) return <span className="delta-flat">—</span>
  const up = points > 0
  return <span className={up ? 'delta-up' : 'delta-down'}>{up ? '↑' : '↓'} {points >= 0 ? '+' : ''}{points.toFixed(1)} pt</span>
}

export function MetricCompare({ metrics, repeats }: MetricCompareProps) {
  if (metrics.branches.length < 2) return null
  if (metrics.branches.length > 2) return <div className="stack">{metrics.branches.slice(1).map(branch => <section key={branch.branchId}><h4>{roleLabel(metrics.branches[0].role)} vs {roleLabel(branch.role)}</h4><MetricCompare metrics={{...metrics,branches:[metrics.branches[0],branch]}} repeats={repeats}/></section>)}</div>
  const baseline = metrics.branches[0]!
  const experiment = metrics.branches[1]!
  const naSummaries = naReasonSummary([
    ...baseline.metrics.dimensionResults,
    ...experiment.metrics.dimensionResults,
  ])

  return (
    <div className="stack-2">
      {naSummaries.map((summary) => (
        <div key={summary.code} className="sm muted">
          這批有 {summary.dimensions.length} 項無法判斷：{summary.dimensions.join('、')}（{summary.reason}
          {NA_BUSINESS_HINTS[summary.code as keyof typeof NA_BUSINESS_HINTS] ? `，${NA_BUSINESS_HINTS[summary.code as keyof typeof NA_BUSINESS_HINTS]}` : ''}）
        </div>
      ))}
      <table className="data metric-table">
      <colgroup>
        <col style={{ width: '34%' }} />
        <col style={{ width: '22%' }} />
        <col style={{ width: '22%' }} />
        <col style={{ width: '22%' }} />
      </colgroup>
      <thead>
        <tr>
          <th>能力項目</th>
          <th className="right">{roleLabel(baseline.role)}</th>
          <th className="right">{roleLabel(experiment.role)}</th>
          <th className="right">變化</th>
        </tr>
      </thead>
      <tbody>
        {baseline.metrics.dimensionResults.map((dimension) => {
          const compared = experiment.metrics.dimensionResults.find((item) => item.key === dimension.key)
          return (
            <tr key={dimension.key}>
              <td>{dimension.label}</td>
              <td className="right">{metricCell(dimension)}</td>
              <td className="right">{metricCell(compared)}</td>
              <td className="right">{delta(dimension.na ? null : dimension.value, compared?.na ? null : compared?.value ?? null)}</td>
            </tr>
          )
        })}
        <tr>
          <td>單次成功率</td>
          <td className="right">{stabilityCell(baseline.metrics.stability.singleSuccessRate, baseline.metrics.stability.singleSuccessRateCi)}</td>
          <td className="right">{stabilityCell(experiment.metrics.stability.singleSuccessRate, experiment.metrics.stability.singleSuccessRateCi)}</td>
          <td className="right">{delta(baseline.metrics.stability.singleSuccessRate, experiment.metrics.stability.singleSuccessRate)}</td>
        </tr>
      </tbody>
      </table>
    </div>
  )
}
