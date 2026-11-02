import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = process.env.AEVAL_DATA_DIR ?? join(process.cwd(), '.data')
mkdirSync(DATA_DIR, { recursive: true })

export const db = new Database(join(DATA_DIR, 'aeval.db'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  platform_type TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  auth_type TEXT NOT NULL,
  auth_header TEXT,
  request_template TEXT NOT NULL,
  response_map TEXT NOT NULL,
  config_json TEXT NOT NULL,
  targeting TEXT,
  allow_write INTEGER NOT NULL DEFAULT 0,
  active_version_id TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_credential (
  agent_id TEXT PRIMARY KEY REFERENCES agent(id),
  cipher TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  mask TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_version (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agent(id),
  version_no INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  diff TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  validation TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_version_agent ON agent_version(agent_id, version_no);

-- 版本不可刪除、不可改（只能改 status）
CREATE TRIGGER IF NOT EXISTS trg_agent_version_no_delete
BEFORE DELETE ON agent_version
BEGIN SELECT RAISE(ABORT, 'agent_version 不可刪除，只能停用'); END;

CREATE TRIGGER IF NOT EXISTS trg_agent_version_immutable
BEFORE UPDATE ON agent_version
WHEN NEW.id IS NOT OLD.id OR NEW.agent_id IS NOT OLD.agent_id OR NEW.version_no IS NOT OLD.version_no
  OR NEW.snapshot IS NOT OLD.snapshot OR NEW.diff IS NOT OLD.diff OR NEW.validation IS NOT OLD.validation
BEGIN SELECT RAISE(ABORT, 'agent_version 快照不可變更'); END;

CREATE TABLE IF NOT EXISTS test_set (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'generic',
  tags TEXT NOT NULL DEFAULT '[]',
  archived INTEGER NOT NULL DEFAULT 0,
  current_version_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS test_case (
  id TEXT PRIMARY KEY,
  test_set_id TEXT NOT NULL REFERENCES test_set(id),
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  input TEXT NOT NULL,
  expected TEXT NOT NULL DEFAULT '',
  scoring_rubric TEXT NOT NULL DEFAULT '',
  rule TEXT,
  judgement TEXT,
  timeout_ms INTEGER NOT NULL DEFAULT 30000,
  multi_turn TEXT,
  priority TEXT NOT NULL DEFAULT 'medium',
  read_write TEXT NOT NULL DEFAULT 'read',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_case_test_set ON test_case(test_set_id, position);

CREATE TABLE IF NOT EXISTS scoring_profile (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scoring_profile_version (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES scoring_profile(id),
  version_no INTEGER NOT NULL,
  rules TEXT NOT NULL,
  thresholds TEXT NOT NULL,
  rubric TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS trg_spv_no_delete
BEFORE DELETE ON scoring_profile_version
BEGIN SELECT RAISE(ABORT, '評分規則集版本不可刪除，只能停用'); END;

CREATE TRIGGER IF NOT EXISTS trg_spv_immutable
BEFORE UPDATE ON scoring_profile_version
WHEN NEW.id IS NOT OLD.id OR NEW.profile_id IS NOT OLD.profile_id OR NEW.version_no IS NOT OLD.version_no
  OR NEW.rules IS NOT OLD.rules OR NEW.thresholds IS NOT OLD.thresholds OR NEW.rubric IS NOT OLD.rubric
BEGIN SELECT RAISE(ABORT, '評分規則集版本快照不可變更'); END;

CREATE TABLE IF NOT EXISTS test_set_version (
  id TEXT PRIMARY KEY,
  test_set_id TEXT NOT NULL REFERENCES test_set(id),
  version_no INTEGER NOT NULL,
  scoring_profile_version_id TEXT NOT NULL REFERENCES scoring_profile_version(id),
  snapshot TEXT NOT NULL,
  case_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS trg_tsv_no_delete
BEFORE DELETE ON test_set_version
BEGIN SELECT RAISE(ABORT, '測試集版本不可刪除，只能停用'); END;

CREATE TRIGGER IF NOT EXISTS trg_tsv_immutable
BEFORE UPDATE ON test_set_version
WHEN NEW.id IS NOT OLD.id OR NEW.test_set_id IS NOT OLD.test_set_id OR NEW.version_no IS NOT OLD.version_no
  OR NEW.snapshot IS NOT OLD.snapshot OR NEW.case_count IS NOT OLD.case_count
  OR NEW.scoring_profile_version_id IS NOT OLD.scoring_profile_version_id
BEGIN SELECT RAISE(ABORT, '測試集版本快照不可變更'); END;

CREATE TABLE IF NOT EXISTS experiment (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'A',
  dataset_version_id TEXT NOT NULL REFERENCES test_set_version(id),
  scoring_profile_version_id TEXT NOT NULL REFERENCES scoring_profile_version(id),
  repeats INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  external_conditions TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS experiment_branch (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiment(id),
  role TEXT NOT NULL,
  agent_version_id TEXT NOT NULL REFERENCES agent_version(id),
  variables TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS experiment_snapshot (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiment(id),
  frozen TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS trg_exp_snapshot_no_delete
BEFORE DELETE ON experiment_snapshot
BEGIN SELECT RAISE(ABORT, '實驗快照不可刪除'); END;

CREATE TRIGGER IF NOT EXISTS trg_exp_snapshot_immutable
BEFORE UPDATE ON experiment_snapshot
BEGIN SELECT RAISE(ABORT, '實驗快照不可變更'); END;

CREATE TABLE IF NOT EXISTS trial (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiment(id),
  run_id TEXT,
  branch_id TEXT NOT NULL REFERENCES experiment_branch(id),
  agent_version_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  case_name TEXT NOT NULL,
  case_type TEXT NOT NULL,
  repeat_index INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  error_class TEXT,
  error_message TEXT,
  session_id TEXT NOT NULL,
  request_summary TEXT NOT NULL,
  normalized TEXT NOT NULL,
  http_status INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trial_experiment ON trial(experiment_id, case_id, repeat_index);

CREATE TABLE IF NOT EXISTS run (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiment(id),
  source TEXT NOT NULL DEFAULT 'live',
  status TEXT NOT NULL,
  total INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  succeeded INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  concurrency INTEGER NOT NULL,
  repeats INTEGER NOT NULL,
  branch_ids TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  interrupted_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS run_task (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES run(id),
  case_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  repeat_index INTEGER NOT NULL,
  trial_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  claimed_at TEXT,
  finished_at TEXT,
  UNIQUE(run_id, branch_id, case_id, repeat_index)
);

CREATE INDEX IF NOT EXISTS idx_run_task_run ON run_task(run_id, status);
CREATE INDEX IF NOT EXISTS idx_run_experiment ON run(experiment_id, started_at);

CREATE TABLE IF NOT EXISTS score (
  id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL REFERENCES trial(id),
  experiment_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  dimension TEXT NOT NULL,
  method TEXT NOT NULL,
  passed INTEGER,
  rationale TEXT NOT NULL,
  checks TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_score_experiment ON score(experiment_id, branch_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  method TEXT NOT NULL,
  path TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_type, target_id);

-- 對外分享連結：token 隨機不可猜，庫存哈希 + 經環境金鑰加密的原文（供建立者重新複製）。
-- snapshot 是建立當下凍結的展示資料，實驗之後的變化不影響已發出的連結。
CREATE TABLE IF NOT EXISTS share_link (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  token_sealed TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_share_experiment ON share_link(experiment_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_judge_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  model TEXT NOT NULL,
  secret TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_judge_models (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  secret TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_evaluation_batch (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiment(id),
  run_id TEXT NOT NULL REFERENCES run(id),
  status TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_one_active_run ON ai_evaluation_batch(run_id) WHERE status = 'running';
CREATE TABLE IF NOT EXISTS ai_evaluation (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES ai_evaluation_batch(id),
  trial_id TEXT NOT NULL REFERENCES trial(id),
  case_name TEXT NOT NULL,
  status TEXT NOT NULL,
  input TEXT NOT NULL,
  result TEXT,
  error TEXT,
  UNIQUE(batch_id, trial_id)
);
CREATE INDEX IF NOT EXISTS idx_ai_evaluation_batch ON ai_evaluation(batch_id);
`

export function migrate(): void {
  db.exec(SCHEMA)
  const judgeColumns = db.prepare('PRAGMA table_info(ai_judge_settings)').all() as Array<{ name: string }>
  for (const [name, definition] of [
    ['name', "TEXT NOT NULL DEFAULT 'DeepSeek'"],
    ['endpoint', "TEXT NOT NULL DEFAULT 'https://api.deepseek.com/chat/completions'"],
    ['profile_id', 'TEXT'],
  ]) if (!judgeColumns.some((column) => column.name === name)) db.exec(`ALTER TABLE ai_judge_settings ADD COLUMN ${name} ${definition}`)
  db.transaction(() => {
    db.exec("INSERT OR IGNORE INTO ai_judge_models (id,name,model,endpoint,secret,updated_at) SELECT 'legacy-deepseek',name,model,endpoint,secret,updated_at FROM ai_judge_settings WHERE profile_id IS NULL")
    db.exec("UPDATE ai_judge_settings SET profile_id='legacy-deepseek' WHERE profile_id IS NULL")
  })()
  const batchColumns = db.prepare('PRAGMA table_info(ai_evaluation_batch)').all() as Array<{ name: string }>
  if (!batchColumns.some((column) => column.name === 'provider_name')) db.exec("ALTER TABLE ai_evaluation_batch ADD COLUMN provider_name TEXT NOT NULL DEFAULT 'DeepSeek'")
  if (!batchColumns.some((column) => column.name === 'api_endpoint')) db.exec("ALTER TABLE ai_evaluation_batch ADD COLUMN api_endpoint TEXT NOT NULL DEFAULT 'https://api.deepseek.com/chat/completions'")
  const experimentColumns = db.prepare('PRAGMA table_info(experiment)').all() as Array<{ name: string }>
  if (!experimentColumns.some((column) => column.name === 'archived')) db.exec('ALTER TABLE experiment ADD COLUMN archived INTEGER NOT NULL DEFAULT 0')
  const caseColumns = db.prepare('PRAGMA table_info(test_case)').all() as Array<{ name: string }>
  if (!caseColumns.some((column) => column.name === 'judgement')) db.exec('ALTER TABLE test_case ADD COLUMN judgement TEXT')
  const trialColumns = db.prepare('PRAGMA table_info(trial)').all() as Array<{ name: string }>
  if (!trialColumns.some((column) => column.name === 'run_id')) db.exec('ALTER TABLE trial ADD COLUMN run_id TEXT')
  const agentColumns = db.prepare('PRAGMA table_info(agent)').all() as Array<{ name: string }>
  if (!agentColumns.some((column) => column.name === 'targeting')) db.exec('ALTER TABLE agent ADD COLUMN targeting TEXT')
  const runColumns = db.prepare('PRAGMA table_info(run)').all() as Array<{ name: string }>
  if (!runColumns.some((column) => column.name === 'source')) db.exec("ALTER TABLE run ADD COLUMN source TEXT NOT NULL DEFAULT 'live'")
  const legacy = backfillLegacyRuns()
  if (legacy.runs > 0) console.log(`資料升級：${legacy.trials} 筆歷史試驗歸入 ${legacy.runs} 個 legacy 批次`)
  // 必須等舊資料完成分批，否則歷史重複鍵會令索引建立失敗。
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_trial_run_unique ON trial(run_id, branch_id, case_id, repeat_index)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_trial_run ON trial(run_id)')
}

/** 將上線前沒有 run 歸屬的試驗，以不重複的鍵貪心分成可重現批次。 */
export function backfillLegacyRuns(): { runs: number; trials: number } {
  type Trial = { id: string; experiment_id: string; branch_id: string; case_id: string; repeat_index: number; status: string; created_at: string }
  const pending = db.prepare('SELECT id, experiment_id, branch_id, case_id, repeat_index, status, created_at FROM trial WHERE run_id IS NULL ORDER BY experiment_id, created_at ASC').all() as Trial[]
  let runs = 0
  let trials = 0
  db.transaction(() => {
    const byExperiment = new Map<string, Trial[]>()
    for (const trial of pending) byExperiment.set(trial.experiment_id, [...(byExperiment.get(trial.experiment_id) ?? []), trial])
    for (const [experimentId, rows] of byExperiment) {
      const batches: Array<{ keys: Set<string>; trials: Trial[] }> = []
      for (const trial of rows) {
        const key = `${trial.branch_id}|${trial.case_id}|${trial.repeat_index}`
        let batch = batches.find((candidate) => !candidate.keys.has(key))
        if (!batch) { batch = { keys: new Set(), trials: [] }; batches.push(batch) }
        batch.keys.add(key)
        batch.trials.push(trial)
      }
      const repeats = (db.prepare('SELECT repeats FROM experiment WHERE id = ?').get(experimentId) as { repeats: number } | undefined)?.repeats ?? 1
      for (const batch of batches) {
        let id = `run_legacy_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`
        while (db.prepare('SELECT 1 FROM run WHERE id = ?').get(id)) id = `run_legacy_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`
        const first = batch.trials[0]!
        const last = batch.trials[batch.trials.length - 1]!
        const succeeded = batch.trials.filter((trial) => trial.status === 'succeeded').length
        const blocked = batch.trials.filter((trial) => trial.status === 'blocked').length
        const failed = batch.trials.length - succeeded - blocked
        db.prepare(`INSERT INTO run (id, experiment_id, source, status, total, done, succeeded, failed, blocked, concurrency, repeats, branch_ids, started_at, finished_at)
          VALUES (?, ?, 'legacy', 'completed', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`).run(
          id, experimentId, batch.trials.length, batch.trials.length, succeeded, failed, blocked, repeats,
          JSON.stringify([...new Set(batch.trials.map((trial) => trial.branch_id))]), first.created_at, last.created_at,
        )
        const update = db.prepare('UPDATE trial SET run_id = ? WHERE id = ? AND run_id IS NULL')
        for (const trial of batch.trials) update.run(id, trial.id)
        runs += 1
        trials += batch.trials.length
      }
    }
  })()
  return { runs, trials }
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
}
