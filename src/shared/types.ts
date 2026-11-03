// 服務端與前端共用的類型定義（僅類型，無執行時依賴）

export type PlatformType = 'custom_http' | 'oumi' | 'dify_agent' | 'dify_workflow'

export type AuthType = 'none' | 'api_key' | 'bearer' | 'header'

export type CaseType =
  | 'basic_qa'
  | 'instruction'
  | 'knowledge'
  | 'tool_use'
  | 'multi_turn'
  | 'complex_task'
  | 'exception'
  | 'security'

export type ReadWrite = 'read' | 'write'

/** 三態證據：null 取不到 / [] 明確沒有 / 有值 */
export type EvidenceStatus = 'unavailable' | 'none' | 'present'

export interface Evidence<T = unknown> {
  status: EvidenceStatus
  value: T | null
}

export interface RequestTemplate {
  method: 'POST' | 'GET'
  headers: Record<string, string>
  /** body 內字符串支持 {{input}} {{sessionId}} {{caseName}} 佔位符 */
  body: unknown
}

export interface ResponseMap {
  outputPath: string
  statusPath?: string
  idPath?: string
  errorPath?: string
  toolCallsPath?: string
  tracePath?: string
  tokensPath?: string
  /** Token 明細路徑；未配置時只取 tokensPath 的總量 */
  promptTokensPath?: string
  completionTokensPath?: string
  totalTokensPath?: string
}

export interface TokenUsage {
  prompt: Evidence<number>
  completion: Evidence<number>
  total: Evidence<number>
}

/** 平台回應欄位模板：佔位路徑，真實端點到位後只改值，不改程式 */
export interface ResponseMapTemplate {
  label: string
  outputPath: string
  statusPath: string
  toolCallsPath: string
  tracePath: string
  promptTokensPath: string
  completionTokensPath: string
  totalTokensPath: string
  /** 模板來源與待實測提醒，接入表單會原樣顯示 */
  note: string
}

/**
 * Oumi／Dify 的預設映射模板。路徑依各自公開文檔與呼叫慣例填寫，
 * 但未經真實實例驗證；接入時按第三步預覽結果改值即可。
 */
export const RESPONSE_MAP_TEMPLATES: Record<string, ResponseMapTemplate> = {
  oumi: {
    label: 'Oumi（會話模式）',
    outputPath: '',
    statusPath: '',
    toolCallsPath: '',
    tracePath: '',
    promptTokensPath: '',
    completionTokensPath: '',
    totalTokensPath: '',
    note: '設定目標後，適配器會建立會話並輪詢結果；output、status、token 由適配器解析，這些路徑僅對自訂 HTTP 生效。',
  },
  dify_agent: {
    label: 'Dify Agent / Chatbot',
    outputPath: 'answer',
    statusPath: 'metadata.status',
    toolCallsPath: 'metadata.tool_calls',
    tracePath: 'metadata.trace',
    promptTokensPath: 'metadata.usage.prompt_tokens',
    completionTokensPath: 'metadata.usage.completion_tokens',
    totalTokensPath: 'metadata.usage.total_tokens',
    note: 'Dify chat-messages：answer 與 metadata.usage 有公開文檔；status 與 tool_calls 依版本可能不在回應裡，缺就留空。',
  },
  dify_workflow: {
    label: 'Dify Workflow / Chatflow',
    outputPath: 'data.outputs.text',
    statusPath: 'data.status',
    toolCallsPath: 'data.tool_calls',
    tracePath: 'data.trace',
    promptTokensPath: '',
    completionTokensPath: '',
    totalTokensPath: 'data.total_tokens',
    note: 'Dify workflows/run：outputs 的鍵由工作流定義，需按實際輸出改；workflow 只公開 total_tokens。',
  },
}

/** 依平台取映射模板；自定義 HTTP 沒有預設模板，回 undefined */
export function responseMapTemplateOf(platformType: string): ResponseMapTemplate | undefined {
  return RESPONSE_MAP_TEMPLATES[platformType]
}

export interface VersionInfo {
  versionName?: string
  model?: string
  promptVersion?: string
  frameworkVersion?: string
  tools?: string[]
  knowledge?: string[]
}

export interface AgentConfig {
  name: string
  platformType: PlatformType
  endpoint: string
  authType: AuthType
  authHeader?: string
  requestTemplate: RequestTemplate
  responseMap: ResponseMap
  targeting?: {
    targetType: 'Group' | 'Agent'
    targetId: string
    providerId?: string
  }
  allowWrite: boolean
  versionInfo: VersionInfo
}

