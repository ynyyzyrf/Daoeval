import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

/* ---------------- 圖示 ---------------- */
const ICONS: Record<string, ReactNode> = {
  overview: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  agents: (
    <>
      <rect x="4" y="6" width="16" height="12" rx="3" />
      <circle cx="9" cy="12" r="1.2" />
      <circle cx="15" cy="12" r="1.2" />
    </>
  ),
  testsets: (
    <>
      <path d="M5 4h11l3 3v13H5z" />
      <path d="M9 10h6M9 14h6M9 18h4" />
    </>
  ),
  experiments: (
    <>
      <path d="M9 3h6" />
      <path d="M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3" />
      <path d="M8 15h8" />
    </>
  ),
  report: (
    <>
      <path d="M4 20V6a2 2 0 0 1 2-2h9l5 5v11" />
      <path d="M8 13h4M8 17h7" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" />
    </>
  ),
  empty: (
    <>
      <rect x="4" y="7" width="16" height="12" rx="2" />
      <path d="M8 7V5h8v2" />
    </>
  ),
  error: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v6M12 16.5v.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  history: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" />
    </>
  ),
  share: (
    <>
      <path d="M8 12h8M12 8l4 4-4 4" />
      <path d="M4 6v12h16V6" />
    </>
  ),
  more: (
    <>
      <circle cx="6" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="18" cy="12" r="1" />
    </>
  ),
  export: (
    <>
      <path d="M12 16V5M8 9l4-4 4 4" />
      <path d="M5 17v2h14v-2" />
    </>
  ),
  chevron: <path d="m7 10 5 5 5-5" />,
  collapse: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M15 10l-2 2 2 2" />
    </>
  ),
  expand: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M13 10l2 2-2 2" />
    </>
  ),
  filter: <path d="M4 6h16M7 12h10M10 18h4" />,
  star: <path d="m12 4 2.4 5 5.6.8-4 4 1 5.6-5-2.7-5 2.7 1-5.6-4-4 5.6-.8z" />,
}

export function Icon({ name, size = 16 }: { name: keyof typeof ICONS | string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name] ?? null}
    </svg>
  )
}

