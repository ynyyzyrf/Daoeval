import type {
  AgentConfig,
  ErrorClass,
  ErrorInfo,
  Evidence,
  NormalizedTrial,
  TokenUsage,
  VersionInfo,
} from '../shared/types.ts'
import { fillTemplate, getPath } from './json-path.ts'

export interface CallInput {
  config: AgentConfig
  secret: string | null
  input: string
  sessionId: string
  caseName: string
  timeoutMs: number
}

export interface CallOutcome {
  finalOutput: string | null
  status: 'succeeded' | 'failed'
  latencyMs: number
  error: ErrorInfo | null
  toolCalls: Evidence<unknown[]>
  trace: Evidence<unknown>
  tokens: Evidence<number>
  tokenUsage: TokenUsage
  httpStatus: number | null
  rawSnippet: string
  rawJson?: unknown
  requestSummary: string
}

const UNAVAILABLE_TOKENS: TokenUsage = {
  prompt: { status: 'unavailable', value: null },
  completion: { status: 'unavailable', value: null },
  total: { status: 'unavailable', value: null },
}

function numberEvidence(value: unknown): Evidence<number> {
  if (value === undefined || value === null) return { status: 'unavailable', value: null }
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? { status: 'present', value: num } : { status: 'unavailable', value: null }
}

/** 三態：null/缺欄位 = 取不到；空陣列 = 明確沒有；有值 = 取到 */
export function toEvidence(value: unknown, expectArray = false): Evidence<unknown> {
  if (value === undefined || value === null) return { status: 'unavailable', value: null }
  if (expectArray) {
    if (Array.isArray(value)) {
      return value.length === 0 ? { status: 'none', value: [] } : { status: 'present', value }
    }
    return { status: 'unavailable', value: null }
  }
  if (Array.isArray(value) && value.length === 0) return { status: 'none', value: [] }
  return { status: 'present', value }
}

export function classifyHttpError(status: number): ErrorClass {
  if (status === 401 || status === 403) return 'auth_failed'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'server_error'
  return 'client_error'
}

/** HTTP 失敗訊息要指到下一步該改哪裡，而不是只回一個狀態碼 */
function httpMessage(status: number, snippet: string): string {
  const detail = snippet ? `；回應：${snippet.slice(0, 160)}` : ''
  if (status === 401 || status === 403) return `認證失敗（HTTP ${status}）：檢查認證方式、Header 名稱與憑證${detail}`
  if (status === 404) return `端點不存在（HTTP ${status}）：檢查 API 地址、路徑與請求方法${detail}`
  if (status === 429) return `被限流（HTTP ${status}）：降低並發或稍後重試${detail}`
  if (status >= 500) return `服務端錯誤（HTTP ${status}）：被測方或上游異常${detail}`
  return `請求被拒（HTTP ${status}）：檢查請求方法、Body 模板與必填欄位${detail}`
}

/** 回應頂層欄位，用於欄位路徑對不上時提示實際可用鍵 */
export function topLevelKeys(json: unknown): string {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return ''
  return Object.keys(json).slice(0, 10).join('、')
}

function redact(text: string, secret: string | null): string {
  if (!secret || secret.length < 4) return text
  return text.split(secret).join('••••')
}

function buildAuthHeaders(config: AgentConfig, secret: string | null): Record<string, string> {
  if (!secret) return {}
  switch (config.authType) {
    case 'api_key':
      return { [config.authHeader || 'X-API-Key']: secret }
    case 'bearer':
      return { Authorization: `Bearer ${secret}` }
    case 'header':
      return { [config.authHeader || 'X-Auth-Token']: secret }
    default:
      return {}
  }
}