export interface AgentVersionSnapshot extends AgentConfig {
  agentId: string
  versionNo: number
  createdAt: string
}

export interface ErrorInfo {
  class: ErrorClass
  message: string
  httpStatus?: number
}

export type ErrorClass =
  | 'timeout'
  | 'connection_failed'
  | 'auth_failed'
  | 'not_found'
  | 'rate_limited'
  | 'server_error'
  | 'client_error'
  | 'config_error'
  | 'parse_failed'
  | 'mapping_failed'
  | 'blocked_readonly'

export interface NormalizedTrial {
  sourceTrial?: { experimentId: string; runId: string; trialId: string; branchId: string; executedAt: string; composedAt: string }
  input: string
  finalOutput: string | null
  status: 'succeeded' | 'failed' | 'blocked'
  latencyMs: number
  error: ErrorInfo | null
  configVersion: {
    agentVersionId: string
    agentVersionNo: number
    platformType: PlatformType
    versionInfo: VersionInfo
    versionInfoComplete: boolean
  }
  toolCalls: Evidence<unknown[]>
  trace: Evidence<unknown>
  tokens: Evidence<number>
  tokenUsage: TokenUsage
  sessionId: string
  httpStatus: number | null
  rawSnippet: string
}

export interface ValidationResult {
  ok: boolean
  checkedAt: string
  latencyMs: number
  httpStatus: number | null
  reason?: string
  errorClass?: ErrorClass
  outputPreview?: string
}

export interface CaseInput {
  id: string
  name: string
  type: CaseType
  input: string
  expected: string
  scoringRubric: string
  rule: RuleSet | null
  timeoutMs: number
  multiTurn: MultiTurnStep[] | null
  priority: 'high' | 'medium' | 'low'
  readWrite: ReadWrite
  judgement?: CaseJudgement[]
}

export interface MultiTurnStep {
  role: 'user'
  content: string
  expected?: string
}

/** 最小 JSON 規則集（等於／包含／正則／JSONPath／長度／耗時上限／是否調用指定工具） */
export type RuleSet = Rule[]

export type Rule =
  | { kind: 'equals'; path: string; value: unknown; note?: string }
  | { kind: 'contains'; path: string; value: string; note?: string }
  | { kind: 'not_contains'; values: string[]; note?: string }
  | { kind: 'regex'; path: string; pattern: string; flags?: string; note?: string }
  | { kind: 'jsonpath_exists'; path: string; note?: string }
  | { kind: 'max_length'; path: string; value: number; note?: string }
  | { kind: 'max_latency_ms'; value: number; note?: string }
  | { kind: 'refuse'; note?: string }
  | { kind: 'tool_called'; name: string; note?: string }

export type JudgementMethod = 'contains' | 'not_contains' | 'max_length' | 'max_latency_ms' | 'refuse' | 'ai_rubric' | 'dev_config'

export interface CaseJudgement {
  method: JudgementMethod
  content?: string
}

export interface Thresholds {
  taskCompletionRate?: number
  correctnessRate?: number
  minSamples?: number
}

/** N/A 的原因分類：報告必須能區分「沒測」與「測不了」 */
export type NaReasonCode =
  | 'no_cases'
  | 'tool_evidence_missing'
  | 'blocked_readonly'
  | 'insufficient_samples'
  | 'not_run'
  | 'no_scoring_basis'

export const NA_REASON_LABELS: Record<NaReasonCode, string> = {
  no_cases: '測試集未覆蓋',
  tool_evidence_missing: 'Agent 未提供工具記錄',
  blocked_readonly: '只讀攔截未測',
  insufficient_samples: '樣本不足',
  not_run: '尚未執行',
  no_scoring_basis: '無可評分依據',
}

/** 錯誤分類的中文標籤；原始枚舉碼保留在 title 或詳情裡供工程排查 */
export const ERROR_CLASS_LABELS: Record<string, string> = {
  blocked_readonly: '只讀攔截',
  timeout: '逾時',
  auth_failed: '認證失敗',
  not_found: '端點不存在',
  rate_limited: '限流',
  server_error: '服務端錯誤',
  client_error: '請求被拒',
  config_error: '配置錯誤',
  parse_failed: '回應解析失敗',
  mapping_failed: '映射失敗',
  connection_failed: '連線失敗',
}

export function errorClassLabel(code: string | null | undefined): string {
  if (!code) return '—'
  return ERROR_CLASS_LABELS[code] ?? code
}