/* ---------------- 按鈕（六態） ---------------- */
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'icon'
  size?: 'md' | 'sm'
  loading?: boolean
  loadingLabel?: string
  children: ReactNode
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  loadingLabel = '處理中…',
  children,
  className = '',
  disabled,
  ...rest
}: ButtonProps) {
  const variantClass =
    variant === 'primary'
      ? 'btn-primary'
      : variant === 'ghost'
        ? 'btn-ghost'
        : variant === 'danger'
          ? 'btn-danger'
          : variant === 'icon'
            ? 'btn-icon'
            : ''
  return (
    <button
      className={`btn ${variantClass} ${size === 'sm' ? 'btn-sm' : ''} ${loading ? 'loading' : ''} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      <span className="btn-label">{children}</span>
      {loading && <span className="btn-spinner" aria-hidden="true" />}
      {loading && <span className="sr-only">{loadingLabel}</span>}
    </button>
  )
}

/* ---------------- 徽章 ---------------- */
export function Badge({ tone = 'muted', children }: { tone?: 'ok' | 'warn' | 'err' | 'info' | 'muted' | 'accent'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>
}

/* ---------------- 標題（輕重並置） ---------------- */
export function PageTitle({ lead, strong, sub }: { lead: string; strong?: string; sub?: ReactNode }) {
  return (
    <div>
      <div className="page-title-row">
        <h1 className="page-title">
          {lead}
          {strong ? <> <b>{strong}</b></> : null}
        </h1>
      </div>
      {sub ? <p className="page-sub">{sub}</p> : null}
    </div>
  )
}

/* ---------------- 統計帶 ---------------- */
export function StatBand({
  items,
}: {
  items: Array<{ label: string; value: ReactNode; unit?: string; word?: boolean; neg?: boolean }>
}) {
  return (
    <div className="stats">
      {items.map((item) => (
        <div className="stat" key={item.label}>
          <span className="stat-label">{item.label}</span>
          <b className={`stat-value ${item.word ? 'word' : ''} ${item.neg ? 'neg' : ''}`}>
            {item.value}
            {item.unit ? <em>{item.unit}</em> : null}
          </b>
        </div>
      ))}
    </div>
  )
}

/* ---------------- 狀態點 / 快捷鍵 ---------------- */
export function Dot({ tone = 'dim' }: { tone?: 'ok' | 'warn' | 'err' | 'dim' | 'acc' }) {
  return <span className={`dot dot-${tone}`} aria-hidden="true" />
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>
}

/* ---------------- 表單欄位 ---------------- */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string
  children: ReactNode
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  )
}

/* ---------------- 卡片 ---------------- */
export function Card({
  title,
  subtitle,
  actions,
  children,
}: {
  title?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  children?: ReactNode
}) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <div className="card-title">{title}</div>}
            {subtitle && <div className="card-sub">{subtitle}</div>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

/* ---------------- 提示塊 ---------------- */
export function Notice({ tone = 'info', children }: { tone?: 'warn' | 'info' | 'err'; children: ReactNode }) {
  return <div className={`notice notice-${tone}`}>{children}</div>
}

/* ---------------- 麵包屑 ---------------- */
export function Breadcrumb({ items }: { items: Array<{ label: string; onClick?: () => void }> }) {
  return (
    <nav className="breadcrumb" aria-label="麵包屑">
      {items.map((item, index) => (
        <span key={`${item.label}-${index}`} className="row-tight">
          {index > 0 && <span className="sep">/</span>}
          {item.onClick ? (
            <button type="button" onClick={item.onClick}>
              {item.label}
            </button>
          ) : (
            <span>{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  )
}

/* ---------------- 步驟條 ---------------- */
export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div className="stepper">
      {steps.map((label, index) => (
        <span key={label} className="row-tight">
          {index > 0 && <span className="step-line" />}
          <span className={`step ${index === current ? 'active' : ''} ${index < current ? 'done' : ''}`}>
            <span className="step-dot">{index < current ? '✓' : index + 1}</span>
            {label}
          </span>
        </span>
      ))}
    </div>
  )
}

/* ---------------- 抽屜 ---------------- */
export function Drawer({
  title,
  onClose,
  children,
  footer,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRef.current() }
      if (e.key === 'Tab') {
        const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? []).filter((element) => element.getClientRects().length > 0)
        const first = controls[0]
        const last = controls[controls.length - 1]
        if (!first) { e.preventDefault(); dialogRef.current?.focus(); return }
        if (e.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) { e.preventDefault(); last?.focus() }
        else if (!e.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) { e.preventDefault(); first.focus() }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      queueMicrotask(() => { if (previous?.isConnected) previous.focus(); else document.querySelector<HTMLElement>('main button')?.focus() })
    }
  }, [])

  // 開啟時焦點進第一個欄位，鍵盤操作不用先 Tab 一輪
  useEffect(() => {
    const first = bodyRef.current?.querySelector<HTMLElement>('input, select, textarea')
    first?.focus()
  }, [])

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="drawer" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}>
        <div className="drawer-head spread">
          <div className="card-title">{title}</div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="關閉">
            ✕
          </Button>
        </div>
        <div className="drawer-body" ref={bodyRef}>{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </div>
    </div>
  )
}

/* ---------------- 骨架屏 ---------------- */
export function useDelayedLoading(loading: boolean, delay = 400): boolean {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!loading) {
      setVisible(false)
      return
    }
    const timer = setTimeout(() => setVisible(true), delay)
    return () => clearTimeout(timer)
  }, [loading, delay])
  return visible
}

export function SkeletonBlock({ height = 16, width = '100%' }: { height?: number; width?: string }) {
  return <span className="skeleton" style={{ display: 'block', height, width }} />
}

export function SkeletonRows({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r} className="skeleton-row">
          {Array.from({ length: cols }).map((__, c) => (
            <td key={c}>
              <span className="skeleton skeleton-line" style={{ display: 'block', width: `${60 + ((r + c) % 3) * 12}%` }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}

/* ---------------- 空 / 錯 ---------------- */
export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="state">
      <Icon name="empty" size={32} />
      <div className="state-title">{title}</div>
      {description && <div className="state-desc">{description}</div>}
      {action}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state">
      <Icon name="error" size={32} />
      <div className="state-title">載入失敗</div>
      <div className="state-desc">{message}</div>
      {onRetry && <Button onClick={onRetry}>重試</Button>}
    </div>
  )
}

/* ---------------- Toast ---------------- */
type ToastItem = { id: number; tone: 'success' | 'error'; text: string }

const ToastContext = createContext<{ push: (tone: 'success' | 'error', text: string) => void }>({
  push: () => undefined,
})

export function useToast() {
  return useContext(ToastContext)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const counter = useRef(0)

  const remove = useCallback((id: number) => {
    setItems((list) => list.filter((item) => item.id !== id))
  }, [])

  const push = useCallback(
    (tone: 'success' | 'error', text: string) => {
      counter.current += 1
      const id = counter.current
      setItems((list) => [...list, { id, tone, text }])
      setTimeout(() => remove(id), tone === 'success' ? 2500 : 8000)
    },
    [remove],
  )

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`toast ${item.tone}`}>
            <span>{item.text}</span>
            <button type="button" onClick={() => remove(item.id)} aria-label="關閉提示">
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

/* ---------------- 進度 ---------------- */
export function Progress({ value }: { value: number }) {
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)}>
      <div className="progress-bar" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  )
}
