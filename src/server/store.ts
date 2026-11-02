import type {
  AgentConfig,
  AgentVersionSnapshot,
  CaseInput,
  NormalizedTrial,
  RuleSet,
  Thresholds,
  ValidationResult,
  VersionInfo,
} from '../shared/types.ts'
import { callAgent, configVersionOf } from './adapter.ts'
import { db, newId, nowIso } from './db.ts'
import { openSecret, sealSecret } from './crypto.ts'
import { scoreTrial } from './scoring.ts'

interface AgentRow {
  id: string
  name: string
  platform_type: string
  endpoint: string
  auth_type: string
  auth_header: string | null
  request_template: string
  response_map: string
  config_json: string
  targeting: string | null
  allow_write: number
  active_version_id: string | null
  archived: number
  created_at: string
}

interface VersionRow {
  id: string
  agent_id: string
  version_no: number
  snapshot: string
  diff: string
  status: string
  validation: string | null
  created_at: string
}

interface CaseRow {
  id: string
  test_set_id: string
  position: number
  name: string
  type: string
  input: string
  expected: string
  scoring_rubric: string
  rule: string | null
  judgement: string | null
  timeout_ms: number
  multi_turn: string | null
  priority: string
  read_write: string
  created_at: string
}

export interface DiffEntry {
  field: string
  before: unknown
  after: unknown
}

function parseJson<T>(text: string | null): T | null {
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

export interface AuditEntry {
  actor: string
  action: string
  targetType: string
  targetId?: string
  detail?: unknown
  method: string
  path: string
}

export interface AuditRow {
  id: string
  at: string
  actor: string
  action: string
  targetType: string
  targetId: string | null
  detail: Record<string, unknown>
  method: string
  path: string
}

const SENSITIVE_AUDIT_KEY = /secret|token|password|api[-_]?key|authorization|cipher|iv|tag/i

function sanitizeAuditDetail(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeAuditDetail)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      SENSITIVE_AUDIT_KEY.test(key) ? '***' : sanitizeAuditDetail(nested),
    ]))
  }
  return value
}

export function writeAudit(entry: AuditEntry): void {
  db.prepare(
    `INSERT INTO audit_log (id, at, actor, action, target_type, target_id, detail, method, path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId('audit'), nowIso(), entry.actor.slice(0, 64), entry.action, entry.targetType, entry.targetId ?? null,
    JSON.stringify(sanitizeAuditDetail(entry.detail ?? {})), entry.method, entry.path,
  )
}

export function listAudit(filter: { actionPrefix?: string; targetType?: string; targetId?: string; limit?: number; offset?: number } = {}): { rows: AuditRow[]; total: number } {
  const clauses: string[] = []
  const params: unknown[] = []
  if (filter.actionPrefix) { clauses.push('action LIKE ?'); params.push(`${filter.actionPrefix}%`) }
  if (filter.targetType) { clauses.push('target_type = ?'); params.push(filter.targetType) }
  if (filter.targetId) { clauses.push('target_id = ?'); params.push(filter.targetId) }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
  const limit = Math.min(200, Math.max(1, Number(filter.limit) || 50))
  const offset = Math.max(0, Number(filter.offset) || 0)
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM audit_log${where}`).get(...params) as { n: number }).n
  const rows = db.prepare(`SELECT * FROM audit_log${where} ORDER BY at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Array<{
    id: string; at: string; actor: string; action: string; target_type: string; target_id: string | null; detail: string; method: string; path: string
  }>
  return {
    total,
    rows: rows.map((row) => ({
      id: row.id, at: row.at, actor: row.actor, action: row.action, targetType: row.target_type, targetId: row.target_id,
      detail: parseJson<Record<string, unknown>>(row.detail) ?? {}, method: row.method, path: row.path,
    })),
  }
}

export function configFromRow(row: AgentRow): AgentConfig {
  return {
    name: row.name,
    platformType: row.platform_type as AgentConfig['platformType'],
    endpoint: row.endpoint,
    authType: row.auth_type as AgentConfig['authType'],
    authHeader: row.auth_header ?? undefined,
    requestTemplate: JSON.parse(row.request_template) as AgentConfig['requestTemplate'],
    responseMap: JSON.parse(row.response_map) as AgentConfig['responseMap'],
    allowWrite: row.allow_write === 1,
    versionInfo: (parseJson<VersionInfo>(row.config_json) ?? {}) as VersionInfo,
    targeting: row.targeting ? (JSON.parse(row.targeting) as AgentConfig['targeting']) : undefined,
  }
}

export function getAgentRow(id: string): AgentRow | undefined {
  return db.prepare('SELECT * FROM agent WHERE id = ?').get(id) as AgentRow | undefined
}

/**
 * 服務啟動時清理上次中斷遺留的 running 記錄。
 * 目前試驗只在完成後落庫，正常情況下不會有 running 行；保留此清理避免未來改成「先落 running 再執行」時卡死。
 */
export function sweepStaleTrials(): number {
  const result = db.prepare("UPDATE trial SET status = 'interrupted' WHERE status = 'running'").run()
  return result.changes
}

export type RunStatus = 'running' | 'paused' | 'completed' | 'cancelled' | 'interrupted'
export type RunSource = 'live' | 'legacy' | 'manual'
export type RunTaskStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'blocked'

export interface RunRow {
  id: string
  experiment_id: string
  source: RunSource
  status: RunStatus
  total: number
  done: number
  succeeded: number
  failed: number
  blocked: number
  concurrency: number
  repeats: number
  branch_ids: string
  started_at: string
  finished_at: string | null
  interrupted_at: string | null
  last_error: string | null
}

export interface RunTaskRow {
  id: string
  run_id: string
  case_id: string
  branch_id: string
  repeat_index: number
  trial_id: string | null
  status: RunTaskStatus
  error: string | null
  claimed_at: string | null
  finished_at: string | null
}

export function insertRun(row: Omit<RunRow, 'source' | 'done' | 'succeeded' | 'failed' | 'blocked' | 'finished_at' | 'interrupted_at' | 'last_error'> & { source?: RunSource }): void {
  db.prepare(
    `INSERT INTO run (id, experiment_id, source, status, total, concurrency, repeats, branch_ids, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.experiment_id, row.source ?? 'live', row.status, row.total, row.concurrency, row.repeats, row.branch_ids, row.started_at)
}

