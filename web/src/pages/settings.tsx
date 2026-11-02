import { useEffect, useState } from 'react'
import { api } from '../api.ts'
import { Badge, Button, Card, EmptyState, Field, PageTitle, useToast } from '../components/ui.tsx'
import { formatDateTime } from '../lib/format.ts'
import { DeepSeekSettings } from '../components/DeepSeekSettings.tsx'

export function SettingsPage() {
  const [meta, setMeta] = useState<Awaited<ReturnType<typeof api.meta>> | null>(null)
  const [seeding, setSeeding] = useState(false)
  const [seeded, setSeeded] = useState<string | null>(null)
  const [audit, setAudit] = useState<Awaited<ReturnType<typeof api.audit>> | null>(null)
  const toast = useToast()

  useEffect(() => {
    api.meta().then(setMeta).catch(() => setMeta(null))
    api.audit({ limit: 50 }).then(setAudit).catch(() => setAudit(null))
  }, [])

  const seed = async () => {
    setSeeding(true)
    try {
      const result = await api.seed()
      setSeeded(result.seeded ? '示範資料已灌入' : result.reason ?? '已有資料，略過')
      toast.push('success', result.seeded ? '示範資料已灌入' : '已有資料，略過')
    } catch (e) {
      toast.push('error', (e as Error).message)
    } finally {
      setSeeding(false)
    }
  }

  return (
    <div className="stack page-stack">
      <div className="page-head">
        <PageTitle lead="設定" sub="AI 評分模型、開發者工具與版本資訊" />
      </div>

      <DeepSeekSettings />
      <Card title="開發者工具" subtitle="只在本地開發與驗證時使用，正式使用不需要。">
        <details>
          <summary className="sm muted" style={{ cursor: 'pointer' }}>
            展開開發者工具
          </summary>
          <div className="stack-3" style={{ marginTop: 16 }}>
            <div className="row">
              <Button onClick={() => void seed()} loading={seeding} loadingLabel="灌入中…">
                灌入示範資料
              </Button>
              <span className="sm muted">會建立 4 個本地模擬 Agent、1 個測試集與 1 個三分支實驗。</span>
            </div>
            {seeded && <div className="notice info">{seeded}</div>}

            <Field label="憑證金鑰來源">
              <div className="sm">
                {meta?.keySource === 'env' ? (
                  <Badge tone="ok">環境變數 AEVAL_ENC_KEY</Badge>
                ) : (
                  <Badge tone="warn">本地開發金鑰（.data/dev-enc.key）</Badge>
                )}
              </div>
            </Field>

            {meta && (
              <div>
                <div className="sm muted" style={{ marginBottom: 8 }}>
                  模擬端點（{meta.mockBase}）
                </div>
                <table className="data">
                  <thead>
                    <tr>
                      <th>路徑</th>
                      <th>用途</th>
                    </tr>
                  </thead>
                  <tbody>
                    {meta.mockEndpoints.map((endpoint) => (
                      <tr key={endpoint.path}>
                        <td className="mono">{endpoint.path}</td>
                        <td className="sm muted">{endpoint.hint}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </details>
      </Card>

      <Card
        title="操作審計"
        subtitle={audit && audit.total > 50 ? `共 ${audit.total} 條，顯示最近 50 條` : '最近 50 條；記錄誰改了配置、跑了什麼、導出了什麼'}
      >
        {audit?.rows.length ? (
          <table className="data">
            <thead>
              <tr>
                <th>時間</th>
                <th>操作</th>
                <th>對象</th>
                <th>執行者</th>
                <th>來源</th>
              </tr>
            </thead>
            <tbody>
              {audit.rows.map((row) => (
                <tr key={row.id}>
                  <td className="sm muted">{formatDateTime(row.at)}</td>
                  <td className="mono">{row.action}</td>
                  <td className="sm">{row.targetType}{row.targetId ? ` · ${row.targetId.slice(0, 12)}` : ''}</td>
                  <td>{row.actor}</td>
                  <td className="sm muted">{`${row.method} ${row.path}`.slice(0, 80)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState title="尚無操作審計" description="完成設定、執行或匯出後，會在這裡留下紀錄。" />
        )}
      </Card>

      <Card title="術語表">
        <dl className="kv" style={{ gridTemplateColumns: '160px 1fr' }}>
          <dt>可重現四元組</dt>
          <dd className="sm">Agent 版本 + 測試集版本 + 評分規則集版本 + 重複次數；缺一不得啟動實驗。</dd>
          <dt>N/A（不可評測）</dt>
          <dd className="sm">不計入分母、不視為 0 分。原因分六類：測試集未覆蓋、Agent 未提供證據、只讀未測、樣本不足、尚未執行、無可評分依據。</dd>
          <dt>工具調用三態</dt>
          <dd className="sm">
            有值（已取得）／空陣列（明確沒有調用）／null（取不到）。null 不當成「沒有調用」，該維度標 N/A。
          </dd>
          <dt>A / B 類實驗</dt>
          <dd className="sm">A 類：同一 Agent 不同版本對比；B 類：不同 Agent 橫向對比。</dd>
          <dt>重複成功比例</dt>
          <dd className="sm">N 次重複中全部成功的案例數 ÷ 案例總數。</dd>
          <dt>只讀攔截</dt>
          <dd className="sm">案例讀寫類型為 write、而 Agent 未標記允許寫入時，平台不發送請求，記為已攔截。</dd>
        </dl>
      </Card>

      <Card title="版本資訊">
        <dl className="kv">
          <dt>平台版本</dt>
          <dd>v1.0</dd>
          <dt>需求文檔</dt>
          <dd>Daoeval V1.0</dd>
          <dt>評分方式</dt>
          <dd className="sm">規則評分＋DeepSeek AI 回答差距評估；兩者獨立保存。</dd>
        </dl>
      </Card>
    </div>
  )
}