export function mapConversationJson(
  json: unknown,
  fallbackLatencyMs: number,
): { finalOutput: string | null; ok: boolean; errorClass?: ErrorClass; errorMessage?: string; latencyMs: number; prompt?: number; completion?: number; total?: number } {
  const fallback = Math.max(0, fallbackLatencyMs)
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { finalOutput: null, ok: false, errorClass: 'mapping_failed', errorMessage: '會話回應不是物件', latencyMs: fallback }
  }
  const response = json as Record<string, unknown>
  const rawError = response.error
  const errorMessage = typeof rawError === 'string'
    ? rawError
    : rawError && typeof rawError === 'object' && typeof (rawError as Record<string, unknown>).message === 'string'
      ? (rawError as Record<string, unknown>).message as string
      : ''
  if (errorMessage || response.status === 2) {
    const message = errorMessage || '會話執行失敗（status=2）'
    const errorClass: ErrorClass = /未配置默认模型|未配置默認模型|未指定模型|not configured|default model/i.test(message)
      ? 'config_error'
      : 'client_error'
    return { finalOutput: null, ok: false, errorClass, errorMessage: message, latencyMs: fallback }
  }
  if (!response.completedAt || !Array.isArray(response.turns) || response.turns.length === 0) {
    return { finalOutput: null, ok: false, errorClass: 'mapping_failed', errorMessage: '會話已完成但沒有可用的 turn', latencyMs: fallback }
  }
  const lastTurn = response.turns[response.turns.length - 1]
  if (!lastTurn || typeof lastTurn !== 'object' || Array.isArray(lastTurn)) {
    return { finalOutput: null, ok: false, errorClass: 'mapping_failed', errorMessage: '最後一個 turn 格式不正確', latencyMs: fallback }
  }
  const turn = lastTurn as Record<string, unknown>
  const finalOutput = typeof turn.text === 'string' && turn.text.trim() ? turn.text : null
  if (!finalOutput) {
    return { finalOutput: null, ok: false, errorClass: 'mapping_failed', errorMessage: '最後一個 turn 沒有非空文字', latencyMs: fallback }
  }
  const startedAt = Date.parse(String(turn.startedAt ?? ''))
  const completedAt = Date.parse(String(turn.completedAt ?? ''))
  const latencyMs = Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt
    ? completedAt - startedAt
    : fallback
  const usage = turn.usage && typeof turn.usage === 'object' && !Array.isArray(turn.usage)
    ? turn.usage as Record<string, unknown>
    : {}
  const number = (value: unknown): number | undefined => {
    const parsed = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return { finalOutput, ok: true, latencyMs, prompt: number(usage.inputTokens), completion: number(usage.outputTokens), total: number(usage.totalTokens) }
}

function buildRequestSummary(
  config: AgentConfig,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): string {
  const safeHeaders: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    safeHeaders[k] = /authorization|key|token|secret/i.test(k) ? '••••' : v
  }
  return JSON.stringify(
    { method: config.requestTemplate.method, url, headers: safeHeaders, body: body ?? null },
    null,
    2,
  )
}

