import assert from 'node:assert/strict'
import { buildConclusion, type TrialFact } from '../src/server/conclusion.ts'
import type { CaseInput } from '../src/shared/types.ts'

const cases = Array.from({ length: 50 }, (_, index) => ({
  id: `case-${index}`, name: `用例 ${index + 1}`, type: 'basic_qa', input: '問題',
  expected: '參考回答', scoringRubric: '', timeoutMs: 30000, priority: 'medium',
  readWrite: 'read', judgement: [{ method: 'ai_rubric' }],
}) as CaseInput)
const fact = (index: number, scorePassed: boolean | null, status = 'succeeded'): TrialFact => ({
  caseId: cases[index].id, status, latencyMs: 100, scorePassed,
})

// Real regression: 50 executed, 7 call failures and 43 answers without rule judgements.
const partial = buildConclusion({ cases, repeats: 1,
  trials: cases.map((_, index) => index < 7 ? fact(index, false, 'failed') : fact(index, null)),
})
assert.equal(partial.totalCases, 50)
assert.equal(partial.judgedCases, 7)
assert.equal(partial.unknownCases, 43)
assert.equal(partial.passRate, null, 'Incomplete judgements must not become an overall 0%')
assert.equal(partial.passRateText, '—')
assert.match(partial.headline, /50.*7.*43/u)
assert.doesNotMatch(partial.headline, /可以上線/u)

const partiallyPassed = buildConclusion({ cases, repeats: 1,
  trials: cases.slice(0, 7).map((_, index) => fact(index, true)),
})
assert.equal(partiallyPassed.passRate, null)
assert.doesNotMatch(partiallyPassed.headline, /全部通過|可以上線/u)

const complete = buildConclusion({ cases, repeats: 1,
  trials: cases.map((_, index) => fact(index, index < 43)),
})
assert.equal(complete.passRate, 0.86)
assert.equal(complete.passRateText, '86.0%')
assert.equal(buildConclusion({ cases, repeats: 1, trials: [] }).passRate, null)
console.log('PASS incomplete and complete report pass rates, 50-case accounting, and release conclusion guard')
