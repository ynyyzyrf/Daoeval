import Fastify from 'fastify'

/** 本地模擬 Agent 服務：用來驗證適配層與三態語義，不代表真實 Oumi/Dify 回應格式 */
export function createMockAgentApp() {
  const app = Fastify({ logger: false })

  const base = (input: string, sessionId: string) => ({
    run_id: `run_${Math.random().toString(36).slice(2, 10)}`,
    session_id: sessionId,
    input_echo: input.slice(0, 120),
  })

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  // 工具型 Agent：工具調用、Trace、Token 都取得到
  app.post('/mock/oumi', async (req) => {
    const body = req.body as { input?: string; session_id?: string }
    const input = body.input ?? ''
    await delay(120 + Math.random() * 300)
    // 安全性案例：越權或索取憑證時拒絕，回應內容即可判定，不需發寫入請求
    if (/其他用戶|他人|別的用戶|後台|密碼|憑證|管理員/.test(input)) {
      return {
        ...base(input, body.session_id ?? ''),
        status: 'success',
        final_answer: '抱歉，我無法提供其他用戶的資料或後台憑證；如需協助，請透過管理員申請權限。',
        tool_calls: [],
        trace: { steps: [{ step: 1, action: 'refuse' }] },
        usage: { total_tokens: 58 },
      }
    }
    const usesTool = /查|搜|計算|工具|天氣/.test(input)
    return {
      ...base(input, body.session_id ?? ''),
      status: 'success',
      final_answer: usesTool
        ? `已為你查詢完成：${input.slice(0, 40)}（資料來源：模擬檢索）`
        : `關於「${input.slice(0, 40)}」，這是模擬回答。`,
      tool_calls: usesTool
        ? [
            { name: 'web_search', input: { q: input.slice(0, 40) }, output: '3 筆結果', duration_ms: 240 },
            { name: 'summarize', input: { n: 3 }, output: '摘要完成', duration_ms: 120 },
          ]
        : [],
      trace: { steps: [{ step: 1, action: 'plan' }, { step: 2, action: 'answer' }] },
      usage: { prompt_tokens: 180, completion_tokens: 96, total_tokens: 276 },
    }
  })

  // 純問答 Agent：完全不提供工具調用與 Trace 欄位（取不到 → null）
  app.post('/mock/plain', async (req) => {
    const body = req.body as { input?: string; session_id?: string }
    await delay(90)
    return {
      ...base(body.input ?? '', body.session_id ?? ''),
      status: 'success',
      final_answer: `（純問答）${(body.input ?? '').slice(0, 60)}`,
    }
  })

  // 明確回報「沒有調用工具」：空陣列，不能與 null 混淆
  app.post('/mock/empty-tools', async (req) => {
    const body = req.body as { input?: string; session_id?: string }
    await delay(110)
    return {
      ...base(body.input ?? '', body.session_id ?? ''),
      status: 'success',
      final_answer: `（無工具，已明確回報）${(body.input ?? '').slice(0, 50)}`,
      tool_calls: [],
      trace: { steps: [{ step: 1, action: 'answer' }] },
      usage: { total_tokens: 64 },
    }
  })

  app.post('/mock/slow', async (req) => {
    const body = req.body as { input?: string; session_id?: string }
    await delay(6000)
    return { ...base(body.input ?? '', body.session_id ?? ''), status: 'success', final_answer: '遲到但成功' }
  })

  app.post('/mock/unauthorized', async (_req, reply) => {
    return reply.code(401).send({ error: 'invalid api key' })
  })

  app.post('/mock/not-found', async (_req, reply) => {
    return reply.code(404).send({ error: 'route not found' })
  })

  app.post('/mock/rate-limited', async (_req, reply) => {
    return reply.code(429).send({ error: 'too many requests' })
  })

  // 非 JSON 回應：驗證 parse_failed 與錯誤訊息帶回應片段
  app.post('/mock/not-json', async (_req, reply) => {
    return reply.type('text/plain').send('<html>gateway error</html>')
  })

  app.post('/mock/server-error', async (_req, reply) => {
    return reply.code(503).send({ error: 'upstream unavailable' })
  })

  app.post('/mock/bad-mapping', async (req) => {
    const body = req.body as { input?: string }
    // 欄位名與約定的 answer 不一致，用於驗證「回應不符合欄位映射」
    return { result: { text: body.input ?? '' }, status: 'success' }
  })

  // Oumi group 形態的佔位回應：結構對齊 RESPONSE_MAP_TEMPLATES.oumi，用來驗證模板與映射可配置
  app.post('/mock/oumi-group', async (req) => {
    const body = req.body as { input?: string; session_id?: string }
    await delay(100)
    return {
      data: {
        message: { content: `（group 形態）${(body.input ?? '').slice(0, 50)}` },
        status: 'succeeded',
        tool_calls: [{ name: 'search', duration_ms: 120 }],
        trace: { steps: [{ step: 1, action: 'plan' }] },
        usage: { prompt_tokens: 210, completion_tokens: 90, total_tokens: 300 },
        run_id: `run_${Math.random().toString(36).slice(2, 10)}`,
      },
    }
  })

  app.post('/mock/flaky', async (req) => {
    const body = req.body as { input?: string; session_id?: string }
    await delay(80)
    if (Math.random() < 0.34) {
      return { ...base(body.input ?? '', body.session_id ?? ''), status: 'failed', error: '模擬隨機失敗' }
    }
    return { ...base(body.input ?? '', body.session_id ?? ''), status: 'success', final_answer: '穩定成功' }
  })

  return app
}
