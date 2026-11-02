/**
 * 報告與匯出件共用的業務語言映射。
 * 產品定位要求使用者可見位置不出現 assertion／provider／trace／N/A 等技術詞，
 * 失敗原因還要能一眼看出是 Agent 的問題還是平台／設定的問題。
 */
import type { CaseJudgement, NaReasonCode } from './types.ts'

/** 問題歸屬：agent 是被測 Agent 的問題，platform 是平台或設定的問題。 */
export type ProblemOwner = 'agent' | 'platform'

export interface FailureReason {
  /** 使用者看到的說法 */
  text: string
  owner: ProblemOwner
  /** 旁邊要配的原文或數字 */
  hint: string
}

export const PROBLEM_OWNER_LABELS: Record<ProblemOwner, string> = {
  agent: 'Agent 的問題',
  platform: '平台／設定的問題',
}

/** Vera《產品定位》3.2 的失敗原因映射表；未列出的錯誤碼按歸屬折疊到最接近的一條。 */
export const FAILURE_REASONS: Record<string, FailureReason> = {
  rule_miss: { text: '回答沒提到關鍵資訊', owner: 'agent', hint: '對照下方期望關鍵詞與實際回答' },
  wrong_answer: { text: '答非所問', owner: 'agent', hint: '問題、期望、實際三段並排' },
  timeout: { text: '超時沒回應', owner: 'agent', hint: '看等了多久、上限多少' },
  blocked_readonly: { text: '權限被拒，沒有送出', owner: 'platform', hint: '平台攔下的，不是 Agent 的錯' },
  auth_failed: { text: '連不上（認證問題）', owner: 'platform', hint: '請找開發確認金鑰' },
  mapping_failed: { text: '系統看不懂回應格式', owner: 'platform', hint: '要請開發調整，不是 Agent 的問題' },
  parse_failed: { text: '系統看不懂回應格式', owner: 'platform', hint: '要請開發調整，不是 Agent 的問題' },
  connection_failed: { text: '連不上', owner: 'platform', hint: '檢查網路或對方服務是否在跑' },
  not_found: { text: '找不到指定接口', owner: 'platform', hint: '檢查接入設定裡的路徑' },
  rate_limited: { text: '被對方限流', owner: 'platform', hint: '降低同時執行數或稍後再跑' },
  server_error: { text: '對方服務出錯', owner: 'agent', hint: '被測服務自己回報錯誤' },
  client_error: { text: '請求被對方拒絕', owner: 'platform', hint: '多半是請求內容或參數不對' },
  config_error: { text: '設定有問題', owner: 'platform', hint: '檢查 Agent 接入設定' },
}

export function failureReason(code: string | null | undefined): FailureReason | null {
  if (!code) return null
  return FAILURE_REASONS[code] ?? { text: '沒有跑出結果', owner: 'platform', hint: '請看下方原文與耗時' }
}

/** 五種固定話術；測試集沒覆蓋的兩種原因碼合併成同一句對外說法。 */
export const NA_BUSINESS_LABELS: Record<NaReasonCode, string> = {
  no_cases: '測試集沒覆蓋',
  no_scoring_basis: '測試集沒覆蓋',
  tool_evidence_missing: 'Agent 沒有提供這項紀錄',
  blocked_readonly: '這項被平台攔下沒送出',
  insufficient_samples: '樣本太少不作判斷',
  not_run: '還沒跑',
}

/** 不可判斷的補充說明：講清楚為什麼，避免被當成平台 bug。 */
export const NA_BUSINESS_HINTS: Record<NaReasonCode, string> = {
  no_cases: '這批測試集裡沒有這一類用例',
  no_scoring_basis: '這類用例沒有設定判定方式，跑完也無法判對錯',
  tool_evidence_missing: '被測平台的會話接口不回傳工具調用，無法確認有沒有用到工具',
  blocked_readonly: '這個平台是只讀模式，寫入類請求不會送給 Agent',
  insufficient_samples: '可判定的樣本太少，結論不穩',
  not_run: '這個維度還沒開始跑',
}

export function naBusinessLabel(code: string | null | undefined): string {
  if (!code) return '這項無法判斷'
  return NA_BUSINESS_LABELS[code as NaReasonCode] ?? '這項無法判斷'
}

export function naBusinessHint(code: string | null | undefined): string {
  if (!code) return ''
  return NA_BUSINESS_HINTS[code as NaReasonCode] ?? ''
}

function splitTerms(content: string): string[] {
  return content
    .replace(/^包含\s*[:：]\s*/u, '')
    .replace(/^不能包含\s*[:：]\s*/u, '')
    .split(/[、,，]/u)
    .map((term) => term.trim())
    .filter(Boolean)
}

function quote(terms: string[]): string {
  return terms.map((term) => `『${term}』`).join('、')
}

/** 把案例的判定方式寫成一句人話，例如「判定：必須包含『退款政策』、『7 天內』」。 */
export function judgementSentence(judgement: CaseJudgement[] | undefined): string {
  if (!judgement || judgement.length === 0) return ''
  const parts: string[] = []
  for (const item of judgement) {
    const content = item.content?.trim() ?? ''
    switch (item.method) {
      case 'contains':
        if (content) parts.push(`必須包含${quote(splitTerms(content))}`)
        break
      case 'not_contains':
        if (content) parts.push(`不能包含${quote(splitTerms(content))}`)
        break
      case 'max_length':
        if (content) parts.push(`不超過 ${content} 字`)
        break
      case 'max_latency_ms':
        if (content) parts.push(`${Math.round(Number(content) / 100) / 10} 秒內回應`)
        break
      case 'refuse':
        parts.push('必須拒絕')
        break
      case 'ai_rubric':
        parts.push('AI 依標準評分')
        break
      case 'dev_config':
        parts.push('由開發預配（唯讀）')
        break
      default:
        break
    }
  }
  return parts.length ? `判定：${parts.join('、')}` : ''
}

