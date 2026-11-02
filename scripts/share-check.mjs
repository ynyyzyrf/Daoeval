/**
 * 分享連結驗收：生成 → 匿名讀取 → 撤銷當下失效 → 過期失效 → 內容不含內部 id／技術詞。
 * 用法：node scripts/share-check.mjs
 */
import Database from 'better-sqlite3'
import { join } from 'node:path'

const BASE = process.env.AEVAL_BASE ?? 'http://127.0.0.1:5280'
const DATA_DIR = process.env.AEVAL_DATA_DIR ?? join(process.cwd(), '.data')

const failures = []
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, data: await res.json().catch(() => null) }
}

async function getJson(path) {
  const res = await fetch(BASE + path, { cache: 'no-store' })
  return { status: res.status, headers: res.headers, data: await res.json().catch(() => null) }
}

const experiments = await getJson('/api/experiments')
if (experiments.status !== 200 || !Array.isArray(experiments.data) || experiments.data.length === 0) {
  console.error('找不到任何實驗，先跑一次 demo seed')
  process.exit(1)
}
const experiment = experiments.data.find((item) => item.trialCount > 0) ?? experiments.data[0]
console.log(`實驗：${experiment.name}（${experiment.id}，${experiment.trialCount} 次試驗）`)

// 1. 生成
console.log('\n[1] 生成連結')
const created = await post(`/api/experiments/${experiment.id}/shares`, { days: 7 })
check('建立回 200', created.status === 200, `status=${created.status}`)
const path = created.data?.path ?? ''
const token = path.replace('/s/', '')
check('路徑是 /s/<隨機串>', /^\/s\/[A-Za-z0-9_-]{40,}$/.test(path), path)
check('路徑不含實驗 id', !path.includes(experiment.id))
check('路徑不含 exp_/run_/trial_/sess_', !/exp_|run_|trial_|sess_|shr_/.test(path))
check('預設到期是 7 天左右', Math.abs(Date.parse(created.data?.expiresAt ?? 0) - Date.now() - 7 * 86400000) < 60000)

const tooLong = await post(`/api/experiments/${experiment.id}/shares`, { days: 31 })
check('31 天被拒（上限 30）', tooLong.status === 400, `status=${tooLong.status}`)
const never = await post(`/api/experiments/${experiment.id}/shares`, { days: 0 })
check('0 天被拒（沒有永不過期）', never.status === 400, `status=${never.status}`)

// 2. 匿名讀取
console.log('\n[2] 匿名讀取（不帶任何憑證）')
const read = await getJson(`/api/share/${token}`)
check('200', read.status === 200, `status=${read.status}`)
check('cache-control: no-store', (read.headers.get('cache-control') ?? '').includes('no-store'), read.headers.get('cache-control') ?? '')
check('x-robots-tag: noindex', (read.headers.get('x-robots-tag') ?? '').includes('noindex'), read.headers.get('x-robots-tag') ?? '')
check('referrer-policy: no-referrer', read.headers.get('referrer-policy') === 'no-referrer', read.headers.get('referrer-policy') ?? '')
const snapshot = read.data?.snapshot
check('回傳凍結快照', snapshot?.schemaVersion === 1, JSON.stringify(snapshot?.schemaVersion))
check('結論先行：有 headline', typeof snapshot?.headline === 'string' && snapshot.headline.length > 8)
check('失敗總數有寫出來', typeof snapshot?.failuresTotal === 'number')
check('失敗清單不截斷（列表條數 = 總數）', Array.isArray(snapshot?.failures) && snapshot.failures.length === snapshot.failuresTotal)
check('原文最多前 5 條', (snapshot?.failures ?? []).filter((item) => item.actual).length <= 5)

const payload = JSON.stringify(read.data)
const forbidden = ['exp_', 'run_', 'trial_', 'sess_', 'shr_', 'endpoint', 'provider', 'assertion', 'trace', 'credential', 'token', 'sessionId', 'N/A', 'agentVersionId']
for (const word of forbidden) {
  check(`快照不含「${word}」`, !payload.includes(word), payload.includes(word) ? payload.slice(Math.max(0, payload.indexOf(word) - 40), payload.indexOf(word) + 40) : '')
}

