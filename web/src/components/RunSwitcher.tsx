import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { RunSummary } from '../api.ts'
import { formatDateTime, statusText } from '../lib/format.ts'
import { Icon } from './ui.tsx'
import './RunSwitcher.css'

const sourceLabel = (run: RunSummary) => run.source === 'live' ? '批量執行' : run.source === 'legacy' ? '歷史批次' : '手動試跑'
const stateLabel = (run: RunSummary) => run.status === 'completed' && run.failed > 0 ? '已完成 · 有失敗' : statusText(run.status)

export function RunSwitcher({ runs, value, onChange }: {
  runs: RunSummary[]
  value: string | null
  onChange: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0, width: 360, maxHeight: 360 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const ordered = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const current = ordered.find((run) => run.id === value) ?? ordered[0]
  const latest = ordered[0]

  const close = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  useLayoutEffect(() => {
    if (!open) return
    const rect = triggerRef.current!.getBoundingClientRect()
    const width = Math.min(400, window.innerWidth - 24)
    const below = window.innerHeight - rect.bottom - 16
    const above = rect.top - 16
    const placeBelow = below >= 240 || below >= above
    const maxHeight = Math.min(400, Math.max(100, placeBelow ? below : above))
    setPosition({
      top: placeBelow ? rect.bottom + 6 : Math.max(12, rect.top - maxHeight - 6),
      left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
      width,
      maxHeight,
    })
    const selected = panelRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')
    selected?.focus({ preventScroll: true })
    selected?.scrollIntoView({ block: 'nearest' })
  }, [open])

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!triggerRef.current?.contains(event.target as Node) && !panelRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const dismiss = () => setOpen(false)
    const scrollOutside = (event: Event) => {
      if (!panelRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const focusOutside = (event: FocusEvent) => {
      if (!triggerRef.current?.contains(event.target as Node) && !panelRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', focusOutside)
    window.addEventListener('resize', dismiss)
    document.addEventListener('scroll', scrollOutside, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', focusOutside)
      window.removeEventListener('resize', dismiss)
      document.removeEventListener('scroll', scrollOutside, true)
    }
  }, [open])

  if (!current) return null

  const choose = (id: string) => {
    close()
    if (id !== current.id) onChange(id)
  }

  const onListKey = (event: KeyboardEvent) => {
    const options = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])
    const index = options.indexOf(document.activeElement as HTMLButtonElement)
    let next = index
    if (event.key === 'ArrowDown') next = (index + 1) % options.length
    else if (event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = options.length - 1
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    else return
    event.preventDefault()
    options[next]?.focus()
  }

  return (
    <div className="run-switcher">
      <button
        ref={triggerRef}
        type="button"
        className="run-switcher-trigger"
        aria-label={`切換執行記錄，目前為 ${formatDateTime(current.startedAt)}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) }
          if (event.key === 'Escape') close()
        }}
      >
        <Icon name="history" size={16} />
        <span className="run-switcher-current">
          <span className="run-switcher-caption">執行記錄 <span className="run-switcher-count">{runs.length}</span></span>
          <span className="run-switcher-date">{formatDateTime(current.startedAt)}</span>
        </span>
        {current.id === latest.id && <span className="run-switcher-latest">最新</span>}
        <span className="run-switcher-state">{stateLabel(current)}</span>
        <span className={`run-switcher-chevron ${open ? 'is-open' : ''}`}><Icon name="chevron" size={16} /></span>
      </button>
      {open && createPortal(
        <div className="run-switcher-panel" ref={panelRef} style={position}>
          <div className="run-switcher-heading"><strong>執行記錄</strong><span>共 {runs.length} 次 · 最新在上</span></div>
          <div id={listId} role="listbox" aria-label="選擇執行記錄" onKeyDown={onListKey}>
            {ordered.map((run, index) => (
              <button
                type="button"
                key={run.id}
                role="option"
                aria-selected={run.id === current.id}
                tabIndex={run.id === current.id ? 0 : -1}
                className="run-switcher-option"
                onClick={() => choose(run.id)}
              >
                <span className="run-switcher-option-main">
                  <span className="run-switcher-option-title">
                    <strong>第 {ordered.length - index} 次執行</strong>
                    {index === 0 && <span className="run-switcher-latest">最新</span>}
                    <span className="run-switcher-option-state">{stateLabel(run)}</span>
                  </span>
                  <span className="run-switcher-option-meta">{formatDateTime(run.startedAt)} · {sourceLabel(run)}</span>
                  <span className="run-switcher-results">
                    <span>進度 {run.done}/{run.total}</span>
                    <span>調用成功 {run.succeeded}</span>
                    <span className={run.failed > 0 ? 'run-switcher-failures' : ''}>失敗 {run.failed}</span>
                    {run.blocked > 0 && <span>攔截 {run.blocked}</span>}
                  </span>
                </span>
                <span className="run-switcher-check" aria-hidden="true">{run.id === current.id ? '✓' : ''}</span>
              </button>
            ))}
          </div>
          <div className="run-switcher-footnote">調用成功不代表答案評分通過</div>
        </div>, document.body,
      )}
    </div>
  )
}
