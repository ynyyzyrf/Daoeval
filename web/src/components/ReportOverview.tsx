import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { AiReportSummary } from '../../../src/shared/ai-report.ts'
import { canRetryAnswerEvaluation } from '../../../src/shared/ai-evaluation.ts'
import type { Conclusion, ExperimentDetail, MetricsResponse } from '../api.ts'
import type { useAnswerEvaluations } from './AnswerEvaluation.tsx'
import { Badge, Button, Icon } from './ui.tsx'
import { RunSwitcher } from './RunSwitcher.tsx'
import { roleLabel } from '../lib/labels.ts'
import './ReportOverview.css'

export type ReportPanel = 'ai' | 'quality' | 'rules'
export type ReportExportFormat = 'pdf' | 'html' | 'json'

/** Presentation-only grouping. Raw diagnostics stay available in the evaluation drawer. */
export function reportErrorGroups(report: AiReportSummary | null) {
  const groups = new Map<string, number>()
  for (const item of report?.batch.evaluations ?? []) {
    if (!canRetryAnswerEvaluation(item)) continue
    const error = item.error ?? ''
    const label = /truncated_response|未回傳完整|截斷/.test(error) ? '輸出未完成'
      : /invalid_|missing_.*quote|unsupported_verdict|格式|原文證據/.test(error) ? '格式或引用不符'
      : /timeout|超時/.test(error) ? '評估超時'
      : /network_error|連線/.test(error) ? '連線異常'
      : /http_429|頻繁/.test(error) ? '服務限流'
      : /http_40[123]|金鑰|餘額|Key|權限/.test(error) ? '服務帳戶問題'
      : item.status === 'interrupted' ? '評估中斷' : '評估服務異常'
    groups.set(label, (groups.get(label) ?? 0) + 1)
  }
  return [...groups].map(([label, count]) => ({ label, count }))
}

function ExportMenu({ onExport }: { onExport: (format: ReportExportFormat) => void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); return }
    if (!open || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const items = Array.from(root.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
  }
  return <div className="report-export" ref={root} onKeyDown={keyboard} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false) }}>
    <button ref={trigger} type="button" className="btn btn-sm" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)} onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true) } }}><Icon name="export" size={14} />匯出報告<Icon name="chevron" size={14} /></button>
    {open && <div id={id} className="report-export-menu" role="menu" aria-label="匯出報告格式">{([['pdf', 'PDF 文件'], ['html', 'HTML 報告'], ['json', 'JSON 原始資料']] as const).map(([format, label]) => <button type="button" role="menuitem" key={format} onClick={() => { onExport(format); setOpen(false); trigger.current?.focus() }}>{label}</button>)}</div>}
  </div>
}