export async function callViaConversation(ctx: CallInput): Promise<CallOutcome> {
  const { config, secret, input, timeoutMs } = ctx
  const targeting = config.targeting!
  const startedAtMs = Date.now()
  const baseUrl = config.endpoint.replace(/\/$/, '')
  const conversationsUrl = `${baseUrl}/api/v1/conversations`
  const headers = { ...buildAuthHeaders(config, secret), 'content-type': 'application/json' }
  const body: Record<string, string> = { targetType: targeting.targetType, targetId: targeting.targetId, prompt: input }
  if (targeting.providerId?.trim()) body.providerId = targeting.providerId.trim()
  const requestSummary = (conversationId?: string) =>
    `POST /api/v1/conversations（targetType=${targeting.targetType}, targetId=${targeting.targetId}）${conversationId ? `；conversation id=${conversationId}` : ''}`
  let conversationId: string | null = null
  let lastStatus: number | null = null
  let lastSnippet = ''

  try {
    let created: Response
    try {
      created = await fetch(conversationsUrl, { method: 'POST', headers, body: JSON.stringify(body) })
    } catch (error) {
      return failure('connection_failed', `連線失敗：${redact(String((error as Error)?.message ?? error), secret)}`, Date.now() - startedAtMs, null, '', requestSummary())
    }
    lastStatus = created.status
    const createText = await created.text()
    lastSnippet = redact(createText.slice(0, 4000), secret)
    if (!created.ok) {
      return failure(classifyHttpError(created.status), httpMessage(created.status, lastSnippet), Date.now() - startedAtMs, created.status, lastSnippet, requestSummary())
    }
    let createJson: unknown
    try {
      createJson = createText ? JSON.parse(createText) : undefined
    } catch {
      return failure('parse_failed', '建立會話的回應不是合法 JSON', Date.now() - startedAtMs, created.status, lastSnippet, requestSummary())
    }
    conversationId = createJson && typeof createJson === 'object' && typeof (createJson as Record<string, unknown>).id === 'string'
      ? (createJson as Record<string, unknown>).id as string
      : null
    if (!conversationId) {
      return failure('mapping_failed', '建立會話的回應沒有 id', Date.now() - startedAtMs, created.status, lastSnippet, requestSummary())
    }

    const conversationUrl = `${conversationsUrl}/${encodeURIComponent(conversationId)}`
    let pollFailures = 0
    while (Date.now() - startedAtMs < Math.max(1, timeoutMs)) {
      await new Promise((resolve) => setTimeout(resolve, 700))
      if (Date.now() - startedAtMs >= Math.max(1, timeoutMs)) break
      let response: Response
      try {
        response = await fetch(conversationUrl, { method: 'GET', headers: buildAuthHeaders(config, secret) })
      } catch (error) {
        pollFailures += 1
        if (pollFailures >= 3) {
          return failure('connection_failed', `輪詢連線失敗：${redact(String((error as Error)?.message ?? error), secret)}`, Date.now() - startedAtMs, null, lastSnippet, requestSummary(conversationId))
        }
        continue
      }
      lastStatus = response.status
      const text = await response.text()
      lastSnippet = redact(text.slice(0, 4000), secret)
      if (!response.ok) {
        pollFailures += 1
        if (pollFailures >= 3) {
          return failure(classifyHttpError(response.status), httpMessage(response.status, lastSnippet), Date.now() - startedAtMs, response.status, lastSnippet, requestSummary(conversationId))
        }
        continue
      }
      pollFailures = 0
      let json: unknown
      try {
        json = text ? JSON.parse(text) : undefined
      } catch {
        return failure('parse_failed', '輪詢會話的回應不是合法 JSON', Date.now() - startedAtMs, response.status, lastSnippet, requestSummary(conversationId))
      }
      const responseObject = json && typeof json === 'object' && !Array.isArray(json) ? json as Record<string, unknown> : null
      const terminal = Boolean(responseObject?.error) || responseObject?.status === 2 || Boolean(responseObject?.completedAt)
      if (!terminal) continue

      const mapped = mapConversationJson(json, Date.now() - startedAtMs)
      if (!mapped.ok) {
        return failure(mapped.errorClass ?? 'mapping_failed', mapped.errorMessage ?? '會話結果解析失敗', mapped.latencyMs, response.status, lastSnippet, requestSummary(conversationId))
      }
      const tokenUsage: TokenUsage = {
        prompt: numberEvidence(mapped.prompt),
        completion: numberEvidence(mapped.completion),
        total: numberEvidence(mapped.total),
      }
      return {
        finalOutput: mapped.finalOutput,
        status: 'succeeded',
        latencyMs: mapped.latencyMs,
        error: null,
        toolCalls: { status: 'unavailable', value: null },
        trace: { status: 'unavailable', value: null },
        tokens: tokenUsage.total,
        tokenUsage,
        httpStatus: response.status,
        rawSnippet: lastSnippet,
        rawJson: json,
        requestSummary: requestSummary(conversationId),
      }
    }
    return failure('timeout', `會話輪詢逾時（${timeoutMs} ms）`, Date.now() - startedAtMs, lastStatus, lastSnippet, requestSummary(conversationId))
  } finally {
    if (conversationId) {
      try {
        await fetch(`${conversationsUrl}/${encodeURIComponent(conversationId)}`, { method: 'DELETE', headers: buildAuthHeaders(config, secret) })
      } catch (error) {
        console.warn(`刪除 Oumi 會話失敗（${conversationId}）：${String((error as Error)?.message ?? error)}`)
      }
    }
  }
}

