/** 跑一輪示範試驗：對每個分支跑問答與工具案例，慢分支跑逾時案例。 */
const BASE = process.env.AEVAL_BASE ?? 'http://127.0.0.1:5280'

const list = await (await fetch(`${BASE}/api/experiments`)).json()
const experimentId = process.argv[2] ?? list[0]?.id
if (!experimentId) throw new Error('找不到實驗')
const exp = await (await fetch(`${BASE}/api/experiments/${experimentId}`)).json()

const cases = exp.frozen.dataset.cases
const byName = (n) => cases.find((c) => c.name.includes(n))

async function run(caseId, branchId, repeatIndex) {
  const res = await fetch(`${BASE}/api/experiments/${experimentId}/trials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ caseId, branchId, repeatIndex }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(JSON.stringify(data))
  return data
}

for (const branch of exp.branches) {
  const role = branch.role
  if (role === 'slow') {
    const c = byName('逾時')
    const r = await run(c.id, branch.id, 1)
    console.log(`${role} / ${c.name} → ${r.status} ${r.error?.class ?? ''} ${r.latencyMs}ms`)
    continue
  }
  for (const name of ['基礎問答', '工具調用']) {
    const c = byName(name)
    const r = await run(c.id, branch.id, 1)
    console.log(`${role} / ${c.name} → ${r.status} 工具=${r.toolCalls.status} ${r.latencyMs}ms`)
  }
}

console.log(`\n完成，實驗 ${experimentId}`)
