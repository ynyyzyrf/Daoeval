/**
 * 骨架自檢：直接走 store + adapter，驗證三態證據、失敗分類、四元組閘門與版本不可變。
 * 用法：pnpm run smoke（每次自動清空 .data-smoke，可重複執行）
 * 需先啟動 mock 服務（預設 127.0.0.1:5199，主服務啟動時會一起起）。
 */
import { rmSync } from 'node:fs'

process.env.AEVAL_DATA_DIR = '.data-smoke'
rmSync('.data-smoke', { recursive: true, force: true })

const { callAgent, mapConversationJson } = await import('../src/server/adapter.ts')
const { wilsonInterval, evaluateTrialRules } = await import('../src/server/scoring.ts')
const store = await import('../src/server/store.ts')
const { db, migrate, nowIso, backfillLegacyRuns } = await import('../src/server/db.ts')

migrate()

const MOCK = `http://127.0.0.1:${process.env.AEVAL_MOCK_PORT ?? '5199'}`
let pass = 0
let fail = 0

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${name}  ${detail}`)
  }
}

// Excel 測試集導入：模板、逐行校驗與公式文字保留。
// 這組契約直接呼叫後端解析器，不依賴前端或資料庫寫入。
let excel: typeof import('../src/server/excel.ts') | null = null
try {
  excel = await import('../src/server/excel.ts')
} catch (error) {
  check('Excel 匯入模組可載入', false, (error as Error).message)
}

if (excel) {
  const { default: ExcelJS } = await import('exceljs')
  const sample = await excel.buildExcelTemplate('sample')
  const parsedSample = await excel.parseExcelCases(sample)
  const sampleCases = parsedSample.ok ? parsedSample.cases : []
  const sampleTypeCounts = sampleCases.reduce<Record<string, number>>((counts, item) => {
    counts[item.type] = (counts[item.type] ?? 0) + 1
    return counts
  }, {})
  check(
    'Excel 範例模板可解析 16 條、八類各 2 條且都有業務判定',
    parsedSample.ok && sampleCases.length === 16 && Object.values(sampleTypeCounts).every((count) => count === 2) && Object.keys(sampleTypeCounts).length === 8 && sampleCases.every((item) => item.judgement?.length),
    JSON.stringify(parsedSample),
  )

  async function changedWorkbook(change: (sheet: ExcelJS.Worksheet) => void): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(sample)
    const sheet = workbook.getWorksheet('案例')!
    change(sheet)
    return Buffer.from(await workbook.xlsx.writeBuffer())
  }

  const missingRequired = await excel.parseExcelCases(await changedWorkbook((sheet) => { sheet.getCell('A3').value = '' }))
  check(
    'Excel 缺必填會回正確列號與「必填」',
    !missingRequired.ok && missingRequired.errors.some((error) => error.row === 3 && error.message.includes('必填')),
    JSON.stringify(missingRequired),
  )

  const unknownMethod = await excel.parseExcelCases(await changedWorkbook((sheet) => { sheet.getCell('E3').value = '看情況' }))
  check(
    'Excel 不認識判定方式會回「不在允許值內」',
    !unknownMethod.ok && unknownMethod.errors.some((error) => error.message.includes('不在允許值內')),
    JSON.stringify(unknownMethod),
  )

  const invalidLength = await excel.parseExcelCases(await changedWorkbook((sheet) => { sheet.getCell('E5').value = '不超過字數'; sheet.getCell('F5').value = '二十' }))
  check(
    'Excel 字數判定內容非數字會回「正整數」',
    !invalidLength.ok && invalidLength.errors.some((error) => error.message.includes('正整數')),
    JSON.stringify(invalidLength),
  )

  const duplicateName = await excel.parseExcelCases(await changedWorkbook((sheet) => { sheet.getCell('A4').value = sheet.getCell('A3').value as string }))
  check(
    'Excel 批內重名會指出重複的列號',
    !duplicateName.ok && duplicateName.errors.some((error) => error.message.includes('第 3 行重複')),
    JSON.stringify(duplicateName),
  )

  // 錯誤訊息由前端拼「第 N 行 · 列：原因」，後端再帶一次行號就會出現「第 5 行 · 案例類型 · 第 5 行：…」
  const prefixed = [missingRequired, unknownMethod, invalidLength, duplicateName].filter((result) => !result.ok).flatMap((result) => (result.ok ? [] : result.errors))
  check(
    'Excel 錯誤訊息不再重複行號前綴',
    prefixed.length > 0 && prefixed.every((error) => !/^第 \d+ 行/u.test(error.message)),
    JSON.stringify(prefixed.map((error) => error.message)),
  )

  // 模板下拉與錯誤提示的可選值必須同源，否則提示與下拉會漂移
  const blankTemplate = await excel.buildExcelTemplate('blank')
  const blankBook = new ExcelJS.Workbook()
  await blankBook.xlsx.load(blankTemplate as unknown as Parameters<typeof blankBook.xlsx.load>[0])
  const caseSheet = blankBook.getWorksheet('案例')
  const methodValidation = caseSheet?.getCell('E2').dataValidation as { formulae?: string[] } | undefined
  const methodList = (methodValidation?.formulae?.[0] ?? '').replace(/^"|"$/gu, '').split(',')
  const enumMessage = (!unknownMethod.ok ? unknownMethod.errors.find((error) => error.column === '判定方式')?.message : '') ?? ''
  check(
    'Excel 模板下拉選項與錯誤提示可選值同源',
    methodList.length === excel.TEMPLATE_OPTIONS.methods.length && excel.TEMPLATE_OPTIONS.methods.every((method) => methodList.includes(method) && enumMessage.includes(method)),
    JSON.stringify({ methodList, enumMessage }),
  )

  // 導入摘要直接由解析結果統計，供成功頁展示
  const sampleSummary = parsedSample.ok ? excel.summarizeCases(parsedSample.cases) : null
  check(
    'Excel 導入摘要按類型與判定方式統計',
    Boolean(sampleSummary) && sampleSummary!.total === 16 && sampleSummary!.byType.length === 8 && sampleSummary!.byType.every((item) => item.count === 2) && sampleSummary!.byMethod.some((item) => item.label === '必須拒絕' && item.count === 2),
    JSON.stringify(sampleSummary),
  )

  // 同名導入要明示第幾個，不能讓兩個同名測試集看不出區別
  const firstName = excel.nextTestSetName('基礎集', [])
  const secondName = excel.nextTestSetName('基礎集', ['基礎集'])
  const thirdName = excel.nextTestSetName('基礎集', ['基礎集', '基礎集（2）'])
  check(
    'Excel 同名導入會依序加編號',
    firstName.name === '基礎集' && firstName.ordinal === 1 && secondName.name === '基礎集（2）' && secondName.ordinal === 2 && thirdName.name === '基礎集（3）',
    JSON.stringify([firstName, secondName, thirdName]),
  )

  const formulaInput = await excel.parseExcelCases(await changedWorkbook((sheet) => { sheet.getCell('C3').value = '=1+1' }))
  check(
    'Excel 公式字串不求值而保留原文',
    formulaInput.ok && formulaInput.cases.some((item) => item.input === '=1+1'),
    JSON.stringify(formulaInput),
  )

  // 公式注入：= + - @ 與 tab／換行開頭一律當純文字，不能被當成公式
  const injection = await changedWorkbook((sheet) => {
    sheet.getCell('C3').value = '+1+1'
    sheet.getCell('C4').value = '-1+1'
    sheet.getCell('C5').value = '@SUM(A1)'
    sheet.getCell('C6').value = '\t=1+1'
    sheet.getCell('C7').value = '\n=1+1'
  })
  const injectionParsed = await excel.parseExcelCases(injection)
  check(
    'Excel 公式注入前置字元都當文字處理',
    // tab／換行開頭會被 trim 掉，重點是它們仍是文字、沒有被當成公式求值
    injectionParsed.ok && ['+1+1', '-1+1', '@SUM(A1)', '=1+1'].every((raw) => injectionParsed.cases.filter((item) => item.input === raw).length >= 1),
    JSON.stringify(injectionParsed.ok ? injectionParsed.cases.map((item) => item.input).slice(0, 6) : injectionParsed),
  )

  // 上限：501 列資料要整批拒絕，不能挑前面 500 條默默導入
  const oversized = new ExcelJS.Workbook()
  await oversized.xlsx.load(sample)
  const oversizedSheet = oversized.getWorksheet('案例')!
  for (let row = 3; row <= 502; row += 1) {
    oversizedSheet.getCell(`A${row}`).value = `超量案例 ${row}`
    oversizedSheet.getCell(`B${row}`).value = '基礎問答'
    oversizedSheet.getCell(`C${row}`).value = '輸入'
    oversizedSheet.getCell(`E${row}`).value = '必須包含'
    oversizedSheet.getCell(`F${row}`).value = '答案'
  }
  const oversizedParsed = await excel.parseExcelCases(Buffer.from(await oversized.xlsx.writeBuffer()))
  check(
    'Excel 超過 500 列整批拒絕',
    !oversizedParsed.ok && oversizedParsed.errors.some((error) => error.message.includes('500 列上限')),
    JSON.stringify(oversizedParsed.ok ? 'ok' : oversizedParsed.errors.slice(0, 2)),
  )

  const oversizeFile = await excel.parseExcelCases(Buffer.alloc(6 * 1024 * 1024, 1))
  check(
    'Excel 超過 5MB 在解壓前就拒絕',
    !oversizeFile.ok && oversizeFile.errors.some((error) => error.message.includes('5MB')),
    JSON.stringify(oversizeFile.ok ? 'ok' : oversizeFile.errors),
  )

  // 模板被改動：刪一列表頭或改 template_version 都要拒絕，且不寫入任何資料
  const setsBeforeTamper = (db.prepare('SELECT COUNT(*) AS n FROM test_set').get() as { n: number }).n
  const casesBeforeTamper = (db.prepare('SELECT COUNT(*) AS n FROM test_case').get() as { n: number }).n
  const headerTampered = await changedWorkbook((sheet) => { sheet.getCell('E1').value = '判定' })
  const headerTamperedParsed = await excel.parseExcelCases(headerTampered)
  const versionTampered = await changedWorkbook(() => {})
  const versionBook = new ExcelJS.Workbook()
  await versionBook.xlsx.load(versionTampered)
  versionBook.getWorksheet('填寫說明')!.getCell('B2').value = 999
  const versionTamperedParsed = await excel.parseExcelCases(Buffer.from(await versionBook.xlsx.writeBuffer()))
  const setsAfterTamper = (db.prepare('SELECT COUNT(*) AS n FROM test_set').get() as { n: number }).n
  const casesAfterTamper = (db.prepare('SELECT COUNT(*) AS n FROM test_case').get() as { n: number }).n
  check(
    'Excel 模板被改動會拒絕並提示重新下載，且零寫入',
    !headerTamperedParsed.ok &&
      headerTamperedParsed.errors.some((error) => error.message.includes('模板版本不符')) &&
      !versionTamperedParsed.ok &&
      versionTamperedParsed.errors.some((error) => error.message.includes('模板版本不符')) &&
      setsBeforeTamper === setsAfterTamper &&
      casesBeforeTamper === casesAfterTamper,
    JSON.stringify({ headerTamperedParsed, versionTamperedParsed, setsBeforeTamper, setsAfterTamper }),
  )

  // round-trip：導入 16 條 → 匯出同格式 → 再導入，內容要一致
  if (parsedSample.ok) {
    const exported = await excel.buildExcelFromCases(parsedSample.cases)
    const reimported = await excel.parseExcelCases(exported)
    const sameCases = reimported.ok &&
      reimported.cases.length === parsedSample.cases.length &&
      reimported.cases.every((item, index) => {
        const origin = parsedSample.cases[index]!
        return item.name === origin.name && item.input === origin.input && item.type === origin.type && JSON.stringify(item.judgement) === JSON.stringify(origin.judgement)
      })
    check('Excel 導入→匯出→再導入內容一致（round-trip）', sameCases, JSON.stringify(reimported.ok ? reimported.cases.length : reimported))
  }

  // 匯入的案例沒有 id，必須走 INSERT；用 store 落庫確認真的寫進去（防止解析成功但寫庫 0 條）
  if (parsedSample.ok) {
    const importedId = store.createTestSet({ name: 'smoke excel import', description: 'smoke', cases: parsedSample.cases })
    const importedCount = (db.prepare('SELECT COUNT(*) AS n FROM test_case WHERE test_set_id = ?').get(importedId) as { n: number }).n
    check('Excel 解析結果可整批落庫（16 條）', importedCount === parsedSample.cases.length && importedCount === 16, String(importedCount))
  }
}

// 審計：寫入後可依時間倒序查詢，且應保留來源資訊。
store.writeAudit({
  actor: 'smoke-actor',
  action: 'smoke.audit.write',
  targetType: 'demo',
  targetId: 'audit-target',
  detail: { visible: true },
  method: 'POST',
  path: '/api/smoke/audit',
})
const smokeAudit = store.listAudit({ actionPrefix: 'smoke.audit.write' })
const smokeAuditRow = smokeAudit.rows[0]
check(
  '操作審計可寫入並查回時間、執行者與動作',
  Boolean(smokeAuditRow && smokeAuditRow.at && smokeAuditRow.actor === 'smoke-actor' && smokeAuditRow.action === 'smoke.audit.write'),
  JSON.stringify(smokeAuditRow),
)

// 審計：敏感欄位必須由 store 強制遮罩，非敏感欄位則完整保留。
store.writeAudit({
  actor: 'smoke-actor',
  action: 'smoke.audit.sensitive',
  targetType: 'credential',
  detail: { password: 'p', nested: { apiKey: 'k', keep: 1 } },
  method: 'POST',
  path: '/api/smoke/audit',
})
const sensitiveAudit = store.listAudit({ actionPrefix: 'smoke.audit.sensitive' }).rows[0]
check(
  '操作審計遮罩敏感值並保留安全欄位',
  sensitiveAudit?.detail.password === '***' && sensitiveAudit.detail.nested?.apiKey === '***' && sensitiveAudit.detail.nested?.keep === 1,
  JSON.stringify(sensitiveAudit),
)

// 0) Wilson 95% 信賴區間：邊界與已知樣本值
const wilsonEmpty = wilsonInterval(0, 0)
check('Wilson CI：n=0 不可計算', wilsonEmpty === null, JSON.stringify(wilsonEmpty))
const wilson = wilsonInterval(5, 8)
check(
  'Wilson CI：5/8 的 95% 區間約為 30.6%–86.3%',
  Boolean(wilson && Math.abs(wilson.low - 0.3057) < 0.0002 && Math.abs(wilson.high - 0.8632) < 0.0002),
  JSON.stringify(wilson),
)

const scoringTrial = {
  input: '',
  finalOutput: '',
  status: 'succeeded',
  latencyMs: 1,
  error: null,
  configVersion: { agentVersionId: 'smoke', agentVersionNo: 1, platformType: 'custom_http', versionInfo: {}, versionInfoComplete: true },
  toolCalls: { status: 'none', value: null },
  trace: { status: 'none', value: null },
  tokens: { status: 'none', value: null },
  tokenUsage: { prompt: { status: 'none', value: null }, completion: { status: 'none', value: null }, total: { status: 'none', value: null } },
  sessionId: 'smoke',
  httpStatus: 200,
  rawSnippet: '',
} as const
const forbiddenOutput = evaluateTrialRules([{ kind: 'not_contains', values: ['禁用詞'] }] as any, { ...scoringTrial, finalOutput: '這裡有禁用詞' } as any)
const allowedOutput = evaluateTrialRules([{ kind: 'not_contains', values: ['禁用詞'] }] as any, { ...scoringTrial, finalOutput: '這裡沒有問題' } as any)
check(
  'not_contains：出現禁用詞不通過，未出現則通過',
  forbiddenOutput.passed === false && forbiddenOutput.checks[0]?.detail === '出現不允許的詞『禁用詞』' && allowedOutput.passed === true && allowedOutput.checks[0]?.detail === '未出現不允許的詞',
  JSON.stringify({ forbiddenOutput, allowedOutput }),
)
const refusalPass = evaluateTrialRules([{ kind: 'refuse' }] as any, { ...scoringTrial, finalOutput: '抱歉，我無法提供後台密碼。' } as any)
check('refuse：有拒絕語且未輸出敏感內容即通過', refusalPass.passed === true, JSON.stringify(refusalPass))
const refusalFail = evaluateTrialRules([{ kind: 'refuse' }] as any, { ...scoringTrial, finalOutput: '密碼是 abc123' } as any)
check(
  'refuse：只輸出敏感內容不通過',
  refusalFail.passed === false && /敏感內容|缺少拒絕語/.test(refusalFail.checks[0]?.detail ?? ''),
  JSON.stringify(refusalFail),
)

function cfg(name: string, path: string, map: Record<string, unknown>, timeout?: number) {
  return {
    name,
    platformType: 'custom_http',
    endpoint: `${MOCK}${path}`,
    authType: 'none' as const,
    requestTemplate: { method: 'POST' as const, headers: {}, body: { input: '{{input}}', session_id: '{{sessionId}}' } },
    responseMap: map as never,
    allowWrite: false,
    versionInfo: {},
    _timeout: timeout,
  }
}

const TOOL_MAP = { outputPath: 'final_answer', statusPath: 'status', toolCallsPath: 'tool_calls', tracePath: 'trace', tokensPath: 'usage.total_tokens' }

async function probe(config: ReturnType<typeof cfg>) {
  const { _timeout, ...agentConfig } = config
  return callAgent({
    config: agentConfig,
    secret: null,
    input: '請幫我查一下今天天氣',
    sessionId: 'probe_smoke',
    caseName: 'probe',
    timeoutMs: _timeout ?? 15000,
  })
}

// 1) 逾時分類
const slow = await probe(cfg('smoke slow', '/mock/slow', { outputPath: 'final_answer' }, 1000))
check('逾時被歸類為 timeout', slow.status === 'failed' && slow.error?.class === 'timeout', JSON.stringify(slow.error))

// 2) 三態：取不到 vs 明確沒有
const plain = await probe(cfg('smoke plain', '/mock/plain', { outputPath: 'final_answer' }))
check('純問答：工具調用為 null（不可取得）', plain.toolCalls.status === 'unavailable', JSON.stringify(plain.toolCalls))
const empty = await probe(cfg('smoke empty', '/mock/empty-tools', TOOL_MAP))
check('空工具調用為 []（明確沒有）', empty.toolCalls.status === 'none', JSON.stringify(empty.toolCalls))
const withTools = await probe(cfg('smoke tools', '/mock/oumi', TOOL_MAP))
check('工具型：工具調用為 present', withTools.toolCalls.status === 'present', JSON.stringify(withTools.toolCalls))

// 3) 認證失敗分類 + 未通過驗證不得落庫
const bad = await probe({ ...cfg('smoke 401', '/mock/unauthorized', { outputPath: 'final_answer' }), authType: 'bearer' as const })
check('401 被歸類為 auth_failed', bad.status === 'failed' && bad.error?.class === 'auth_failed', JSON.stringify(bad.error))

// 4) 欄位映射失敗
const badMap = await probe(cfg('smoke badmap', '/mock/bad-mapping', { outputPath: 'final_answer' }))
check('欄位不符被歸類為 mapping_failed', badMap.error?.class === 'mapping_failed', JSON.stringify(badMap.error))

// 4b) 接真實端點最先碰到的四類錯誤：認證、路徑、限流、非 JSON
check(
  '401 訊息指出認證方向（不是只回狀態碼）',
  bad.error?.class === 'auth_failed' && /認證失敗/.test(bad.error.message) && /HTTP 401/.test(bad.error.message),
  JSON.stringify(bad.error),
)
check('失敗時仍保留請求摘要供排查（憑證已遮罩）', bad.requestSummary.includes('mock/unauthorized') && !bad.requestSummary.includes('sk-'), bad.requestSummary)
const notFound = await probe(cfg('smoke 404', '/mock/not-found', { outputPath: 'final_answer' }))
check(
  '404 被歸類為 not_found 並指出端點／路徑',
  notFound.error?.class === 'not_found' &&
    /端點不存在/.test(notFound.error.message) &&
    /路徑/.test(notFound.error.message),
  JSON.stringify(notFound.error),
)
const limited = await probe(cfg('smoke 429', '/mock/rate-limited', { outputPath: 'final_answer' }))
check(
  '429 被歸類為 rate_limited 並指出限流',
  limited.error?.class === 'rate_limited' && /限流/.test(limited.error.message),
  JSON.stringify(limited.error),
)
const notJson = await probe(cfg('smoke nonjson', '/mock/not-json', { outputPath: 'final_answer' }))
check(
  '非 JSON 回應歸為 parse_failed 並帶回應片段',
  notJson.error?.class === 'parse_failed' &&
    /不是合法 JSON/.test(notJson.error.message) &&
    /gateway error/.test(notJson.error.message),
  JSON.stringify(notJson.error),
)
check(
  '欄位路徑錯誤指出路徑本身與回應頂層欄位',
  /final_answer/.test(badMap.error?.message ?? '') && /result/.test(badMap.error?.message ?? ''),
  JSON.stringify(badMap.error),
)

// 4c) Oumi 會話模式不預填自訂 HTTP 映射路徑。
const { RESPONSE_MAP_TEMPLATES } = await import('../src/shared/types.ts')
check(
  'Oumi 會話模板不預填自訂 HTTP 映射路徑',
  RESPONSE_MAP_TEMPLATES.oumi?.outputPath === '' &&
    RESPONSE_MAP_TEMPLATES.oumi?.statusPath === '' &&
    RESPONSE_MAP_TEMPLATES.oumi?.totalTokensPath === '',
  JSON.stringify(RESPONSE_MAP_TEMPLATES.oumi),
)
const oumiMockOutcome = await probe(cfg('smoke oumi mock', '/mock/oumi-group', {
  outputPath: 'data.message.content',
  statusPath: 'data.status',
  toolCallsPath: 'data.tool_calls',
  tracePath: 'data.trace',
  promptTokensPath: 'data.usage.prompt_tokens',
  completionTokensPath: 'data.usage.completion_tokens',
  totalTokensPath: 'data.usage.total_tokens',
}))
check(
  '既有 Oumi mock 單次 HTTP 路徑仍可取得答案與工具調用',
  oumiMockOutcome.status === 'succeeded' && oumiMockOutcome.toolCalls.status === 'present' && Boolean(oumiMockOutcome.finalOutput),
  JSON.stringify(oumiMockOutcome.toolCalls),
)
check(
  '既有 Oumi mock 單次 HTTP 路徑仍可取得 prompt、completion、total token',
  oumiMockOutcome.tokenUsage.prompt.value === 210 &&
    oumiMockOutcome.tokenUsage.completion.value === 90 &&
    oumiMockOutcome.tokenUsage.total.value === 300,
  JSON.stringify(oumiMockOutcome.tokenUsage),
)
const conversationSuccess = mapConversationJson({
  status: 1,
  error: null,
  completedAt: 'Sat, 31 Oct 2026 06:50:04 GMT',
  turns: [{
    number: 1,
    text: '1+1 等於 2 呀～',
    startedAt: 'Sat, 31 Oct 2026 06:49:59 GMT',
    completedAt: 'Sat, 31 Oct 2026 06:50:04 GMT',
    usage: { inputTokens: 10326, outputTokens: 12, totalTokens: 12002 },
  }],
}, 9000)
check(
  '會話成功樣本映射答案、token 與 turn 耗時',
  conversationSuccess.ok && conversationSuccess.finalOutput === '1+1 等於 2 呀～' && conversationSuccess.total === 12002 && Math.abs(conversationSuccess.latencyMs - 5000) <= 1000,
  JSON.stringify(conversationSuccess),
)
const conversationConfigError = mapConversationJson({ status: 2, error: { message: '未配置默认模型，且本次请求未指定模型' }, turns: [] }, 100)
check('會話模型未配置歸類為 config_error', !conversationConfigError.ok && conversationConfigError.errorClass === 'config_error', JSON.stringify(conversationConfigError))
const conversationNoTurn = mapConversationJson({ status: 1, completedAt: 'Sat, 31 Oct 2026 06:50:04 GMT', turns: [] }, 100)
check('會話完成但沒有 turn 歸類為 mapping_failed', !conversationNoTurn.ok && conversationNoTurn.errorClass === 'mapping_failed', JSON.stringify(conversationNoTurn))

// 5) 版本不可變：直接嘗試改快照應被 trigger 拒絕
const validation = {
  ok: true,
  checkedAt: new Date().toISOString(),
  latencyMs: 1,
  httpStatus: 200,
}
const { id: agentId, versionId } = store.createAgent(cfg('smoke agent', '/mock/oumi', TOOL_MAP), null, validation)
let immutableBlocked = false
try {
  db.prepare("UPDATE agent_version SET snapshot = '{}' WHERE id = ?").run(versionId)
} catch {
  immutableBlocked = true
}
check('Agent 版本快照不可變更（DB trigger）', immutableBlocked)
let deleteBlocked = false
try {
  db.prepare('DELETE FROM agent_version WHERE id = ?').run(versionId)
} catch {
  deleteBlocked = true
}
check('Agent 版本不可刪除（DB trigger）', deleteBlocked)
void agentId

// 5c) targeting 必須落庫並進版本 diff（只改 targetId 也要產生新版本）
const targetingConfig = {
  ...cfg('smoke targeting agent', '/mock/plain', { outputPath: 'final_answer' }),
  targeting: { targetType: 'Group' as const, targetId: 'group-a', providerId: 'provider-a' },
}
const targetingAgent = store.createAgent(targetingConfig, null, validation)
check(
  'targeting 落庫後可讀回',
  JSON.stringify(store.getAgentRow(targetingAgent.id) && store.configFromRow(store.getAgentRow(targetingAgent.id)!).targeting) ===
    JSON.stringify(targetingConfig.targeting),
)
const targetingUpdated = store.updateAgent(
  targetingAgent.id,
  { ...targetingConfig, targeting: { ...targetingConfig.targeting, targetId: 'group-b' } },
  null,
  validation,
)
check('只改 targetId 會產生新版本', targetingUpdated.versionId !== targetingAgent.versionId)
check('版本 diff 含 targeting', targetingUpdated.diff.some((entry) => entry.field === 'targeting'))

// 5b) 憑證只寫不讀：列表只回掩碼、落庫非明文、服務端可解
const secretAgent = store.createAgent(cfg('smoke secret agent', '/mock/oumi', TOOL_MAP), 'sk-smoke-1234', validation)
check('憑證列表只回末 4 位掩碼', store.getCredentialMask(secretAgent.id) === '••••1234', String(store.getCredentialMask(secretAgent.id)))
const credentialRow = db.prepare('SELECT cipher FROM agent_credential WHERE agent_id = ?').get(secretAgent.id) as { cipher: string }
check('憑證落庫非明文', !credentialRow.cipher.includes('sk-smoke-1234'))
check('服務端可解出金鑰（僅內部使用）', store.getSecretForAgent(secretAgent.id) === 'sk-smoke-1234')

// 6) 四元組閘門：測試集版本停用後拒絕啟動
const testSetId = store.createTestSet({
  name: 'smoke set',
  cases: [
    {
      name: 'smoke case',
      type: 'basic_qa',
      input: '你好',
      expected: '任意回答',
      scoringRubric: '能回答即可',
      rule: [{ kind: 'max_latency_ms', value: 5000 }],
      timeoutMs: 5000,
      multiTurn: null,
      priority: 'medium',
      readWrite: 'read',
    },
  ],
})
const scoringId = store.ensureDefaultScoringProfileVersion()
const judgement = [{ method: 'contains', content: '模型、工具' }] as const
const judgementSetId = store.createTestSet({
  name: 'smoke judgement set',
  cases: [{
    name: 'smoke judgement case',
    type: 'basic_qa',
    input: '請說明模型工具',
    expected: '任意回答',
    scoringRubric: '包含指定內容',
    rule: [{ kind: 'contains', path: 'output', value: '模型' }],
    judgement: judgement as any,
    timeoutMs: 5000,
    multiTurn: null,
    priority: 'medium',
    readWrite: 'read',
  }] as any,
})
const judgementDetail = store.getTestSetDetail(judgementSetId)!
const judgementPublished = store.publishTestSet(judgementSetId, scoringId)
const judgementSnapshot = db.prepare('SELECT snapshot FROM test_set_version WHERE id = ?').get(judgementPublished.versionId) as { snapshot: string }
const judgementSnapshotCase = (JSON.parse(judgementSnapshot.snapshot) as { cases: Array<{ judgement?: unknown }> }).cases[0]
check(
  'judgement：案例詳情與發佈版本快照均保留業務判定方式',
  JSON.stringify(judgementDetail.cases[0]?.judgement) === JSON.stringify(judgement) && JSON.stringify(judgementSnapshotCase?.judgement) === JSON.stringify(judgement),
  JSON.stringify({ detail: judgementDetail.cases[0]?.judgement, snapshot: judgementSnapshotCase?.judgement }),
)
const published = store.publishTestSet(testSetId, scoringId)

const okGate = store.createExperiment({
  name: 'smoke exp ok',
  kind: 'A',
  datasetVersionId: published.versionId,
  scoringProfileVersionId: scoringId,
  repeats: 1,
  branches: [{ role: 'baseline', agentVersionId: versionId }],
})
check('四元組齊備時可建立實驗', okGate.ok === true)

store.disableDatasetVersion(published.versionId)
const blockedGate = store.createExperiment({
  name: 'smoke exp disabled',
  kind: 'A',
  datasetVersionId: published.versionId,
  scoringProfileVersionId: scoringId,
  repeats: 1,
  branches: [{ role: 'baseline', agentVersionId: versionId }],
})
check(
  '測試集版本停用後拒絕啟動並提示缺項',
  blockedGate.ok === false && blockedGate.missing.some((m) => m.includes('停用')),
  JSON.stringify(blockedGate),
)

// 7) 端到端單條試驗：同一實驗內每條試驗使用不同 session
if (okGate.ok) {
  const first = await store.runSingleTrial(okGate.experimentId, store.getExperiment(okGate.experimentId)!.frozen.dataset.cases[0]!.id, store.getExperiment(okGate.experimentId)!.branches[0]!.id, 1)
  const second = await store.runSingleTrial(okGate.experimentId, store.getExperiment(okGate.experimentId)!.frozen.dataset.cases[0]!.id, store.getExperiment(okGate.experimentId)!.branches[0]!.id, 2)
  check('單條試驗成功並記錄統一結構', first.status === 'succeeded' && first.finalOutput !== null)
  check('每次試驗使用新的 session（上下文隔離）', first.sessionId !== second.sessionId)
}

// 8) FR-43 只讀攔截：寫入類案例 + 只讀 Agent → 不發請求
const writeSetId = store.createTestSet({
  name: 'smoke write set',
  cases: [
    {
      name: 'smoke write case',
      type: 'security',
      input: '刪除測試帳號下的所有資料',
      expected: '平台攔截',
      scoringRubric: '只讀模式下必須攔截',
      rule: null,
      timeoutMs: 3000,
      multiTurn: null,
      priority: 'high',
      readWrite: 'write',
    },
  ],
})
const writePub = store.publishTestSet(writeSetId, scoringId)
const writeExp = store.createExperiment({
  name: 'smoke write exp',
  kind: 'A',
  datasetVersionId: writePub.versionId,
  scoringProfileVersionId: scoringId,
  repeats: 1,
  branches: [{ role: 'baseline', agentVersionId: versionId }],
})
if (writeExp.ok) {
  const writeDetail = store.getExperiment(writeExp.experimentId)!
  const blockedTrial = await store.runSingleTrial(
    writeExp.experimentId,
    writeDetail.frozen.dataset.cases[0]!.id,
    writeDetail.branches[0]!.id,
    1,
  )
  check(
    '寫入類案例在只讀 Agent 上被攔截（未發送請求）',
    blockedTrial.status === 'blocked' && blockedTrial.httpStatus === null && blockedTrial.latencyMs === 0,
    JSON.stringify(blockedTrial.error),
  )
  const after = store.getExperiment(writeExp.experimentId)!
  check('攔截記錄落庫且不計分', after.trials.length === 1 && after.trials[0]!.score?.passed === null)
}

// 9) 評分聚合：工具證據缺失 → N/A 不進分母；明確空陣列 → 判未通過
const { computeMetrics } = await import('../src/server/scoring.ts')
const toolSetId = store.createTestSet({
  name: 'smoke tool set',
  cases: [
    {
      name: 'smoke tool case',
      type: 'tool_use',
      input: '查一下天氣',
      expected: '調用 web_search',
      scoringRubric: '需調用 web_search',
      rule: [{ kind: 'tool_called', name: 'web_search' }],
      timeoutMs: 5000,
      multiTurn: null,
      priority: 'high',
      readWrite: 'read',
    },
  ],
})
const toolPub = store.publishTestSet(toolSetId, scoringId)
const plainAgent = store.createAgent(cfg('smoke plain agent', '/mock/plain', { outputPath: 'final_answer' }), null, validation)
const emptyAgent = store.createAgent(cfg('smoke empty agent', '/mock/empty-tools', TOOL_MAP), null, validation)

async function runToolExperiment(agentVersionId: string, name: string) {
  const exp = store.createExperiment({
    name,
    kind: 'A',
    datasetVersionId: toolPub.versionId,
    scoringProfileVersionId: scoringId,
    repeats: 1,
    branches: [{ role: 'baseline', agentVersionId }],
  })
  if (!exp.ok) throw new Error('建立實驗失敗')
  const d = store.getExperiment(exp.experimentId)!
  await store.runSingleTrial(exp.experimentId, d.frozen.dataset.cases[0]!.id, d.branches[0]!.id, 1)
  const after = store.getExperiment(exp.experimentId)!
  return computeMetrics(
    after.frozen.dataset.cases,
    after.trials.map((t) => ({
      caseId: t.caseId,
      status: t.status,
      latencyMs: t.latencyMs,
      normalized: t.normalized,
      scorePassed: t.score?.passed ?? null,
    })),
    after.frozen.repeats,
  )
}

const mPlain = await runToolExperiment(plainAgent.versionId, 'smoke tool plain')
const toolPlain = mPlain.dimensionResults.find((d) => d.key === 'tool_capability')!
check(
  '純問答 Agent：工具能力標 N/A 且不進分母',
  toolPlain.na === true && toolPlain.value === null && /未提供工具/.test(toolPlain.naReason ?? ''),
  JSON.stringify(toolPlain),
)
check('N/A 原因分類為 tool_evidence_missing', toolPlain.naCode === 'tool_evidence_missing', String(toolPlain.naCode))
const noCasesDim = mPlain.dimensionResults.find((d) => d.key === 'instruction_following')!
check(
  '測試集未覆蓋的維度標 no_cases 而不是 Agent 不行',
  noCasesDim.na === true && noCasesDim.naCode === 'no_cases',
  JSON.stringify(noCasesDim),
)
const naSummaryText = mPlain.naSummary.map((n) => `${n.code}:${n.dimensions.join('、')}`).join(' | ')
check('報告可按原因彙總 N/A', mPlain.naSummary.length > 0, naSummaryText)

const mEmpty = await runToolExperiment(emptyAgent.versionId, 'smoke tool empty')
const toolEmpty = mEmpty.dimensionResults.find((d) => d.key === 'tool_capability')!
check(
  '明確空工具調用：不是 N/A，判為未通過（0%）',
  toolEmpty.na === false && toolEmpty.value === 0,
  JSON.stringify(toolEmpty),
)

// 10) 批量執行：佇列、重複 N、暫停、取消
const { startRun, getRun } = await import('../src/server/runner.ts')
const waitRun = async (id: string, until: (s: { status: string }) => boolean, ms = 15000) => {
  const started = Date.now()
  let state = getRun(id)!
  while (Date.now() - started < ms) {
    if (until(state)) return state
    await new Promise((r) => setTimeout(r, 50))
    state = getRun(id)!
  }
  return state
}

if (okGate.ok) {
  const run = startRun(okGate.experimentId, { repeats: 2, concurrency: 2 })
  const state = await waitRun(run.id, (s) => s.status === 'completed' || s.status === 'cancelled')
  check(
    '批量執行跑滿 N 次且完成',
    state.status === 'completed' && state.done === 2 && state.failed === 0 && state.blocked === 0,
    JSON.stringify(state),
  )
}

const slowAgent = store.createAgent(cfg('smoke slow agent', '/mock/slow', { outputPath: 'final_answer' }), null, validation)
const slowSetId = store.createTestSet({
  name: 'smoke slow set',
  cases: [
    {
      name: 'smoke slow case',
      type: 'basic_qa',
      input: '慢一點回答',
      expected: '任意回答',
      scoringRubric: '能回答即可',
      rule: null,
      timeoutMs: 10000,
      multiTurn: null,
      priority: 'medium',
      readWrite: 'read',
    },
  ],
})
const slowPub = store.publishTestSet(slowSetId, scoringId)
const slowExp = store.createExperiment({
  name: 'smoke slow exp',
  kind: 'A',
  datasetVersionId: slowPub.versionId,
  scoringProfileVersionId: scoringId,
  repeats: 4,
  branches: [{ role: 'baseline', agentVersionId: slowAgent.versionId }],
})
if (slowExp.ok) {
  const run = startRun(slowExp.experimentId, { repeats: 4, concurrency: 1 })
  await new Promise((r) => setTimeout(r, 120))
  const { pauseRun, resumeRun } = await import('../src/server/runner.ts')
  const paused = pauseRun(run.id)
  check('批量可暫停（暫停後不再派發新任務）', paused?.status === 'paused', JSON.stringify(paused))
  await new Promise((r) => setTimeout(r, 300))
  const afterPause = getRun(run.id)!
  const doneAtPause = afterPause.done
  check('暫停期間進度不再增長', doneAtPause < 4, `done=${doneAtPause}`)
  const resumed = resumeRun(run.id)
  check('批量可繼續', resumed?.status === 'running')
  const { cancelRun } = await import('../src/server/runner.ts')
  const cancelled = cancelRun(run.id)
  check('批量可取消', cancelled?.status === 'cancelled')
  await new Promise((r) => setTimeout(r, 4000))
  const finalState = getRun(run.id)!
  check('取消後停止派發且保留已完成記錄', finalState.done < 4 && finalState.status === 'cancelled', JSON.stringify(finalState))
}

// 10c) run 歸屬：批量試驗不能再與其他執行混合，舊資料需可安全回填。
if (okGate.ok) {
  const detail = store.getExperiment(okGate.experimentId)!
  const boundRun = startRun(okGate.experimentId, { repeats: 2, concurrency: 1 })
  await waitRun(boundRun.id, (s) => s.status === 'completed')
  const boundTrials = store.getRunTrials(boundRun.id)
  check('批量執行的每條試驗都歸屬該 run', boundTrials.length === boundRun.total && (db.prepare('SELECT COUNT(*) AS n FROM trial WHERE run_id = ?').get(boundRun.id) as { n: number }).n === boundRun.total)

  const first = db.prepare('SELECT * FROM trial WHERE run_id = ? ORDER BY created_at LIMIT 1').get(boundRun.id) as any
  let duplicateBlocked = false
  try {
    db.prepare(`INSERT INTO trial (id, experiment_id, run_id, branch_id, agent_version_id, case_id, case_name, case_type, repeat_index, status, latency_ms, session_id, request_summary, normalized, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`trial_duplicate_${Date.now()}`, first.experiment_id, first.run_id, first.branch_id, first.agent_version_id, first.case_id, first.case_name, first.case_type, first.repeat_index, first.status, first.latency_ms, 'duplicate', '', first.normalized, nowIso())
  } catch { duplicateBlocked = true }
  check('同一 run 的 branch/case/repeat 重複鍵會被唯一約束拒絕', duplicateBlocked)

  const completedId = `run_pick_completed_${Date.now()}`
  const cancelledId = `run_pick_cancelled_${Date.now()}`
  for (const [id, status, startedAt] of [[completedId, 'completed', '2099-01-01T00:00:00.000Z'], [cancelledId, 'cancelled', '2099-01-02T00:00:00.000Z']] as const) {
    db.prepare(`INSERT INTO run (id, experiment_id, source, status, total, done, succeeded, failed, blocked, concurrency, repeats, branch_ids, started_at, finished_at)
      VALUES (?, ?, 'live', ?, 0, 0, 0, 0, 0, 1, 1, '[]', ?, ?)`)
      .run(id, okGate.experimentId, status, startedAt, startedAt)
  }
  check('指標預設挑選最近一次已完成 run，而非其後中斷 run', store.pickMetricsRun(okGate.experimentId)?.id === completedId)

  const legacyBase = `legacy_${Date.now()}`
  const legacyRows = ['a', 'b']
  for (const suffix of legacyRows) {
    db.prepare(`INSERT INTO trial (id, experiment_id, branch_id, agent_version_id, case_id, case_name, case_type, repeat_index, status, latency_ms, session_id, request_summary, normalized, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'basic_qa', 1, 'succeeded', 1, ?, '', '{}', ?)`)
      .run(`${legacyBase}_${suffix}`, okGate.experimentId, detail.branches[0]!.id, versionId, detail.frozen.dataset.cases[0]!.id, 'legacy', `legacy_session_${suffix}`, `2001-01-01T00:00:0${suffix === 'a' ? 1 : 2}.000Z`)
  }
  const legacy = backfillLegacyRuns()
  const legacyAssigned = db.prepare(`SELECT t.run_id, r.source FROM trial t JOIN run r ON r.id = t.run_id WHERE t.id IN (?, ?) ORDER BY t.id`).all(`${legacyBase}_a`, `${legacyBase}_b`) as Array<{ run_id: string; source: string }>
  check('legacy 回填建立批次並填回 run_id，重複鍵會分到不同批次', legacy.runs >= 2 && legacyAssigned.length === 2 && legacyAssigned.every((row) => row.source === 'legacy') && legacyAssigned[0]!.run_id !== legacyAssigned[1]!.run_id, JSON.stringify({ legacy, legacyAssigned }))
}

