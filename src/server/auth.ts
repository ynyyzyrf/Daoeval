import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'

const COOKIE = 'daoeval_session'
const LIFETIME = 12 * 60 * 60 * 1000
const LOGIN_WINDOW = 15 * 60 * 1000
const digest = (value: string) => createHash('sha256').update(value).digest()

/** Single administrator login; sessions are deliberately local to this process. */
export function registerAuth(app: FastifyInstance): void {
  const username = process.env.AEVAL_ADMIN_USERNAME || 'admin'
  const password = process.env.AEVAL_ADMIN_PASSWORD || 'admin'
  const salt = randomBytes(16)
  const passwordHash = scryptSync(password, salt, 64)
  const sessions = new Map<string, number>()
  const failures = new Map<string, { count: number; until: number }>()
  const secure = (request: FastifyRequest) => process.env.AEVAL_COOKIE_SECURE === 'true' || request.protocol === 'https'
  const cookieHeader = (value: string, age: number, request: FastifyRequest) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure(request) ? '; Secure' : ''}`
  const tokenHash = (request: FastifyRequest) => {
    const token = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1)
    return token ? digest(token).toString('hex') : null
  }
  const authenticated = (request: FastifyRequest) => {
    const token = tokenHash(request)
    if (!token) return false
    const expires = sessions.get(token)
    if (!expires || expires <= Date.now()) { sessions.delete(token); return false }
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
    if (!authenticated(request)) return reply.code(401).send({ error: '請先登入' })
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
    for (const [token, expires] of sessions) if (expires <= now) sessions.delete(token)
    const oldToken = tokenHash(request)
    if (oldToken) sessions.delete(oldToken)
    if (sessions.size >= 1000) sessions.delete(sessions.keys().next().value!)
    const token = randomBytes(32).toString('hex')
    sessions.set(digest(token).toString('hex'), now + LIFETIME)
    return reply.header('set-cookie', cookieHeader(token, LIFETIME / 1000, request)).send({ username })
  })
  app.get('/api/auth/session', async (request, reply) => {
    if (!authenticated(request)) return reply.code(401).send({ error: '請先登入' })
    return { username }
  })
  app.post('/api/auth/logout', async (request, reply) => {
    const token = tokenHash(request)
    if (token) sessions.delete(token)
    return reply.header('set-cookie', cookieHeader('', 0, request)).send({ ok: true })
  })
  app.addHook('onClose', async () => { sessions.clear(); failures.clear() })
}
