import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'

// Run from the repository root. Requires Docker with Linux containers.
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 600_000, stdio: ['ignore', 'pipe', 'inherit'] }).trim()
const image = 'daoeval-deploy-check'
const name = `daoeval-check-${process.pid}`
execFileSync('docker', ['build', '-t', image, '.'], { stdio: 'inherit', timeout: 1_200_000 })
try {
  docker('run', '-d', '--name', name, '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=512m,mode=1777', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--shm-size=256m', '-e', 'HOME=', '-p', '127.0.0.1::3000', image)
  const port = JSON.parse(docker('inspect', name))[0].NetworkSettings.Ports['3000/tcp'][0].HostPort
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 300_000
  let ready = false
  while (Date.now() < deadline) {
    assert.equal(JSON.parse(docker('inspect', name))[0].State.Running, true, 'container exited before becoming healthy')
    try {
      const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2000) })
      if (response.status === 200) {
        assert.deepEqual(await response.json(), { status: 'ok' })
        ready = true
        break
      }
    } catch { /* Wait for startup. */ }
    await setTimeout(1000)
  }
  assert.ok(ready, 'health check must succeed within five minutes')
  assert.equal((await fetch(base, { signal: AbortSignal.timeout(5000) })).status, 200, 'frontend must be served')
  assert.equal((await fetch(`${base}/api/overview`)).status, 401, 'web API must require login')
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }) })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie, 'login must set a session cookie')
  assert.equal((await fetch(`${base}/api/overview`, { headers: { cookie }, signal: AbortSignal.timeout(5000) })).status, 200, 'database must be usable after login')
  assert.equal(docker('exec', name, 'id', '-u'), '10001')
  docker('exec', name, 'node', '--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { writeFileSync } from 'node:fs';
    import { renderReportPdf } from './src/server/report.ts';
    assert.throws(() => writeFileSync('/app/readonly-probe', 'blocked'));
    const pdf = await renderReportPdf('<html><meta charset="utf-8"><body>Daoeval 中文 PDF deployment check</body></html>');
    assert.ok(pdf && pdf.subarray(0, 5).toString() === '%PDF-', 'Chromium must produce a PDF');
  `)
  console.log('PASS container: UID 10001, port 3000, health, frontend, SQLite, PDF, read-only filesystem')
} catch (error) {
  try { console.error(docker('logs', name)) } catch { /* Container may not exist. */ }
  throw error
} finally {
  try { docker('rm', '-f', name) } catch { /* Container may not exist. */ }
}
