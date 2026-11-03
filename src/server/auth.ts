import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { db } from './db.ts'
import { authCredentialFingerprint } from './crypto.ts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

const COOKIE = 'daoeval_session'
const LIFETIME = 7 * 24 * 60 * 60 * 1000
const RENEW_INTERVAL = 24 * 60 * 60 * 1000
const LOGIN_WINDOW = 15 * 60 * 1000
const digest = (value: string) => createHash('sha256').update(value).digest()

/** Hashed sessions persist across restarts and renew at most once per day. */
export function registerAuth(app: FastifyInstance): void {
  const username = process.env.AEVAL_ADMIN_USERNAME || 'admin'
  const password = process.env.AEVAL_ADMIN_PASSWORD || 'admin'
  const salt = randomBytes(16)
  const passwordHash = scryptSync(password, salt, 64)
  const fingerprint = authCredentialFingerprint(username, password)
  db.prepare('DELETE FROM web_session WHERE expires_at <= ? OR auth_fingerprint <> ?').run(Date.now(), fingerprint)
  const failures = new Map<string, { count: number; until: number }>()
  const secure = (request: FastifyRequest) => process.env.AEVAL_COOKIE_SECURE === 'true' || request.protocol === 'https'
  const cookieHeader = (value: string, age: number, request: FastifyRequest) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure(request) ? '; Secure' : ''}`
  const tokenHash = (request: FastifyRequest) => {
    const token = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1)
    return token ? digest(token).toString('hex') : null
  }
  const authenticated = (request: FastifyRequest, reply: FastifyReply) => {
    const token = tokenHash(request)
    if (!token) return false
    const session = db.prepare('SELECT expires_at, auth_fingerprint FROM web_session WHERE token_hash = ?').get(token) as { expires_at: number; auth_fingerprint: string } | undefined
    const now = Date.now()
    if (!session || session.expires_at <= now || session.auth_fingerprint !== fingerprint) {
      db.prepare('DELETE FROM web_session WHERE token_hash = ?').run(token)
      return false
    }
    if (session.expires_at - now <= LIFETIME - RENEW_INTERVAL) {
      db.prepare('UPDATE web_session SET expires_at = ? WHERE token_hash = ?').run(now + LIFETIME, token)
      const raw = request.headers.cookie!.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))!.slice(COOKIE.length + 1)
      reply.header('set-cookie', cookieHeader(raw, LIFETIME / 1000, request))
    }
    return true
  }

  app.addHook('onRequest', async (request, reply) => {
    const path = request.routeOptions.url ?? request.url.split('?')[0]!
    if (!(path === '/api' || path.startsWith('/api/')) || path === '/api/v1' || path.startsWith('/api/v1/')) return
    if (path === '/api/share/:token' && ['GET', 'HEAD'].includes(request.method)) return
    reply.header('cache-control', 'no-store')
    // SameSite cookies plus origin checking protect browser mutations and login/logout.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin) {
      try {
        if (new URL(request.headers.origin).host !== request.headers.host) return reply.code(403).send({ error: '不允許跨站請求' })
      } catch { return reply.code(403).send({ error: '不允許跨站請求' }) }
    }
    if (['/api/auth/login', '/api/auth/logout', '/api/auth/session'].includes(path)) return
    if (!authenticated(request, reply)) return reply.code(401).send({ error: '請先登入' })
    request.headers['x-actor'] = username
  })

  app.post('/api/auth/login', { bodyLimit: 4096 }, async (request, reply) => {
    const now = Date.now()
    for (const [ip, failure] of failures) if (failure.until <= now) failures.delete(ip)
    const failure = failures.get(request.ip)
    if (failure && failure.count >= 5) {
      return reply.code(429).header('retry-after', String(Math.ceil((failure.until - now) / 1000))).send({ error: '登入失敗次數過多，請稍後再試' })
    }
    const body = request.body as { username?: unknown; password?: unknown } | null
    if (typeof body?.username !== 'string' || typeof body.password !== 'string' || body.username.length > 128 || body.password.length > 1024) {
      return reply.code(400).send({ error: '請輸入帳號和密碼' })
    }
    const userOk = timingSafeEqual(digest(body.username), digest(username))
    const passwordOk = timingSafeEqual(scryptSync(body.password, salt, 64), passwordHash)
    if (!userOk || !passwordOk) {
      if (failures.size >= 10000) failures.delete(failures.keys().next().value!)
      failures.set(request.ip, { count: (failure?.count ?? 0) + 1, until: failure?.until ?? now + LOGIN_WINDOW })
      return reply.code(401).send({ error: '帳號或密碼錯誤' })
    }
    failures.delete(request.ip)
    db.prepare('DELETE FROM web_session WHERE expires_at <= ?').run(now)
    const oldToken = tokenHash(request)
    if (oldToken) db.prepare('DELETE FROM web_session WHERE token_hash = ?').run(oldToken)
    if ((db.prepare('SELECT COUNT(*) AS n FROM web_session').get() as { n: number }).n >= 1000) db.prepare('DELETE FROM web_session WHERE token_hash IN (SELECT token_hash FROM web_session ORDER BY created_at LIMIT 1)').run()
    const token = randomBytes(32).toString('hex')
    db.prepare('INSERT INTO web_session (token_hash, auth_fingerprint, expires_at, created_at) VALUES (?, ?, ?, ?)').run(digest(token).toString('hex'), fingerprint, now + LIFETIME, now)
    return reply.header('set-cookie', cookieHeader(token, LIFETIME / 1000, request)).send({ username })
  })
  app.get('/api/auth/session', async (request, reply) => {
    if (!authenticated(request, reply)) return reply.code(401).send({ error: '請先登入' })
    return { username }
  })
  app.post('/api/auth/logout', async (request, reply) => {
    const token = tokenHash(request)
    if (token) db.prepare('DELETE FROM web_session WHERE token_hash = ?').run(token)
    return reply.header('set-cookie', cookieHeader('', 0, request)).send({ ok: true })
  })
  app.addHook('onClose', async () => { failures.clear() })
}
