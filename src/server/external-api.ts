import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { registerCreationRoutes } from './routes.ts'
import { listAgents, listDatasetVersions, listScoringProfileVersions, listTestSets } from './store.ts'

/** Separate integration surface authenticated by API key rather than browser session. */
export async function registerExternalApi(app: FastifyInstance): Promise<void> {
  const configuredKey = process.env.AEVAL_API_KEY?.trim()
  const expected = configuredKey ? createHash('sha256').update(configuredKey).digest() : null
  await app.register(async (external) => {
    external.addHook('onRequest', async (request, reply) => {
      reply.header('cache-control', 'no-store')
      if (!expected) return reply.code(503).send({ error: 'External API is disabled: AEVAL_API_KEY is not configured' })
      const header = request.headers['x-api-key']
      const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? '')?.[1]
      const provided = typeof header === 'string' ? header : bearer
      if (!provided || (header && bearer && header !== bearer) ||
          !timingSafeEqual(expected, createHash('sha256').update(provided).digest())) {
        return reply.code(401).send({ error: 'Invalid or missing API key' })
      }
      request.headers['x-actor'] = 'external-api'
    })
    registerCreationRoutes(external, '/api/v1')
    external.get('/api/v1/agents', async () => listAgents())
    external.get('/api/v1/test-sets', async () => listTestSets())
    external.get('/api/v1/dataset-versions', async () => listDatasetVersions())
    external.get('/api/v1/scoring-profile-versions', async () => listScoringProfileVersions())
  })
}
