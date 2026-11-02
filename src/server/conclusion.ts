/**
 * 結果頁與匯出件的「結論先行」計算：一句話結論、三個數字、失敗證據。
 * 界面與匯出件共用同一份計算，避免兩邊各算一套。
 */
import type { CaseInput } from '../shared/types.ts'
import { failureText, judgementSentence, unknownReasonFor, type ProblemOwner } from '../shared/vocabulary.ts'
import { wilsonInterval } from './scoring.ts'

export type CaseVerdict = 'passed' | 'failed' | 'unknown'

export interface CaseOutcome {
  caseId: string
  caseName: string
  verdict: CaseVerdict
  /** 無法判斷的原因（業務說法） */
  unknownReason: string | null
  /** 無法判斷的歸屬 */
  unknownOwner: ProblemOwner | null
  judgement: string
  priority: string
  reason: string | null
  owner: ProblemOwner | null
  hint: string | null
  expected: string
  actual: string
  regressed: boolean
}

export interface Conclusion {
  headline: string
  passedCases: number
  judgedCases: number
  totalCases: number
  unknownCases: number
  passRate: number | null
  passRateText: string
  sampleText: string
  deltaText: string
  deltaValue: number | null
  regressedCases: number
  improvedCases: number
  evidence: CaseOutcome[]
  unknownSummary: Array<{ label: string; hint: string; cases: number }>
}

export interface TrialFact {
  caseId: string
  status: string
  latencyMs: number
  /** 失敗時的錯誤分類（若有的話） */
  errorClass?: string | null
  /** Agent 最後回覆的原文，用於證據對照 */
  finalOutput?: string | null
  scorePassed: boolean | null
}

const EVIDENCE_LIMIT = 5
const OUTPUT_SNIPPET = 160

function snippet(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length > OUTPUT_SNIPPET ? `${flat.slice(0, OUTPUT_SNIPPET)}…` : flat
}

function judgeCase(caseInput: CaseInput, trials: TrialFact[]): { verdict: CaseVerdict; unknownReason: string | null; unknownOwner: ProblemOwner | null; reasonCode: string | null; passed: boolean | null } {
  if (trials.length === 0) return { verdict: 'unknown', unknownReason: '還沒跑', unknownOwner: 'platform', reasonCode: null, passed: null }
  const sent = trials.filter((t) => t.status !== 'blocked')
  if (sent.length === 0) return { verdict: 'unknown', unknownReason: '這項被平台攔下沒送出', unknownOwner: 'platform', reasonCode: null, passed: null }
  const scored = sent.filter((t) => t.scorePassed !== null)
  if (scored.length === 0) {
    const reason = unknownReasonFor(caseInput.judgement)
    return { verdict: 'unknown', unknownReason: reason.text, unknownOwner: reason.owner, reasonCode: null, passed: null }
  }
  const errorCode = sent.find((t) => t.errorClass)?.errorClass ?? null
  const passed = sent.every((t) => t.status === 'succeeded') && scored.every((t) => t.scorePassed === true)
  return { verdict: passed ? 'passed' : 'failed', unknownReason: null, unknownOwner: null, reasonCode: errorCode, passed }
}

