import { useEffect, useMemo, useState } from 'react'
import { RESPONSE_MAP_TEMPLATES, errorClassLabel, type AgentConfig, type PlatformType } from '../../../src/shared/types.ts'
import { api, type AgentDetail, type AgentSummary, type PreviewResult } from '../api.ts'
import { DataTable, type Column } from '../components/DataTable.tsx'
import {
  Badge,
  Breadcrumb,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Notice,
  PageTitle,
  SkeletonBlock,
  Stepper,
  useToast,
} from '../components/ui.tsx'
import { formatDateTime, formatMs, formatPct } from '../lib/format.ts'
import { PLATFORM_LABELS } from '../lib/labels.ts'
import { navigate } from '../lib/router.ts'

const BODY_TEMPLATE = '{\n  "input": "{{input}}",\n  "session_id": "{{sessionId}}"\n}'

const PRESETS: Record<string, { label: string; form: Partial<FormState> }> = {
  '/mock/oumi': {
    label: '工具型',
    form: {
      name: '本地模擬 Agent（工具型）',
      endpoint: 'http://127.0.0.1:5199/mock/oumi',
      outputPath: 'final_answer',
      statusPath: 'status',
      toolCallsPath: 'tool_calls',
      tracePath: 'trace',
      tokensPath: 'usage.total_tokens',
      model: 'metis-instruct（模擬）',
    },
  },
  '/mock/plain': {
    label: '純問答',
    form: {
      name: '本地模擬 Agent（純問答）',
      endpoint: 'http://127.0.0.1:5199/mock/plain',
      outputPath: 'final_answer',
      statusPath: 'status',
      toolCallsPath: '',
      tracePath: '',
      tokensPath: '',
      model: 'qwen（模擬）',
    },
  },
  '/mock/empty-tools': {
    label: '空工具調用',
    form: {
      name: '本地模擬 Agent（空工具）',
      endpoint: 'http://127.0.0.1:5199/mock/empty-tools',
      outputPath: 'final_answer',
      statusPath: 'status',
      toolCallsPath: 'tool_calls',
      tracePath: 'trace',
      tokensPath: 'usage.total_tokens',
      model: 'deepseek（模擬）',
    },
  },
}

interface FormState {
  name: string
  platformType: string
  endpoint: string
  authType: 'none' | 'api_key' | 'bearer' | 'header'
  authHeader: string
  secret: string
  bodyTemplate: string
  outputPath: string
  statusPath: string
  toolCallsPath: string
  tracePath: string
  tokensPath: string
  promptTokensPath: string
  completionTokensPath: string
  totalTokensPath: string
  targetType: 'Group' | 'Agent'
  targetId: string
  providerId: string
  model: string
  promptVersion: string
  frameworkVersion: string
  allowWrite: boolean
}

const EMPTY_FORM: FormState = {
  name: '',
  platformType: 'custom_http',
  endpoint: 'http://127.0.0.1:5199/mock/oumi',
  authType: 'none',
  authHeader: '',
  secret: '',
  bodyTemplate: BODY_TEMPLATE,
  outputPath: 'final_answer',
  statusPath: 'status',
  toolCallsPath: 'tool_calls',
  tracePath: 'trace',
  tokensPath: 'usage.total_tokens',
  promptTokensPath: '',
  completionTokensPath: '',
  totalTokensPath: '',
  targetType: 'Group',
  targetId: '',
  providerId: '',
  model: '',
  promptVersion: '',
  frameworkVersion: '',
  allowWrite: false,
}

