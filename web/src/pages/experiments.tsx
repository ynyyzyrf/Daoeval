import { useEffect, useRef, useState } from 'react'
import './experiments.css'
import { NA_REASON_LABELS, type NaReasonCode } from '../../../src/shared/types.ts'
import {
  api,
  type AgentSummary,
  type DatasetVersion,
  type DimensionResult,
  type ExperimentDetail,
  type ExperimentSummary,
  type MetricsResponse,
  type RunState,
  type ScoringVersion,
} from '../api.ts'
import { DataTable, type Column } from '../components/DataTable.tsx'
import {
  Badge,
  Breadcrumb,
  Button,
  Card,
  Drawer,
  EmptyState,
  ErrorState,
  Field,
  Notice,
  PageTitle,
  Progress,
  SkeletonBlock,
  useToast,
} from '../components/ui.tsx'
import { formatAgentTime, formatDateTime, formatMs, formatPct, statusText } from '../lib/format.ts'
import { experimentKindLabel, roleLabel } from '../lib/labels.ts'
import { MetricCompare } from '../components/MetricCompare.tsx'
import { RunSwitcher } from '../components/RunSwitcher.tsx'
import { ArchiveAction, ArchiveFilter } from '../components/ArchiveControls.tsx'
import { navigate } from '../lib/router.ts'

/* ================= 列表 ================= */

function naReasonSummary(dimensions: DimensionResult[]) {
  const groups = new Map<string, { code: string; reason: string; dimensions: string[] }>()
  for (const dimension of dimensions) {
    if (!dimension.na) continue
    const code = dimension.naCode ?? 'unknown'
    const group = groups.get(code) ?? {
      code,
      reason: dimension.naCode ? NA_REASON_LABELS[dimension.naCode as NaReasonCode] ?? '不可評' : '不可評',
      dimensions: [],
    }
    group.dimensions.push(dimension.label)
    groups.set(code, group)
  }
  return [...groups.values()]
}