export function getRunRow(id: string): RunRow | undefined {
  return db.prepare('SELECT * FROM run WHERE id = ?').get(id) as RunRow | undefined
}

export function listRunRows(experimentId: string): RunRow[] {
  return db.prepare('SELECT * FROM run WHERE experiment_id = ? ORDER BY started_at DESC').all(experimentId) as RunRow[]
}

export function getLatestRunRow(experimentId: string): RunRow | undefined {
  return db.prepare('SELECT * FROM run WHERE experiment_id = ? ORDER BY started_at DESC LIMIT 1').get(experimentId) as RunRow | undefined
}

export function insertRunTasks(runId: string, tasks: Array<Pick<RunTaskRow, 'id' | 'case_id' | 'branch_id' | 'repeat_index'>>): void {
  const insert = db.prepare(
    'INSERT INTO run_task (id, run_id, case_id, branch_id, repeat_index) VALUES (?, ?, ?, ?, ?)',
  )
  db.transaction(() => {
    for (const task of tasks) insert.run(task.id, runId, task.case_id, task.branch_id, task.repeat_index)
  })()
}

/** 唯一可領取待跑任務的入口，交易保證同一任務不會被重複執行。 */
export function claimNextRunTask(runId: string, now: string): RunTaskRow | null {
  return db.transaction(() => {
    const candidate = db
      .prepare("SELECT id FROM run_task WHERE run_id = ? AND status = 'pending' ORDER BY rowid LIMIT 1")
      .get(runId) as { id: string } | undefined
    if (!candidate) return null
    const updated = db
      .prepare("UPDATE run_task SET status = 'running', claimed_at = ? WHERE id = ? AND status = 'pending'")
      .run(now, candidate.id)
    if (updated.changes !== 1) return null
    return db.prepare('SELECT * FROM run_task WHERE id = ?').get(candidate.id) as RunTaskRow
  })()
}

export function assignRunTaskTrialId(taskId: string, trialId: string): void {
  db.prepare("UPDATE run_task SET trial_id = ? WHERE id = ? AND status = 'running'").run(trialId, taskId)
}

export function finishRunTask(taskId: string, status: Extract<RunTaskStatus, 'succeeded' | 'failed' | 'blocked'>, error: string | null = null): void {
  db.prepare("UPDATE run_task SET status = ?, error = ?, finished_at = ? WHERE id = ? AND status = 'running'")
    .run(status, error, nowIso(), taskId)
}

export function updateRunCounters(runId: string): void {
  db.prepare(
    `UPDATE run
     SET done = (SELECT COUNT(*) FROM run_task WHERE run_id = ? AND status IN ('succeeded', 'failed', 'blocked')),
         succeeded = (SELECT COUNT(*) FROM run_task WHERE run_id = ? AND status = 'succeeded'),
         failed = (SELECT COUNT(*) FROM run_task WHERE run_id = ? AND status = 'failed'),
         blocked = (SELECT COUNT(*) FROM run_task WHERE run_id = ? AND status = 'blocked')
     WHERE id = ?`,
  ).run(runId, runId, runId, runId, runId)
}

export function setRunStatus(
  runId: string,
  status: RunStatus,
  extra: { lastError?: string | null; finishedAt?: string; interruptedAt?: string } = {},
): void {
  const finishedAt = extra.finishedAt ?? ((status === 'completed' || status === 'cancelled') ? nowIso() : null)
  const interruptedAt = extra.interruptedAt ?? (status === 'interrupted' ? nowIso() : null)
  db.prepare(
    `UPDATE run SET status = ?,
      finished_at = CASE WHEN ? IS NULL THEN finished_at ELSE ? END,
      interrupted_at = CASE WHEN ? IS NULL THEN interrupted_at ELSE ? END,
      last_error = CASE WHEN ? = 1 THEN ? ELSE last_error END
     WHERE id = ?`,
  ).run(status, finishedAt, finishedAt, interruptedAt, interruptedAt, extra.lastError === undefined ? 0 : 1, extra.lastError ?? null, runId)
}

export function countPendingTasks(runId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM run_task WHERE run_id = ? AND status = 'pending'").get(runId) as { n: number }).n
}

export function countTasksByStatus(runId: string): Record<RunTaskStatus, number> {
  const counts: Record<RunTaskStatus, number> = { pending: 0, running: 0, succeeded: 0, failed: 0, blocked: 0 }
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM run_task WHERE run_id = ? GROUP BY status').all(runId) as Array<{ status: RunTaskStatus; n: number }>
  for (const row of rows) counts[row.status] = row.n
  return counts
}

/** 啟動時保留中斷的執行，僅退回尚未確定完成的任務，絕不自動續跑。 */
export function recoverRunsAtStartup(): { interruptedRuns: number; requeuedTasks: number } {
  return db.transaction(() => {
    const runIds = new Set<string>()
    const activeRuns = db.prepare("SELECT id FROM run WHERE status IN ('running', 'paused')").all() as Array<{ id: string }>
    for (const row of activeRuns) runIds.add(row.id)
    const interruptedRuns = db.prepare("UPDATE run SET status = 'interrupted', interrupted_at = ? WHERE status IN ('running', 'paused')").run(nowIso()).changes

    const runningTasks = db.prepare("SELECT id, run_id, trial_id FROM run_task WHERE status = 'running'").all() as Array<Pick<RunTaskRow, 'id' | 'run_id' | 'trial_id'>>
    let requeuedTasks = 0
    for (const task of runningTasks) {
      runIds.add(task.run_id)
      const trial = task.trial_id
        ? (db.prepare('SELECT status FROM trial WHERE id = ?').get(task.trial_id) as { status: string } | undefined)
        : undefined
      if (trial) {
        const status: Extract<RunTaskStatus, 'succeeded' | 'failed' | 'blocked'> =
          trial.status === 'succeeded' ? 'succeeded' : trial.status === 'blocked' ? 'blocked' : 'failed'
        db.prepare("UPDATE run_task SET status = ?, finished_at = ? WHERE id = ? AND status = 'running'").run(status, nowIso(), task.id)
      } else {
        db.prepare("UPDATE run_task SET status = 'pending', claimed_at = NULL WHERE id = ? AND status = 'running'").run(task.id)
        requeuedTasks += 1
      }
    }
    for (const runId of runIds) updateRunCounters(runId)
    return { interruptedRuns, requeuedTasks }
  })()
}