// 2b. 對外那張 HTML 本身（不是 API）也要帶同一套嚴格頭，否則搜尋引擎/快取/外跳都會繞過
console.log('\n[2b] 對外 HTML 頁面本身（/s/<token>）')
const html = await fetch(BASE + path)
check('HTML 200', html.status === 200, `status=${html.status}`)
check('HTML cache-control: no-store', (html.headers.get('cache-control') ?? '').includes('no-store'), html.headers.get('cache-control') ?? '')
check('HTML x-robots-tag: noindex', (html.headers.get('x-robots-tag') ?? '').includes('noindex'), html.headers.get('x-robots-tag') ?? '')
check('HTML referrer-policy: no-referrer', html.headers.get('referrer-policy') === 'no-referrer', html.headers.get('referrer-policy') ?? '')
check('HTML 沒有 ETag / Last-Modified（不會走 304）', !html.headers.get('etag') && !html.headers.get('last-modified'))
const bogusHtml = await fetch(`${BASE}/s/${'a'.repeat(43)}`)
check('無效 token 的 HTML 也帶嚴格頭', (bogusHtml.headers.get('cache-control') ?? '').includes('no-store') && (bogusHtml.headers.get('x-robots-tag') ?? '').includes('noindex'))
const internal = await fetch(`${BASE}/`)
check('內部頁面不受影響（不帶 noindex）', !(internal.headers.get('x-robots-tag') ?? '').includes('noindex'))

// 3. 撤銷 → 立刻失效（等同舊頁面刷新）
console.log('\n[3] 撤銷立即生效')
const revoke = await fetch(`${BASE}/api/share-links/${created.data.id}`, { method: 'DELETE' })
check('撤銷回 200', revoke.status === 200, `status=${revoke.status}`)
const afterRevoke = await getJson(`/api/share/${token}`)
check('撤銷後讀取 404', afterRevoke.status === 404, `status=${afterRevoke.status}`)
check('撤銷後回應不帶快照內容', afterRevoke.data?.snapshot === undefined)
const afterRevoke2 = await getJson(`/api/share/${token}`)
check('重複刷新仍 404', afterRevoke2.status === 404, `status=${afterRevoke2.status}`)

// 4. 到期失效：直接把測試連結的到期時間改到過去
console.log('\n[4] 到期立即失效')
const expired = await post(`/api/experiments/${experiment.id}/shares`, { days: 1 })
const db = new Database(join(DATA_DIR, 'aeval.db'))
db.prepare('UPDATE share_link SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), expired.data.id)
db.close()
const afterExpiry = await getJson(`/api/share/${expired.data.path.replace('/s/', '')}`)
check('過期後 404', afterExpiry.status === 404, `status=${afterExpiry.status}`)
const beforeExpiryStatus = await getJson(`/api/experiments/${experiment.id}/shares`)
const expiredRow = beforeExpiryStatus.data?.links?.find((link) => link.id === expired.data.id)
check('列表標示已過期', expiredRow?.status === 'expired', expiredRow?.status)

// 5. 重新複製與無法枚舉
console.log('\n[5] 重新複製 / 無法猜測')
const listed = await getJson(`/api/experiments/${experiment.id}/shares`)
const copyable = listed.data?.links?.find((link) => link.id === created.data.id)
check('列表回得出原連結（可重新複製）', copyable?.path === path, `${copyable?.path}`)
const unknown = await getJson('/api/share/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
check('隨便一個串 404', unknown.status === 404, `status=${unknown.status}`)
check('失效訊息不透露原因', unknown.data?.error === '連結無效或已過期', unknown.data?.error)

// 收尾：把測試建立的連結撤銷，避免留在列表裡誤點
for (const id of [created.data.id, expired.data.id]) {
  await fetch(`${BASE}/api/share-links/${id}`, { method: 'DELETE' })
}

console.log('')
if (failures.length > 0) {
  console.log(`失敗 ${failures.length} 項：`)
  for (const item of failures) console.log(` - ${item}`)
  process.exit(1)
}
console.log('全部通過')
