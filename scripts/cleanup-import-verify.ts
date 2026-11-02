/** 驗證殘留清理：先備份受影響的測試集與案例，再按名稱前綴刪除。 */
import { db } from '../src/server/db.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const prefix = process.argv[2] ?? 'sample-good'
const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
const backupDir = join('.data', 'backup')
mkdirSync(backupDir, { recursive: true })

const sets = db.prepare('SELECT id, name, created_at FROM test_set WHERE name LIKE ?').all(`${prefix}%`) as Array<{ id: string; name: string; created_at: string }>
if (sets.length === 0) {
  console.log('沒有符合的測試集')
  process.exit(0)
}
const ids = sets.map((item) => item.id)
const placeholders = ids.map(() => '?').join(',')
const cases = db.prepare(`SELECT * FROM test_case WHERE test_set_id IN (${placeholders})`).all(...ids)
const versions = db.prepare(`SELECT * FROM test_set_version WHERE test_set_id IN (${placeholders})`).all(...ids)
const file = join(backupDir, `import-verify-${stamp}.json`)
writeFileSync(file, JSON.stringify({ sets, cases, versions }, null, 2))

const remove = db.transaction(() => {
  db.prepare(`DELETE FROM test_case WHERE test_set_id IN (${placeholders})`).run(...ids)
  db.prepare(`DELETE FROM test_set_version WHERE test_set_id IN (${placeholders})`).run(...ids)
  db.prepare(`DELETE FROM test_set WHERE id IN (${placeholders})`).run(...ids)
})
remove()
console.log(`已備份 ${file}；刪除 ${sets.length} 個測試集、${cases.length} 條案例、${versions.length} 個版本`)