export async function callAgent(ctx: CallInput): Promise<CallOutcome> {
  if (ctx.config.targeting) return callViaConversation(ctx)
  const { config, secret, input, sessionId, caseName, timeoutMs } = ctx
  const started = Date.now()
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...config.requestTemplate.headers,
    ...buildAuthHeaders(config, secret),
  }
  const vars = { input, sessionId, caseName }
  const body = config.requestTemplate.method === 'GET'
    ? undefined
    : fillTemplate(config.requestTemplate.body, vars)
  const summary = buildRequestSummary(config, config.endpoint, headers, body ?? { input, sessionId })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))

  let httpStatus: number | null = null
  let text = ''
  try {
    const init: RequestInit = {
      method: config.requestTemplate.method,
      headers,
      signal: controller.signal,
    }
    if (body !== undefined) init.body = JSON.stringify(body)
    const res = await fetch(config.endpoint, init)
    httpStatus = res.status
    text = await res.text()
  } catch (e) {
    clearTimeout(timer)
    const latencyMs = Date.now() - started
    const aborted = (e as Error)?.name === 'AbortError'
    const errClass: ErrorClass = aborted ? 'timeout' : 'connection_failed'
    const message = aborted
      ? `請求逾時（${timeoutMs} ms）`
      : `連線失敗：${redact(String((e as Error)?.message ?? e), secret)}`
    return failure(errClass, message, latencyMs, httpStatus, '', summary)
  }
  clearTimeout(timer)

  const latencyMs = Date.now() - started
  const snippet = redact(text.slice(0, 4000), secret)

  if (httpStatus !== null && (httpStatus < 200 || httpStatus >= 300)) {
    return failure(classifyHttpError(httpStatus), httpMessage(httpStatus, snippet), latencyMs, httpStatus, snippet, summary)
  }

  let json: unknown
  try {
    json = text.length ? JSON.parse(text) : undefined
  } catch {
    return failure(
      'parse_failed',
      `回應不是合法 JSON：${snippet.slice(0, 160) || '（空回應）'}`,
      latencyMs,
      httpStatus,
      snippet,
      summary,
    )
  }

  const map = config.responseMap
  const output = getPath(json, map.outputPath)
  const finalOutput = output === undefined || output === null ? null : String(output)
  if (!finalOutput || finalOutput.trim() === '') {
    const keys = topLevelKeys(json)
    const hint = keys.length > 0 ? `；回應頂層欄位：${keys}` : ''
    return failure(
      'mapping_failed',
      `最終回答路徑「${map.outputPath}」取不到非空內容${hint}`,
      latencyMs,
      httpStatus,
      snippet,
      summary,
    )
  }

  const rawStatus = getPath(json, map.statusPath)
  const failedByField = typeof rawStatus === 'string' && /fail|error|timeout|abort/i.test(rawStatus)
  const toolCalls = toEvidence(getPath(json, map.toolCallsPath), true)
  const trace = toEvidence(getPath(json, map.tracePath))
  const tokenUsage: TokenUsage = {
    prompt: numberEvidence(getPath(json, map.promptTokensPath)),
    completion: numberEvidence(getPath(json, map.completionTokensPath)),
    total: numberEvidence(getPath(json, map.totalTokensPath ?? map.tokensPath)),
  }
  const tokens = tokenUsage.total
  const errorPathValue = getPath(json, map.errorPath)

  return {
    finalOutput,
    status: failedByField ? 'failed' : 'succeeded',
    latencyMs,
    error: failedByField
      ? {
          class: 'client_error',
          message: `被測 Agent 回報失敗狀態：${String(rawStatus)}${errorPathValue ? ` / ${String(errorPathValue)}` : ''}`,
        }
      : null,
    toolCalls: toolCalls as Evidence<unknown[]>,
    trace,
    tokens,
    tokenUsage,
    httpStatus,
    rawSnippet: snippet,
    rawJson: json,
    requestSummary: summary,
  }
}

function failure(
  errorClass: ErrorClass,
  message: string,
  latencyMs: number,
  httpStatus: number | null,
  rawSnippet = '',
  requestSummary = '',
): CallOutcome {
  return {
    finalOutput: null,
    status: 'failed',
    latencyMs,
    error: { class: errorClass, message, httpStatus: httpStatus ?? undefined },
    toolCalls: { status: 'unavailable', value: null },
    trace: { status: 'unavailable', value: null },
    tokens: { status: 'unavailable', value: null },
    tokenUsage: UNAVAILABLE_TOKENS,
    httpStatus,
    rawSnippet,
    requestSummary,
  }
}

/** 版本資訊完整度：任一項缺失即標「未提供」，不冒充已取得 */
export function versionInfoComplete(info: VersionInfo): boolean {
  return Boolean(info.model || info.promptVersion || info.frameworkVersion)
}

export function configVersionOf(
  snapshot: { agentVersionId: string; agentVersionNo: number; config: AgentConfig },
): NormalizedTrial['configVersion'] {
  const info = snapshot.config.versionInfo
  return {
    agentVersionId: snapshot.agentVersionId,
    agentVersionNo: snapshot.agentVersionNo,
    platformType: snapshot.config.platformType,
    versionInfo: info,
    versionInfoComplete: versionInfoComplete(info),
  }
}