export function ReportOverview({ detail, metrics, runId, conclusion, ai, state, onRunChange, onOpen, onEvidence, onExport }: {
  detail: ExperimentDetail; metrics: MetricsResponse | null; runId: string | null; conclusion: Conclusion | null
  ai: AiReportSummary | null; state: ReturnType<typeof useAnswerEvaluations>
  onRunChange: (id: string) => void; onOpen: (panel: ReportPanel) => void; onEvidence: () => void; onExport: (format: ReportExportFormat) => void
}) {
  const run = detail.runs.find((item) => item.id === runId)
  const agents = detail.frozen.branches.map((item) => item.config.name).join(' / ')
  const group = metrics?.branches[0]?.role
  const retryCount = ai?.batch.evaluations.filter(canRetryAnswerEvaluation).length ?? 0
  const eligible = detail.trials.filter((trial) => trial.status === 'succeeded' && trial.normalized.finalOutput?.trim() && detail.frozen.dataset.cases.find((item) => item.id === trial.caseId)?.expected.trim()).length
  const runActive = run?.status === 'running' || run?.status === 'paused'
  const errors = reportErrorGroups(ai)
  const stats = [
    { label: '測試總數', value: conclusion?.totalCases ?? detail.frozen.dataset.cases.length, note: '條用例', tone: '' },
    { label: '通過', value: conclusion?.passedCases ?? '—', note: '已符合規則', tone: 'positive' },
    { label: '未通過', value: conclusion ? conclusion.judgedCases - conclusion.passedCases : '—', note: '含執行失敗', tone: 'negative' },
    { label: '無法判斷', value: conclusion?.unknownCases ?? '—', note: '尚無規則判定', tone: 'neutral' },
  ]
  return <>
    <header className="report-header">
      <div className="report-heading"><h1 title={detail.name}>{detail.name}</h1><p title={agents}>{agents || '尚未指定 Agent'}{run && <span> · 執行 {run.done}/{run.total} 次，調用成功 {run.succeeded}、失敗 {run.failed}{run.blocked > 0 ? `、攔截 ${run.blocked}` : ''}</span>}</p></div>
      <div className="report-header-actions">{detail.runs.length ? <RunSwitcher runs={detail.runs} value={runId} onChange={onRunChange} compact /> : <span className="report-muted">尚無執行紀錄</span>}<ExportMenu onExport={onExport} /></div>
    </header>
    <section className="report-summary" aria-label="報告 KPI 摘要">
      <div className="report-scope"><span>規則判定{group ? ` · ${roleLabel(group)}` : ''}<span className="report-scope-note">用例口徑，與 AI 回答品質分開</span></span><button type="button" onClick={() => onOpen('rules')}>查看規則與比較<Icon name="chevron" size={12} /></button></div>
      <div className="report-kpis">{stats.map((stat) => <div className="report-kpi" key={stat.label}><span>{stat.label}</span><strong className={typeof stat.value === 'number' && stat.value > 0 ? stat.tone : ''}>{stat.value}</strong><small>{stat.note}</small></div>)}
        <div className="report-kpi report-kpi-ai"><span>AI 評估進度</span><strong>{ai ? <>{ai.completed}<em> / {ai.eligible}</em></> : '—'}</strong><small>{ai ? `${ai.pending > 0 ? `${ai.pending} 條處理中 · ` : ''}${ai.failed + ai.interrupted > 0 ? `${ai.failed + ai.interrupted} 條評估異常 · ` : ''}${ai.skipped} 條未送評` : '尚未啟動回答評估'}</small></div>
      </div>
    </section>
    <section className={`report-ai-summary${retryCount ? ' has-retry' : ''}`} aria-label="AI 回答品質摘要">
      <div className="report-ai-main"><div className="report-ai-top"><strong>AI 回答品質</strong><Badge tone={ai?.batch.status === 'running' ? 'info' : errors.length ? 'warn' : 'muted'}>{ai?.label ?? '尚未評估'}</Badge>{ai && <span className="report-ai-model" title={ai.batch.model}>{ai.batch.model}</span>}</div>
        <div className="report-ai-result">{ai ? <><span>符合 <b>{ai.meets}</b></span><span>部分符合 <b>{ai.partial}</b></span><span>不符合 <b>{ai.doesNotMeet}</b></span><span>無法判定 <b>{ai.uncertain}</b></span><span className="report-ai-rate">已判定符合率 {ai.matchRateText}<span className="report-muted">（{ai.meets}/{ai.judged} 條回答）</span></span></> : <span className="report-muted">對已有回答進行品質評估，查看差距與原文證據。</span>}</div>
        {errors.length > 0 && <button className="report-anomalies" type="button" onClick={() => onOpen('ai')} aria-label="查看評估異常原因"><span>評估異常</span>{errors.slice(0, 2).map((item) => <span key={item.label}>{item.label} <b>{item.count}</b></span>)}{errors.length > 2 && <span>另 {errors.length - 2} 類</span>}<Icon name="chevron" size={12} /></button>}
        {state.error && <p className="negative report-request-error" role="alert">評估資料載入失敗，請在評估詳情查看原因。</p>}
      </div>
      <div className="report-ai-actions">{retryCount > 0 ? <Button size="sm" loading={state.busy} disabled={state.running || runActive} onClick={() => ai && void state.start(ai.batch.id)}>補評失敗 {retryCount} 條</Button> : !ai && <Button size="sm" loading={state.busy} disabled={!runId || !eligible || state.running || runActive} onClick={() => void state.start()}>開始 AI 評估</Button>}
        <Button size="sm" variant="ghost" className="report-ai-details-action" onClick={() => onOpen('ai')}>評估詳情</Button>{ai && <Button size="sm" variant="ghost" className="report-ai-quality-action" onClick={() => onOpen('quality')}>差距與建議</Button>}
        <button className="report-evidence-link" type="button" onClick={onEvidence}>查看測試明細 ↓</button>
      </div>
    </section>
  </>
}