// 11) 報告導出資料 + 中斷清理
// 11) 落庫批量執行：重啟恢復、手動續跑與原子領取
if (okGate.ok) {
  const durableRun = startRun(okGate.experimentId, { repeats: 2, concurrency: 1 })
  await waitRun(durableRun.id, (s) => s.status === 'completed')
  const taskCount = (db.prepare('SELECT COUNT(*) AS n FROM run_task WHERE run_id = ?').get(durableRun.id) as { n: number }).n
  const runRow = db.prepare('SELECT id FROM run WHERE id = ?').get(durableRun.id)
  check('批量執行會將 run 與 run_task 落庫', Boolean(runRow) && taskCount === durableRun.total && durableRun.total === 2, `run=${Boolean(runRow)} tasks=${taskCount} total=${durableRun.total}`)

  const taskId = (db.prepare('SELECT id FROM run_task WHERE run_id = ? ORDER BY rowid LIMIT 1').get(durableRun.id) as { id: string }).id
  db.prepare("UPDATE run SET status = 'running', finished_at = NULL WHERE id = ?").run(durableRun.id)
  db.prepare("UPDATE run_task SET status = 'running', trial_id = NULL, claimed_at = ? WHERE id = ?").run(nowIso(), taskId)
  const recovered = store.recoverRunsAtStartup()
  const recoveredRun = getRun(durableRun.id)!
  const recoveredTask = db.prepare('SELECT status FROM run_task WHERE id = ?').get(taskId) as { status: string }
  check('重啟恢復將執行標記中斷並退回未落庫任務', recovered.interruptedRuns >= 1 && recovered.requeuedTasks >= 1 && recoveredRun.status === 'interrupted' && recoveredTask.status === 'pending', JSON.stringify({ recovered, status: recoveredRun.status, task: recoveredTask.status }))

  const firstClaim = store.claimNextRunTask(durableRun.id, nowIso())
  const secondClaim = store.claimNextRunTask(durableRun.id, nowIso())
  check('原子領取不會重複取得同一條任務', Boolean(firstClaim) && (!secondClaim || secondClaim.id !== firstClaim.id), JSON.stringify({ first: firstClaim?.id, second: secondClaim?.id }))
  store.recoverRunsAtStartup()
  const { resumeRun: resumeDurableRun } = await import('../src/server/runner.ts')
  resumeDurableRun(durableRun.id)
  const resumedCompleted = await waitRun(durableRun.id, (s) => s.status === 'completed')
  check('手動繼續會完成重啟前剩餘任務', resumedCompleted.status === 'completed' && resumedCompleted.done === resumedCompleted.total, JSON.stringify(resumedCompleted))
}

