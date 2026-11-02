export type AnswerVerdict = 'meets' | 'partial' | 'does_not_meet' | 'uncertain'
export type DifferenceKind = 'missing' | 'contradiction' | 'unsupported' | 'wording'
export const ANSWER_VERDICTS: Record<AnswerVerdict, string> = {
  meets: '符合', partial: '部分符合', does_not_meet: '不符合', uncertain: '無法判定',
}
export const DIFFERENCE_KINDS: Record<DifferenceKind, string> = {
  missing: '關鍵遺漏', contradiction: '與參考矛盾', unsupported: '參考未支持的新增內容', wording: '僅表述差異',
}
export interface AnswerComparison {
  verdict: AnswerVerdict
  summary: string
  differences: Array<{ kind: DifferenceKind; referenceQuote: string; actualQuote: string; explanation: string }>
  suggestions: string[]
}
export interface JudgeSettings {
  model: string
  configured: boolean
  keyMask: string | null
}
export interface AnswerEvaluation {
  id: string
  trialId: string
  caseName: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'interrupted'
  result: AnswerComparison | null
  error: string | null
}
export interface AnswerEvaluationBatch {
  id: string
  experimentId: string
  runId: string
  status: 'running' | 'completed' | 'interrupted'
  model: string
  promptVersion: string
  createdAt: string
  finishedAt: string | null
  evaluations: AnswerEvaluation[]
}
