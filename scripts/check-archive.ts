/** 隔離資料庫驗證歸檔／還原、歷史保留及舊庫升級，不調用外部 Agent。 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

mkdirSync('.tmp', { recursive: true })
process.env.AEVAL_DATA_DIR = mkdtempSync(join(process.cwd(), '.tmp', 'archive-check-'))
const { db, migrate } = await import('../src/server/db.ts')
const store = await import('../src/server/store.ts')
const { buildApp } = await import('../src/server/app.ts')
migrate()
const app = await buildApp()
let headers: Record<string, string> = {}
const json = async (url: string) => (await app.inject({ method: 'GET', url, headers })).json()
const archive = async (path: string, archived: unknown) => app.inject({ method: 'POST', url: `/api/${path}/archive`, headers, payload: { archived } })

try {
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: process.env.AEVAL_ADMIN_USERNAME ?? 'admin', password: process.env.AEVAL_ADMIN_PASSWORD ?? 'admin' } })
  assert.equal(login.statusCode, 200)
  headers = { cookie: login.cookies.map(item => `${item.name}=${item.value}`).join('; ') }
  const scoringId = store.ensureDefaultScoringProfileVersion()
  const testSetId = store.createTestSet({ name: '歸檔驗證', cases: [{
    name: '只讀攔截', type: 'basic_qa', input: '不可實際送出', expected: '', scoringRubric: '應被只讀保護攔截',
    timeoutMs: 1000, priority: 'high', readWrite: 'write',
  }] })
  const version = store.publishTestSet(testSetId, scoringId)
  const agent = store.createAgent({
    name: '離線驗證 Agent', platformType: 'custom_http', endpoint: 'http://127.0.0.1:1', authType: 'none',
    requestTemplate: { method: 'POST', headers: {}, body: {} }, responseMap: { outputPath: 'answer' }, allowWrite: false, versionInfo: {},
  }, null, { ok: true, checkedAt: new Date().toISOString(), latencyMs: 0, httpStatus: 200 })
  const created = store.createExperiment({ name: '保留歷史的實驗', kind: 'A', datasetVersionId: version.versionId, scoringProfileVersionId: scoringId, repeats: 1, branches: [{ role: 'baseline', agentVersionId: agent.versionId }] })
  assert.equal(created.ok, true)
  if (!created.ok) throw new Error('fixture experiment failed')
  const id = created.experimentId
  const detail = store.getExperiment(id)!
  await store.runManualTrial(id, detail.frozen.dataset.cases[0].id, detail.branches[0].id, 1)
  const before = store.getExperiment(id)!
  assert.equal(before.trials.length, 1)

  // 模擬舊庫沒有歸檔欄位，升級不能丟失實驗或歷史。
  db.exec('ALTER TABLE experiment DROP COLUMN archived')
  migrate()
  assert.deepEqual(store.getExperiment(id), before)
  assert.equal((await json('/api/experiments'))[0].archived, false)

  for (const [resource, itemId] of [['test-sets', testSetId], ['experiments', id]]) {
    assert.equal((await archive(`${resource}/${itemId}`, true)).statusCode, 200)
    assert.equal((await archive(`${resource}/${itemId}`, true)).statusCode, 200)
    assert.equal((await json(`/api/${resource}`)).length, 0)
    assert.equal((await json(`/api/${resource}?view=archived`))[0].id, itemId)
    assert.equal((await json(`/api/${resource}?view=all`))[0].archived, true)
    assert.equal((await app.inject({ method: 'GET', url: `/api/${resource}/${itemId}`, headers })).statusCode, 200)
    assert.equal((await archive(`${resource}/missing`, true)).statusCode, 404)
    assert.equal((await archive(`${resource}/${itemId}`, 'false')).statusCode, 400)
    assert.equal((await app.inject({ method: 'GET', url: `/api/${resource}?view=oops`, headers })).statusCode, 400)
  }
  assert.equal(store.listDatasetVersions().length, 0)
  assert.equal(store.getTestSetDetail(testSetId)!.cases.length, 1)
  assert.deepEqual(store.getExperiment(id), before)
  assert.equal(store.getOverview().recentExperiments.length, 0)
  assert.equal(store.getOverview().counts.reportsReady, 0)
  migrate()
  assert.equal((await json('/api/experiments?view=archived')).length, 1)

  for (const [resource, itemId] of [['test-sets', testSetId], ['experiments', id]]) {
    assert.equal((await archive(`${resource}/${itemId}`, false)).statusCode, 200)
    assert.equal((await json(`/api/${resource}`))[0].id, itemId)
    assert.equal((await json(`/api/${resource}?view=archived`)).length, 0)
  }
  assert.equal(store.listDatasetVersions().length, 1)
  assert.deepEqual(store.getExperiment(id), before)
  assert.equal(store.getOverview().counts.reportsReady, 1)
  assert.ok(store.listAudit().rows.some((item) => item.action === 'experiment.restore'))
  console.log('PASS 歸檔／還原 API、篩選、參數校驗、歷史保留、舊庫升級及重複升級')
} finally {
  await app.close()
  db.close()
}
