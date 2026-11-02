import { useCallback, useEffect, useState } from 'react'
import { Badge, Button, Drawer, Notice, useToast } from './ui.tsx'
import { shareApi, type ShareLink } from '../lib/share-api.ts'
import { formatDateTime } from '../lib/format.ts'

const DAY_OPTIONS = [1, 7, 30]

function absoluteUrl(path: string): string {
  return `${window.location.origin}${path}`
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 非 https 或瀏覽器不給剪貼簿權限時，退回選取 + execCommand
    const input = document.createElement('textarea')
    input.value = text
    input.style.position = 'fixed'
    input.style.opacity = '0'
    document.body.appendChild(input)
    input.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(input)
    return ok
  }
}

function statusBadge(status: ShareLink['status']) {
  if (status === 'active') return <Badge tone="ok">有效</Badge>
  if (status === 'revoked') return <Badge tone="err">已撤銷</Badge>
  return <Badge tone="muted">已過期</Badge>
}

/** 報告頁的「分享」抽屜：生成只讀連結、重新複製、一鍵撤銷。 */
export function ShareDialog({ experimentId, experimentName, onClose }: { experimentId: string; experimentName: string; onClose: () => void }) {
  const toast = useToast()
  const [links, setLinks] = useState<ShareLink[]>([])
  const [days, setDays] = useState(7)
  const [loading, setLoading] = useState(false)
  const [created, setCreated] = useState<{ path: string; expiresAt: string } | null>(null)
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null)

  const refresh = useCallback(() => {
    shareApi
      .list(experimentId)
      .then((result) => setLinks(result.links))
      .catch(() => toast.push('error', '讀取連結列表失敗'))
  }, [experimentId, toast])

  useEffect(() => {
    refresh()
  }, [refresh])

  const create = async () => {
    setLoading(true)
    try {
      const result = await shareApi.create(experimentId, days)
      setCreated({ path: result.path, expiresAt: result.expiresAt })
      const ok = await copyText(absoluteUrl(result.path))
      toast.push('success', ok ? '連結已生成並複製' : '連結已生成，請手動複製')
      refresh()
    } catch (error) {
      toast.push('error', error instanceof Error ? error.message : '生成連結失敗')
    } finally {
      setLoading(false)
    }
  }

  const revoke = async (id: string) => {
    try {
      await shareApi.revoke(id)
      if (created && links.find((link) => link.id === id)?.path === created.path) setCreated(null)
      toast.push('success', '已撤銷，舊連結立刻失效')
      setConfirmRevoke(null)
      refresh()
    } catch (error) {
      toast.push('error', error instanceof Error ? error.message : '撤銷失敗')
    }
  }

  return (
    <Drawer title="分享連結" onClose={onClose}>
      <div className="stack">
        <Notice tone="info">
          拿到連結的人不需要登入就能打開，只能閱讀，不能修改或重跑。到期或撤銷後立刻失效，重新整理也不會復活。
        </Notice>

        <div className="share-create">
          <div className="share-create-main">
            <span className="field-label">連結有效期</span>
            <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
              {DAY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option} 天
                </option>
              ))}
            </select>
            <Button variant="primary" loading={loading} onClick={create}>
              生成連結
            </Button>
          </div>
          <span className="field-hint">1–30 天，不支援永不過期</span>
        </div>

        {created && (
          <div className="share-new">
            <div className="sm muted">建立給「{experimentName}」，{formatDateTime(created.expiresAt)} 到期</div>
            <div className="share-link-row">
              <input className="mono" readOnly value={absoluteUrl(created.path)} onFocus={(event) => event.target.select()} />
              <Button
                size="sm"
                onClick={async () => toast.push('success', (await copyText(absoluteUrl(created.path))) ? '已複製' : '複製失敗，請手動選取')}
              >
                複製
              </Button>
            </div>
          </div>
        )}

        <div className="stack-2">
          <div className="card-title">已生成的連結</div>
          {links.length === 0 ? (
            <div className="sm muted">還沒有連結。生成後把連結發給外部同事即可。</div>
          ) : (
            <div className="share-list">
              {links.map((link) => (
                <div key={link.id} className="share-item">
                  <div className="share-item-main">
                    {statusBadge(link.status)}
                    <span className="sm">到期 {formatDateTime(link.expiresAt)}</span>
                    <span className="xs muted">建立於 {formatDateTime(link.createdAt)}</span>
                  </div>
                  {link.status === 'active' && link.path ? (
                    confirmRevoke === link.id ? (
                      <div className="row-tight">
                        <span className="xs">撤銷後這個連結立刻打不開，確定？</span>
                        <Button size="sm" variant="danger" onClick={() => revoke(link.id)}>
                          確定撤銷
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmRevoke(null)}>
                          取消
                        </Button>
                      </div>
                    ) : (
                      <div className="row-tight">
                        <Button
                          size="sm"
                          onClick={async () => toast.push('success', (await copyText(absoluteUrl(link.path!))) ? '已複製' : '複製失敗，請手動選取')}
                        >
                          複製連結
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmRevoke(link.id)}>
                          撤銷
                        </Button>
                      </div>
                    )
                  ) : (
                    <span className="xs muted">{link.status === 'revoked' ? '已撤銷' : '已過期'}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Drawer>
  )
}