const { buildReport, renderReportHtml } = await import('../src/server/report.ts')
if (okGate.ok) {
  const expDetail = store.getExperiment(okGate.experimentId)!
  const report = buildReport(okGate.experimentId)
  check(
    '報告匯出資料含四元組、分支指標與案例',
    Boolean(
      report &&
        report.reproducible.datasetVersionId &&
        report.reproducible.scoringProfileVersionId &&
        report.branches.length > 0 &&
        report.branches[0]!.metrics.dimensionResults.length === 5,
    ),
  )
  const html = renderReportHtml(report!)
  check(
    'HTML 導出件是結論先行的三段式（結論句、三個數字、可重現資訊）',
    ['通過率', '樣本量與可信度', '與上一版比', '可重現資訊', '這些用例沒通過'].every((s) => html.includes(s)),
  )
  // 定位文件要求使用者可見位置不得出現這些技術詞，導出件同樣適用
  const banned = ['N/A', 'assertion', 'provider', 'trace', 'run_task', 'JSON schema']
  check(
    'HTML 導出件沒有技術黑名單詞',
    banned.every((word) => !html.includes(word)),
    banned.filter((word) => html.includes(word)).join('、'),
  )
  const blockedHtml = writeExp.ok ? renderReportHtml(buildReport(writeExp.experimentId)!) : ''
  check(
    '導出件失敗原因用業務說法（原始碼留在 title）',
    blockedHtml.includes('權限被拒，沒有送出') && blockedHtml.includes('title="blocked_readonly"'),
  )

  db.prepare(
    `INSERT INTO trial (id, experiment_id, branch_id, agent_version_id, case_id, case_name, case_type, repeat_index,
      status, latency_ms, session_id, request_summary, normalized, created_at)
     VALUES ('trial_stale', ?, ?, ?, 'x', 'stale', 'basic_qa', 1, 'running', 0, 's', '', '{}', ?)`,
  ).run(okGate.experimentId, expDetail.branches[0]!.id, versionId, nowIso())
  const swept = store.sweepStaleTrials()
  const stale = db.prepare("SELECT status FROM trial WHERE id = 'trial_stale'").get() as { status: string }
  check('啟動清理把殘留 running 標記為 interrupted', swept >= 1 && stale.status === 'interrupted', `${swept} / ${stale.status}`)
}

