import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, EmptyState, ErrorState, SkeletonRows, useDelayedLoading } from './ui.tsx'

export interface Column<T> {
  key: string
  title: string
  render: (row: T) => ReactNode
  sortValue?: (row: T) => string | number
  align?: 'left' | 'right'
}

export interface FilterDef<T> {
  key: string
  label: string
  options: Array<{ value: string; label: string }>
  match: (row: T, value: string) => boolean
}

interface Props<T> {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
  searchText: (row: T) => string
  searchPlaceholder?: string
  filters?: Array<FilterDef<T>>
  pageSize?: number
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  onRowClick?: (row: T) => void
  emptyTitle?: string
  emptyDescription?: string
  emptyAction?: ReactNode
  toolbarExtra?: ReactNode
  selectedIds?: string[]
  highlightedId?: string | null
  onToggleSelect?: (id: string, checked: boolean) => void
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  searchText,
  searchPlaceholder = '搜尋…',
  filters = [],
  pageSize = 20,
  loading = false,
  error = null,
  onRetry,
  onRowClick,
  emptyTitle = '沒有資料',
  emptyDescription,
  emptyAction,
  toolbarExtra,
  selectedIds,
  highlightedId = null,
  onToggleSelect,
}: Props<T>) {
  const [query, setQuery] = useState('')
  const [filterValues, setFilterValues] = useState<Record<string, string>>({})
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null)
  const [page, setPage] = useState(1)

  const showSkeleton = useDelayedLoading(loading)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((row) => {
      if (q && !searchText(row).toLowerCase().includes(q)) return false
      for (const filter of filters) {
        const value = filterValues[filter.key]
        if (value && !filter.match(row, value)) return false
      }
      return true
    })
  }, [rows, query, filters, filterValues, searchText])

  const sorted = useMemo(() => {
    if (!sort) return filtered
    const column = columns.find((c) => c.key === sort.key)
    if (!column?.sortValue) return filtered
    const copy = [...filtered]
    copy.sort((a, b) => {
      const av = column.sortValue!(a)
      const bv = column.sortValue!(b)
      if (av === bv) return 0
      return (av > bv ? 1 : -1) * (sort.dir === 'asc' ? 1 : -1)
    })
    return copy
  }, [filtered, sort, columns])

  useEffect(() => {
    setPage(1)
  }, [query, filterValues, sort])

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const pageRows = sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  const selectionEnabled = Boolean(onToggleSelect)
  const allPageSelected = selectionEnabled && pageRows.length > 0 && pageRows.every((r) => (selectedIds ?? []).includes(rowKey(r)))

  const toggleSort = (key: string) => {
    setSort((prev) => {
      if (prev?.key !== key) return { key, dir: 'asc' }
      if (prev.dir === 'asc') return { key, dir: 'desc' }
      return null
    })
  }

  const body = (() => {
    if (error) {
      return (
        <tr>
          <td colSpan={columns.length + (selectionEnabled ? 1 : 0)}>
            <ErrorState message={error} onRetry={onRetry} />
          </td>
        </tr>
      )
    }
    if (showSkeleton) return <SkeletonRows rows={Math.min(pageSize, 6)} cols={columns.length + (selectionEnabled ? 1 : 0)} />
    if (pageRows.length === 0) {
      return (
        <tr>
          <td colSpan={columns.length + (selectionEnabled ? 1 : 0)}>
            <EmptyState
              title={query || Object.values(filterValues).some(Boolean) ? '沒有符合條件的結果' : emptyTitle}
              description={emptyDescription}
              action={query || Object.values(filterValues).some(Boolean) ? undefined : emptyAction}
            />
          </td>
        </tr>
      )
    }
    return pageRows.map((row) => {
      const id = rowKey(row)
      const selected = (selectedIds ?? []).includes(id)
      return (
        <tr key={id} className={`${onRowClick ? 'clickable' : ''} ${selected ? 'selected' : ''} ${highlightedId === id ? 'row-highlight' : ''}`} onClick={onRowClick ? () => onRowClick(row) : undefined}>
          {selectionEnabled && (
            <td onClick={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={selected}
                aria-label="選取此行"
                onChange={(e) => onToggleSelect?.(id, e.target.checked)}
              />
            </td>
          )}
          {columns.map((column) => (
            <td key={column.key} className={`${column.key === 'description' ? 'description' : ''} ${column.align === 'right' ? 'right numeric' : ''}`.trim() || undefined}>
              {column.render(row)}
            </td>
          ))}
        </tr>
      )
    })
  })()

  return (
    <div className="table-wrap">
      <div className="table-toolbar">
        <input
          className="grow"
          placeholder={searchPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={searchPlaceholder}
        />
        {filters.map((filter) => (
          <select
            key={filter.key}
            value={filterValues[filter.key] ?? ''}
            aria-label={filter.label}
            onChange={(e) => setFilterValues((prev) => ({ ...prev, [filter.key]: e.target.value }))}
          >
            <option value="">{filter.label}：全部</option>
            {filter.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ))}
        {toolbarExtra}
      </div>

      <table className="data">
        <thead>
          <tr>
            {selectionEnabled && (
              <th style={{ width: 40 }}>
                <input
                  type="checkbox"
                  checked={allPageSelected}
                  aria-label="選取本頁"
                  onChange={(e) => {
                    for (const row of pageRows) onToggleSelect?.(rowKey(row), e.target.checked)
                  }}
                />
              </th>
            )}
            {columns.map((column) => (
              <th
                key={column.key}
                className={`${column.sortValue ? 'sortable' : ''} ${column.align === 'right' ? 'right numeric' : ''}`}
                onClick={column.sortValue ? () => toggleSort(column.key) : undefined}
              >
                {column.title}
                {sort?.key === column.key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{body}</tbody>
      </table>

      <div className="pager">
        <span>
          共 {sorted.length} 條 · 第 {currentPage} / {totalPages} 頁
        </span>
        <span className="pager-buttons">
          <Button size="sm" onClick={() => setPage(1)} disabled={currentPage <= 1}>
            首頁
          </Button>
          <Button size="sm" onClick={() => setPage(currentPage - 1)} disabled={currentPage <= 1}>
            上一頁
          </Button>
          <Button size="sm" onClick={() => setPage(currentPage + 1)} disabled={currentPage >= totalPages}>
            下一頁
          </Button>
          <Button size="sm" onClick={() => setPage(totalPages)} disabled={currentPage >= totalPages}>
            末頁
          </Button>
        </span>
      </div>
    </div>
  )
}