/** 失敗原因的業務說法；沒有錯誤碼但判定未通過時用「回答沒提到關鍵資訊」。 */
export function failureText(code: string | null | undefined, passed: boolean | null): FailureReason | null {
  const mapped = failureReason(code)
  if (mapped) return mapped
  if (passed === false) return FAILURE_REASONS.rule_miss!
  return null
}

/** 每一種判定方式沒通過時該怎麼說；不要一律寫成「回答沒提到關鍵資訊」。 */
export const CHECK_FAILURE_TEXT: Record<string, string> = {
  refuse: '沒有拒絕，或洩漏了敏感內容',
  not_contains: '出現了不該出現的內容',
  contains: '回答沒提到關鍵資訊',
  max_length: '回應超過字數上限',
  max_latency_ms: '超時沒回應',
  equals: '回答與期望不一致',
  regex: '不符合預設格式',
  jsonpath_exists: '回應缺少指定欄位',
  tool_called: '沒有調用指定的工具',
}

/** 一次試驗失敗的業務說法：先看哪一項判定沒過，再看有沒有連線類錯誤。 */
export function trialFailureText(
  checks: Array<{ kind: string; pass: boolean | null }> | undefined,
  errorClass: string | null | undefined,
  passed: boolean | null,
): string | null {
  const failed = checks?.find((check) => check.pass === false)
  if (failed && CHECK_FAILURE_TEXT[failed.kind]) return CHECK_FAILURE_TEXT[failed.kind]!
  return failureText(errorClass, passed)?.text ?? null
}

/** 沒有判定依據時的業務原因：AI 評分尚未提供要講清楚，不能只寫「無法判斷」。 */
export function unknownReasonFor(judgement: CaseJudgement[] | undefined): { text: string; owner: ProblemOwner } {
  const methods = (judgement ?? []).map((item) => item.method)
  if (methods.includes('ai_rubric')) return { text: '平台尚未提供 AI 評分，還無法判斷', owner: 'platform' }
  if (methods.includes('dev_config')) return { text: '這條要由開發預配的檢查判定，平台還沒有結果', owner: 'platform' }
  return { text: '測試集沒覆蓋', owner: 'platform' }
}

function quotedTerm(detail: string): string {
  return /「(.+?)」/u.exec(detail)?.[1] ?? ''
}

/** 舊資料裡可能存著技術錯誤碼、規則類型或正則原文，顯示前先換成業務說法。 */
export function sanitizeBusinessText(text: string): string {
  let out = text
  for (const [code, reason] of Object.entries(FAILURE_REASONS)) out = out.split(code).join(reason.text)
  return out.replace(/N\/A/gu, '這項無法判斷')
}

const TECHNICAL_RATIONALE = /(contains|not_contains|equals|regex|jsonpath_exists|max_length|max_latency_ms|refuse|tool_called)\s*[:：]|\\s\\S|\\d\+|執行失敗/u

/** 舊批次存下來的判定依據可能含規則類型與正則原文，改寫成一句業務結論。 */
export function businessRationale(rationale: string, passed: boolean | null, errorClass: string | null): string {
  const reason = errorClass ? failureText(errorClass, passed) : null
  if (reason) return `${reason.text}，這次沒有判定依據`
  if (passed === null) return '這條用例沒有可判斷的結果'
  if (TECHNICAL_RATIONALE.test(rationale)) return passed ? '符合這個用例的判定方式' : '不符合這個用例的判定方式'
  return sanitizeBusinessText(rationale)
}

/** 把一次判定拆成一句人話，供報告的「依據」欄使用；不出現規則類型碼與 N/A。 */
export function rationaleSentence(checks: Array<{ kind: string; pass: boolean | null; detail: string }>): string {
  if (checks.length === 0) return ''
  const parts = checks.map((check) => {
    const term = quotedTerm(check.detail)
    const state = check.pass === null ? null : check.pass
    switch (check.kind) {
      case 'contains':
        if (state === null) return '這項測不了'
        return state ? `回答提到了${term ? `「${term}」` : '關鍵詞'}` : `回答沒提到${term ? `「${term}」` : '關鍵詞'}`
      case 'not_contains':
        if (state === null) return '這項測不了'
        return state ? '沒有出現不允許的詞' : `出現了不允許的詞${term ? `「${term}」` : ''}`
      case 'equals':
        if (state === null) return '這項測不了'
        return state ? '回答與期望一致' : '回答與期望不一致'
      case 'regex':
        if (state === null) return '這項測不了'
        return state ? '符合預設格式' : '不符合預設格式'
      case 'jsonpath_exists':
        if (state === null) return '這項測不了'
        return state ? '回應包含指定欄位' : '回應缺少指定欄位'
      case 'max_length':
        if (state === null) return '這項測不了'
        return state ? '字數在上限內' : '字數超過上限'
      case 'max_latency_ms':
        if (state === null) return '這項測不了'
        return state ? '在時限內回應' : '超過時限才回應'
      case 'refuse':
        if (state === null) return '這項測不了'
        return state ? '正確拒絕且沒洩漏敏感內容' : '沒有拒絕或洩漏了敏感內容'
      case 'tool_called':
        if (state === null) return '這項測不了（Agent 沒有提供工具紀錄）'
        return state ? '有調用工具' : '沒有調用工具'
      default:
        return '由開發預配的檢查'
    }
  })
  return parts.join('；')
}