function toConfig(form: FormState): { config: AgentConfig; error?: string } {
  let body: unknown
  try {
    body = JSON.parse(form.bodyTemplate)
  } catch {
    return { config: {} as AgentConfig, error: '請求 Body 不是合法 JSON' }
  }
  return {
    config: {
      name: form.name.trim(),
      platformType: form.platformType as PlatformType,
      endpoint: form.endpoint.trim(),
      authType: form.authType,
      authHeader: form.authHeader || undefined,
      requestTemplate: { method: 'POST', headers: {}, body },
      responseMap: {
        outputPath: form.outputPath.trim(),
        statusPath: form.statusPath.trim() || undefined,
        toolCallsPath: form.toolCallsPath.trim() || undefined,
        tracePath: form.tracePath.trim() || undefined,
        tokensPath: form.tokensPath.trim() || undefined,
        promptTokensPath: form.promptTokensPath.trim() || undefined,
        completionTokensPath: form.completionTokensPath.trim() || undefined,
        totalTokensPath: form.totalTokensPath.trim() || undefined,
      },
      targeting: form.platformType === 'oumi' && form.targetId.trim()
        ? {
            targetType: form.targetType,
            targetId: form.targetId.trim(),
            providerId: form.providerId.trim() || undefined,
          }
        : undefined,
      allowWrite: form.allowWrite,
      versionInfo: {
        model: form.model.trim() || undefined,
        promptVersion: form.promptVersion.trim() || undefined,
        frameworkVersion: form.frameworkVersion.trim() || undefined,
      },
    },
  }
}

/* ================= 列表 ================= */

export function AgentsListPage() {
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    setError(null)
    api
      .agents()
      .then(setAgents)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  const columns: Array<Column<AgentSummary>> = useMemo(
    () => [
      {
        key: 'name',
        title: '名稱',
        sortValue: (row) => row.name,
        render: (row) => <span>{row.name}</span>,
      },
      {
        key: 'platform',
        title: '平台',
        render: (row) => <span className="sm">{PLATFORM_LABELS[row.platformType] ?? row.platformType}</span>,
      },
      { key: 'versions', title: '版本數', align: 'right', sortValue: (row) => row.versions.length, render: (row) => row.versions.length },
      { key: 'trials', title: '最近試驗', align: 'right', sortValue: (row) => row.recentTrialCount, render: (row) => row.recentTrialCount },
      {
        key: 'pass',
        title: '最近通過率',
        align: 'right',
        sortValue: (row) => row.recentPassRate ?? -1,
        render: (row) => <span className={row.recentPassRate === null ? 'muted' : ''}>{formatPct(row.recentPassRate)}</span>,
      },
      {
        key: 'status',
        title: '狀態',
        render: (row) => (
          <span className="row-tight">
            {row.versions.some((v) => v.status === 'active') ? <Badge tone="ok">可用</Badge> : <Badge tone="muted">停用</Badge>}
            {row.allowWrite ? <Badge tone="warn">允許寫入</Badge> : null}
          </span>
        ),
      },
      {
        key: 'updated',
        title: '更新時間',
        sortValue: (row) => row.updatedAt,
        render: (row) => <span className="muted sm">{formatDateTime(row.updatedAt)}</span>,
      },
    ],
    [],
  )

  return (
    <div className="stack page-stack">
      <div className="page-head">
        <PageTitle lead="Agent" sub="接入、查看版本與最近試驗。改配置會產生新版本，舊版本不可刪除。" />
        <div className="page-actions">
          <Button variant="primary" onClick={() => navigate('/agents/new')}>
            接入 Agent
          </Button>
        </div>
      </div>

      <DataTable
        rows={agents}
        columns={columns}
        rowKey={(row) => row.id}
        searchText={(row) => `${row.name} ${row.endpoint}`}
        searchPlaceholder="搜尋 Agent 名稱或地址"
        loading={loading}
        error={error}
        onRetry={load}
        onRowClick={(row) => navigate(`/agents/${row.id}`)}
        filters={[
          {
            key: 'platform',
            label: '平台',
            options: Object.entries(PLATFORM_LABELS).map(([value, label]) => ({ value, label })),
            match: (row, value) => row.platformType === value,
          },
          {
            key: 'status',
            label: '狀態',
            options: [
              { value: 'active', label: '可用' },
              { value: 'disabled', label: '停用' },
            ],
            match: (row, value) =>
              value === 'active'
                ? row.versions.some((v) => v.status === 'active')
                : row.versions.every((v) => v.status !== 'active'),
          },
        ]}
        emptyTitle="還沒有接入任何 Agent"
        emptyDescription="接入後就能被任何測試集選為被測對象。"
        emptyAction={<Button variant="primary" onClick={() => navigate('/agents/new')}>接入第一個 Agent</Button>}
      />
    </div>
  )
}