export function getSecretForAgent(agentId: string): string | null {
  const row = db
    .prepare('SELECT cipher, iv, tag FROM agent_credential WHERE agent_id = ?')
    .get(agentId) as { cipher: string; iv: string; tag: string } | undefined
  if (!row) return null
  return openSecret(row)
}

export function getCredentialMask(agentId: string): string | null {
  const row = db.prepare('SELECT mask FROM agent_credential WHERE agent_id = ?').get(agentId) as
    | { mask: string }
    | undefined
  return row?.mask ?? null
}

export function listAgents() {
  const rows = db.prepare('SELECT * FROM agent WHERE archived = 0 ORDER BY created_at DESC').all() as AgentRow[]
  return rows.map((row) => {
    const versions = db
      .prepare('SELECT id, version_no, status, created_at, validation FROM agent_version WHERE agent_id = ? ORDER BY version_no DESC')
      .all(row.id) as Array<Pick<VersionRow, 'id' | 'version_no' | 'status' | 'created_at' | 'validation'>>
    const stats = db
      .prepare(
        `SELECT COUNT(*) AS n,
                SUM(CASE WHEN t.status = 'succeeded' AND (s.passed IS NULL OR s.passed = 1) THEN 1 ELSE 0 END) AS ok,
                MAX(t.created_at) AS last_at
         FROM trial t LEFT JOIN score s ON s.trial_id = t.id
         WHERE t.agent_version_id IN (SELECT id FROM agent_version WHERE agent_id = ?)`,
      )
      .get(row.id) as { n: number; ok: number | null; last_at: string | null }
    return {
      id: row.id,
      name: row.name,
      platformType: row.platform_type,
      endpoint: row.endpoint,
      authType: row.auth_type,
      allowWrite: row.allow_write === 1,
      credentialMask: getCredentialMask(row.id),
      versionInfo: parseJson<VersionInfo>(row.config_json) ?? {},
      activeVersionId: row.active_version_id,
      createdAt: row.created_at,
      updatedAt: versions[0]?.created_at ?? row.created_at,
      recentTrialCount: stats.n,
      recentPassRate: stats.n === 0 ? null : (stats.ok ?? 0) / stats.n,
      lastTrialAt: stats.last_at,
      versions: versions.map((v) => ({
        id: v.id,
        versionNo: v.version_no,
        status: v.status,
        createdAt: v.created_at,
        validation: parseJson<ValidationResult>(v.validation),
      })),
    }
  })
}

function diffConfig(before: AgentConfig, after: AgentConfig, credentialChanged: boolean): DiffEntry[] {  const diffs: DiffEntry[] = []
  const scalarFields: Array<keyof AgentConfig> = ['name', 'platformType', 'endpoint', 'authType', 'authHeader', 'allowWrite']
  for (const field of scalarFields) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
      diffs.push({ field, before: before[field] ?? null, after: after[field] ?? null })
    }
  }
  if (JSON.stringify(before.requestTemplate) !== JSON.stringify(after.requestTemplate)) {
    diffs.push({ field: 'requestTemplate', before: before.requestTemplate, after: after.requestTemplate })
  }
  if (JSON.stringify(before.responseMap) !== JSON.stringify(after.responseMap)) {
    diffs.push({ field: 'responseMap', before: before.responseMap, after: after.responseMap })
  }
  if (JSON.stringify(before.versionInfo) !== JSON.stringify(after.versionInfo)) {
    diffs.push({ field: 'versionInfo', before: before.versionInfo, after: after.versionInfo })
  }
  if (JSON.stringify(before.targeting ?? null) !== JSON.stringify(after.targeting ?? null)) {
    diffs.push({ field: 'targeting', before: before.targeting ?? null, after: after.targeting ?? null })
  }
  if (credentialChanged) {
    diffs.push({ field: 'credential', before: '****', after: '****' })
  }
  return diffs
}

