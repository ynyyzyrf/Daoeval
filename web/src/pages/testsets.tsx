import { useEffect, useState } from 'react'
import type { CaseInput, CaseType } from '../../../src/shared/types.ts'
import { api, type ExperimentSummary, type ScoringVersion, type TestSetSummary } from '../api.ts'
import { DataTable, type Column } from '../components/DataTable.tsx'
import { ExcelImport } from '../components/ExcelImport.tsx'
import { ArchiveAction, ArchiveFilter } from '../components/ArchiveControls.tsx'
import {
  Badge,
  Breadcrumb,
  Button,
  Card,
  Drawer,
  EmptyState,
  ErrorState,
  Field,
  PageTitle,
  SkeletonBlock,
  useToast,
} from '../components/ui.tsx'
import { formatDateTime } from '../lib/format.ts'
import { CASE_TYPE_LABELS } from '../lib/labels.ts'
import { navigate } from '../lib/router.ts'

const CASE_TYPES = Object.entries(CASE_TYPE_LABELS)

interface CaseDraft {
  id?: string
  name: string
  type: CaseType
  input: string
  expected: string
  scoringRubric: string
  ruleText: string
  timeoutMs: number
  priority: 'high' | 'medium' | 'low'
  readWrite: 'read' | 'write'
}

function emptyDraft(): CaseDraft {
  return {
    id: undefined,
    name: '',
    type: 'basic_qa',
    input: '',
    expected: '',
    scoringRubric: '',
    ruleText: '',
    timeoutMs: 30000,
    priority: 'medium',
    readWrite: 'read',
  }
}

function draftFromCase(c: CaseInput): CaseDraft {
  return {
    id: c.id,
    name: c.name,
    type: c.type,
    input: c.input,
    expected: c.expected,
    scoringRubric: c.scoringRubric,
    ruleText: c.rule ? JSON.stringify(c.rule, null, 2) : '',
    timeoutMs: c.timeoutMs,
    priority: c.priority,
    readWrite: c.readWrite,
  }
}

/* ================= 列表 ================= */