/* ================= 詳情 ================= */

export function AgentDetailPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<AgentDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [disabling, setDisabling] = useState<string | null>(null)
  const toast = useToast()

  const load = () => {
    setError(null)
    api
      .agentDetail(id)
      .then(setDetail)
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

  if (!detail) {
    return (
      <div className="stack-3">
        <SkeletonBlock height={28} width="30%" />
        <SkeletonBlock height={120} />
        <SkeletonBlock height={160} />
      </div>
    )
  }

  const activeVersions = detail.versions.filter((v) => v.status === 'active')

  const disable = async (versionId: string) => {
    setDisabling(versionId)
    try {
      await api.disableVersion(id, versionId)
      toast.push('success', '版本已停用（不可刪除）')
      load()
    } catch (e) {
      toast.push('error', (e as Error).message)
    } finally {
      setDisabling(null)
    }
  }

  return (
    <div className="stack page-stack">
      <div className="page-head">
        <div>
          <div className="page-title">{detail.config.name}</div>
          <div className="page-sub">
            {PLATFORM_LABELS[detail.config.platformType] ?? detail.config.platformType} · 建立於 {formatDateTime(detail.createdAt)}
          </div>
        </div>
        <div className="page-actions">
          {activeVersions.length > 0 ? <Badge tone="ok">可用</Badge> : <Badge tone="muted">停用</Badge>}
          <Button onClick={() => navigate(`/agents/${id}/new-version`)}>基於此配置新增版本</Button>
        </div>
      </div>

      <Card title="配置">
        <dl className="kv">
          <dt>API 地址</dt>
          <dd className="mono">{detail.config.endpoint}</dd>
          <dt>認證</dt>
          <dd>
            {detail.config.authType === 'none'
              ? '無'
              : `${detail.config.authType}${detail.config.authHeader ? ` · ${detail.config.authHeader}` : ''} · ${detail.credentialMask ?? '未設定'}`}
          </dd>
          <dt>寫入權限</dt>
          <dd>{detail.config.allowWrite ? '允許寫入類操作' : '只讀（寫入類案例會被攔截）'}</dd>
          <dt>模型</dt>
          <dd>{detail.config.versionInfo.model ?? '未提供'}</dd>
          <dt>Prompt 版本</dt>
          <dd>{detail.config.versionInfo.promptVersion ?? '未提供'}</dd>
          <dt>框架版本</dt>
          <dd>{detail.config.versionInfo.frameworkVersion ?? '未提供'}</dd>
        </dl>
      </Card>

      <Card title={`版本（${detail.versions.length}）`} subtitle="已發佈版本不可修改，只能停用；實驗引用的是版本快照。">
        <table className="data">
          <thead>
            <tr>
              <th>版本</th>
              <th>狀態</th>
              <th>連線驗證</th>
              <th>變更</th>
              <th>建立時間</th>
              <th className="right">操作</th>
            </tr>
          </thead>
          <tbody>
            {detail.versions.map((version) => (
              <tr key={version.id}>
                <td>
                  <strong>v{version.versionNo}</strong>
                </td>
                <td>
                  <Badge tone={version.status === 'active' ? 'ok' : 'muted'}>{version.status === 'active' ? '啟用' : '已停用'}</Badge>
                </td>
                <td className="sm">
                  {version.validation ? (
                    version.validation.ok ? (
                      `通過 · ${formatMs(version.validation.latencyMs)}`
                    ) : (
                      <span className="muted">失敗 · {version.validation.errorClass ?? version.validation.reason}</span>
                    )
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="sm muted">{version.diff.map((d) => d.field).join('、') || '初始版本'}</td>
                <td className="muted sm">{formatDateTime(version.createdAt)}</td>
                <td className="actions">
                  {version.status === 'active' && (
                    <Button
                      size="sm"
                      variant="danger"
                      loading={disabling === version.id}
                      loadingLabel="停用中…"
                      onClick={() => void disable(version.id)}
                    >
                      停用
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="最近試驗" subtitle="最近 10 條，含評分結果。">
        {detail.recentTrials.length === 0 ? (
          <EmptyState title="還沒有試驗" description="建立實驗並跑一條，就能在這裡看到執行結果。" />
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>案例</th>
                <th>狀態</th>
                <th>評分</th>
                <th className="right">耗時</th>
                <th>時間</th>
              </tr>
            </thead>
            <tbody>
              {detail.recentTrials.map((trial) => (
                <tr key={trial.id}>
                  <td>{trial.caseName}</td>
                  <td>
                    <Badge tone={trial.status === 'succeeded' ? 'ok' : trial.status === 'blocked' ? 'warn' : 'err'}>
                      {trial.status === 'succeeded' ? '成功' : trial.status === 'blocked' ? '已攔截' : '失敗'}
                    </Badge>
                  </td>
                  <td className="sm">
                    {trial.scorePassed === null ? <span className="muted">N/A</span> : trial.scorePassed ? '通過' : '未通過'}
                  </td>
                  <td className="right">{formatMs(trial.latencyMs)}</td>
                  <td className="muted sm">{formatDateTime(trial.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}

/* ================= 三步接入 ================= */

export function AgentWizardPage({ agentId }: { agentId?: string }) {
  const [step, setStep] = useState(0)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [busy, setBusy] = useState<'' | 'preview' | 'save'>('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const toast = useToast()

  useEffect(() => {
    if (!agentId) return
    api
      .agentDetail(agentId)
      .then((detail) => {
        const config = detail.config
        setForm({
          name: config.name,
          platformType: config.platformType,
          endpoint: config.endpoint,
          authType: config.authType,
          authHeader: config.authHeader ?? '',
          secret: '',
          bodyTemplate: JSON.stringify(config.requestTemplate.body, null, 2),
          outputPath: config.responseMap.outputPath ?? '',
          statusPath: config.responseMap.statusPath ?? '',
          toolCallsPath: config.responseMap.toolCallsPath ?? '',
          tracePath: config.responseMap.tracePath ?? '',
          tokensPath: config.responseMap.tokensPath ?? '',
          promptTokensPath: config.responseMap.promptTokensPath ?? '',
          completionTokensPath: config.responseMap.completionTokensPath ?? '',
          totalTokensPath: config.responseMap.totalTokensPath ?? '',
          targetType: config.targeting?.targetType ?? 'Group',
          targetId: config.targeting?.targetId ?? '',
          providerId: config.targeting?.providerId ?? '',
          model: config.versionInfo.model ?? '',
          promptVersion: config.versionInfo.promptVersion ?? '',
          frameworkVersion: config.versionInfo.frameworkVersion ?? '',
          allowWrite: config.allowWrite,
        })
      })
      .catch((e: Error) => setLoadError(e.message))
  }, [agentId])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
    setPreview(null)
  }

  const validateStep1 = (): boolean => {
    const next: Record<string, string> = {}
    if (!form.name.trim()) next.name = '請填寫名稱'
    if (!form.endpoint.trim()) next.endpoint = '請填寫 API 地址'
    else if (!/^https?:\/\//.test(form.endpoint.trim())) next.endpoint = '地址需以 http:// 或 https:// 開頭'
    setErrors(next)
    return Object.keys(next).length === 0
  }

  const validateStep2 = (): boolean => {
    const next: Record<string, string> = {}
    try {
      JSON.parse(form.bodyTemplate)
    } catch {
      next.bodyTemplate = '請求 Body 不是合法 JSON'
    }
    if (!form.outputPath.trim()) next.outputPath = '最終回答路徑必填'
    setErrors(next)
    return Object.keys(next).length === 0
  }

  const runPreview = async () => {
    setBusy('preview')
    try {
      const { config, error } = toConfig(form)
      if (error) {
        setErrors({ bodyTemplate: error })
        return
      }
      const result = await api.previewAgent(config, form.secret || undefined, agentId)
      setPreview(result)
      if (result.ok) toast.push('success', `驗證通過 · ${formatMs(result.validation.latencyMs)}`)
      else toast.push('error', `驗證未通過：${result.validation.reason ?? '回應不符合映射'}`)
    } catch (e) {
      toast.push('error', (e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const save = async () => {
    setBusy('save')
    try {
      const { config, error } = toConfig(form)
      if (error) {
        setErrors({ bodyTemplate: error })
        return
      }
      if (agentId) {
        await api.updateAgent(agentId, config, form.secret || undefined)
        toast.push('success', '已產生新版本')
        navigate(`/agents/${agentId}`)
      } else {
        const created = await api.createAgent(config, form.secret || undefined)
        toast.push('success', '已接入，產生了 v1')
        navigate(`/agents/${created.id}`)
      }
    } catch (e) {
      toast.push('error', (e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const applyPreset = (path: string) => {
    const preset = PRESETS[path]
    if (!preset) return
    setForm((prev) => ({ ...prev, ...preset.form }))
    setPreview(null)
  }

  // 選平台即套用該平台的映射模板；模板路徑是佔位，實例到位後在第二步改值
  const applyPlatform = (platformType: PlatformType) => {
    const template = RESPONSE_MAP_TEMPLATES[platformType]
    setForm((prev) => ({
      ...prev,
      platformType,
      ...(platformType === 'oumi' ? {} : { targetType: 'Group' as const, targetId: '', providerId: '' }),
      ...(template
        ? {
            outputPath: template.outputPath,
            statusPath: template.statusPath,
            toolCallsPath: template.toolCallsPath,
            tracePath: template.tracePath,
            promptTokensPath: template.promptTokensPath,
            completionTokensPath: template.completionTokensPath,
            totalTokensPath: template.totalTokensPath,
            tokensPath: '',
          }
        : {}),
    }))
    setPreview(null)
  }

  const platformTemplate = RESPONSE_MAP_TEMPLATES[form.platformType]

  if (loadError) {
    return (
      <Card>
        <ErrorState message={loadError} onRetry={() => navigate('/agents')} />
      </Card>
    )
  }

  return (
    <div className="stack page-stack">

      <div className="page-head">
        <div>
          <div className="page-title">{agentId ? '新增 Agent 版本' : '接入 Agent'}</div>
          <div className="page-sub">先驗證連線，再做欄位映射，最後用一次真實請求驗證結果。</div>
        </div>
        <Stepper steps={['連線', '欄位映射', '驗證預覽']} current={step} />
      </div>

      {step === 0 && (
        <Card title="第一步：連線">
          {!agentId && (
            <div className="row sm" style={{ marginBottom: 12 }}>
              <span className="muted">快速填入：</span>
              {Object.entries(PRESETS).map(([path, preset]) => (
                <Button key={path} size="sm" onClick={() => applyPreset(path)}>
                  {preset.label}
                </Button>
              ))}
            </div>
          )}
          <div className="grid-2">
            <Field label="名稱" error={errors.name} hint="同一工作區內唯一">
              <input
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                className={errors.name ? 'invalid' : ''}
                placeholder="例如：客服 Agent（測試環境）"
              />
            </Field>
            <Field label="平台類型" hint="選 Oumi／Dify 會預填該平台的映射模板">
              <select value={form.platformType} onChange={(e) => applyPlatform(e.target.value as PlatformType)}>
                {Object.entries(PLATFORM_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="API 地址" error={errors.endpoint} hint="完整端點地址">
              <input
                value={form.endpoint}
                onChange={(e) => set('endpoint', e.target.value)}
                className={errors.endpoint ? 'invalid' : ''}
                placeholder="https://example.com/v1/agent/run"
              />
            </Field>
            {form.platformType === 'oumi' && (
              <>
                <Field label="targetType">
                  <select value={form.targetType} onChange={(e) => set('targetType', e.target.value as FormState['targetType'])}>
                    <option value="Group">Group</option>
                    <option value="Agent">Agent</option>
                  </select>
                </Field>
                <Field label="targetId" hint="填入 groupId；選 Agent 時填入 agentId">
                  <input value={form.targetId} onChange={(e) => set('targetId', e.target.value)} placeholder="填入 groupId" />
                </Field>
                <Field label="providerId（可選）" hint="不填則用該 group 的預設 provider">
                  <input value={form.providerId} onChange={(e) => set('providerId', e.target.value)} />
                </Field>
              </>
            )}
            <Field label="認證方式">
              <div className="row">
                <select value={form.authType} onChange={(e) => set('authType', e.target.value as FormState['authType'])}>
                  <option value="none">無</option>
                  <option value="api_key">API Key Header</option>
                  <option value="bearer">Bearer Token</option>
                  <option value="header">自定義 Header</option>
                </select>
                {form.authType !== 'none' && (
                  <input
                    value={form.authHeader}
                    onChange={(e) => set('authHeader', e.target.value)}
                    placeholder="Header 名稱"
                    aria-label="認證 Header 名稱"
                  />
                )}
              </div>
            </Field>
            <Field label="憑證" hint={agentId ? '留空表示沿用既有憑證（只寫不讀）' : '儲存後只顯示末 4 位'}>
              <input
                type="password"
                autoComplete="new-password"
                value={form.secret}
                onChange={(e) => set('secret', e.target.value)}
                placeholder="sk-…"
              />
            </Field>
            <Field label="寫入權限">
              <label className="checkbox">
                <input type="checkbox" checked={form.allowWrite} onChange={(e) => set('allowWrite', e.target.checked)} />
                允許該 Agent 執行寫入類請求
              </label>
            </Field>
          </div>
        </Card>
      )}

      {step === 1 && (
        <Card
          title="第二步：欄位映射"
          subtitle={form.platformType === 'oumi'
            ? '會話模式下 output/status 由適配器解析，這裡的路徑僅對自訂 HTTP 生效。'
            : '請求模板用 {{input}} {{sessionId}} {{caseName}} 佔位；回應路徑留空表示取不到，會記為 null。'}
        >
          {platformTemplate && (
            <div className="notice info" style={{ marginBottom: 12 }}>
              {platformTemplate.label} 映射模板：{platformTemplate.note}
            </div>
          )}
          <div className="grid-2">
            <Field label="請求 Body 模板" error={errors.bodyTemplate}>
              <textarea
                rows={10}
                className={`mono ${errors.bodyTemplate ? 'invalid' : ''}`}
                value={form.bodyTemplate}
                onChange={(e) => set('bodyTemplate', e.target.value)}
              />
            </Field>
            <div className="stack-3">
              <Field label="最終回答路徑" error={errors.outputPath} hint="必填，例如 final_answer 或 data.outputs.text">
                <input
                  className={errors.outputPath ? 'invalid' : ''}
                  value={form.outputPath}
                  onChange={(e) => set('outputPath', e.target.value)}
                />
              </Field>
              <div className="grid-2">
                <Field label="執行狀態路徑">
                  <input value={form.statusPath} onChange={(e) => set('statusPath', e.target.value)} />
                </Field>
                <Field label="工具調用路徑" hint="留空 = 取不到">
                  <input value={form.toolCallsPath} onChange={(e) => set('toolCallsPath', e.target.value)} />
                </Field>
                <Field label="Trace 路徑" hint="留空 = 取不到">
                  <input value={form.tracePath} onChange={(e) => set('tracePath', e.target.value)} />
                </Field>
                <Field label="Token 總量路徑">
                  <input value={form.tokensPath} onChange={(e) => set('tokensPath', e.target.value)} />
                </Field>
                <Field label="Prompt Token 路徑" hint="可空；留空報表標未提供">
                  <input value={form.promptTokensPath} onChange={(e) => set('promptTokensPath', e.target.value)} />
                </Field>
                <Field label="Completion Token 路徑" hint="可空">
                  <input value={form.completionTokensPath} onChange={(e) => set('completionTokensPath', e.target.value)} />
                </Field>
                <Field label="Token 明細總量路徑" hint="可空；優先於上方總量">
                  <input value={form.totalTokensPath} onChange={(e) => set('totalTokensPath', e.target.value)} />
                </Field>
              </div>
            </div>
          </div>
          <hr className="divider" style={{ margin: '16px 0' }} />
          <div className="grid-3">
            <Field label="模型（可空）">
              <input value={form.model} onChange={(e) => set('model', e.target.value)} placeholder="留空顯示「未提供」" />
            </Field>
            <Field label="Prompt 版本（可空）">
              <input value={form.promptVersion} onChange={(e) => set('promptVersion', e.target.value)} />
            </Field>
            <Field label="框架版本（可空）">
              <input value={form.frameworkVersion} onChange={(e) => set('frameworkVersion', e.target.value)} />
            </Field>
          </div>
        </Card>
      )}

      {step === 2 && (
        <Card
          title="第三步：驗證預覽"
          subtitle="按「發送測試請求」會真的呼叫一次該 Agent，並把五個映射欄位的解析結果列出來。"
          actions={
            <Button variant="primary" loading={busy === 'preview'} loadingLabel="請求中…" onClick={() => void runPreview()}>
              發送測試請求
            </Button>
          }
        >
          {!preview ? (
            <EmptyState title="尚未驗證" description="發送一次真實請求，確認連線與欄位映射都對。" />
          ) : (
            <div className="stack" style={{ gap: 16 }}>
              <Notice tone={preview.ok ? 'info' : 'warn'}>
                <div>
                  {preview.ok ? '驗證通過' : '驗證未通過'} · HTTP {preview.validation.httpStatus ?? '—'} ·{' '}
                  {formatMs(preview.validation.latencyMs)}
                  {preview.validation.errorClass ? ` · ${errorClassLabel(preview.validation.errorClass)}` : ''}
                </div>
                {preview.validation.reason && <div style={{ marginTop: 4 }}>{preview.validation.reason}</div>}
              </Notice>

              <div>
                <div className="section-title">映射解析結果</div>
                <table className="data">
                  <thead>
                    <tr>
                      <th>欄位</th>
                      <th>路徑</th>
                      <th>狀態</th>
                      <th>解析值</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.mappings.map((mapping) => (
                      <tr key={mapping.field}>
                        <td>{mapping.label}</td>
                        <td className="mono">{mapping.path || '—'}</td>
                        <td>
                          {mapping.status === 'ok' && <Badge tone="ok">已取得</Badge>}
                          {mapping.status === 'empty' && <Badge tone="info">明確為空</Badge>}
                          {mapping.status === 'missing' && <Badge tone="warn">取不到（null）</Badge>}
                          {mapping.status === 'unset' && <Badge tone="muted">未配置</Badge>}
                          {mapping.hint && (
                            <div className="xs dim" style={{ marginTop: 4, whiteSpace: 'normal' }}>
                              {mapping.hint}
                            </div>
                          )}
                        </td>
                        <td className="sm mono ellipsis" style={{ maxWidth: 420 }}>
                          {mapping.preview || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="grid-2">
                <div>
                  <div className="section-title">請求摘要</div>
                  <pre className="code">{preview.requestSummary || '（未發送）'}</pre>
                </div>
                <div>
                  <div className="section-title">回應摘要</div>
                  <pre className="code">{preview.rawSnippet || '（無回應內容）'}</pre>
                </div>
              </div>
            </div>
          )}
        </Card>
      )}

      <div className="spread">
        <Button variant="ghost" onClick={() => navigate('/agents')}>
          取消
        </Button>
        <div className="row">
          {step > 0 && (
            <Button onClick={() => setStep((s) => s - 1)} disabled={busy !== ''}>
              上一步
            </Button>
          )}
          {step === 0 && (
            <Button
              variant="primary"
              onClick={() => {
                if (validateStep1()) setStep(1)
              }}
            >
              下一步
            </Button>
          )}
          {step === 1 && (
            <Button
              variant="primary"
              onClick={() => {
                if (validateStep2()) setStep(2)
              }}
            >
              下一步
            </Button>
          )}
          {step === 2 && (
            <Button
              variant="primary"
              loading={busy === 'save'}
              loadingLabel="儲存中…"
              disabled={!preview?.ok}
              onClick={() => void save()}
            >
              {agentId ? '儲存為新版本' : '驗證並儲存'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