export function ExperimentsListPage() {
  const [archived, setArchived] = useState(false)
  const [experiments, setExperiments] = useState<ExperimentSummary[]>([])
  const [datasets, setDatasets] = useState<DatasetVersion[]>([])
  const [scoring, setScoring] = useState<ScoringVersion[]>([])
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [compare, setCompare] = useState(false)
  const [modelCompare, setModelCompare] = useState(false)
  const [candidates, setCandidates] = useState<string[]>([''])
  const [advanced, setAdvanced] = useState(false)
  const [form, setForm] = useState({
    name: '',
    datasetVersionId: '',
    scoringProfileVersionId: '',
    repeats: 1,
    baseline: '',
  })
  const toast = useToast()

  const load = () => {
    setLoading(true)
    setError(null)
    Promise.all([api.experiments('all'), api.datasetVersions(), api.scoringVersions(), api.agents()])
      .then(([exps, ds, scs, ags]) => {
        setExperiments(exps)
        setDatasets(ds)
        setScoring(scs)
        setAgents(ags)
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  useEffect(() => {
    const onNew = () => setCreating(true)
    window.addEventListener('aeval:new', onNew)
    return () => window.removeEventListener('aeval:new', onNew)
  }, [])

  const agentVersionOptions = agents.flatMap((agent) =>
    agent.versions.filter((v) => v.status === 'active').map((v) => ({ id: v.id, agentId: agent.id, label: `${agent.name} · ${v.versionName || v.model || '未命名'} · v${v.versionNo}` })),
  )

  const selectedDataset = datasets.find((d) => d.id === form.datasetVersionId)
  const selectedBaseline = agentVersionOptions.find((v) => v.id === form.baseline)
  const selectedCandidates = candidates.map(id => agentVersionOptions.find(v => v.id === id))
  const groupCount = compare ? candidates.length + 1 : 1
  const suggestedName = selectedDataset && selectedBaseline
    ? `${selectedDataset.testSetName}｜${modelCompare && compare ? '模型對比' : compare ? '對比測試' : '單組測試'}` : ''
  const canCreate = Boolean(form.datasetVersionId && form.scoringProfileVersionId && form.baseline
    && (!compare || (candidates.length > 0 && candidates.every(id => id && id !== form.baseline) && new Set(candidates).size === candidates.length
      && (!modelCompare || selectedCandidates.every(v => v?.agentId === selectedBaseline?.agentId))))
    && Number.isInteger(form.repeats) && form.repeats >= 1)

  const create = async () => {
    if (!canCreate) {
      toast.push('error', '請選擇題目、評分規則與測試對象；對比測試需要兩個不同的版本')
      return
    }
    setBusy(true)
    try {
      const branches = [{ role: 'baseline', agentVersionId: form.baseline }]
      if (compare) candidates.forEach((id, index) => branches.push({ role: index === 0 ? 'experiment' : `candidate_${index + 1}`, agentVersionId: id }))
      const result = await api.createExperiment({
        name: form.name.trim() || suggestedName,
        kind: compare && selectedCandidates.some(v => v?.agentId !== selectedBaseline?.agentId) ? 'B' : 'A',
        externalConditions: { comparisonMode: compare && modelCompare ? 'models' : compare ? 'versions' : 'single' },
        datasetVersionId: form.datasetVersionId,
        scoringProfileVersionId: form.scoringProfileVersionId,
        repeats: form.repeats,
        branches,
      })
      toast.push('success', '實驗已建立，設定已保存；可在下一頁開始執行')
      navigate(`/experiments/${result.experimentId}`)
    } catch (e) {
      const payload = (e as { payload?: { missing?: string[] } }).payload
      toast.push('error', payload?.missing?.length ? `請補齊設定：${payload.missing.join('、')}` : (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const columns: Array<Column<ExperimentSummary>> = [
    { key: 'name', title: '名稱', sortValue: (row) => row.name, render: (row) => <strong>{row.name}</strong> },
    { key: 'kind', title: '類型', render: (row) => <span title={row.kind}>{experimentKindLabel(row.kind)}</span> },
    { key: 'branches', title: '分支', align: 'right', render: (row) => row.branches.length },
    { key: 'samples', title: '樣本量', align: 'right', sortValue: (row) => row.trialCount, render: (row) => `${row.trialCount} 次` },
    {
      key: 'status',
      title: '狀態',
      render: (row) => (
        <Badge tone={row.trialCount === 0 ? 'muted' : row.status === 'ready' ? 'info' : 'ok'}>{statusText(row.status)}</Badge>
      ),
    },
    {
      key: 'created',
      title: '建立時間',
      sortValue: (row) => row.createdAt,
      render: (row) => <span className="muted sm">{formatDateTime(row.createdAt)}</span>,
    },
    { key: 'archive', title: '操作', align: 'right', render: (row) => <ArchiveAction kind="experiment" item={row} onChanged={load} /> },
  ]

  return (
    <div className="stack page-stack">
      <div className="page-head">
        <PageTitle lead="實驗" sub="使用同一批題目測試 Agent，或比較兩個版本的表現。" />
        <div className="page-actions">
          <Button variant="primary" onClick={() => setCreating(true)}>
            新建實驗
          </Button>
        </div>
      </div>

      <ArchiveFilter archived={archived} onChange={setArchived} items={experiments} />
      {archived && <p className="sm muted">歸檔只隱藏實驗，執行記錄與報告均保留，不會取消正在執行的任務，可隨時還原。</p>}
      <DataTable
        key={String(archived)}
        rows={experiments.filter((item) => item.archived === archived)}
        columns={columns}
        rowKey={(row) => row.id}
        searchText={(row) => row.name}
        searchPlaceholder="搜尋實驗名稱"
        loading={loading}
        error={error}
        onRetry={load}
        onRowClick={(row) => navigate(`/experiments/${row.id}`)}
        filters={[
          {
            key: 'status',
            label: '狀態',
            options: [
              { value: 'todo', label: '待執行' },
              { value: 'done', label: '已執行' },
            ],
            match: (row, value) => (value === 'todo' ? row.trialCount === 0 : row.trialCount > 0),
          },
        ]}
        emptyTitle={archived ? '還沒有已歸檔的實驗' : '還沒有未歸檔的實驗'}
        emptyDescription={archived ? '在未歸檔列表點「歸檔」，項目便會移到這裡。' : '建立實驗需要一個已發佈的測試集版本、一個評分規則集版本與至少一個 Agent 版本。'}
        emptyAction={archived ? undefined : <Button variant="primary" onClick={() => setCreating(true)}>新建實驗</Button>}
      />

      {creating && (
        <Drawer
          title="新建實驗"
          onClose={() => setCreating(false)}
          footer={
            <>
              <Button onClick={() => setCreating(false)}>取消</Button>
              <Button variant="primary" loading={busy} loadingLabel="建立中…" disabled={!canCreate} onClick={() => void create()}>
                建立實驗，下一步執行
              </Button>
            </>
          }
        >
          <div className="experiment-setup">
            <p className="muted sm">先選題目與測試對象。建立後再開始執行，這一步不會調用 Agent。</p>
            <section className="experiment-setup-section" aria-labelledby="setup-dataset">
              <h3 id="setup-dataset">1. 用哪些題目測試？</h3>
              <Field label="測試集" hint="選擇已發布的版本；所有對比組會使用同一批題目。">
                <select value={form.datasetVersionId} onChange={(e) => {
                  const dataset = datasets.find((d) => d.id === e.target.value)
                  setAdvanced(!scoring.some((s) => s.id === dataset?.scoringProfileVersionId && s.status === 'active'))
                  setForm({ ...form, datasetVersionId: e.target.value,
                    scoringProfileVersionId: scoring.some((s) => s.id === dataset?.scoringProfileVersionId && s.status === 'active')
                      ? dataset!.scoringProfileVersionId : '' })
                }}>
                  <option value="">請選擇測試集</option>
                  {datasets.filter((d) => d.status === 'active').map((d) => (
                    <option key={d.id} value={d.id}>{d.testSetName} · {d.caseCount} 題 · v{d.versionNo}</option>
                  ))}
                </select>
              </Field>
              {!datasets.some((d) => d.status === 'active') && <p className="sm">還沒有可用題目，請先到 <a href="/testsets">測試集</a> 建立並發布版本。</p>}
              {form.datasetVersionId && !form.scoringProfileVersionId && <Notice tone="warn">這份測試集沒有可用的預設評分規則，請在下方「評分與執行設定」中選擇。</Notice>}
            </section>
            <section className="experiment-setup-section" aria-labelledby="setup-target">
              <h3 id="setup-target">2. 要測試誰？</h3>
              <Field label="測試方式">
                <select value={compare ? modelCompare ? 'models' : 'compare' : 'single'} onChange={(e) => { setCompare(e.target.value !== 'single'); setModelCompare(e.target.value === 'models') }}>
                  <option value="single">測試一個版本：先了解目前表現</option>
                  <option value="compare">比較多個版本：查看改版是否改善</option>
                  <option value="models">模型對比：同一 Agent，只換模型</option>
                </select>
              </Field>
              <Field label={compare ? '目前版本（基準組）' : '要測試的 Agent 版本'} hint={compare ? '選擇目前使用的版本，作為比較基準。' : '使用這個版本回答測試集中的問題。'}>
                <select value={form.baseline} onChange={(e) => setForm({ ...form, baseline: e.target.value })}>
                  <option value="">請選擇 Agent 版本</option>
                  {agentVersionOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
              </Field>
              {compare && <>
                {candidates.map((value, index) => <div key={index}>
                  <Field label={`對比版本 ${index + 1}`} hint={modelCompare ? '選同一 Agent 的另一個模型版本；其他配置需一致。' : '可比較同一個或不同 Agent 的版本。'}>
                    <select value={value} onChange={e => setCandidates(candidates.map((id,i) => i === index ? e.target.value : id))}>
                      <option value="">請選擇要比較的版本</option>
                      {agentVersionOptions.filter(o => o.id !== form.baseline && (!modelCompare || o.agentId === selectedBaseline?.agentId) && (!candidates.includes(o.id) || o.id === value)).map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </select>
                  </Field>
                  {candidates.length > 1 && <Button size="sm" variant="ghost" onClick={() => setCandidates(candidates.filter((_,i) => i !== index))}>移除對比版本 {index + 1}</Button>}
                </div>)}
                <Button size="sm" disabled={candidates.length >= 7} onClick={() => setCandidates([...candidates, ''])}>＋ 加入另一個模型／版本</Button>
                <Notice>先在 Agent 接入設定或遠端平台配置各版本；此處不會改寫遠端 Prompt 或模型。模型對比會檢查同一 Agent、模型路由不同且其他本地配置一致。</Notice>
              </>}
              {!agentVersionOptions.length && <p className="sm">還沒有可用版本，請先到 <a href="/agents">Agent 接入</a> 完成配置並發布版本。</p>}
            </section>
            <section className="experiment-setup-section" aria-labelledby="setup-confirm">
              <h3 id="setup-confirm">3. 確認這次測試</h3>
              <Field label="實驗名稱（可選）" hint="不填會按測試集與測試方式自動命名。">
                <input value={form.name} placeholder={suggestedName || '例如：蘑菇教授 Prompt 改版對比'} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
              <details open={advanced} onToggle={(e) => setAdvanced(e.currentTarget.open)}>
                <summary>評分與執行設定</summary>
                <div className="experiment-advanced">
                  <Field label="評分規則" hint="預設使用測試集綁定的規則；所有組共用同一份標準。AI 回答評估可在執行後另外發起。">
                    <select value={form.scoringProfileVersionId} onChange={(e) => setForm({ ...form, scoringProfileVersionId: e.target.value })}>
                      <option value="">請選擇評分規則</option>
                      {scoring.filter((s) => s.status === 'active').map((s) => <option key={s.id} value={s.id}>{s.profileName} · v{s.versionNo}</option>)}
                    </select>
                  </Field>
                  <Field label="每題執行次數" hint="預設 1 次；增加次數可觀察回答穩定性，也會增加調用量。">
                    <input type="number" min={1} step={1} value={form.repeats} onChange={(e) => setForm({ ...form, repeats: Number(e.target.value) })} />
                  </Field>
                </div>
              </details>
              <div className="experiment-setup-summary" aria-live="polite">
                <strong>{selectedDataset ? `${selectedDataset.caseCount} 題` : '尚未選擇題目'} · {compare ? `${groupCount} 組對比` : '1 組測試'} · 每題 {form.repeats || 0} 次</strong>
                <span className="sm muted">{selectedDataset && Number.isInteger(form.repeats) && form.repeats >= 1 ? `預計 ${selectedDataset.caseCount * groupCount * form.repeats} 次 Agent 調用，另計 AI 評估。` : '完成選擇後會顯示預計調用量。'}</span>
                <span className="sm muted">評分：{scoring.find((s) => s.id === form.scoringProfileVersionId)?.profileName ?? '尚未選擇'}</span>
              </div>
            </section>
          </div>
        </Drawer>
      )}
    </div>
  )
}

/* ================= 詳情 ================= */

function shortHash(id: string): string {
  const suffix = id.split('_').pop() ?? id
  return suffix.slice(0, 6) || id.slice(0, 6)
}

export function ExperimentDetailPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<ExperimentDetail | null>(null)
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null)
  const [datasetVersions, setDatasetVersions] = useState<DatasetVersion[]>([])
  const [scoringVersions, setScoringVersions] = useState<ScoringVersion[]>([])
  const [run, setRun] = useState<RunState | null>(null)
  const [viewRunId, setViewRunId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [concurrency, setConcurrency] = useState(2)
  const [repeats, setRepeats] = useState(1)
  const [starting, setStarting] = useState(false)
  const pollRef = useRef<number | null>(null)
  const pageEpochRef = useRef(0)
  const loadSequenceRef = useRef(0)
  const hydratedConcurrencyRef = useRef<string | null>(null)
  const viewRunIdRef = useRef<string | null>(null)
  const startRef = useRef<() => void>(() => undefined)
  const toast = useToast()

  const load = async (requestedRunId: string | null = viewRunIdRef.current) => {
    const epoch = pageEpochRef.current
    const sequence = ++loadSequenceRef.current
    setError(null)
    try {
      const initialDetail = await api.experiment(id)
      const selectedRunId = requestedRunId ?? initialDetail.selectedRunId ?? initialDetail.runs[0]?.id ?? null
      const [detailData, metricsData, runs, datasets, scoring] = await Promise.all([
        selectedRunId ? api.experiment(id, selectedRunId) : Promise.resolve(initialDetail),
        api.metrics(id, selectedRunId ?? undefined),
        api.runs(id).catch(() => []),
        api.datasetVersions().catch(() => []),
        api.scoringVersions().catch(() => []),
      ])
      if (epoch !== pageEpochRef.current || sequence !== loadSequenceRef.current) return
      viewRunIdRef.current = selectedRunId
      setViewRunId(selectedRunId)
      setDetail(detailData)
      setMetrics(metricsData)
      setDatasetVersions(datasets)
      setScoringVersions(scoring)
      const latestRun = runs[0] ?? null
      setRun(latestRun)
      if (hydratedConcurrencyRef.current !== id || latestRun?.status === 'running' || latestRun?.status === 'paused') {
        setConcurrency(latestRun?.concurrency ?? 2)
        hydratedConcurrencyRef.current = id
      }
      setRepeats(detailData.frozen.repeats)
      if (latestRun?.status === 'running' || latestRun?.status === 'paused') poll(latestRun.id)
      else if (pollRef.current) window.clearTimeout(pollRef.current)
    } catch (e) {
      if (epoch === pageEpochRef.current && sequence === loadSequenceRef.current) setError((e as Error).message)
    }
  }

  useEffect(() => {
    pageEpochRef.current += 1
    viewRunIdRef.current = null
    hydratedConcurrencyRef.current = null
    setDetail(null)
    setRun(null)
    setStarting(false)
    void load(null)
    return () => {
      pageEpochRef.current += 1
      if (pollRef.current) window.clearTimeout(pollRef.current)
    }
  }, [id])

  useEffect(() => {
    const onRun = () => startRef.current()
    window.addEventListener('aeval:run', onRun)
    return () => window.removeEventListener('aeval:run', onRun)
  }, [])

  const poll = (runId: string) => {
    if (pollRef.current) window.clearTimeout(pollRef.current)
    const epoch = pageEpochRef.current
    pollRef.current = window.setTimeout(async () => {
      try {
        const state = await api.getRun(runId)
        if (epoch !== pageEpochRef.current || state.experimentId !== id) return
        setRun(state)
        if (state.status === 'running' || state.status === 'paused') poll(runId)
        else {
          window.dispatchEvent(new CustomEvent('aeval:experiments-changed'))
          load()
        }
      } catch {
        if (epoch === pageEpochRef.current) load()
      }
    }, 700)
  }

  if (error) {
    return (
      <Card>
        <ErrorState message={error} onRetry={load} />
      </Card>
    )
  }

  if (!detail) {
    return (
      <div className="stack-3">
        <SkeletonBlock height={28} width="30%" />
        <SkeletonBlock height={140} />
        <SkeletonBlock height={200} />
      </div>
    )
  }

  const totalTrials = detail.frozen.dataset.cases.length * detail.frozen.repeats * detail.branches.length
  const running = run?.status === 'running' || run?.status === 'paused'
  const datasetVersion = datasetVersions.find((version) => version.id === detail.frozen.dataset.versionId)
  const scoringVersion = scoringVersions.find((version) => version.id === detail.frozen.scoring.versionId)

  const start = async () => {
    if (detail?.frozen.externalConditions.composition === 'reuse') { toast.push('error', '這份報告由來源批次彙整，不需重新調用模型'); return }
    const epoch = pageEpochRef.current
    loadSequenceRef.current += 1
    setStarting(true)
    try {
      const state = await api.startRun(id, { concurrency, repeats })
      if (epoch !== pageEpochRef.current) return
      setRun(state)
      setConcurrency(state.concurrency)
      poll(state.id)
    } catch (e) {
      if (epoch === pageEpochRef.current) toast.push('error', (e as Error).message)
    } finally {
      if (epoch === pageEpochRef.current) setStarting(false)
    }
  }

  startRef.current = () => {
    if (!running && !starting) void start()
  }

  const control = async (action: 'pause' | 'resume' | 'cancel') => {
    if (!run) return
    const epoch = pageEpochRef.current
    try {
      const state =
        action === 'pause' ? await api.pauseRun(run.id) : action === 'resume' ? await api.resumeRun(run.id) : await api.cancelRun(run.id)
      if (epoch !== pageEpochRef.current) return
      setRun(state)
      if (action === 'resume' && state.status === 'running') poll(state.id)
      if (action === 'cancel') load()
    } catch (e) {
      if (epoch === pageEpochRef.current) toast.push('error', (e as Error).message)
    }
  }

  return (
    <div className="stack page-stack">
      <div className="page-head">
        <div>
          <div className="page-title">{detail.name}</div>
          <div className="page-sub">
            {experimentKindLabel(detail.kind)} · {detail.branches.length} 個分支 · 凍結於 {formatDateTime(detail.frozen.frozenAt)}
          </div>
        </div>
        <div className="page-actions">
          <Button onClick={() => navigate(`/report/${id}`)}>查看報告</Button>
        </div>
      </div>

      <Card title="凍結配置" subtitle="啟動時凍結，之後修改測試集或 Agent 配置不會影響此實驗。">
        <dl className="kv">
          <dt>測試集版本</dt>
          <dd>
            {datasetVersion ? `測試集 v${datasetVersion.versionNo}（${formatDateTime(datasetVersion.createdAt)}）` : '測試集版本'}{' '}
            <span className="mono dim" title={detail.frozen.dataset.versionId}>· {shortHash(detail.frozen.dataset.versionId)}</span>
          </dd>
          <dt>評分規則集版本</dt>
          <dd>
            {scoringVersion ? `評分規則集 v${scoringVersion.versionNo}（${formatDateTime(scoringVersion.createdAt)}）` : '評分規則集版本'}{' '}
            <span className="mono dim" title={detail.frozen.scoring.versionId}>· {shortHash(detail.frozen.scoring.versionId)}</span>
          </dd>
          <dt>重複次數 N</dt>
          <dd>{detail.frozen.repeats}</dd>
          <dt>分支</dt>
          <dd>
            {detail.frozen.branches.map((branch) => (
              <div key={branch.agentVersionId} className="row-tight">
                <span title={branch.agentVersionId}>{branch.config.name} · {branch.versionName || branch.config.versionInfo.model || '未命名'} · v{branch.agentVersionNo}（{roleLabel(branch.role)}）</span>
              </div>
            ))}
          </dd>
          <dt>樣本量</dt>
          <dd>
            {detail.frozen.dataset.cases.length} 條案例 · {totalTrials} 次試驗（預期）
          </dd>
        </dl>
      </Card>

      {detail.frozen.externalConditions.composition === 'reuse' && <Notice>{detail.frozen.externalConditions.sourceDescription} 此頁等待來源完成後彙整，不會自動重跑四組。</Notice>}
      <Card
        title="跑批控制"
        actions={
          <span className="row">
            <label className="row sm muted">
              並發
              <input
                type="number"
                min={1}
                max={16}
                value={running ? run.concurrency : concurrency}
                disabled={running || starting}
                onChange={(e) => setConcurrency(Math.max(1, Number(e.target.value)))}
                style={{ width: 72 }}
              />
            </label>
            <label className="row sm muted">
              重複 N
              <input
                type="number"
                min={1}
                max={20}
                value={repeats}
                disabled={running}
                onChange={(e) => setRepeats(Math.max(1, Number(e.target.value)))}
                style={{ width: 72 }}
              />
            </label>
            {!running && run?.status !== 'interrupted' && (
              <Button variant="primary" disabled={detail.frozen.externalConditions.composition === 'reuse'} loading={starting} loadingLabel="啟動中…" onClick={() => void start()}>
                開始批量
              </Button>
            )}
            {run?.status === 'running' && <Button onClick={() => void control('pause')}>暫停</Button>}
            {run?.status === 'paused' && <Button onClick={() => void control('resume')}>繼續</Button>}
            {run?.status === 'interrupted' && <Button onClick={() => void control('resume')}>繼續</Button>}
            {running && (
              <Button variant="ghost" onClick={() => void control('cancel')}>
                取消
              </Button>
            )}
          </span>
        }
      >
        {!run ? (
          <div className="sm muted">尚未啟動。預期 {totalTrials} 次試驗。</div>
        ) : (
          <div className="stack-3">
            <div className="run-status-row spread sm">
              <span>
                {run.status === 'interrupted'
                  ? `已中斷 · ${run.done}/${run.total} · 尚有 ${run.total - run.done} 條未跑，按「繼續」接續`
                  : `${statusText(run.status)} · ${run.done}/${run.total}`}
              </span>
              <span className="row">
                <Badge tone="ok">成功 {run.succeeded}</Badge>
                <Badge tone="err">失敗 {run.failed}</Badge>
                <Badge tone="warn">攔截 {run.blocked}</Badge>
              </span>
            </div>
            <div className="run-controls-row"><Progress value={(run.done / Math.max(1, run.total)) * 100} /></div>
          </div>
        )}
      </Card>

      <Card
        title="指標"
        subtitle="N/A 表示不可評測，不計入分母、不視為 0 分。樣本為去重後的案例數，試驗為實際執行次數（含重複 N 次），兩者可能不同。"
        actions={
          detail.runs.length > 0 ? (
            <RunSwitcher runs={detail.runs} value={viewRunId} onChange={(runId) => void load(runId)} />
          ) : null
        }
      >
        {metrics?.run?.source === 'legacy' && <Notice tone="warn">歷史批次：此批試驗建立於 run 歸屬功能上線前，指標可能不完整</Notice>}
        {!metrics ? (
          <SkeletonBlock height={160} />
        ) : (
          <div className="grid-branches">
            {metrics.branches.map((branch) => (
              <div key={branch.branchId} className="card" style={{ boxShadow: 'none' }}>
                <div className="spread" style={{ marginBottom: 12 }}>
                  <Badge tone={branch.role === 'baseline' ? 'accent' : 'muted'}>{roleLabel(branch.role)}</Badge>
                  <span className="sm muted">
                    樣本 {branch.metrics.samples} 個案例 · 試驗 {branch.metrics.trialCount} 次 · 攔截 {branch.metrics.blockedCount}
                  </span>
                </div>
                {naReasonSummary(branch.metrics.dimensionResults).map((summary) => (
                  <div key={summary.code} className="sm muted">
                    N/A：{summary.dimensions.join('、')}（{summary.reason}）
                  </div>
                ))}
                <table className="data metric-table">
                  <colgroup>
                    <col style={{ width: '46%' }} />
                    <col style={{ width: '20%' }} />
                    <col style={{ width: '34%' }} />
                  </colgroup>
                  <tbody>
                    {branch.metrics.dimensionResults.map((dim) => (
                      <tr key={dim.key}>
                        <td className="metric-label">{dim.label}</td>
                        <td className="right numeric">
                          {dim.na ? (
                            <span className="sm muted">N/A</span>
                          ) : (
                            <span>{formatPct(dim.value)}</span>
                          )}
                        </td>
                        <td className="muted sm">
                          {dim.na ? '' : `${dim.passedCases}/${dim.totalCases}`}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td className="metric-label">單次成功率</td>
                      <td className="right numeric">{formatPct(branch.metrics.stability.singleSuccessRate)}</td>
                      <td className="muted sm">
                        {branch.metrics.trialCount - branch.metrics.blockedCount} 次已發送
                      </td>
                    </tr>
                    <tr>
                      <td className="metric-label">重複成功比例</td>
                      <td className="right numeric">
                        {detail.frozen.repeats === 1 ? (
                          <span className="sm muted">不適用（N=1）</span>
                        ) : (
                          formatPct(branch.metrics.stability.repeatAllSuccessRatio)
                        )}
                      </td>
                      <td className="muted sm">N={detail.frozen.repeats}</td>
                    </tr>
                    <tr>
                      <td className="metric-label">資源消耗</td>
                      <td className="right numeric">
                        <span className="xs muted">
                          prompt {branch.metrics.resources.promptTokens ?? '未提供'} · completion{' '}
                          {branch.metrics.resources.completionTokens ?? '未提供'}
                        </span>
                      </td>
                      <td className="muted sm">
                        total {branch.metrics.resources.totalTokens ?? '未提供'}
                      </td>
                    </tr>
                    <tr>
                      <td className="metric-label" title="統計已發送的調用，包含失敗與超時等待；不含 AI 評審">調用耗時（含失敗等待）</td>
                      <td className="right numeric">平均 {formatMs(branch.metrics.efficiency.avgLatencyMs)}</td>
                      <td className="muted sm">P95 {formatMs(branch.metrics.efficiency.p95LatencyMs)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </Card>

      {metrics && metrics.branches.length >= 2 && (
        <Card title="A/B 對比" subtitle="以基線與實驗組的百分點差異比較各評測維度。">
          {metrics.run?.source === 'legacy' && <Notice tone="warn">歷史批次：此批試驗建立於 run 歸屬功能上線前，指標可能不完整</Notice>}
          <MetricCompare metrics={metrics} repeats={detail.frozen.repeats} />
        </Card>
      )}

      <Card title={`試驗記錄（${detail.trials.length}）`} subtitle="最近 20 條。">
        {detail.trials.length === 0 ? (
          <EmptyState title="還沒有試驗" description="按上方「開始批量」執行整套案例。" />
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>案例</th>
                <th>分支</th>
                <th>狀態</th>
                <th>評分</th>
                <th className="right" title="失敗時為等待耗時，不含 AI 評審">Agent 耗時</th>
                <th>時間</th>
              </tr>
            </thead>
            <tbody>
              {detail.trials.slice(0, 20).map((trial) => {
                const branch = detail.branches.find((b) => b.id === trial.branchId)
                return (
                  <tr key={trial.id}>
                    <td>
                      {trial.caseName}
                      <span className="xs muted"> · 第 {trial.repeatIndex} 次</span>
                    </td>
                    <td className="sm">{branch ? roleLabel(branch.role) : '—'}</td>
                    <td>
                      <Badge tone={trial.status === 'succeeded' ? 'ok' : trial.status === 'blocked' ? 'warn' : 'err'}>
                        {statusText(trial.status)}
                      </Badge>
                    </td>
                    <td className="sm">
                      {trial.score?.passed === null ? (
                        <span className="muted">N/A</span>
                      ) : trial.score?.passed ? (
                        '通過'
                      ) : trial.score ? (
                        '未通過'
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="right">{formatAgentTime(trial.latencyMs, trial.status)}</td>
                    <td className="muted sm">{formatDateTime(trial.createdAt)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}