function rateText(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`
}

/** 單條用例的結論，供跨批次比較與失敗證據共用。 */
export function caseVerdict(caseInput: CaseInput, trials: TrialFact[]): CaseVerdict {
  return judgeCase(caseInput, trials).verdict
}

export interface ConclusionInput {
  cases: CaseInput[]
  trials: TrialFact[]
  repeats: number
  previous?: Map<string, CaseVerdict> | null
}

export function buildConclusion({ cases, trials, repeats, previous }: ConclusionInput): Conclusion {
  const byCase = new Map<string, TrialFact[]>()
  for (const trial of trials) {
    const list = byCase.get(trial.caseId) ?? []
    list.push(trial)
    byCase.set(trial.caseId, list)
  }

  const outcomes: CaseOutcome[] = cases.map((caseInput) => {
    const caseTrials = byCase.get(caseInput.id) ?? []
    const judged = judgeCase(caseInput, caseTrials)
    const priorVerdict = previous?.get(caseInput.id) ?? null
    const regressed = priorVerdict === 'passed' && judged.verdict === 'failed'
    const sent = caseTrials.filter((t) => t.status !== 'blocked')
    const last = sent[sent.length - 1] ?? null
    const failure = judged.verdict === 'failed' ? failureText(judged.reasonCode, judged.passed) : null
    return {
      caseId: caseInput.id,
      caseName: caseInput.name,
      verdict: judged.verdict,
      unknownReason: judged.unknownReason,
      unknownOwner: judged.unknownOwner,
      judgement: judgementSentence(caseInput.judgement),
      priority: caseInput.priority,
      reason: failure?.text ?? null,
      owner: failure?.owner ?? null,
      hint: failure?.hint ?? null,
      expected: caseInput.expected ?? '',
      actual: last?.finalOutput ? snippet(last.finalOutput) : '',
      regressed,
    }
  })

  const passedCases = outcomes.filter((item) => item.verdict === 'passed').length
  const failedCases = outcomes.filter((item) => item.verdict === 'failed').length
  const unknownCases = outcomes.filter((item) => item.verdict === 'unknown').length
  const judgedCases = passedCases + failedCases
  const passRate = judgedCases === 0 ? null : passedCases / judgedCases

  const sentTrials = trials.filter((t) => t.status !== 'blocked')
  const succeeded = sentTrials.filter((t) => t.status === 'succeeded').length
  const ci = wilsonInterval(succeeded, sentTrials.length)
  const sampleText = sentTrials.length === 0
    ? `還沒送出任何一次試驗（每條跑 ${repeats} 次）`
    : `${cases.length} 條用例 × ${repeats} 次 = ${trials.length} 次試驗；單次成功率 95% 區間 ${ci ? `${(ci.low * 100).toFixed(1)}–${(ci.high * 100).toFixed(1)}%` : '—'}`
  const eligibleTrials = sentTrials.filter((t) => t.scorePassed !== null).length
  const sampleNote = eligibleTrials < sentTrials.length ? `；其中 ${sentTrials.length - eligibleTrials} 次沒有判定依據，未計入通過率` : ''

  let deltaValue: number | null = null
  let regressedCases = 0
  let improvedCases = 0
  if (previous) {
    for (const outcome of outcomes) {
      const prior = previous.get(outcome.caseId) ?? null
      if (prior === 'passed' && outcome.verdict === 'failed') regressedCases += 1
      if (prior === 'failed' && outcome.verdict === 'passed') improvedCases += 1
    }
    const previousJudged = [...previous.values()].filter((verdict) => verdict !== 'unknown').length
    const previousPassed = [...previous.values()].filter((verdict) => verdict === 'passed').length
    if (previousJudged > 0 && judgedCases > 0) {
      deltaValue = passedCases / judgedCases - previousPassed / previousJudged
    }
  }
  const deltaText = previous
    ? deltaValue === null
      ? '上一版沒有可比較的結果'
      : Math.abs(deltaValue) < 0.0005
        ? `與上一版持平（退步 ${regressedCases} 條、改善 ${improvedCases} 條）`
        : `${deltaValue > 0 ? '比上一版多通過' : '比上一版少通過'} ${Math.abs(Math.round(deltaValue * judgedCases))} 條（退步 ${regressedCases} 條、改善 ${improvedCases} 條）`
    : '第一次執行，沒有上一版可比較'

  const headline = (() => {
    if (judgedCases === 0) {
      return unknownCases > 0
        ? `這批 ${cases.length} 條用例都沒有跑出可判斷的結果，先確認 ${unknownCases} 條為什麼沒結果`
        : '這批還沒有任何用例'
    }
    if (failedCases === 0) {
      return `${judgedCases} 條用例全部通過，可以上線`
    }
    const comparison = previous
      ? regressedCases > 0
        ? `，其中 ${regressedCases} 條比上一版退步需要確認`
        : improvedCases > 0
          ? `，比上一版少失敗 ${improvedCases} 條`
          : ''
      : ''
    if (passRate !== null && passRate >= 0.8) {
      return `${judgedCases} 條用例通過 ${passedCases} 條，可以上線，但有 ${failedCases} 條沒通過需要確認${comparison}`
    }
    return `${judgedCases} 條用例只通過 ${passedCases} 條（${rateText(passRate)}），不建議上線，先處理 ${failedCases} 條失敗`
  })()

  const evidence = outcomes
    .filter((item) => item.verdict === 'failed')
    .sort((a, b) => (a.regressed === b.regressed ? 0 : a.regressed ? -1 : 1))
    .slice(0, EVIDENCE_LIMIT)

  const unknownMap = new Map<string, { label: string; hint: string; cases: number }>()
  for (const outcome of outcomes) {
    if (outcome.verdict !== 'unknown' || !outcome.unknownReason) continue
    const entry = unknownMap.get(outcome.unknownReason) ?? { label: outcome.unknownReason, hint: '', cases: 0 }
    entry.cases += 1
    unknownMap.set(outcome.unknownReason, entry)
  }

  return {
    headline,
    passedCases,
    judgedCases,
    totalCases: cases.length,
    unknownCases,
    passRate,
    passRateText: rateText(passRate),
    sampleText: `${sampleText}${sampleNote}`,
    deltaText,
    deltaValue,
    regressedCases,
    improvedCases,
    evidence,
    unknownSummary: [...unknownMap.values()],
  }
}
