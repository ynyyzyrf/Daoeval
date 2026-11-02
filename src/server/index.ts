import './env.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { migrate } from './db.ts'
import { recoverRunsAtStartup, sweepStaleTrials } from './store.ts'
import { keySource } from './crypto.ts'
import { createMockAgentApp } from './mock-agent.ts'
import { buildApp } from './app.ts'
import { recoverAiEvaluations } from './ai-evaluation.ts'

const PORT = Number(process.env.AEVAL_PORT ?? 5280)
const HOST = process.env.AEVAL_HOST ?? '127.0.0.1'
const MOCK_PORT = Number(process.env.AEVAL_MOCK_PORT ?? 5199)

migrate()
recoverAiEvaluations()
const swept = sweepStaleTrials()
const recoveredRuns = recoverRunsAtStartup()
if (recoveredRuns.interruptedRuns > 0 || recoveredRuns.requeuedTasks > 0) {
  console.log(`啟動恢復：${recoveredRuns.interruptedRuns} 個執行因重啟中斷，${recoveredRuns.requeuedTasks} 條試驗已退回待跑，可在實驗詳情頁按「繼續」接續`)
}
if (swept > 0) console.log(`啟動清理：${swept} 筆上次中斷的 running 試驗已標記為 interrupted`)

const app = await buildApp()
await app.listen({ port: PORT, host: HOST })

const mock = createMockAgentApp()
await mock.listen({ port: MOCK_PORT, host: '127.0.0.1' })

const dist = join(process.cwd(), 'web', 'dist')
console.log(`\n  Daoeval 骨架已啟動`)
console.log(`  平台：      http://${HOST}:${PORT}`)
console.log(`  模擬 Agent：http://127.0.0.1:${MOCK_PORT}/mock/oumi`)
console.log(`  憑證金鑰來源：${keySource === 'env' ? '環境變數 AEVAL_ENC_KEY' : '資料目錄中的 dev-enc.key（臨時金鑰）'}`)
console.log(`  前端建置：   ${existsSync(dist) ? '已載入 web/dist' : '未建置，先執行 pnpm run build:web'}\n`)
