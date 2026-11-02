/** 對指定實驗啟動批量執行並輪詢到結束。用法：node scripts/batch-run.mjs <experimentId> [concurrency] */
const BASE = process.env.AEVAL_BASE ?? 'http://127.0.0.1:5280'
const experimentId = process.argv[2]
const concurrency = Number(process.argv[3] ?? 3)
if (!experimentId) throw new Error('需要 experimentId')

const started = await fetch(`${BASE}/api/experiments/${experimentId}/run`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ concurrency }),
})
let state = await started.json()
if (!started.ok) throw new Error(JSON.stringify(state))
console.log(`run ${state.id} 開始，共 ${state.total} 次試驗，並發 ${state.concurrency}`)

while (state.status === 'running' || state.status === 'paused') {
  await new Promise((r) => setTimeout(r, 500))
  state = await (await fetch(`${BASE}/api/runs/${state.id}`)).json()
}
console.log(`結束：${state.status}，完成 ${state.done}/${state.total}，成功 ${state.succeeded}，失敗 ${state.failed}，攔截 ${state.blocked}`)
