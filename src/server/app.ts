import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { registerRoutes } from './routes.ts'
import { registerAiEvaluationRoutes } from './ai-evaluation.ts'
import { SHARE_SECURITY_HEADERS, registerShareRoutes } from './share.ts'
import { registerExternalApi } from './external-api.ts'
import { registerAuth } from './auth.ts'

export interface BuildAppOptions {
  /** 前端建置產物目錄；預設為 web/dist */
  dist?: string
}

/**
 * 組裝 HTTP 服務：API 路由 + 前端靜態檔 + SPA fallback。
 * 前端使用 hash 路由，但 /agents、/report 這類路徑仍會被直接貼上、書籤或重新整理，
 * 因此非 /api/ 的 GET/HEAD 一律回 index.html，/api/ 維持 JSON 404。
 * /s/ 開頭是對外分享頁：外殼 HTML 由這裡直接回，避免 @fastify/static 的預設快取頭。
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: 'warn' } })
  registerAuth(app)
  app.get('/healthz', async () => ({ status: 'ok' }))
  registerRoutes(app)
  registerAiEvaluationRoutes(app)
  registerShareRoutes(app)
  await registerExternalApi(app)

  const dist = options.dist ?? join(process.cwd(), 'web', 'dist')
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist })
    app.setNotFoundHandler((req, reply) => {
      const path = (req.url.split('?')[0] ?? '/').split('#')[0] ?? '/'
      const isApi = path === '/api' || path.startsWith('/api/')
      const wantsPage = (req.method === 'GET' || req.method === 'HEAD') && !isApi && extname(path) === ''
      if (wantsPage) {
        if (path === '/s' || path.startsWith('/s/')) {
          return reply
            .headers(SHARE_SECURITY_HEADERS)
            .type('text/html; charset=utf-8')
            .send(readFileSync(join(dist, 'index.html'), 'utf8'))
        }
        return reply.type('text/html; charset=utf-8').sendFile('index.html')
      }
      return reply.code(404).send({ error: 'Not Found', message: `Route ${req.method}:${path} not found` })
    })
  }

  return app
}
