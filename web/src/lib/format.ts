import { splitTitle } from '../../../src/shared/text.ts'

export { splitTitle }

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return formatDateTime(iso).slice(0, 10)
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  return `${ms} ms`
}

/** 百分比一位小數；null 一律顯示 N/A，不寫成 0 或 - */
export function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'N/A'
  return `${(value * 100).toFixed(1)}%`
}

export function truncate(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

export function statusText(status: string): string {
  const map: Record<string, string> = {
    succeeded: '成功',
    failed: '失敗',
    blocked: '已攔截',
    interrupted: '已中斷',
    ready: '待執行',
    running: '執行中',
    paused: '已暫停',
    completed: '已完成',
    partial_failed: '部分失敗',
    cancelled: '已取消',
    active: '啟用',
    disabled: '已停用',
  }
  return map[status] ?? status
}