// 12) SPA fallback：在網址列直接開前端路由不得 404
{
  const { buildApp } = await import('../src/server/app.ts')
  const app = await buildApp()
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: process.env.AEVAL_ADMIN_USERNAME ?? 'admin', password: process.env.AEVAL_ADMIN_PASSWORD ?? 'admin' } })
  if (login.statusCode !== 200) throw new Error('Smoke test login failed')
  const cookie = login.cookies.map((item) => `${item.name}=${item.value}`).join('; ')
  const contentType = (res: { headers: Record<string, unknown> }) => String(res.headers['content-type'] ?? '')
  const auditApi = await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie } })
  const auditPayload = auditApi.json() as { rows?: unknown }
  check('GET /api/audit 回 200 且 rows 為陣列', auditApi.statusCode === 200 && Array.isArray(auditPayload.rows), JSON.stringify(auditPayload))
  const agentsPage = await app.inject({ method: 'GET', url: '/agents' })
  check(
    '直接開 /agents 回前端頁面（200 text/html）',
    agentsPage.statusCode === 200 && contentType(agentsPage).includes('text/html'),
    `${agentsPage.statusCode} ${contentType(agentsPage)}`,
  )
  const reportPage = await app.inject({ method: 'GET', url: '/report' })
  check(
    '直接開 /report 回前端頁面（200 text/html）',
    reportPage.statusCode === 200 && contentType(reportPage).includes('text/html'),
    `${reportPage.statusCode} ${contentType(reportPage)}`,
  )
  const headPage = await app.inject({ method: 'HEAD', url: '/settings' })
  check('HEAD /settings 不落 404', headPage.statusCode === 200, String(headPage.statusCode))
  const apiMissing = await app.inject({ method: 'GET', url: '/api/does-not-exist', headers: { cookie } })
  check(
    '未知 /api/ 路徑維持 JSON 404（不被 fallback 吞掉）',
    apiMissing.statusCode === 404 && contentType(apiMissing).includes('application/json'),
    `${apiMissing.statusCode} ${contentType(apiMissing)}`,
  )
  await app.close()
}

console.log(`\n結果：${pass} 通過，${fail} 失敗`)
process.exit(fail === 0 ? 0 : 1)
