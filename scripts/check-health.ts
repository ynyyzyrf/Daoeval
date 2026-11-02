import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AEVAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'daoeval-health-'))
const { migrate, db } = await import('../src/server/db.ts')
const { buildApp } = await import('../src/server/app.ts')
migrate()
// Health must work even without frontend assets and without authentication.
const app = await buildApp({ dist: join(process.env.AEVAL_DATA_DIR, 'missing') })
try {
  const response = await app.inject({ method: 'GET', url: '/healthz' })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { status: 'ok' })
  console.log('PASS unauthenticated health check without frontend assets')
} finally {
  await app.close()
  db.close()
  rmSync(process.env.AEVAL_DATA_DIR, { recursive: true, force: true })
}
