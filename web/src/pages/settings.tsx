import { useEffect, useState } from 'react'
import { api } from '../api.ts'
import { Card, EmptyState, PageTitle } from '../components/ui.tsx'
import { formatDateTime } from '../lib/format.ts'

export function SettingsPage() {
  const [audit, setAudit] = useState<Awaited<ReturnType<typeof api.audit>> | null>(null)

  useEffect(() => {
    api.audit({ limit: 50 }).then(setAudit).catch(() => setAudit(null))
  }, [])

  return (
    <div className="stack page-stack">
      <div className="page-head">
        <PageTitle lead="設定" sub="查看系統操作記錄" />
      </div>

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

    </div>
  )
}
