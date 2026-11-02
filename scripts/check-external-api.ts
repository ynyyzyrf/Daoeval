import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const directory = mkdtempSync(join(tmpdir(), 'daoeval-api-'))
const key = 'test-only-api-key-not-a-production-secret'
process.env.AEVAL_DATA_DIR = directory
process.env.AEVAL_API_KEY = key
const { migrate, db } = await import('../src/server/db.ts')
const { buildApp } = await import('../src/server/app.ts')
const { createMockAgentApp } = await import('../src/server/mock-agent.ts')
migrate()
const app = await buildApp()
const mock = createMockAgentApp()
await mock.listen({ port: 0, host: '127.0.0.1' })
const headers = { 'x-api-key': key }
try {
  // Configuration is loaded before DB/crypto modules, while injected env takes precedence.
  writeFileSync(join(directory, '.env'), 'AEVAL_API_KEY=from-file\nAEVAL_ENV_PROBE=loaded\n')
  const envModule = new URL('../src/server/env.ts', import.meta.url).href
  const probe = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', `
    await import(${JSON.stringify(envModule)});
    if (process.env.AEVAL_ENV_PROBE !== 'loaded' || process.env.AEVAL_API_KEY !== ${JSON.stringify(key)}) process.exit(1);
  `], { cwd: directory, env: { ...process.env, AEVAL_ENV_PROBE: undefined }, encoding: 'utf8' })
  assert.equal(probe.status, 0, probe.stderr)
  const noKey = await app.inject({ method: 'POST', url: '/api/v1/test-sets', payload: { name: 'unauthorized' } })
  assert.equal(noKey.statusCode, 401)
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/agents', headers: { 'x-api-key': 'wrong' } })).statusCode, 401)
  assert.equal((await app.inject({ method: 'GET', url: `/api/v1/agents?api_key=${key}` })).statusCode, 401)
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/agents', headers: { authorization: `Bearer ${key}` } })).statusCode, 200)
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/agents', headers: { ...headers, authorization: 'Bearer wrong' } })).statusCode, 401)
  assert.equal((await app.inject('/healthz')).statusCode, 200)
  assert.equal((await app.inject('/api/agents')).statusCode, 401, 'web API requires a browser session')
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM test_set').get() as { n: number }).n, 0, 'rejected requests must not write data')
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/agents', headers, payload: { config: {} } })).statusCode, 400)
  const invalidSet = await app.inject({ method: 'POST', url: '/api/v1/test-sets', headers, payload: { name: 'must-roll-back', cases: [{}] } })
  assert.equal(invalidSet.statusCode, 400)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM test_set').get() as { n: number }).n, 0, 'invalid cases must not leave an orphan test set')
  const agentResponse = await app.inject({ method: 'POST', url: '/api/v1/agents', headers, payload: { config: {
    name: 'API Agent', platformType: 'custom_http', endpoint: `${mock.listeningOrigin}/mock/plain`, authType: 'none',
    requestTemplate: { method: 'POST', headers: {}, body: { input: '{{input}}', session_id: '{{sessionId}}' } },
    responseMap: { outputPath: 'final_answer' }, allowWrite: false, versionInfo: { model: 'mock' },
  } } })
  assert.equal(agentResponse.statusCode, 201, agentResponse.body)
  const agent = agentResponse.json()
  assert.ok(agent.id && agent.versionId && agent.validation.ok)
  const setResponse = await app.inject({ method: 'POST', url: '/api/v1/test-sets', headers, payload: { name: 'API test set', cases: [{
    name: 'Case 1', type: 'basic_qa', input: '你好', expected: '你好', scoringRubric: '',
    rule: [{ kind: 'contains', path: 'output', value: '你好' }], timeoutMs: 30000,
    multiTurn: null, priority: 'medium', readWrite: 'read',
  }] } })
  assert.equal(setResponse.statusCode, 201, setResponse.body)
  const publishResponse = await app.inject({ method: 'POST', url: `/api/v1/test-sets/${setResponse.json().id}/publish`, headers, payload: {} })
  assert.equal(publishResponse.statusCode, 201, publishResponse.body)
  const scoring = (await app.inject({ method: 'GET', url: '/api/v1/scoring-profile-versions', headers })).json()
  const experimentResponse = await app.inject({ method: 'POST', url: '/api/v1/experiments', headers, payload: {
    name: 'API experiment', kind: 'A', datasetVersionId: publishResponse.json().versionId,
    scoringProfileVersionId: scoring[0].id, repeats: 1, branches: [{ role: 'baseline', agentVersionId: agent.versionId }],
  } })
  assert.equal(experimentResponse.statusCode, 201, experimentResponse.body)
  assert.ok(experimentResponse.json().experimentId)
  const audit = db.prepare("SELECT actor, path, detail FROM audit_log WHERE action = 'experiment.create'").get() as { actor: string; path: string; detail: string }
  assert.equal(audit.actor, 'external-api')
  assert.equal(audit.path, '/api/v1/experiments')
  assert.ok(!JSON.stringify(audit).includes(key), 'API key must not appear in audit')
  delete process.env.AEVAL_API_KEY
  const disabled = await buildApp()
  try {
    assert.equal((await disabled.inject({ method: 'GET', url: '/api/v1/agents', headers })).statusCode, 503)
    assert.equal((await disabled.inject('/api/agents')).statusCode, 401)
  } finally { await disabled.close() }
  console.log('PASS external API: env, auth, fail-closed, independent web login, agent → dataset → publish → experiment, audit')
} finally {
  await app.close()
  await mock.close()
  db.close()
  rmSync(directory, { recursive: true, force: true })
}
