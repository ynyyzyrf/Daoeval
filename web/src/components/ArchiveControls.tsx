import { useState } from 'react'
import { api } from '../api.ts'
import { Button, useToast } from './ui.tsx'
import './ArchiveControls.css'

export function ArchiveFilter({ archived, onChange, items }: {
  archived: boolean
  onChange: (archived: boolean) => void
  items: Array<{ archived: boolean }>
}) {
  return (
    <div className="archive-filter" role="group" aria-label="歸檔狀態">
      {[false, true].map((value) => (
        <button type="button" key={String(value)} aria-pressed={archived === value} onClick={() => onChange(value)}>
          {value ? '已歸檔' : '未歸檔'} <span>{items.filter((item) => item.archived === value).length}</span>
        </button>
      ))}
    </div>
  )
}

export function ArchiveAction({ kind, item, onChanged }: {
  kind: 'test-set' | 'experiment'
  item: { id: string; name: string; archived: boolean }
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const label = item.archived ? '還原' : '歸檔'
  const save = async () => {
    setBusy(true)
    try {
      if (kind === 'test-set') await api.archiveTestSet(item.id, !item.archived)
      else await api.archiveExperiment(item.id, !item.archived)
      toast.push('success', item.archived ? `已還原「${item.name}」` : `已歸檔「${item.name}」，可在已歸檔列表還原`)
      window.dispatchEvent(new CustomEvent('aeval:archive-changed'))
      onChanged()
    } catch (error) {
      toast.push('error', (error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <span onClick={(event) => event.stopPropagation()}>
      <Button size="sm" variant="ghost" loading={busy} loadingLabel="儲存中…" aria-label={`${label} ${item.name}`} title={item.archived ? '還原到未歸檔列表' : '隱藏此項目，保留資料及歷史結果'} onClick={() => void save()}>{label}</Button>
    </span>
  )
}
