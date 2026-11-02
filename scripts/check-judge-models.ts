import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'

const directory = mkdtempSync(join(tmpdir(), 'daoeval-models-'))
process.env.AEVAL_DATA_DIR = directory
const { db, migrate } = await import('../src/server/db.ts')
const { sealSecret } = await import('../src/server/crypto.ts')
// Simulate an existing installation before multi-model support.
db.exec('CREATE TABLE ai_judge_settings (id INTEGER PRIMARY KEY, model TEXT NOT NULL, secret TEXT NOT NULL, updated_at TEXT NOT NULL)')
db.prepare('INSERT INTO ai_judge_settings VALUES (1, ?, ?, ?)').run('deepseek-flash', JSON.stringify(sealSecret('legacy-test-key')), new Date().toISOString())
migrate()
const { buildApp } = await import('../src/server/app.ts')
const ai = await import('../src/server/ai-evaluation.ts')
const app = await buildApp()
const provider = Fastify()
const calls: Array<{ model: string; key: string | undefined }> = []
provider.post('/v1/chat/completions', async (request) => {
  calls.push({ model: (request.body as { model: string }).model, key: request.headers.authorization })
  return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ verdict: 'meets', summary: '符合', differences: [], suggestions: [] }) } }] }
})
await provider.listen({ port: 0, host: '127.0.0.1' })
try {
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin' } })
  assert.equal(login.statusCode, 200)
  const headers = { cookie: login.cookies.map((item) => `${item.name}=${item.value}`).join('; ') }
  const initial = ai.getJudgeSettings()
  assert.equal(initial.profiles.length, 1, 'old settings must become a saved profile')
  assert.equal(initial.model, 'deepseek-flash')
  assert.equal(initial.endpoint, 'https://api.deepseek.com/chat/completions')
  const legacyId = initial.activeProfileId
  const endpoint = `${provider.listeningOrigin}/v1/chat/completions`
  const create = await app.inject({ method: 'POST', url: '/api/ai-judge/models', headers, payload: { name: '自定义模型', model: 'custom-model', endpoint: `${provider.listeningOrigin}/v1`, apiKey: 'custom-test-key' } })
  assert.equal(create.statusCode, 201, create.body)
  const settings = create.json()
  assert.equal(settings.profiles.length, 2)
  assert.equal(settings.activeProfileId, legacyId, 'saving a second model must not silently switch the active model')
  const profile = settings.profiles.find((item: { name: string }) => item.name === '自定义模型')
  assert.equal(profile.endpoint, endpoint)
  assert.ok(!create.body.includes('custom-test-key'))
  assert.ok(!(db.prepare('SELECT secret FROM ai_judge_models WHERE id=?').get(profile.id) as { secret: string }).secret.includes('custom-test-key'))
  const testSaved = await app.inject({ method: 'POST', url: '/api/ai-judge/test', headers, payload: { profileId: profile.id } })
  assert.equal(testSaved.statusCode, 200, testSaved.body)
  assert.equal(ai.getJudgeSettings().activeProfileId, legacyId, 'testing a model must not switch the active provider')
  const activate = await app.inject({ method: 'POST', url: `/api/ai-judge/models/${profile.id}/activate`, headers })
  assert.equal(activate.statusCode, 200)
  assert.equal(activate.json().activeProfileId, profile.id)
  const test = await app.inject({ method: 'POST', url: '/api/ai-judge/test', headers, payload: {} })
  assert.equal(test.statusCode, 200, test.body)
  assert.deepEqual(calls[0], { model: 'custom-model', key: 'Bearer custom-test-key' })
  const update = await app.inject({ method: 'PUT', url: `/api/ai-judge/models/${profile.id}`, headers, payload: { name: '重命名', model: 'custom-model-v2', endpoint } })
  assert.equal(update.statusCode, 200, update.body)
  await app.inject({ method: 'POST', url: '/api/ai-judge/test', headers, payload: {} })
  assert.deepEqual(calls[2], { model: 'custom-model-v2', key: 'Bearer custom-test-key' })
  const changeHost = await app.inject({ method: 'PUT', url: `/api/ai-judge/models/${profile.id}`, headers, payload: { name: '重命名', model: 'custom-model-v2', endpoint: 'https://other.example/v1' } })
  assert.equal(changeHost.statusCode, 400, 'changing provider requires an explicit new key')
  for (const invalid of ['file:///tmp/model', 'https://user:password@example.com/v1', 'https://example.com/v1?key=secret']) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/ai-judge/models', headers, payload: { name: 'bad', model: 'model', endpoint: invalid, apiKey: 'test' } })).statusCode, 400)
  }
  const beforeMigration = ai.getJudgeSettings()
  migrate()
  assert.deepEqual(ai.getJudgeSettings(), beforeMigration, 'migration must be repeatable without resetting model selection')
  await app.inject({ method: 'POST', url: `/api/ai-judge/models/${legacyId}/activate`, headers })
  assert.equal(ai.getJudgeSettings().model, 'deepseek-flash')
  console.log('PASS custom models: legacy migration, multiple profiles, encrypted keys, edit, switch, actual compatible HTTP request, endpoint validation, key isolation')
} finally { await provider.close(); await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }) }
