import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directory = mkdtempSync(join(tmpdir(), 'daoeval-login-'))
process.env.AEVAL_DATA_DIR = directory
delete process.env.AEVAL_ADMIN_USERNAME
delete process.env.AEVAL_ADMIN_PASSWORD
process.env.AEVAL_API_KEY = 'login-test-external-api-key'
const { migrate, db } = await import('../src/server/db.ts')
const { buildApp } = await import('../src/server/app.ts')
migrate()
const app = await buildApp()
try {
  for (const url of ['/api/agents', '/api/test-sets', '/api/experiments', '/api/audit', '/api/test-sets/template.xlsx']) {
    assert.equal((await app.inject(url)).statusCode, 401, url)
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/test-sets', payload: { name: 'unauthorized' } })).statusCode, 401)
  assert.equal((await app.inject('/api/auth/session')).statusCode, 401)
  assert.equal((await app.inject('/healthz')).statusCode, 200)
  assert.equal((await app.inject('/api/share/abcdefghijklmnopqrstuvwxyz')).statusCode, 404, 'public share links stay public')
  const login = (username: string, password: string, ip = '127.0.0.1') => app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: ip, payload: { username, password } })
  assert.equal((await login('admin', 'wrong')).statusCode, 401)
  const response = await login('admin', 'admin')
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().username, 'admin')
  const cookie = response.cookies[0]!
  assert.ok(cookie.httpOnly)
  assert.equal(cookie.sameSite, 'Strict')
  assert.equal(cookie.path, '/')
  const headers = { cookie: `${cookie.name}=${cookie.value}` }
  assert.equal((await app.inject({ url: '/api/auth/session', headers })).statusCode, 200)
  assert.equal((await app.inject({ url: '/api/agents', headers })).statusCode, 200)
  assert.equal((await app.inject({ url: '/api/agents', headers: { cookie: `${cookie.name}=tampered` } })).statusCode, 401)
  assert.equal((await app.inject({ url: '/api/v1/agents', headers })).statusCode, 401, 'browser session does not replace API key')
  assert.equal((await app.inject({ url: '/api/v1/agents', headers: { 'x-api-key': process.env.AEVAL_API_KEY } })).statusCode, 200)
  assert.equal((await app.inject({ url: '/api/agents', headers: { 'x-api-key': process.env.AEVAL_API_KEY } })).statusCode, 401, 'API key does not replace web login')
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...headers, origin: 'https://other.example' } })).statusCode, 403)
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/logout', headers })).statusCode, 200)
  assert.equal((await app.inject({ url: '/api/agents', headers })).statusCode, 401, 'logout invalidates session server-side')
  for (let index = 0; index < 5; index++) assert.equal((await login('admin', 'bad', '127.0.0.2')).statusCode, 401)
  assert.equal((await login('admin', 'admin', '127.0.0.2')).statusCode, 429)
  const fresh = await login('admin', 'admin')
  const freshCookie = fresh.cookies.map((item) => `${item.name}=${item.value}`).join('; ')
  const realNow = Date.now
  try {
    Date.now = () => realNow() + 12 * 60 * 60 * 1000 + 1
    assert.equal((await app.inject({ url: '/api/auth/session', headers: { cookie: freshCookie } })).statusCode, 401, 'sessions expire after 12 hours')
  } finally { Date.now = realNow }

  process.env.AEVAL_ADMIN_USERNAME = 'operator'
  process.env.AEVAL_ADMIN_PASSWORD = 'custom-test-password'
  process.env.AEVAL_COOKIE_SECURE = 'true'
  const configured = await buildApp()
  try {
    assert.equal((await configured.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin' } })).statusCode, 401)
    const result = await configured.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'operator', password: 'custom-test-password' } })
    assert.equal(result.statusCode, 200)
    assert.equal(result.cookies[0]!.secure, true)
    assert.ok(!result.body.includes('custom-test-password'))
  } finally { await configured.close() }
  console.log('PASS login: defaults, env override, protected web APIs/downloads, HttpOnly session, tamper rejection, logout, rate limit, CSRF, independent API key, public health/share')
} finally {
  await app.close()
  db.close()
  rmSync(directory, { recursive: true, force: true })
}
