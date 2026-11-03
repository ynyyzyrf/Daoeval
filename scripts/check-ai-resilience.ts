import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AEVAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'daoeval-ai-resilience-'))
const ai = await import('../src/server/ai-evaluation.ts')
const { db, migrate } = await import('../src/server/db.ts')
migrate()
const input = { question: '問題', reference: '參考原文', actual: '回答原文', rubric: '' }
const good = { verdict: 'meets', summary: '符合', differences: [], suggestions: [] }
const response = (content: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] }))
try {
  assert.deepEqual(ai.validateComparison({ ...good, suggestions: '請補充關鍵資訊' }, input).suggestions, ['請補充關鍵資訊'])
  assert.deepEqual(ai.validateComparison({ ...good, suggestions: null }, input).suggestions, [])
  assert.throws(() => ai.validateComparison({ ...good, suggestions: [{ unknown: '不可猜測內容' }] }, input), /invalid_suggestions/)
  assert.throws(() => ai.validateComparison({ ...good, differences: [{ kind: 'wording', referenceQuote: '不存在的引用', actualQuote: '回答原文', explanation: '一致' }] }, input), /invalid_reference_quote/)
  let calls = 0
  const attempts: number[] = []
  const result = await ai.judgeAnswerWithRetry(input, { model: 'test', key: 'fake-key' }, async () => {
    calls++
    return calls === 1 ? new Response('', { status: 503 }) : response(good)
  }, (attempt) => attempts.push(attempt))
  assert.deepEqual(result, good)
  assert.deepEqual(attempts, [1, 2])
  calls = 0
  await assert.rejects(ai.judgeAnswerWithRetry(input, { model: 'test', key: 'fake-key' }, async () => {
    calls++; return new Response('', { status: 402 })
  }), /餘額不足/)
  assert.equal(calls, 1, 'Quota errors must halt without extra billable attempts')
  calls = 0
  await assert.rejects(ai.judgeAnswerWithRetry(input, { model: 'test', key: 'fake-key' }, async () => {
    calls++; return new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '' } }] }))
  }), /truncated_response.*已嘗試 2 次/)
  assert.equal(calls, 2, 'Retries must be bounded')
  const budgets: number[] = []
  await ai.judgeAnswerWithRetry(input, { model: 'test', key: 'fake-key' }, async (_url, options) => {
    const body = JSON.parse(options!.body as string)
    budgets.push(body.max_tokens)
    return budgets.length === 1 ? new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '' } }] })) : response(good)
  })
  assert.deepEqual(budgets, [4096, 8192], 'Truncation retries must have a larger, bounded output budget')
  calls = 0
  await ai.judgeAnswerWithRetry(input, { model: 'test', key: 'fake-key' }, async (_url, options) => {
    calls++
    if (calls === 1) return response({ ...good, differences: [{ kind: 'wording', referenceQuote: '錯誤引用', actualQuote: '回答原文', explanation: '一致' }] })
    assert.match(JSON.parse(options!.body as string).messages[0].content, /invalid_reference_quote/)
    return response(good)
  })
  assert.equal(calls, 2, 'Validation retry must receive a specific repair hint')
  const { answerBatchLabel } = await import('../src/shared/ai-evaluation.ts')
  assert.equal(answerBatchLabel({ status: 'completed', evaluations: [{ status: 'completed' }, { status: 'failed' }] }), '部分失敗')
  assert.equal(answerBatchLabel({ status: 'completed', evaluations: [{ status: 'failed' }] }), '評估失敗')
  assert.equal(answerBatchLabel({ status: 'completed', evaluations: [{ status: 'completed' }, { status: 'skipped' }] }), '評估完成')
  console.log('PASS bounded retries, repair hints, precise diagnostics, quota stop and batch labels; no external model calls')
} finally { db.close() }