export function TestSetsListPage() {
  const [archived, setArchived] = useState(false)
  const [sets, setSets] = useState<TestSetSummary[]>([])
  const [experiments, setExperiments] = useState<ExperimentSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [fieldError, setFieldError] = useState('')
  const toast = useToast()

  const load = () => {
    setLoading(true)
    setError(null)
    Promise.all([api.testSets('all'), api.experiments('all')])
      .then(([setList, expList]) => {
        setSets(setList)
        setExperiments(expList)
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  useEffect(() => {
    if (!highlightId) return
    const timer = window.setTimeout(() => setHighlightId(null), 1600)
    return () => window.clearTimeout(timer)
  }, [highlightId])

  const refreshAfterImport = (testSetId: string) => {
    setHighlightId(testSetId)
    load()
  }

  const create = async () => {
    if (!name.trim()) {
      setFieldError('請填寫名稱')
      return
    }
    setBusy(true)
    try {
      const created = await api.createTestSet(name.trim(), description.trim(), [])
      toast.push('success', '測試集已建立，接著加入案例')
      navigate(`/testsets/${created.id}`)
    } catch (e) {
      toast.push('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const columns: Array<Column<TestSetSummary>> = [
    {
      key: 'name',
      title: '名稱',
      sortValue: (row) => row.name,
      render: (row) => (
        <span className="stack-2" style={{ gap: 2 }}>
          <strong>{row.name}</strong>
          {row.description && <span className="xs muted ellipsis" style={{ maxWidth: 380 }}>{row.description}</span>}
        </span>
      ),
    },
    { key: 'cases', title: '案例數', align: 'right', sortValue: (row) => row.cases.length, render: (row) => row.cases.length },
    {
      key: 'version',
      title: '最新版本',
      sortValue: (row) => row.versions[0]?.versionNo ?? 0,
      render: (row) => (row.versions[0] ? <span>v{row.versions[0].versionNo}</span> : <span className="muted">未發佈</span>),
    },
    {
      key: 'published',
      title: '最後發佈',
      sortValue: (row) => row.versions[0]?.createdAt ?? '',
      render: (row) => <span className="muted sm">{formatDateTime(row.versions[0]?.createdAt)}</span>,
    },
    {
      key: 'scope',
      title: '適用範圍',
      render: (row) => <span className="sm">{row.scope === 'generic' ? '通用能力' : row.scope}</span>,
    },
    {
      key: 'refs',
      title: '被實驗引用',
      render: (row) => {
        const used = experiments.filter((exp) => row.versions.some((v) => v.id === exp.datasetVersionId))
        return used.length === 0 ? <span className="muted sm">未引用</span> : <Badge tone="info">{used.length} 個實驗</Badge>
      },
    },
    { key: 'archive', title: '操作', align: 'right', render: (row) => <ArchiveAction kind="test-set" item={row} onChanged={load} /> },
  ]

  return (
    <div className="stack page-stack">
      <div className="page-head">
        <PageTitle lead="測試集" sub="案例庫與不可變版本。發佈後修改需要建立新版本。" />
        <div className="page-actions">
          <Button onClick={() => setImporting(true)}>導入 Excel</Button>
          <Button variant="primary" onClick={() => setCreating(true)}>
            新建測試集
          </Button>
        </div>
      </div>

      <ArchiveFilter archived={archived} onChange={setArchived} items={sets} />
      {archived && <p className="sm muted">歸檔只隱藏測試集，案例、已發佈版本與實驗結果均保留，可隨時還原。</p>}
      <DataTable
        key={String(archived)}
        rows={sets.filter((item) => item.archived === archived)}
        columns={columns}
        rowKey={(row) => row.id}
        searchText={(row) => `${row.name} ${row.description}`}
        searchPlaceholder="搜尋測試集名稱"
        loading={loading}
        error={error}
        onRetry={load}
        onRowClick={(row) => navigate(`/testsets/${row.id}`)}
        highlightedId={highlightId}
        filters={[
          {
            key: 'published',
            label: '狀態',
            options: [
              { value: 'published', label: '已發佈' },
              { value: 'draft', label: '未發佈' },
            ],
            match: (row, value) => (value === 'published' ? row.versions.length > 0 : row.versions.length === 0),
          },
        ]}
        emptyTitle={archived ? '還沒有已歸檔的測試集' : '還沒有未歸檔的測試集'}
        emptyDescription={archived ? '在未歸檔列表點「歸檔」，項目便會移到這裡。' : '一個測試集包含若干案例與評分規則，發佈成版本後可被實驗引用。'}
        emptyAction={archived ? undefined : <Button variant="primary" onClick={() => setCreating(true)}>新建測試集</Button>}
      />

      {creating && (
        <Drawer
          title="新建測試集"
          onClose={() => setCreating(false)}
          footer={
            <>
              <Button onClick={() => setCreating(false)}>取消</Button>
              <Button variant="primary" loading={busy} loadingLabel="建立中…" onClick={() => void create()}>
                建立
              </Button>
            </>
          }
        >
          <Field label="名稱" error={fieldError}>
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setFieldError('')
              }}
              className={fieldError ? 'invalid' : ''}
              placeholder="例如：金融客服問答集"
              autoFocus
            />
          </Field>
          <Field label="描述" hint="可留空">
            <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </Drawer>
      )}
      {importing && <Drawer title="導入 Excel" onClose={() => setImporting(false)}><ExcelImport onImported={refreshAfterImport} /></Drawer>}
    </div>
  )
}

/* ================= 詳情 ================= */

export function TestSetDetailPage({ id }: { id: string }) {
  const [set, setSet] = useState<TestSetSummary | null>(null)
  const [experiments, setExperiments] = useState<ExperimentSummary[]>([])
  const [scoring, setScoring] = useState<ScoringVersion[]>([])
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [editing, setEditing] = useState<CaseDraft | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [importing, setImporting] = useState(false)
  const [busy, setBusy] = useState<'' | 'save' | 'publish'>('')
  const toast = useToast()

  const load = () => {
    setError(null)
    Promise.all([api.testSetDetail(id), api.experiments(), api.scoringVersions()])
      .then(([detail, expList, scoringList]) => {
        setSet(detail)
        setExperiments(expList)
        setScoring(scoringList)
      })
      .catch((e: Error) => setError(e.message))
  }

  useEffect(load, [id])

  if (error) {
    return (
      <Card>
        <ErrorState message={error} onRetry={load} />
      </Card>
    )
  }

  if (!set) {
    return (
      <div className="stack-3">
        <SkeletonBlock height={28} width="30%" />
        <SkeletonBlock height={200} />
      </div>
    )
  }

  const filteredCases = set.cases.filter((c) => {
    const matchQuery = !query.trim() || `${c.name} ${c.input}`.toLowerCase().includes(query.trim().toLowerCase())
    const matchType = !typeFilter || c.type === typeFilter
    return matchQuery && matchType
  })

  const persist = async (cases: CaseInput[]) => {
    setBusy('save')
    try {
      await api.saveCases(
        id,
        cases.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          input: c.input,
          expected: c.expected,
          scoringRubric: c.scoringRubric,
          rule: c.rule,
          timeoutMs: c.timeoutMs,
          multiTurn: c.multiTurn,
          priority: c.priority,
          readWrite: c.readWrite,
        })),
      )
      toast.push('success', '案例已儲存')
      load()
    } catch (e) {
      toast.push('error', (e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const saveDraft = async () => {
    if (!editing) return
    if (!editing.name.trim()) {
      toast.push('error', '案例名稱必填')
      return
    }
    let rule: CaseInput['rule'] = null
    if (editing.ruleText.trim()) {
      try {
        rule = JSON.parse(editing.ruleText) as CaseInput['rule']
      } catch {
        toast.push('error', '規則不是合法 JSON')
        return
      }
    }
    const next: CaseInput = {
      id: editing.id ?? `case_${crypto.randomUUID().slice(0, 12)}`,
      name: editing.name.trim(),
      type: editing.type,
      input: editing.input,
      expected: editing.expected,
      scoringRubric: editing.scoringRubric,
      rule,
      timeoutMs: Number(editing.timeoutMs) || 30000,
      multiTurn: null,
      priority: editing.priority,
      readWrite: editing.readWrite,
    }
    const cases = editing.id ? set.cases.map((c) => (c.id === editing.id ? next : c)) : [...set.cases, next]
    setEditing(null)
    await persist(cases)
  }

  const removeSelected = async () => {
    const cases = set.cases.filter((c) => !selected.includes(c.id))
    setSelected([])
    setConfirmDelete(false)
    await persist(cases)
  }

  const changeSelectedType = async (type: string) => {
    if (!type) return
    const cases = set.cases.map((c) => (selected.includes(c.id) ? { ...c, type: type as CaseType } : c))
    setSelected([])
    await persist(cases)
  }

  const publish = async () => {
    setBusy('publish')
    try {
      const result = await api.publish(id)
      toast.push('success', `已發佈不可變版本 v${result.versionNo}`)
      load()
    } catch (e) {
      toast.push('error', (e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const disableVersion = async (versionId: string) => {
    try {
      await api.disableDatasetVersion(versionId)
      toast.push('success', '版本已停用')
      load()
    } catch (e) {
      toast.push('error', (e as Error).message)
    }
  }

  return (
    <div className="stack page-stack">
      <div className="page-head">
        <div>
          <div className="page-title">{set.name}</div>
          <div className="page-sub">
            {set.cases.length} 條案例 · {set.versions.length} 個版本 · {set.description || '無描述'}
          </div>
        </div>
        <div className="page-actions">
          <Button onClick={() => setImporting(true)}>導入 Excel</Button>
          <Button variant="primary" loading={busy === 'publish'} loadingLabel="發佈中…" onClick={() => void publish()}>
            發佈新版本
          </Button>
        </div>
      </div>

      <Card
        title="案例"
        subtitle="編輯、批量選取；發佈前每條案例都需要評分標準（規則或 Rubric）。"
        actions={
          <div className="row">
            <Button size="sm" onClick={() => setEditing(emptyDraft())}>
              新增案例
            </Button>
          </div>
        }
      >
        {selected.length > 0 ? (
          <div className="bulk-bar">
            <span className="sm">已選 {selected.length} 條</span>
            <select
              value=""
              aria-label="批量改類型"
              onChange={(e) => void changeSelectedType(e.target.value)}
              disabled={busy === 'save'}
            >
              <option value="">改類型…</option>
              {CASE_TYPES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)} disabled={busy === 'save'}>
              刪除
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
              清除選取
            </Button>
          </div>
        ) : (
          <div className="table-toolbar" style={{ padding: '0 0 12px' }}>
            <input
              className="grow"
              placeholder="搜尋案例名稱或輸入"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="搜尋案例"
            />
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="案例類型">
              <option value="">類型：全部</option>
              {CASE_TYPES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        )}

        {filteredCases.length === 0 ? (
          <EmptyState
            title={set.cases.length === 0 ? '還沒有案例' : '沒有符合條件的案例'}
            description={set.cases.length === 0 ? '加入第一條案例，填寫輸入、預期結果與評分標準。' : undefined}
            action={
              set.cases.length === 0 ? (
                <Button variant="primary" onClick={() => setEditing(emptyDraft())}>
                  新增案例
                </Button>
              ) : undefined
            }
          />
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th style={{ width: 40 }}>
                  <input
                    type="checkbox"
                    aria-label="選取全部"
                    checked={filteredCases.length > 0 && filteredCases.every((c) => selected.includes(c.id))}
                    onChange={(e) => setSelected(e.target.checked ? filteredCases.map((c) => c.id) : [])}
                  />
                </th>
                <th>名稱</th>
                <th>類型</th>
                <th>讀寫</th>
                <th className="right">逾時</th>
                <th>優先級</th>
                <th className="right">操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredCases.map((c) => (
                <tr key={c.id} className={selected.includes(c.id) ? 'selected' : ''}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label="選取案例"
                      checked={selected.includes(c.id)}
                      onChange={(e) =>
                        setSelected((prev) => (e.target.checked ? [...prev, c.id] : prev.filter((x) => x !== c.id)))
                      }
                    />
                  </td>
                  <td>
                    <div className="stack-2" style={{ gap: 2 }}>
                      <strong>{c.name}</strong>
                      <span className="xs muted ellipsis" style={{ maxWidth: 420 }}>{c.input}</span>
                    </div>
                  </td>
                  <td className="sm">{CASE_TYPE_LABELS[c.type] ?? c.type}</td>
                  <td>
                    <span title={c.readWrite}>
                      <Badge tone={c.readWrite === 'write' ? 'warn' : 'muted'}>
                        {c.readWrite === 'write' ? '寫入' : '讀取'}
                      </Badge>
                    </span>
                  </td>
                  <td className="right sm">{c.timeoutMs} ms</td>
                  <td className="sm">{c.priority === 'high' ? '高' : c.priority === 'low' ? '低' : '中'}</td>
                  <td className="actions">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(draftFromCase(c))}>
                      編輯
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="版本" subtitle="已發佈版本不可修改；被實驗引用的版本只能停用，不能刪除。">
        {set.versions.length === 0 ? (
          <EmptyState title="還沒有發佈版本" description="案例準備好後發佈，實驗才能引用。" />
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>版本</th>
                <th className="right">案例數</th>
                <th>評分規則集版本</th>
                <th>被實驗引用</th>
                <th>發佈時間</th>
                <th className="right">操作</th>
              </tr>
            </thead>
            <tbody>
              {set.versions.map((version) => {
                const refs = experiments.filter((exp) => exp.datasetVersionId === version.id)
                const scoringVersion = scoring.find((s) => s.id === version.scoringProfileVersionId)
                return (
                  <tr key={version.id}>
                    <td>
                      <strong>v{version.versionNo}</strong>{' '}
                      <Badge tone={version.status === 'active' ? 'ok' : 'muted'}>
                        {version.status === 'active' ? '生效中' : '已停用'}
                      </Badge>
                    </td>
                    <td className="right">{version.caseCount}</td>
                    <td className="sm">
                      {scoringVersion ? `${scoringVersion.profileName} v${scoringVersion.versionNo}` : version.scoringProfileVersionId}
                    </td>
                    <td className="sm">{refs.length === 0 ? <span className="muted">未引用</span> : `${refs.length} 個實驗`}</td>
                    <td className="muted sm">{formatDateTime(version.createdAt)}</td>
                    <td className="actions">
                      {version.status === 'active' && (
                        <Button size="sm" variant="danger" onClick={() => void disableVersion(version.id)}>
                          停用
                        </Button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>

      {editing && (
        <Drawer
          title={editing.id ? '編輯案例' : '新增案例'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button onClick={() => setEditing(null)}>取消</Button>
              <Button variant="primary" loading={busy === 'save'} loadingLabel="儲存中…" onClick={() => void saveDraft()}>
                儲存
              </Button>
            </>
          }
        >
          <Field label="名稱">
            <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} autoFocus />
          </Field>
          <div className="grid-2">
            <Field label="類型">
              <select value={editing.type} onChange={(e) => setEditing({ ...editing, type: e.target.value as CaseType })}>
                {CASE_TYPES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="讀寫類型" hint="寫入類在只讀 Agent 上會被攔截">
              <select
                title={editing.readWrite}
                value={editing.readWrite}
                onChange={(e) => setEditing({ ...editing, readWrite: e.target.value as 'read' | 'write' })}
              >
                <option value="read">讀取</option>
                <option value="write">寫入</option>
              </select>
            </Field>
          </div>
          <Field label="測試輸入">
            <textarea rows={3} value={editing.input} onChange={(e) => setEditing({ ...editing, input: e.target.value })} />
          </Field>
          <Field label="預期結果">
            <textarea rows={2} value={editing.expected} onChange={(e) => setEditing({ ...editing, expected: e.target.value })} />
          </Field>
          <Field label="評分標準（Rubric）" hint="與規則至少填一項才能發佈">
            <textarea
              rows={2}
              value={editing.scoringRubric}
              onChange={(e) => setEditing({ ...editing, scoringRubric: e.target.value })}
            />
          </Field>
          <Field label="規則（JSON，可空）" hint='例如 [{"kind":"max_latency_ms","value":3000}]'>
            <textarea
              rows={4}
              className="mono"
              value={editing.ruleText}
              onChange={(e) => setEditing({ ...editing, ruleText: e.target.value })}
            />
          </Field>
          <div className="grid-2">
            <Field label="逾時（毫秒）">
              <input
                type="number"
                value={editing.timeoutMs}
                onChange={(e) => setEditing({ ...editing, timeoutMs: Number(e.target.value) })}
              />
            </Field>
            <Field label="優先級">
              <select
                value={editing.priority}
                onChange={(e) => setEditing({ ...editing, priority: e.target.value as CaseDraft['priority'] })}
              >
                <option value="high">高</option>
                <option value="medium">中</option>
                <option value="low">低</option>
              </select>
            </Field>
          </div>
        </Drawer>
      )}

      {confirmDelete && (
        <Drawer
          title={`刪除 ${selected.length} 條案例`}
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <Button onClick={() => setConfirmDelete(false)}>取消</Button>
              <Button variant="danger" loading={busy === 'save'} loadingLabel="刪除中…" onClick={() => void removeSelected()}>
                確認刪除
              </Button>
            </>
          }
        >
          <div className="sm">
            已選：{set.cases.filter((c) => selected.includes(c.id)).map((c) => c.name).slice(0, 5).join('、')}
            {selected.length > 5 ? ` 等 ${selected.length} 條` : ''}
          </div>
          <div className="notice info">
            {set.versions.length === 0
              ? '這個測試集還沒有發佈版本，刪除直接改動草稿。'
              : `已發佈的 ${set.versions.length} 個版本不會改變，刪除只作用於草稿；要讓改動生效需重新發佈，產生新版本。`}
          </div>
        </Drawer>
      )}
      {importing && <Drawer title="導入 Excel" onClose={() => setImporting(false)}><ExcelImport /></Drawer>}
    </div>
  )
}
