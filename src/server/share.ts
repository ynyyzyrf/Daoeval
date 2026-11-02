/**
 * 對外分享連結：建立（凍結快照）、列出、撤銷，以及公開讀取。
 *
 * 安全約定：
 * - token 是 32 bytes 隨機數的 base64url，跟實驗 id 沒有推導關係；URL 只有這一個值。
 * - 服務端每次請求都重新查庫判斷撤銷與到期，回應一律 `no-store`，刷新即失效。
 * - 公開路徑只有 GET；快照內容在建立時就剝掉 id、endpoint、token 等內部資訊。
 */
import { createHash, randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db, newId, nowIso } from './db.ts'
import { openSecret, sealSecret } from './crypto.ts'
import { caseVerdict } from './conclusion.ts'
import { getExperiment, pickMetricsRun, writeAudit } from './store.ts'
import { PROBLEM_OWNER_LABELS, failureText, type ProblemOwner } from '../shared/vocabulary.ts'
import type { CaseInput } from '../shared/types.ts'

export const SHARE_DEFAULT_DAYS = 7
export const SHARE_MAX_DAYS = 30
export const SHARE_MAX_EVIDENCE = 5

const ROLE_LABELS: Record<string, string> = { baseline: '原版本', experiment: '新版本', slow: '慢分支' }
const KIND_LABELS: Record<string, string> = { A: 'A/B 對照', B: '橫向對比' }

export interface ShareBranchView {
  name: string
  headline: string
  passRateText: string
  passedCases: number
  judgedCases: number
  unknownCases: number
  avgLatencyText: string
  sampleText: string
}

export interface ShareFailureView {
  caseName: string
  branchName: string
  reason: string
  owner: string
  hint: string
  expected: string
  /** 只有前幾條附原文，其餘為 null（總數另外給）。 */
  actual: string | null
}

export interface ShareSnapshot {
  schemaVersion: 1
  generatedAt: string
  title: string
  kindLabel: string
  headline: string
  passRateText: string
  sampleText: string
  totals: { cases: number; judged: number; passed: number; failed: number; unknown: number }
  trialCount: number
  branches: ShareBranchView[]
  /** 全部失敗條數（不受證據上限影響）。 */
  failuresTotal: number
  evidenceListed: number
  failures: ShareFailureView[]
  unknownSummary: Array<{ label: string; hint: string; cases: number }>
}

interface TrialFactLike {
  caseId: string
  status: string
  latencyMs: number
  errorClass: string | null
  finalOutput: string
  scorePassed: boolean | null
}

function toFact(trial: {
  caseId: string
  status: string
  latencyMs: number
  normalized: unknown
  score: { passed: boolean | null } | null
}): TrialFactLike {
  const normalized = (trial.normalized ?? {}) as { finalOutput?: unknown; error?: { class?: unknown } | null }
  const errorClass = normalized.error?.class
  return {
    caseId: trial.caseId,
    status: trial.status,
    latencyMs: trial.latencyMs,
    errorClass: typeof errorClass === 'string' ? errorClass : null,
    finalOutput: typeof normalized.finalOutput === 'string' ? normalized.finalOutput : '',
    scorePassed: trial.score?.passed ?? null,
  }
}

function snippet(text: string, limit = 160): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

function unknownReasonOf(trials: TrialFactLike[]): string | null {
  if (trials.length === 0) return '還沒跑'
  const sent = trials.filter((trial) => trial.status !== 'blocked')
  if (sent.length === 0) return '這項被平台攔下沒送出'
  if (sent.every((trial) => trial.scorePassed === null)) return '測試集沒覆蓋'
  return null
}

function latencyText(values: number[]): string {
  if (values.length === 0) return '—'
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length
  return avg >= 1000 ? `${(avg / 1000).toFixed(1)} 秒` : `${Math.round(avg)} 毫秒`
}

