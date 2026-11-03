import type { AgentConfig, CaseInput, NormalizedTrial, ValidationResult } from '../../src/shared/types.ts'
import type { AnswerEvaluationBatch, JudgeSettings } from '../../src/shared/ai-evaluation.ts'
import { notifyUnauthorized } from './lib/auth.ts'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init?.headers ?? {}) },
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    notifyUnauthorized(res.status)
    const error = new Error(data?.error ?? `請求失敗（${res.status}）`)
    ;(error as Error & { payload?: unknown; errors?: unknown; status?: number }).payload = data
    ;(error as Error & { errors?: unknown }).errors = data?.errors
    ;(error as Error & { status?: number }).status = res.status
    throw error
  }
  if (init?.method === 'POST' && (
    /^\/api\/experiments(?:\/[^/]+\/(?:run|trials))?$/.test(path) ||
    /^\/api\/runs\/[^/]+\/(?:pause|resume|cancel)$/.test(path)
  )) window.dispatchEvent(new CustomEvent('aeval:experiments-changed'))
  return data as T
}

export const api = {
  judgeSettings: () => request<JudgeSettings>('/api/ai-judge/settings'),
  saveJudgeSettings: (model: string, apiKey?: string) => request<JudgeSettings>('/api/ai-judge/settings', { method: 'PUT', body: JSON.stringify({ model, apiKey }) }),
  saveJudgeModel: (id: string | null, config: { name: string; model: string; endpoint: string; apiKey?: string }) => request<JudgeSettings>(id ? `/api/ai-judge/models/${encodeURIComponent(id)}` : '/api/ai-judge/models', { method: id ? 'PUT' : 'POST', body: JSON.stringify(config) }),
  activateJudgeModel: (id: string) => request<JudgeSettings>(`/api/ai-judge/models/${encodeURIComponent(id)}/activate`, { method: 'POST' }),
  testJudge: (profileId?: string) => request<{ ok: true }>('/api/ai-judge/test', { method: 'POST', body: JSON.stringify({ profileId }) }),
  answerEvaluations: (experimentId: string, runId: string) => request<AnswerEvaluationBatch[]>(`/api/experiments/${experimentId}/answer-evaluations?runId=${encodeURIComponent(runId)}`),
  startAnswerEvaluation: (experimentId: string, runId: string, retryBatchId?: string) => request<{ batchId: string }>(`/api/experiments/${experimentId}/answer-evaluations`, { method: 'POST', body: JSON.stringify({ runId, retryBatchId }) }),
  meta: () =>
    request<{
      keySource: string
      mockBase: string
      mockEndpoints: Array<{ path: string; hint: string }>
      platformTypes: Array<{ value: string; label: string; ready: boolean }>
      caseTypes: Array<[string, string]>
    }>('/api/meta'),

  overview: () => request<Overview>('/api/overview'),
  audit: (filter: { action?: string; targetType?: string; targetId?: string; limit?: number; offset?: number } = {}) => {
    const query = new URLSearchParams(Object.entries(filter).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))
    return request<{ rows: AuditRow[]; total: number }>(`/api/audit${query.size ? `?${query}` : ''}`)
  },
  agentDetail: (id: string) => request<AgentDetail>(`/api/agents/${id}`),
  previewAgent: (config: AgentConfig, secret?: string, agentId?: string, input?: string) =>
    request<PreviewResult>('/api/agents/preview', {
      method: 'POST',
      body: JSON.stringify({ config, secret, agentId, input }),
    }),
  testSetDetail: (id: string) => request<TestSetSummary>(`/api/test-sets/${id}`),

  agents: () => request<AgentSummary[]>('/api/agents'),
  validateAgent: (config: AgentConfig, secret?: string, agentId?: string) =>
    request<{ validation: ValidationResult }>('/api/agents/validate', {
      method: 'POST',
      body: JSON.stringify({ config, secret, agentId }),
    }),
  createAgent: (config: AgentConfig, secret?: string) =>
    request<{ id: string; versionId: string; validation: ValidationResult }>('/api/agents', {
      method: 'POST',
      body: JSON.stringify({ config, secret }),
    }),
  updateAgent: (id: string, config: AgentConfig, secret?: string) =>
    request<{ versionId: string; diff: Array<{ field: string; before: unknown; after: unknown }> }>(
      `/api/agents/${id}`,
      { method: 'POST', body: JSON.stringify({ config, secret }) },
    ),
  agentVersions: (id: string) =>
    request<{ versions: AgentVersion[]; credentialMask: string | null }>(`/api/agents/${id}/versions`),
  renameVersion: (agentId: string, versionId: string, versionName: string) =>
    request<{ versionName: string }>(`/api/agents/${agentId}/versions/${versionId}/name`, { method: 'PATCH', body: JSON.stringify({ versionName }) }),
  disableVersion: (agentId: string, versionId: string) =>
    request<{ ok: boolean }>(`/api/agents/${agentId}/versions/${versionId}/disable`, { method: 'POST' }),

  testSets: (view: 'active' | 'archived' | 'all' = 'active') => request<TestSetSummary[]>(`/api/test-sets?view=${view}`),
  archiveTestSet: (id: string, archived: boolean) => request<{ ok: true }>(`/api/test-sets/${id}/archive`, { method: 'POST', body: JSON.stringify({ archived }) }),
  createTestSet: (name: string, description: string, cases: Array<Omit<CaseInput, 'id'>>) =>
    request<{ id: string }>('/api/test-sets', {
      method: 'POST',
      body: JSON.stringify({ name, description, cases }),
    }),
  saveCases: (id: string, cases: Array<Omit<CaseInput, 'id'> & { id?: string }>) =>
    request<{ ok: boolean }>(`/api/test-sets/${id}/cases`, {
      method: 'PUT',
      body: JSON.stringify({ cases }),
    }),
  publish: (id: string) =>
    request<{ versionId: string; versionNo: number }>(`/api/test-sets/${id}/publish`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  importExcel: (input: { filename: string; dataBase64: string }) =>
    request<{ testSetId: string; imported: number }>('/api/test-sets/import-excel', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  datasetVersions: () => request<DatasetVersion[]>('/api/dataset-versions'),
  scoringVersions: () => request<ScoringVersion[]>('/api/scoring-profile-versions'),
  disableDatasetVersion: (id: string) =>
    request<{ ok: boolean }>(`/api/dataset-versions/${id}/disable`, { method: 'POST' }),

  experiments: (view: 'active' | 'archived' | 'all' = 'active') => request<ExperimentSummary[]>(`/api/experiments?view=${view}`),
  recentExperiments: () => request<ExperimentSummary[]>('/api/experiments/recent'),
  archiveExperiment: (id: string, archived: boolean) => request<{ ok: true }>(`/api/experiments/${id}/archive`, { method: 'POST', body: JSON.stringify({ archived }) }),
  createExperiment: (input: {
    name: string
    kind: 'A' | 'B'
    datasetVersionId: string
    scoringProfileVersionId: string
    repeats: number
    branches: Array<{ role: string; agentVersionId: string }>
    externalConditions?: Record<string, string>
  }) =>
    request<{ ok: true; experimentId: string }>('/api/experiments', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  experiment: (id: string, runId?: string) =>
    request<ExperimentDetail>(`/api/experiments/${id}${runId ? `?runId=${encodeURIComponent(runId)}` : ''}`),
  runTrial: (experimentId: string, caseId: string, branchId: string, repeatIndex: number) =>
    request<NormalizedTrial>(`/api/experiments/${experimentId}/trials`, {
      method: 'POST',
      body: JSON.stringify({ caseId, branchId, repeatIndex }),
    }),
  startRun: (experimentId: string, body: { repeats?: number; concurrency?: number; branchIds?: string[] }) =>
    request<RunState>(`/api/experiments/${experimentId}/run`, { method: 'POST', body: JSON.stringify(body) }),
  getRun: (runId: string) => request<RunState>(`/api/runs/${runId}`),
  runs: (experimentId: string) => request<RunState[]>(`/api/experiments/${experimentId}/runs`),
  cancelRun: (runId: string) => request<RunState>(`/api/runs/${runId}/cancel`, { method: 'POST' }),
  pauseRun: (runId: string) => request<RunState>(`/api/runs/${runId}/pause`, { method: 'POST' }),
  resumeRun: (runId: string) => request<RunState>(`/api/runs/${runId}/resume`, { method: 'POST' }),
  metrics: (experimentId: string, runId?: string) =>
    request<MetricsResponse>(`/api/experiments/${experimentId}/metrics${runId ? `?runId=${encodeURIComponent(runId)}` : ''}`),

  seed: () => request<{ seeded: boolean; experimentId: string | null; reason?: string }>('/api/demo/seed', {
    method: 'POST',
  }),
}

export interface AgentSummary {
  id: string
  name: string
  platformType: string
  endpoint: string
  authType: string
  allowWrite: boolean
  credentialMask: string | null
  versionInfo: Record<string, unknown>
  activeVersionId: string | null
  createdAt: string
  updatedAt: string
  recentTrialCount: number
  recentPassRate: number | null
  lastTrialAt: string | null
  versions: Array<{
    id: string
    versionNo: number
    versionName?: string
    model?: string | null
    status: string
    createdAt: string
    validation: ValidationResult | null
  }>
}

export interface AuditRow {
  id: string
  at: string
  actor: string
  action: string
  targetType: string
  targetId: string | null
  method: string
  path: string
  detail: Record<string, unknown>
}

export interface AgentDetail {
  id: string
  config: AgentConfig
  credentialMask: string | null
  createdAt: string
  versions: AgentVersion[]
  recentTrials: Array<{
    id: string
    caseName: string
    status: string
    latencyMs: number
    createdAt: string
    scorePassed: boolean | null
    scoreDimension: string | null
  }>
}

export interface PreviewResult {
  ok: boolean
  validation: ValidationResult
  requestSummary: string
  rawSnippet: string
  responseKeys: string
  mappings: Array<{
    field: string
    label: string
    path: string
    status: 'ok' | 'empty' | 'missing' | 'unset'
    preview: string
    hint: string
  }>
}

export interface Overview {
  counts: {
    agents: number
    testSets: number
    datasetVersions: number
    experiments: number
    trials: number
    reportsReady: number
  }
  recentExperiments: ExperimentSummary[]
  recentFailures: {
    experimentId: string | null
    experimentName: string | null
    total: number
    items: Array<{
      trialId: string
      caseName: string
      status: 'failed' | 'blocked'
      branchRole: string
      errorClass: string | null
      createdAt: string
    }>
  }
  attention: { notRun: number; failedTrials: number; blockedTrials: number }
}

export interface AgentVersion {
  id: string
  versionNo: number
  versionName?: string
  status: string
  createdAt: string
  diff: Array<{ field: string; before: unknown; after: unknown }>
  validation: ValidationResult | null
  snapshot: AgentConfig & { agentId: string; versionNo: number }
}

export interface TestSetSummary {
  id: string
  archived: boolean
  name: string
  description: string
  scope: string
  currentVersionId: string | null
  cases: CaseInput[]
  versions: Array<{
    id: string
    versionNo: number
    status: string
    caseCount: number
    scoringProfileVersionId: string
    createdAt: string
  }>
}

export interface DatasetVersion {
  id: string
  testSetId: string
  testSetName: string
  versionNo: number
  caseCount: number
  status: string
  scoringProfileVersionId: string
  createdAt: string
}

export interface ScoringVersion {
  id: string
  profileId: string
  profileName: string
  versionNo: number
  thresholds: Record<string, number>
  status: string
  createdAt: string
}

export interface ExperimentSummary {
  id: string
  archived: boolean
  lastRunAt: string | null
  name: string
  kind: string
  repeats: number
  status: string
  datasetVersionId: string
  scoringProfileVersionId: string
  createdAt: string
  branches: Array<{ id: string; role: string; agent_version_id: string }>
  trialCount: number
}

export interface RunState {
  id: string
  experimentId: string
  source: 'live' | 'legacy' | 'manual' | 'composed'
  status: 'running' | 'paused' | 'completed' | 'cancelled' | 'interrupted'
  total: number
  done: number
  succeeded: number
  failed: number
  blocked: number
  concurrency: number
  startedAt: string
  finishedAt: string | null
  lastError?: string
}

export interface RunSummary {
  repeats?: number
  id: string
  status: string
  source: 'live' | 'legacy' | 'manual' | 'composed'
  startedAt: string
  finishedAt: string | null
  total: number
  done: number
  succeeded: number
  failed: number
  blocked: number
}

export interface DimensionResult {
  key: string
  label: string
  value: number | null
  ci: { low: number; high: number } | null
  unit: string
  passedCases: number
  totalCases: number
  na: boolean
  naCode?: string | null
  naReason?: string
  sampleShort?: boolean
}

export interface ConclusionEvidence {
  caseId: string
  caseName: string
  verdict: 'passed' | 'failed' | 'unknown'
  unknownReason: string | null
  judgement: string
  priority: string
  reason: string | null
  owner: 'agent' | 'platform' | null
  hint: string | null
  expected: string
  actual: string
  regressed: boolean
}

export interface Conclusion {
  headline: string
  passedCases: number
  judgedCases: number
  totalCases: number
  unknownCases: number
  passRate: number | null
  passRateText: string
  sampleText: string
  deltaText: string
  deltaValue: number | null
  regressedCases: number
  improvedCases: number
  evidence: ConclusionEvidence[]
  unknownSummary: Array<{ label: string; hint: string; cases: number }>
}

export interface MetricsResponse {
  experimentId: string
  run: RunSummary | null
  previousRun: RunSummary | null
  repeats: number
  branches: Array<{
    branchId: string
    role: string
    conclusion: Conclusion | null
    metrics: {
      dimensionResults: DimensionResult[]
      naSummary: Array<{ code: string; label: string; dimensions: string[] }>
      samples: number
      trialCount: number
      blockedCount: number
      stability: { singleSuccessRate: number | null; singleSuccessRateCi: { low: number; high: number } | null; repeatAllSuccessRatio: number | null }
      efficiency: { avgLatencyMs: number | null; p95LatencyMs: number | null; samples: number }
      resources: {
        promptTokens: number | null
        completionTokens: number | null
        totalTokens: number | null
        samples: number
      }
    }
  }>
}

export interface ExperimentDetail {
  id: string
  name: string
  kind: string
  repeats: number
  status: string
  createdAt: string
  frozen: {
    frozenAt: string
    repeats: number
    scoring: { versionId: string; rules: unknown[]; thresholds: Record<string, number> }
    dataset: { versionId: string; cases: CaseInput[] }
    branches: Array<{
      role: string
      agentVersionId: string
      agentVersionNo: number
      versionName?: string
      config: AgentConfig
      variables: Record<string, string>
    }>
    externalConditions: Record<string, string>
  }
  branches: Array<{ id: string; role: string; agent_version_id: string; variables: Record<string, string> }>
  runs: RunSummary[]
  selectedRunId: string | null
  trials: Array<{
    id: string
    branchId: string
    caseId: string
    caseName: string
    caseType: string
    repeatIndex: number
    status: string
    latencyMs: number
    createdAt: string
    normalized: NormalizedTrial
    score: {
      dimension: string
      method: string
      passed: boolean | null
      rationale: string
      checks: Array<{ index: number; kind: string; pass: boolean | null; detail: string }>
    } | null
  }>
}