function insertVersion(agentId: string, config: AgentConfig, diff: DiffEntry[], validation: ValidationResult): string {
  const versionId = newId('av')
  const versionNo =
    ((db.prepare('SELECT MAX(version_no) AS n FROM agent_version WHERE agent_id = ?').get(agentId) as { n: number | null }).n ?? 0) + 1
  const snapshot: AgentVersionSnapshot = { ...config, agentId, versionNo, createdAt: nowIso() }
  db.prepare(
    `INSERT INTO agent_version (id, agent_id, version_no, snapshot, diff, status, validation, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(
    versionId,
    agentId,
    versionNo,
    JSON.stringify(snapshot),
    JSON.stringify(diff),
    JSON.stringify(validation),
    nowIso(),
  )
  return versionId
}

export function createAgent(
  config: AgentConfig,
  secret: string | null,
  validation: ValidationResult,
): { id: string; versionId: string } {
  const existing = db.prepare('SELECT id FROM agent WHERE name = ?').get(config.name)
  if (existing) throw new Error(`Agent 名稱已存在：${config.name}`)
  const id = newId('ag')
  const createdAt = nowIso()
  db.prepare(
    `INSERT INTO agent (id, name, platform_type, endpoint, auth_type, auth_header, request_template, response_map, config_json, targeting, allow_write, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    config.name,
    config.platformType,
    config.endpoint,
    config.authType,
    config.authHeader ?? null,
    JSON.stringify(config.requestTemplate),
    JSON.stringify(config.responseMap),
    JSON.stringify(config.versionInfo),
    config.targeting ? JSON.stringify(config.targeting) : null,
    config.allowWrite ? 1 : 0,
    createdAt,
  )
  if (secret) saveCredential(id, secret)
  const versionId = insertVersion(id, config, [{ field: 'created', before: null, after: 'initial' }], validation)
  db.prepare('UPDATE agent SET active_version_id = ? WHERE id = ?').run(versionId, id)
  return { id, versionId }
}

export function updateAgent(
  agentId: string,
  config: AgentConfig,
  secret: string | null,
  validation: ValidationResult,
): { versionId: string; diff: DiffEntry[] } {
  const row = getAgentRow(agentId)
  if (!row) throw new Error('Agent 不存在')
  if (row.name !== config.name) {
    const clash = db.prepare('SELECT id FROM agent WHERE name = ? AND id <> ?').get(config.name, agentId)
    if (clash) throw new Error(`Agent 名稱已存在：${config.name}`)
  }
  const before = configFromRow(row)
  const credentialChanged = secret !== null
  const diff = diffConfig(before, config, credentialChanged)
  if (diff.length === 0) throw new Error('配置未變更，未產生新版本')
  db.prepare(
    `UPDATE agent SET name = ?, platform_type = ?, endpoint = ?, auth_type = ?, auth_header = ?,
       request_template = ?, response_map = ?, config_json = ?, targeting = ?, allow_write = ? WHERE id = ?`,
  ).run(
    config.name,
    config.platformType,
    config.endpoint,
    config.authType,
    config.authHeader ?? null,
    JSON.stringify(config.requestTemplate),
    JSON.stringify(config.responseMap),
    JSON.stringify(config.versionInfo),
    config.targeting ? JSON.stringify(config.targeting) : null,
    config.allowWrite ? 1 : 0,
    agentId,
  )
  if (secret) saveCredential(agentId, secret)
  const versionId = insertVersion(agentId, config, diff, validation)
  db.prepare('UPDATE agent SET active_version_id = ? WHERE id = ?').run(versionId, agentId)
  return { versionId, diff }
}

function saveCredential(agentId: string, secret: string): void {
  const sealed = sealSecret(secret)
  db.prepare(
    `INSERT INTO agent_credential (agent_id, cipher, iv, tag, mask, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET cipher = excluded.cipher, iv = excluded.iv, tag = excluded.tag,
       mask = excluded.mask, updated_at = excluded.updated_at`,
  ).run(agentId, sealed.cipher, sealed.iv, sealed.tag, sealed.mask, nowIso())
}

export function listAgentVersions(agentId: string) {
  const rows = db
    .prepare('SELECT * FROM agent_version WHERE agent_id = ? ORDER BY version_no DESC')
    .all(agentId) as VersionRow[]
  return rows.map((row) => ({
    id: row.id,
    versionNo: row.version_no,
    status: row.status,
    createdAt: row.created_at,
    diff: parseJson<DiffEntry[]>(row.diff) ?? [],
    validation: parseJson<ValidationResult>(row.validation),
    snapshot: JSON.parse(row.snapshot) as AgentVersionSnapshot,
  }))
}

export function getAgentVersion(versionId: string): VersionRow | undefined {
  return db.prepare('SELECT * FROM agent_version WHERE id = ?').get(versionId) as VersionRow | undefined
}

export function disableAgentVersion(versionId: string): void {
  db.prepare("UPDATE agent_version SET status = 'disabled' WHERE id = ?").run(versionId)
}

// ---- 測試集 ----

export type ArchiveView = 'active' | 'archived' | 'all'

export function setArchived(kind: 'test_set' | 'experiment', id: string, archived: boolean): boolean {
  return db.prepare(`UPDATE ${kind} SET archived = ? WHERE id = ?`).run(archived ? 1 : 0, id).changes > 0
}

export function listTestSets(view: ArchiveView = 'active') {
  const sets = db.prepare(`SELECT * FROM test_set ${view === 'all' ? '' : 'WHERE archived = ?'} ORDER BY created_at DESC`).all(...(view === 'all' ? [] : [view === 'archived' ? 1 : 0])) as Array<{
    id: string
    name: string
    description: string
    scope: string
    tags: string
    current_version_id: string | null
    created_at: string
    archived: number
  }>
  return sets.map((set) => {
    const cases = db.prepare('SELECT * FROM test_case WHERE test_set_id = ? ORDER BY position').all(set.id) as CaseRow[]
    const versions = db
      .prepare('SELECT id, version_no, status, case_count, scoring_profile_version_id, created_at FROM test_set_version WHERE test_set_id = ? ORDER BY version_no DESC')
      .all(set.id) as Array<{
      id: string
      version_no: number
      status: string
      case_count: number
      scoring_profile_version_id: string
      created_at: string
    }>
    return {
      id: set.id,
      archived: set.archived === 1,
      name: set.name,
      description: set.description,
      scope: set.scope,
      tags: parseJson<string[]>(set.tags) ?? [],
      currentVersionId: set.current_version_id,
      createdAt: set.created_at,
      cases: cases.map(rowToCase),
      versions: versions.map((v) => ({
        id: v.id,
        versionNo: v.version_no,
        status: v.status,
        caseCount: v.case_count,
        scoringProfileVersionId: v.scoring_profile_version_id,
        createdAt: v.created_at,
      })),
    }
  })
}

function rowToCase(row: CaseRow): CaseInput {
  return {
    id: row.id,
    name: row.name,
    type: row.type as CaseInput['type'],
    input: row.input,
    expected: row.expected,
    scoringRubric: row.scoring_rubric,
    rule: parseJson<RuleSet>(row.rule),
    judgement: parseJson<CaseInput['judgement']>(row.judgement) ?? undefined,
    timeoutMs: row.timeout_ms,
    multiTurn: parseJson<CaseInput['multiTurn']>(row.multi_turn),
    priority: row.priority as CaseInput['priority'],
    readWrite: row.read_write as CaseInput['readWrite'],
  }
}

export function createTestSet(input: {
  name: string
  description?: string
  scope?: string
  tags?: string[]
  cases?: Array<Omit<CaseInput, 'id'>>
}): string {
  const id = newId('ts')
  db.prepare(
    'INSERT INTO test_set (id, name, description, scope, tags, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, input.name, input.description ?? '', input.scope ?? 'generic', JSON.stringify(input.tags ?? []), nowIso())
  if (input.cases?.length) saveCases(id, input.cases)
  return id
}

export function saveCases(testSetId: string, cases: Array<Omit<CaseInput, 'id'> & { id?: string }>): void {
  const existing = db.prepare('SELECT id FROM test_case WHERE test_set_id = ?').all(testSetId) as Array<{ id: string }>
  const keep = new Set(cases.map((c) => c.id).filter(Boolean))
  for (const row of existing) {
    if (!keep.has(row.id)) db.prepare('DELETE FROM test_case WHERE id = ?').run(row.id)
  }
  const del = db.prepare('DELETE FROM test_case WHERE id = ?')
  const ins = db.prepare(
    `INSERT INTO test_case (id, test_set_id, position, name, type, input, expected, scoring_rubric, rule, judgement, timeout_ms, multi_turn, priority, read_write, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const upd = db.prepare(
    `UPDATE test_case SET position = ?, name = ?, type = ?, input = ?, expected = ?, scoring_rubric = ?,
     rule = ?, judgement = ?, timeout_ms = ?, multi_turn = ?, priority = ?, read_write = ? WHERE id = ?`,
  )
  cases.forEach((c, index) => {
    const payload = [
      index,
      c.name,
      c.type,
      c.input,
      c.expected,
      c.scoringRubric,
      c.rule ? JSON.stringify(c.rule) : null,
      c.judgement?.length ? JSON.stringify(c.judgement) : null,
      c.timeoutMs ?? 30000,
      c.multiTurn ? JSON.stringify(c.multiTurn) : null,
      c.priority ?? 'medium',
      c.readWrite ?? 'read',
    ] as const
    if (c.id) {
      upd.run(...payload, c.id)
      void del
    } else {
      ins.run(newId('case'), testSetId, ...payload, nowIso())
    }
  })
}

export function ensureDefaultScoringProfileVersion(): string {
  const total = db.prepare('SELECT COUNT(*) AS n FROM scoring_profile').get() as { n: number }
  if (total.n === 0) {
    const profileId = newId('sp')
    db.prepare('INSERT INTO scoring_profile (id, name, description, created_at) VALUES (?, ?, ?, ?)').run(
      profileId,
      '預設評分規則集',
      '骨架版：規則集為空，閾值取預設值',
      nowIso(),
    )
    const versionId = newId('spv')
    const thresholds: Thresholds = { taskCompletionRate: 0.8, minSamples: 20 }
    db.prepare(
      `INSERT INTO scoring_profile_version (id, profile_id, version_no, rules, thresholds, rubric, created_at)
       VALUES (?, ?, 1, ?, ?, '', ?)`,
    ).run(versionId, profileId, '[]', JSON.stringify(thresholds), nowIso())
    return versionId
  }
  const row = db
    .prepare('SELECT id FROM scoring_profile_version ORDER BY created_at DESC LIMIT 1')
    .get() as { id: string } | undefined
  if (!row) throw new Error('評分規則集版本缺失')
  return row.id
}

export function listScoringProfileVersions() {
  const rows = db
    .prepare(
      `SELECT spv.*, sp.name AS profile_name FROM scoring_profile_version spv
       JOIN scoring_profile sp ON sp.id = spv.profile_id ORDER BY spv.created_at DESC`,
    )
    .all() as Array<{
    id: string
    profile_id: string
    version_no: number
    thresholds: string
    status: string
    created_at: string
    profile_name: string
  }>
  return rows.map((r) => ({
    id: r.id,
    profileId: r.profile_id,
    profileName: r.profile_name,
    versionNo: r.version_no,
    thresholds: parseJson<Thresholds>(r.thresholds) ?? {},
    status: r.status,
    createdAt: r.created_at,
  }))
}

export function publishTestSet(
  testSetId: string,
  scoringProfileVersionId: string,
): { versionId: string; versionNo: number } {
  const cases = db.prepare('SELECT * FROM test_case WHERE test_set_id = ? ORDER BY position').all(testSetId) as CaseRow[]
  if (cases.length === 0) throw new Error('測試集為空，不能發佈版本')
  for (const row of cases) {
    const c = rowToCase(row)
    if (!c.scoringRubric && !c.rule) throw new Error(`案例「${c.name}」缺少評分標準，不能發佈`)
  }
  const scoring = db
    .prepare('SELECT * FROM scoring_profile_version WHERE id = ?')
    .get(scoringProfileVersionId) as { status: string } | undefined
  if (!scoring || scoring.status !== 'active') throw new Error('評分規則集版本不存在或已停用')

  const versionNo =
    ((db.prepare('SELECT MAX(version_no) AS n FROM test_set_version WHERE test_set_id = ?').get(testSetId) as { n: number | null }).n ?? 0) + 1
  const versionId = newId('tsv')
  const snapshot = {
    testSetId,
    versionNo,
    publishedAt: nowIso(),
    scoringProfileVersionId,
    cases: cases.map(rowToCase),
  }
  db.prepare(
    `INSERT INTO test_set_version (id, test_set_id, version_no, scoring_profile_version_id, snapshot, case_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(versionId, testSetId, versionNo, scoringProfileVersionId, JSON.stringify(snapshot), cases.length, nowIso())
  db.prepare('UPDATE test_set SET current_version_id = ? WHERE id = ?').run(versionId, testSetId)
  return { versionId, versionNo }
}

export function listDatasetVersions() {
  const rows = db
    .prepare(
      `SELECT tsv.*, ts.name AS set_name FROM test_set_version tsv
       JOIN test_set ts ON ts.id = tsv.test_set_id WHERE ts.archived = 0 ORDER BY tsv.created_at DESC`,
    )
    .all() as Array<{
    id: string
    test_set_id: string
    version_no: number
    case_count: number
    status: string
    created_at: string
    set_name: string
    scoring_profile_version_id: string
  }>
  return rows.map((r) => ({
    id: r.id,
    testSetId: r.test_set_id,
    testSetName: r.set_name,
    versionNo: r.version_no,
    caseCount: r.case_count,
    status: r.status,
    scoringProfileVersionId: r.scoring_profile_version_id,
    createdAt: r.created_at,
  }))
}

export function disableDatasetVersion(versionId: string): void {
  db.prepare("UPDATE test_set_version SET status = 'disabled' WHERE id = ?").run(versionId)
}

// ---- 實驗 ----

export interface GateInput {
  datasetVersionId: string
  scoringProfileVersionId: string
  repeats: number
  branches: Array<{ role: string; agentVersionId: string; variables?: Record<string, string> }>
}

export interface GateResult {
  ok: boolean
  missing: string[]
  datasetVersion?: { id: string; snapshot: { cases: CaseInput[] } }
  scoringProfileVersion?: { id: string; rules: string; thresholds: string; rubric: string }
}

export function evaluateGate(input: GateInput): GateResult {
  const missing: string[] = []
  const dv = db.prepare('SELECT * FROM test_set_version WHERE id = ?').get(input.datasetVersionId) as
    | { id: string; status: string; snapshot: string }
    | undefined
  if (!dv) missing.push('測試集版本不存在')
  else if (dv.status !== 'active') missing.push('測試集版本已停用')

  const spv = db.prepare('SELECT * FROM scoring_profile_version WHERE id = ?').get(input.scoringProfileVersionId) as
    | { id: string; status: string; rules: string; thresholds: string; rubric: string }
    | undefined
  if (!spv) missing.push('評分規則集版本不存在')
  else if (spv.status !== 'active') missing.push('評分規則集版本已停用')

  if (!Number.isInteger(input.repeats) || input.repeats < 1) missing.push('重複次數 N 必須 >= 1')

  for (const branch of input.branches) {
    const version = getAgentVersion(branch.agentVersionId)
    if (!version) missing.push(`分支 ${branch.role} 的 Agent 版本不存在`)
    else if (version.status !== 'active') missing.push(`分支 ${branch.role} 的 Agent 版本已停用`)
  }

  return {
    ok: missing.length === 0,
    missing,
    datasetVersion: dv ? { id: dv.id, snapshot: JSON.parse(dv.snapshot) } : undefined,
    scoringProfileVersion: spv
      ? { id: spv.id, rules: spv.rules, thresholds: spv.thresholds, rubric: spv.rubric }
      : undefined,
  }
}

export function createExperiment(input: GateInput & { name: string; kind: 'A' | 'B'; externalConditions?: Record<string, string> }) {
  const gate = evaluateGate(input)
  if (!gate.ok) return { ok: false as const, missing: gate.missing }
  const id = newId('exp')
  const cases = gate.datasetVersion!.snapshot.cases
  const branches = input.branches.map((branch) => {
    const version = getAgentVersion(branch.agentVersionId)!
    return {
      id: newId('br'),
      role: branch.role,
      agentVersionId: branch.agentVersionId,
      variables: branch.variables ?? {},
      agentSnapshot: JSON.parse(version.snapshot),
    }
  })
  const frozen = {
    frozenAt: nowIso(),
    repeats: input.repeats,
    scoring: {
      versionId: gate.scoringProfileVersion!.id,
      rules: JSON.parse(gate.scoringProfileVersion!.rules) as RuleSet,
      thresholds: JSON.parse(gate.scoringProfileVersion!.thresholds) as Thresholds,
      rubric: gate.scoringProfileVersion!.rubric,
    },
    dataset: { versionId: gate.datasetVersion!.id, cases },
    branches: branches.map((b) => ({
      role: b.role,
      agentVersionId: b.agentVersionId,
      agentVersionNo: b.agentSnapshot.versionNo,
      config: b.agentSnapshot as AgentConfig,
      variables: b.variables,
    })),
    externalConditions: input.externalConditions ?? {},
  }
  db.prepare(
    `INSERT INTO experiment (id, name, kind, dataset_version_id, scoring_profile_version_id, repeats, status, external_conditions, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
  ).run(
    id,
    input.name,
    input.kind,
    input.datasetVersionId,
    input.scoringProfileVersionId,
    input.repeats,
    JSON.stringify(input.externalConditions ?? {}),
    nowIso(),
  )
  for (const b of branches) {
    db.prepare('INSERT INTO experiment_branch (id, experiment_id, role, agent_version_id, variables) VALUES (?, ?, ?, ?, ?)').run(
      b.id,
      id,
      b.role,
      b.agentVersionId,
      JSON.stringify(b.variables),
    )
  }
  db.prepare('INSERT INTO experiment_snapshot (id, experiment_id, frozen, created_at) VALUES (?, ?, ?, ?)').run(
    newId('snap'),
    id,
    JSON.stringify(frozen),
    nowIso(),
  )
  return { ok: true as const, experimentId: id }
}

export function listExperiments(view: ArchiveView = 'active') {
  const rows = db.prepare(`
    SELECT e.*, r.started_at AS last_run_at, r.status AS last_run_status, r.failed AS last_run_failed
    FROM experiment e LEFT JOIN run r ON r.id = (
      SELECT latest.id FROM run latest WHERE latest.experiment_id = e.id ORDER BY latest.started_at DESC, latest.id DESC LIMIT 1
    )
    ${view === 'all' ? '' : 'WHERE e.archived = ?'} ORDER BY e.created_at DESC
  `).all(...(view === 'all' ? [] : [view === 'archived' ? 1 : 0])) as Array<{
    id: string
    name: string
    kind: string
    repeats: number
    status: string
    dataset_version_id: string
    scoring_profile_version_id: string
    created_at: string
    archived: number
    last_run_at: string | null
    last_run_status: string | null
    last_run_failed: number | null
  }>
  return rows.map((r) => ({
    id: r.id,
    archived: r.archived === 1,
    name: r.name,
    kind: r.kind,
    repeats: r.repeats,
    lastRunAt: r.last_run_at,
    status: (() => {
      if (r.last_run_status) return r.last_run_status === 'completed' && (r.last_run_failed ?? 0) > 0 ? 'partial_failed' : r.last_run_status
      const stats = db
        .prepare(
          `SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
           FROM trial WHERE experiment_id = ?`,
        )
        .get(r.id) as { n: number; failed: number | null }
      if (stats.n === 0) return 'ready'
      return (stats.failed ?? 0) > 0 ? 'partial_failed' : 'completed'
    })(),
    datasetVersionId: r.dataset_version_id,
    scoringProfileVersionId: r.scoring_profile_version_id,
    createdAt: r.created_at,
    branches: db
      .prepare('SELECT id, role, agent_version_id FROM experiment_branch WHERE experiment_id = ?')
      .all(r.id) as Array<{ id: string; role: string; agent_version_id: string }>,
    trialCount: (db.prepare('SELECT COUNT(*) AS n FROM trial WHERE experiment_id = ?').get(r.id) as { n: number }).n,
  }))
}

export function listRecentExperiments() {
  return listExperiments()
    .sort((a, b) => (b.lastRunAt ?? b.createdAt).localeCompare(a.lastRunAt ?? a.createdAt) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, 5)
}

type TrialWithScoreRow = {
  id: string; branch_id: string; case_id: string; case_name: string; case_type: string; repeat_index: number; status: string; latency_ms: number; normalized: string; created_at: string
  score_passed: number | null; score_rationale: string | null; score_checks: string | null; score_dimension: string | null; score_method: string | null
}

function trialRows(where: string, value: string): TrialWithScoreRow[] {
  return db.prepare(
    `SELECT t.*, s.passed AS score_passed, s.rationale AS score_rationale, s.checks AS score_checks,
            s.dimension AS score_dimension, s.method AS score_method
     FROM trial t LEFT JOIN score s ON s.trial_id = t.id WHERE ${where} ORDER BY t.created_at ASC`,
  ).all(value) as TrialWithScoreRow[]
}

function normalizeTrialRows(trials: TrialWithScoreRow[]) {
  return trials.map((t) => ({
    id: t.id, branchId: t.branch_id, caseId: t.case_id, caseName: t.case_name, caseType: t.case_type,
    repeatIndex: t.repeat_index, status: t.status, latencyMs: t.latency_ms, createdAt: t.created_at, normalized: JSON.parse(t.normalized),
    score: t.score_dimension === null ? null : {
      dimension: t.score_dimension, method: t.score_method, passed: t.score_passed === null ? null : t.score_passed === 1,
      rationale: t.score_rationale, checks: parseJson<unknown[]>(t.score_checks) ?? [],
    },
  }))
}

export function getRunTrials(runId: string) { return normalizeTrialRows(trialRows('t.run_id = ?', runId)) }

export function getRunSummary(runId: string) {
  const row = getRunRow(runId)
  return row ? { id: row.id, status: row.status, source: row.source, startedAt: row.started_at, finishedAt: row.finished_at, total: row.total, done: row.done, succeeded: row.succeeded, failed: row.failed, blocked: row.blocked } : null
}

export function pickMetricsRun(experimentId: string): RunRow | null {
  return (db.prepare("SELECT * FROM run WHERE experiment_id = ? ORDER BY CASE WHEN status = 'completed' THEN 0 ELSE 1 END, started_at DESC LIMIT 1").get(experimentId) as RunRow | undefined) ?? null
}

export function getExperiment(id: string, runId?: string) {
  const row = db.prepare('SELECT * FROM experiment WHERE id = ?').get(id) as
    | { id: string; name: string; kind: string; repeats: number; status: string; created_at: string }
    | undefined
  if (!row) return null
  const frozen = db.prepare('SELECT frozen FROM experiment_snapshot WHERE experiment_id = ?').get(id) as { frozen: string }
  const branches = db.prepare('SELECT * FROM experiment_branch WHERE experiment_id = ?').all(id) as Array<{
    id: string
    role: string
    agent_version_id: string
    variables: string
  }>
  const trials = runId ? getRunTrials(runId) : normalizeTrialRows(trialRows('t.experiment_id = ?', id))
  const runs = listRunRows(id).map((run) => getRunSummary(run.id)!)
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    repeats: row.repeats,
    status: row.status,
    createdAt: row.created_at,
    frozen: JSON.parse(frozen.frozen),
    branches: branches.map((b) => ({ ...b, variables: JSON.parse(b.variables) })),
    trials,
    runs,
    selectedRunId: runId ?? null,
  }
}

export async function runSingleTrial(experimentId: string, caseId: string, branchId: string, repeatIndex = 1, trialId?: string, runId?: string) {
  const experiment = getExperiment(experimentId)
  if (!experiment) throw new Error('實驗不存在')
  const branch = experiment.branches.find((b) => b.id === branchId)
  if (!branch) throw new Error('分支不存在')
  const caseInput = (experiment.frozen.dataset.cases as CaseInput[]).find((c) => c.id === caseId)
  if (!caseInput) throw new Error('案例不在該實驗凍結的測試集快照內')

  const agentVersion = getAgentVersion(branch.agent_version_id)
  if (!agentVersion) throw new Error('Agent 版本不存在')
  const versionSnapshot = JSON.parse(agentVersion.snapshot) as AgentVersionSnapshot

  const sessionId = newId('sess')
  const configVersion = configVersionOf({
    agentVersionId: agentVersion.id,
    agentVersionNo: agentVersion.version_no,
    config: versionSnapshot,
  })

  // FR-43：案例讀寫類型與 Agent 寫入標記取「與」，任一為 read 即只讀；寫入類案例在只讀模式下不發請求
  const readOnlyBlocked = caseInput.readWrite === 'write' && !versionSnapshot.allowWrite

  let normalized: NormalizedTrial
  let requestSummary: string

  if (readOnlyBlocked) {
    requestSummary = '未發送：只讀攔截'
    normalized = {
      input: caseInput.input,
      finalOutput: null,
      status: 'blocked',
      latencyMs: 0,
      error: {
        class: 'blocked_readonly',
        message: `案例讀寫類型為 write，Agent「${versionSnapshot.name}」未標記允許寫入，平台已攔截、未向被測方發送請求`,
      },
      configVersion,
      toolCalls: { status: 'unavailable', value: null },
      trace: { status: 'unavailable', value: null },
      tokens: { status: 'unavailable', value: null },
      tokenUsage: {
        prompt: { status: 'unavailable', value: null },
        completion: { status: 'unavailable', value: null },
        total: { status: 'unavailable', value: null },
      },
      sessionId,
      httpStatus: null,
      rawSnippet: '',
    }
  } else {
    const secret = getSecretForAgent(versionSnapshot.agentId)
    const outcome = await callAgent({
      config: versionSnapshot,
      secret,
      input: caseInput.input,
      sessionId,
      caseName: caseInput.name,
      timeoutMs: caseInput.timeoutMs,
    })
    requestSummary = outcome.requestSummary
    normalized = {
      input: caseInput.input,
      finalOutput: outcome.finalOutput,
      status: outcome.status,
      latencyMs: outcome.latencyMs,
      error: outcome.error,
      configVersion,
      toolCalls: outcome.toolCalls,
      trace: outcome.trace,
      tokens: outcome.tokens,
      tokenUsage: outcome.tokenUsage,
      sessionId,
      httpStatus: outcome.httpStatus,
      rawSnippet: outcome.rawSnippet,
    }
  }

  const insertedTrialId = trialId ?? newId('trial')
  db.prepare(
    `INSERT INTO trial (id, experiment_id, run_id, branch_id, agent_version_id, case_id, case_name, case_type, repeat_index,
      status, latency_ms, error_class, error_message, session_id, request_summary, normalized, http_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    insertedTrialId,
    experimentId,
    runId ?? null,
    branchId,
    agentVersion.id,
    caseId,
    caseInput.name,
    caseInput.type,
    repeatIndex,
    normalized.status,
    normalized.latencyMs,
    normalized.error?.class ?? null,
    normalized.error?.message ?? null,
    sessionId,
    requestSummary,
    JSON.stringify(normalized),
    normalized.httpStatus,
    nowIso(),
  )

  const score = scoreTrial(caseInput, normalized)
  db.prepare(
    `INSERT INTO score (id, trial_id, experiment_id, branch_id, case_id, dimension, method, passed, rationale, checks, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'rule', ?, ?, ?, ?)`,
  ).run(
    newId('sc'),
    insertedTrialId,
    experimentId,
    branchId,
    caseId,
    score.dimension,
    score.passed === null ? null : score.passed ? 1 : 0,
    score.rationale,
    JSON.stringify(score.checks),
    nowIso(),
  )

  return normalized
}

/** 手動試跑也建立獨立 run，避免與批量執行或其他試跑混合。 */
export async function runManualTrial(experimentId: string, caseId: string, branchId: string, repeatIndex: number) {
  const experiment = getExperiment(experimentId)
  if (!experiment) throw new Error('實驗不存在')
  const runId = newId('run')
  const taskId = newId('rtask')
  insertRun({
    id: runId, experiment_id: experimentId, source: 'manual', status: 'running', total: 1, concurrency: 1,
    repeats: experiment.repeats, branch_ids: JSON.stringify([branchId]), started_at: nowIso(),
  })
  insertRunTasks(runId, [{ id: taskId, case_id: caseId, branch_id: branchId, repeat_index: repeatIndex }])
  const task = claimNextRunTask(runId, nowIso())
  if (!task) throw new Error('無法建立手動試跑任務')
  const trialId = newId('trial')
  assignRunTaskTrialId(taskId, trialId)
  try {
    const normalized = await runSingleTrial(experimentId, caseId, branchId, repeatIndex, trialId, runId)
    finishRunTask(taskId, normalized.status === 'succeeded' || normalized.status === 'blocked' ? normalized.status : 'failed')
    updateRunCounters(runId)
    setRunStatus(runId, 'completed')
    return { normalized, runId }
  } catch (error) {
    finishRunTask(taskId, 'failed', (error as Error).message)
    updateRunCounters(runId)
    setRunStatus(runId, 'completed', { lastError: (error as Error).message })
    throw error
  }
}

// ---- 產品化：詳情與概覽 ----

export function getAgentDetail(id: string) {
  const row = getAgentRow(id)
  if (!row) return null
  const versions = listAgentVersions(id)
  const trials = db
    .prepare(
      `SELECT t.id, t.case_name, t.status, t.latency_ms, t.created_at, t.normalized,
              s.passed AS score_passed, s.dimension AS score_dimension
       FROM trial t LEFT JOIN score s ON s.trial_id = t.id
       WHERE t.agent_version_id IN (SELECT id FROM agent_version WHERE agent_id = ?)
       ORDER BY t.created_at DESC LIMIT 10`,
    )
    .all(id) as Array<{
    id: string
    case_name: string
    status: string
    latency_ms: number
    created_at: string
    normalized: string
    score_passed: number | null
    score_dimension: string | null
  }>
  return {
    id,
    config: configFromRow(row),
    credentialMask: getCredentialMask(id),
    createdAt: row.created_at,
    versions,
    recentTrials: trials.map((t) => ({
      id: t.id,
      caseName: t.case_name,
      status: t.status,
      latencyMs: t.latency_ms,
      createdAt: t.created_at,
      scorePassed: t.score_passed === null ? null : t.score_passed === 1,
      scoreDimension: t.score_dimension,
      normalized: JSON.parse(t.normalized),
    })),
  }
}

export function getTestSetDetail(id: string) {
  return listTestSets('all').find((set) => set.id === id) ?? null
}

export function getOverview() {
  const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n

  // 最近一次有試驗的實驗，取其失敗與攔截案例（與報告頁同一口徑：狀態失敗／攔截，或評分未通過）
  const latest = db
    .prepare(
      `SELECT e.id, e.name FROM experiment e
       WHERE e.archived = 0 AND EXISTS (SELECT 1 FROM trial t WHERE t.experiment_id = e.id)
       ORDER BY e.created_at DESC LIMIT 1`,
    )
    .get() as { id: string; name: string } | undefined
  const failureRows = latest
    ? (db
        .prepare(
          `SELECT t.id, t.case_name, t.status, t.created_at, t.normalized, b.role, s.passed AS score_passed
           FROM trial t
           JOIN experiment_branch b ON b.id = t.branch_id
           LEFT JOIN score s ON s.trial_id = t.id
           WHERE t.experiment_id = ? AND (t.status IN ('failed', 'blocked') OR s.passed = 0)
           ORDER BY t.created_at DESC`,
        )
        .all(latest.id) as Array<{
        id: string
        case_name: string
        status: string
        created_at: string
        normalized: string
        role: string
        score_passed: number | null
      }>)
    : []
  const failures = failureRows.map((row) => {
    const normalized = JSON.parse(row.normalized) as NormalizedTrial
    const blocked = row.status === 'blocked' || normalized.status === 'blocked'
    return {
      trialId: row.id,
      caseName: row.case_name,
      status: blocked ? 'blocked' : 'failed',
      branchRole: row.role,
      errorClass: normalized.error?.class ?? null,
      createdAt: row.created_at,
    }
  })

  return {
    counts: {
      agents: count('SELECT COUNT(*) AS n FROM agent WHERE archived = 0'),
      testSets: count('SELECT COUNT(*) AS n FROM test_set WHERE archived = 0'),
      datasetVersions: count("SELECT COUNT(*) AS n FROM test_set_version v JOIN test_set s ON s.id = v.test_set_id WHERE v.status = 'active' AND s.archived = 0"),
      experiments: count('SELECT COUNT(*) AS n FROM experiment WHERE archived = 0'),
      trials: count('SELECT COUNT(*) AS n FROM trial t JOIN experiment e ON e.id = t.experiment_id WHERE e.archived = 0'),
      reportsReady: count('SELECT COUNT(DISTINCT t.experiment_id) AS n FROM trial t JOIN experiment e ON e.id = t.experiment_id WHERE e.archived = 0'),
    },
    recentExperiments: listRecentExperiments(),
    recentFailures: {
      experimentId: latest?.id ?? null,
      experimentName: latest?.name ?? null,
      total: failures.length,
      items: failures.slice(0, 5),
    },
    attention: {
      notRun: count('SELECT COUNT(*) AS n FROM experiment e WHERE e.archived = 0 AND NOT EXISTS (SELECT 1 FROM trial t WHERE t.experiment_id = e.id)'),
      failedTrials: count("SELECT COUNT(*) AS n FROM trial t JOIN experiment e ON e.id = t.experiment_id WHERE e.archived = 0 AND t.status = 'failed'"),
      blockedTrials: count("SELECT COUNT(*) AS n FROM trial t JOIN experiment e ON e.id = t.experiment_id WHERE e.archived = 0 AND t.status = 'blocked'"),
    },
  }
}
