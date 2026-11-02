/** 隔離驗證最近實驗排序、重跑與最新批次狀態，不調用外部 Agent。 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'

mkdirSync('.tmp', { recursive: true })
process.env.AEVAL_DATA_DIR = mkdtempSync(join(process.cwd(), '.tmp', 'recent-check-'))
const { db, migrate } = await import('../src/server/db.ts')
const store = await import('../src/server/store.ts')
const { buildApp } = await import('../src/server/app.ts')
migrate()
const app = await buildApp()
try {
  const scoringId = store.ensureDefaultScoringProfileVersion()
  const testSetId = store.createTestSet({ name: '最近實驗驗證', cases: [{ name: '只讀測試', type: 'basic_qa', input: '不發送', expected: '', scoringRubric: '應攔截', timeoutMs: 1000, priority: 'high', readWrite: 'write' }] })
  const version = store.publishTestSet(testSetId, scoringId)
  const agent = store.createAgent({ name: '離線 Agent', platformType: 'custom_http', endpoint: 'http://127.0.0.1:1', authType: 'none', requestTemplate: { method: 'POST', headers: {}, body: {} }, responseMap: { outputPath: 'answer' }, allowWrite: false, versionInfo: {} }, null, { ok: true, checkedAt: new Date().toISOString(), latencyMs: 0, httpStatus: 200 })
  const ids: string[] = []
  for (let index = 0; index < 6; index += 1) {
    const exp = store.createExperiment({ name: `實驗 ${index + 1}`, kind: 'A', datasetVersionId: version.versionId, scoringProfileVersionId: scoringId, repeats: 1, branches: [{ role: 'baseline', agentVersionId: agent.versionId }] })
    assert.ok(exp.ok)
    if (!exp.ok) throw new Error('fixture failed')
    ids.push(exp.experimentId)
    db.prepare('UPDATE experiment SET created_at = ? WHERE id = ?').run(`2026-10-0${index + 1}T00:00:00.000Z`, exp.experimentId)
  }
  const recent = async () => (await app.inject({ method: 'GET', url: '/api/experiments/recent' })).json()
  assert.equal((await recent())[0].id, ids[5], '未執行時回退建立時間')
  const original = store.getExperiment(ids[0])!
  const addRun = (id: string, startedAt: string) => {
    store.insertRun({ id, experiment_id: ids[0], status: 'running', total: 1, concurrency: 1, repeats: 1, branch_ids: JSON.stringify(original.branches.map((branch) => branch.id)), started_at: startedAt })
  }
  addRun('old-run', '2026-10-07T00:00:00.000Z')
  db.prepare("UPDATE run SET status = 'completed', failed = 1, done = 1 WHERE id = 'old-run'").run()
  assert.equal((await recent())[0].status, 'partial_failed')
  addRun('new-run', '2026-10-08T00:00:00.000Z')
  let rows = await recent()
  assert.equal(rows.length, 5)
  assert.equal(rows[0].id, ids[0], '原本第六位的舊實驗重跑後置頂')
  assert.equal(rows[0].status, 'running', '新批次執行中不沿用舊失敗狀態')
  assert.equal(rows[0].lastRunAt, '2026-10-08T00:00:00.000Z')
  assert.equal(rows.filter((row: { id: string }) => row.id === ids[0]).length, 1, '重跑不產生重複實驗')
  db.prepare("UPDATE run SET status = 'completed', succeeded = 1, done = 1 WHERE id = 'new-run'").run()
  assert.equal((await recent())[0].status, 'completed')
  assert.deepEqual(store.getExperiment(ids[0])!.frozen, original.frozen)
  assert.equal(store.getExperiment(ids[0])!.createdAt, original.createdAt)
  assert.equal(store.getOverview().recentExperiments[0].id, ids[0])
  store.setArchived('experiment', ids[0], true)
  rows = await recent()
  assert.equal(rows.some((row: { id: string }) => row.id === ids[0]), false)
  store.setArchived('experiment', ids[0], false)
  assert.equal((await recent())[0].id, ids[0])
  // 走前端 API 包裝到真實 Fastify：無 body 的控制請求不應帶 JSON Content-Type。
  const originalFetch = globalThis.fetch
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() })
  globalThis.fetch = async (path, init) => {
    const headers = init?.headers as Record<string, string>
    if (init?.body === undefined) assert.equal(headers['content-type'], undefined)
    else assert.equal(headers['content-type'], 'application/json')
    const response = await app.inject({ method: (init?.method ?? 'GET') as 'POST' | 'GET', url: String(path), headers, payload: init?.body as string | undefined })
    return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } })
  }
  try {
    const { api } = await import('../web/src/api.ts')
    db.prepare("UPDATE run SET status='running' WHERE id='new-run'").run()
    assert.equal((await api.pauseRun('new-run')).status, 'paused')
    assert.equal((await api.getRun('new-run')).concurrency, 1)
    assert.equal((await api.resumeRun('new-run')).status, 'completed')
    db.prepare("UPDATE run SET status='running' WHERE id='new-run'").run()
    assert.equal((await api.cancelRun('new-run')).status, 'cancelled')
    const started = await api.startRun(ids[0], { concurrency: 1, repeats: 1 })
    assert.equal(started.concurrency, 1)
    for (let index = 0; index < 100 && (await api.getRun(started.id)).status === 'running'; index += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    const finished = await api.getRun(started.id)
    assert.equal(finished.status, 'completed')
    assert.equal(finished.concurrency, 1)
    assert.equal(finished.blocked, 1, '隔離測試不得調用外部 Agent')
  } finally {
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
  console.log('PASS 最近執行排序、前五條、重跑置頂、最新狀態、歸檔及快照保留')
  console.log('PASS 前端 API 啟動／暫停／繼續／取消；並發 1 從提交到完成保持一致')
} finally {
  await app.close()
  db.close()
}