/** 建立分享快照：只留業務說法，不帶任何內部識別碼。 */
export function buildShareSnapshot(experimentId: string): ShareSnapshot | null {
  const run = pickMetricsRun(experimentId)
  const experiment = run ? getExperiment(experimentId, run.id) : getExperiment(experimentId)
  if (!experiment) return null
  const cases = (experiment.frozen.dataset.cases ?? []) as CaseInput[]
  const repeats = experiment.frozen.repeats ?? experiment.repeats

  const failures: ShareFailureView[] = []
  const unknownMap = new Map<string, { label: string; hint: string; cases: number }>()
  const branches: ShareBranchView[] = []
  let judgedTotal = 0
  let passedTotal = 0

  for (const branch of experiment.branches) {
    const facts = experiment.trials.filter((trial) => trial.branchId === branch.id).map(toFact)
    const branchName = ROLE_LABELS[branch.role] ?? branch.role
    const latencies: number[] = []
    let passed = 0
    let failed = 0
    let unknown = 0

    for (const caseInput of cases) {
      const caseTrials = facts.filter((fact) => fact.caseId === caseInput.id)
      const verdict = caseVerdict(caseInput, caseTrials.map((fact) => ({
        caseId: fact.caseId,
        status: fact.status,
        latencyMs: fact.latencyMs,
        finalOutput: fact.finalOutput,
        scorePassed: fact.scorePassed,
        errorClass: fact.errorClass,
      })))
      const sent = caseTrials.filter((fact) => fact.status !== 'blocked')
      for (const trial of sent) latencies.push(trial.latencyMs)

      if (verdict === 'passed') {
        passed += 1
      } else if (verdict === 'failed') {
        failed += 1
        const last = sent[sent.length - 1]
        const reason = failureText(last?.errorClass ?? null, false)
        failures.push({
          caseName: caseInput.name,
          branchName,
          reason: reason?.text ?? '回答沒提到關鍵資訊',
          owner: PROBLEM_OWNER_LABELS[(reason?.owner ?? 'agent') as ProblemOwner],
          hint: reason?.hint ?? '',
          expected: caseInput.expected ?? '',
          actual: last?.finalOutput ? snippet(last.finalOutput) : null,
        })
      } else {
        unknown += 1
        const key = unknownReasonOf(caseTrials) ?? '這項無法判斷'
        const entry = unknownMap.get(key) ?? { label: key, hint: '', cases: 0 }
        entry.cases += 1
        unknownMap.set(key, entry)
      }
    }

    const judged = passed + failed
    judgedTotal += judged
    passedTotal += passed
    branches.push({
      name: branchName,
      headline: judged === 0
        ? '這批還沒有可判斷的結果'
        : failed === 0
          ? `${judged} 條用例全部通過${unknown > 0 ? `（另 ${unknown} 條無法判斷）` : ''}`
          : `${judged} 條用例通過 ${passed} 條，${failed} 條沒通過${unknown > 0 ? `（另 ${unknown} 條無法判斷）` : ''}`,
      passRateText: judged === 0 ? '—' : `${((passed / judged) * 100).toFixed(1)}%`,
      passedCases: passed,
      judgedCases: judged,
      unknownCases: unknown,
      avgLatencyText: latencyText(latencies),
      sampleText: `${cases.length} 條用例 × ${repeats} 次 = ${experiment.trials.filter((trial) => trial.branchId === branch.id).length} 次試驗`,
    })
  }

  const failuresTotal = failures.length
  const evidence = failures.map((failure, index) => ({ ...failure, actual: index < SHARE_MAX_EVIDENCE ? failure.actual : null }))

  const headline = (() => {
    if (judgedTotal === 0) return `這批 ${cases.length} 條用例還沒有可判斷的結果`
    if (failuresTotal === 0) return `${cases.length} 條用例全部通過，可以上線`
    if (branches.length === 1) {
      return `${judgedTotal} 條可判斷的用例通過 ${passedTotal} 條（${((passedTotal / judgedTotal) * 100).toFixed(1)}%），有 ${failuresTotal} 條沒通過需要確認`
    }
    const detail = branches.map((branch) => `${branch.name} 通過 ${branch.passedCases} 條`).join('、')
    return `${cases.length} 條用例，${branches.length} 份結果合計 ${failuresTotal} 條沒通過（${detail}）`
  })()

  return {
    schemaVersion: 1,
    generatedAt: nowIso(),
    title: experiment.name,
    kindLabel: KIND_LABELS[experiment.kind] ?? '評測結果',
    headline,
    passRateText: judgedTotal === 0 ? '—' : `${((passedTotal / judgedTotal) * 100).toFixed(1)}%`,
    sampleText: `${cases.length} 條用例 × ${repeats} 次；共 ${experiment.trials.length} 次試驗`,
    totals: {
      cases: cases.length,
      judged: judgedTotal,
      passed: passedTotal,
      failed: failuresTotal,
      unknown: [...unknownMap.values()].reduce((sum, entry) => sum + entry.cases, 0),
    },
    branches,
    failuresTotal,
    evidenceListed: Math.min(failuresTotal, SHARE_MAX_EVIDENCE),
    failures: evidence,
    trialCount: experiment.trials.length,
    unknownSummary: [...unknownMap.values()],
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

interface ShareRow {
  id: string
  token_hash: string
  token_sealed: string
  experiment_id: string
  snapshot: string
  created_at: string
  expires_at: string
  revoked_at: string | null
}

function sharePath(row: ShareRow): string | null {
  try {
    const sealed = JSON.parse(row.token_sealed) as { cipher: string; iv: string; tag: string }
    return `/s/${openSecret(sealed)}`
  } catch {
    return null
  }
}

function shareStatus(row: ShareRow): 'active' | 'revoked' | 'expired' {
  if (row.revoked_at) return 'revoked'
  return Date.parse(row.expires_at) <= Date.now() ? 'expired' : 'active'
}

/** 公開連結的限流：同一 IP 每分鐘最多 30 次查詢，避免被暴力枚舉。 */
const RATE_WINDOW_MS = 60_000
const RATE_LIMIT = 30
const hits = new Map<string, number[]>()

function rateLimited(ip: string): boolean {
  const now = Date.now()
  const list = (hits.get(ip) ?? []).filter((at) => now - at < RATE_WINDOW_MS)
  list.push(now)
  hits.set(ip, list)
  if (hits.size > 5000) {
    for (const [key, value] of hits) if (value.every((at) => now - at >= RATE_WINDOW_MS)) hits.delete(key)
  }
  return list.length > RATE_LIMIT
}

/** 對外分享的資料接口與 HTML 外殼共用同一套嚴格頭（app.ts 直接引用）。 */
export const SHARE_SECURITY_HEADERS = {
  'cache-control': 'no-store, no-cache, must-revalidate',
  pragma: 'no-cache',
  'x-robots-tag': 'noindex, nofollow, noarchive',
  'referrer-policy': 'no-referrer',
}

/** 統一的失效回應：不區分「不存在／已撤銷／已過期」，避免被拿來探測。 */
function invalidLink(reply: FastifyReply) {
  return reply.code(404).headers(SHARE_SECURITY_HEADERS).send({ error: '連結無效或已過期', message: '這個分享連結不存在、已被撤銷，或已超過有效期。' })
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

export function registerShareRoutes(app: FastifyInstance): void {
  // 建立連結：只接受 1–30 天，沒有「永不過期」
  app.post('/api/experiments/:id/shares', async (req: FastifyRequest<{ Params: { id: string }; Body: { days?: unknown } }>, reply) => {
    const days = req.body?.days === undefined ? SHARE_DEFAULT_DAYS : Number(req.body.days)
    if (!Number.isInteger(days) || days < 1 || days > SHARE_MAX_DAYS) {
      return reply.code(400).send({ error: `有效期只能選 1–${SHARE_MAX_DAYS} 天，不支援永不過期` })
    }
    const experiment = getExperiment(req.params.id)
    if (!experiment) return reply.code(404).send({ error: '實驗不存在' })
    const snapshot = buildShareSnapshot(req.params.id)
    if (!snapshot) return reply.code(404).send({ error: '實驗不存在' })

    const token = randomBytes(32).toString('base64url')
    const sealed = sealSecret(token)
    const row: ShareRow = {
      id: newId('shr'),
      token_hash: hashToken(token),
      token_sealed: JSON.stringify(sealed),
      experiment_id: req.params.id,
      snapshot: JSON.stringify(snapshot),
      created_at: nowIso(),
      expires_at: daysFromNow(days),
      revoked_at: null,
    }
    db.prepare(
      `INSERT INTO share_link (id, token_hash, token_sealed, experiment_id, snapshot, created_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(row.id, row.token_hash, row.token_sealed, row.experiment_id, row.snapshot, row.created_at, row.expires_at)
    writeAudit({
      actor: typeof req.headers['x-actor'] === 'string' ? req.headers['x-actor'] : 'local',
      action: 'share.create', targetType: 'experiment', targetId: req.params.id,
      detail: { shareId: row.id, days, expiresAt: row.expires_at },
      method: req.method, path: req.url,
    })
    return { id: row.id, path: `/s/${token}`, createdAt: row.created_at, expiresAt: row.expires_at, days }
  })

  // 列出這個實驗的連結（建立者可以重新複製，不需重新生成）
  app.get('/api/experiments/:id/shares', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const rows = db.prepare('SELECT * FROM share_link WHERE experiment_id = ? ORDER BY created_at DESC LIMIT 50').all(req.params.id) as ShareRow[]
    return {
      links: rows
        .map((row) => ({
          id: row.id,
          path: sharePath(row),
          status: shareStatus(row),
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          revokedAt: row.revoked_at,
        }))
        .filter((link) => link.path !== null),
    }
  })

  // 撤銷：寫入 revoked_at，下一條請求立刻 404
  app.delete('/api/share-links/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const row = db.prepare('SELECT * FROM share_link WHERE id = ?').get(req.params.id) as ShareRow | undefined
    if (!row) return reply.code(404).send({ error: '連結不存在' })
    if (!row.revoked_at) {
      db.prepare('UPDATE share_link SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(nowIso(), row.id)
      writeAudit({
        actor: typeof req.headers['x-actor'] === 'string' ? req.headers['x-actor'] : 'local',
        action: 'share.revoke', targetType: 'experiment', targetId: row.experiment_id,
        detail: { shareId: row.id }, method: req.method, path: req.url,
      })
    }
    return { ok: true }
  })

  // 公開讀取：無需登入，只有 GET，每次請求都重新判斷撤銷與到期
  app.get('/api/share/:token', async (req: FastifyRequest<{ Params: { token: string } }>, reply) => {
    if (rateLimited(req.ip)) {
      return reply.code(429).headers(SHARE_SECURITY_HEADERS).send({ error: '請求太頻繁，請稍後再試' })
    }
    const token = req.params.token ?? ''
    if (token.length < 20 || token.length > 128) return invalidLink(reply)
    const row = db.prepare('SELECT * FROM share_link WHERE token_hash = ?').get(hashToken(token)) as ShareRow | undefined
    if (!row) return invalidLink(reply)
    if (shareStatus(row) !== 'active') return invalidLink(reply)
    return reply
      .headers(SHARE_SECURITY_HEADERS)
      .send({ snapshot: JSON.parse(row.snapshot) as ShareSnapshot, expiresAt: row.expires_at })
  })
}
