import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type ExperimentSummary } from './api.ts'
import { Badge, Button, Icon, Kbd } from './components/ui.tsx'
import { ShareDialog } from './components/ShareDialog.tsx'
import { navigate, useRoute, type Route } from './lib/router.ts'
import { AgentDetailPage, AgentWizardPage, AgentsListPage } from './pages/agents.tsx'
import { ExperimentsListPage, ExperimentDetailPage } from './pages/experiments.tsx'
import { OverviewPage } from './pages/overview.tsx'
import { ReportDetailPage, ReportListPage } from './pages/report.tsx'
import { SettingsPage } from './pages/settings.tsx'
import { ModelsPage } from './pages/models.tsx'
import { TestSetDetailPage, TestSetsListPage } from './pages/testsets.tsx'
import { useAuth } from './components/AuthGate.tsx'

interface Hit {
  kind: string
  label: string
  path: string
}

function statusDot(status: string): string {
  if (status === 'completed') return 'dot-ok'
  if (status === 'partial_failed' || status === 'failed') return 'dot-warn'
  return 'dot-dim'
}

const STATUS_LABELS: Record<string, string> = {
  ready: '待執行',
  running: '執行中',
  completed: '已完成',
  partial_failed: '部分失敗',
  failed: '失敗',
  canceled: '已取消',
  interrupted: '已中斷',
}

function statusLabel(status: string): string {
  // 未知狀態不要冒充「執行中」，寧可顯示原始值
  return STATUS_LABELS[status] ?? (status || '未知')
}

function activeKey(route: Route): string {
  if (route.name.startsWith('agent')) return 'agents'
  if (route.name.startsWith('testset')) return 'testsets'
  if (route.name.startsWith('experiment')) return 'experiments'
  if (route.name.startsWith('report')) return 'report'
  if (route.name === 'settings') return 'settings'
  if (route.name === 'models') return 'models'
  return 'overview'
}

function crumbs(route: Route, entityName: string | null): Array<{ label: string; onClick?: () => void }> {
  const home = { label: '工作區', onClick: () => navigate('/') }
  const loading = entityName ?? '載入中'
  switch (route.name) {
    case 'agents':
      return [home, { label: 'Agent' }]
    case 'agent-new':
      return [home, { label: 'Agent', onClick: () => navigate('/agents') }, { label: '接入' }]
    case 'agent-version':
      return [home, { label: 'Agent', onClick: () => navigate('/agents') }, { label: '新增版本' }]
    case 'agent-detail':
      return [home, { label: 'Agent', onClick: () => navigate('/agents') }, { label: loading }]
    case 'testsets':
      return [home, { label: '測試集' }]
    case 'testset-detail':
      return [home, { label: '測試集', onClick: () => navigate('/testsets') }, { label: loading }]
    case 'experiments':
      return [home, { label: '實驗' }]
    case 'experiment-detail':
      return [home, { label: '實驗', onClick: () => navigate('/experiments') }, { label: loading }]
    case 'report':
      return [home, { label: '報告' }]
    case 'report-detail':
      return [home, { label: '報告', onClick: () => navigate('/report') }, { label: loading }]
    case 'settings':
      return [home, { label: '操作審計' }]
    case 'models':
      return [home, { label: '評估模型' }]
    default:
      return [home, { label: '概覽' }]
  }
}

const LIST_ROUTES = ['overview', 'agents', 'testsets', 'experiments', 'report', 'models', 'settings']

function CommandPalette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [loaded, setLoaded] = useState<Hit[]>([])
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    Promise.all([api.agents(), api.testSets(), api.experiments()])
      .then(([agents, sets, experiments]) => {
        setLoaded([
          { kind: '跳轉', label: '概覽', path: '/' },
          { kind: '跳轉', label: 'Agent 列表', path: '/agents' },
          { kind: '跳轉', label: '測試集列表', path: '/testsets' },
          { kind: '跳轉', label: '實驗列表', path: '/experiments' },
          { kind: '跳轉', label: '報告列表', path: '/report' },
          { kind: '跳轉', label: '操作審計', path: '/settings' },
          { kind: '跳轉', label: '評估模型', path: '/models' },
          ...agents.map((a) => ({ kind: 'Agent', label: a.name, path: `/agents/${a.id}` })),
          ...sets.map((s) => ({ kind: '測試集', label: s.name, path: `/testsets/${s.id}` })),
          ...experiments.map((e) => ({ kind: '實驗', label: e.name, path: `/experiments/${e.id}` })),
        ])
      })
      .catch(() => setLoaded([]))
  }, [])

  const hits = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return loaded.slice(0, 8)
    return loaded.filter((hit) => hit.label.toLowerCase().includes(q)).slice(0, 10)
  }, [query, loaded])

  useEffect(() => setActive(0), [query])

  const choose = (hit: Hit | undefined) => {
    if (!hit) return
    navigate(hit.path)
    onClose()
  }

  return (
    <div className="palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="指令面板">
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="搜尋 Agent、測試集、實驗，或輸入頁面名稱"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((i) => Math.min(hits.length - 1, i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) => Math.max(0, i - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              choose(hits[active])
            } else if (e.key === 'Escape') {
              onClose()
            }
          }}
        />
        <div className="palette-list">
          {hits.length === 0 && <div className="dim sm" style={{ padding: 10 }}>沒有符合的結果</div>}
          {hits.map((hit, index) => (
            <button
              key={`${hit.kind}-${hit.path}`}
              type="button"
              className={`palette-item ${index === active ? 'active' : ''}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(hit)}
            >
              <span>{hit.label}</span>
              <span className="kind">{hit.kind}</span>
            </button>
          ))}
        </div>
        <div className="palette-foot">
          <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> 選擇</span>
          <span><Kbd>↵</Kbd> 開啟</span>
          <span><Kbd>esc</Kbd> 關閉</span>
        </div>
      </div>
    </div>
  )
}

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case 'overview':
      return <OverviewPage />
    case 'agents':
      return <AgentsListPage />
    case 'agent-new':
      return <AgentWizardPage />
    case 'agent-version':
      return <AgentWizardPage agentId={route.id} />
    case 'agent-detail':
      return <AgentDetailPage id={route.id} />
    case 'testsets':
      return <TestSetsListPage />
    case 'testset-detail':
      return <TestSetDetailPage id={route.id} />
    case 'experiments':
      return <ExperimentsListPage />
    case 'experiment-detail':
      return <ExperimentDetailPage id={route.id} />
    case 'report':
      return <ReportListPage />
    case 'report-detail':
      return <ReportDetailPage id={route.id} trialId={route.trialId} />
    case 'settings':
      return <SettingsPage />
    case 'models':
      return <ModelsPage />
    default:
      return null
  }
}

const PAGE_NAMES: Record<string, string> = {
  overview: '概覽',
  agents: 'Agent',
  testsets: '測試集',
  experiments: '實驗',
  report: '報告',
  settings: '操作審計',
  models: '評估模型',
}

function pageName(key: string): string {
  return PAGE_NAMES[key] ?? '概覽'
}

export function App() {
  const auth = useAuth()
  const route = useRoute()
  const current = activeKey(route)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [recent, setRecent] = useState<ExperimentSummary[]>([])
  const [reportMeta, setReportMeta] = useState<{ name: string; failed: boolean } | null>(null)
  const [entityName, setEntityName] = useState<string | null>(null)
  const [sidebarPref, setSidebarPref] = useState<'collapsed' | 'expanded' | null>(() => {
    const saved = window.localStorage.getItem('daoeval.sidebar')
    return saved === 'collapsed' || saved === 'expanded' ? saved : null
  })
  const routeRef = useRef(route)
  routeRef.current = route
  const workbench = route.name === 'report-detail'

  // 頂欄、側欄與 ⌘N 共用：不在實驗列表頁時先跳過去，再開新建抽屜；
  // 只發事件的話詳情頁與其他頁面沒有任何監聽者，按了等於沒反應。
  const openNewExperiment = () => {
    const openNew = () => window.dispatchEvent(new CustomEvent('aeval:new'))
    if (routeRef.current.name === 'experiments') openNew()
    else {
      navigate('/experiments')
      window.setTimeout(openNew, 150)
    }
  }

  const toggleSidebar = () => {
    // 以「目前看到的状态」為準切換，否則窄螢幕自動收起時第一次點擊會沒反應
    const next = sidebarCollapsed ? 'expanded' : 'collapsed'
    setSidebarPref(next)
    window.localStorage.setItem('daoeval.sidebar', next)
  }

  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 900px)').matches)
  useEffect(() => {
    const query = window.matchMedia('(max-width: 900px)')
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  // 使用者的手動選擇優先；沒選過時窄螢幕自動收成 icon rail
  const sidebarCollapsed = sidebarPref === null ? narrow : sidebarPref === 'collapsed'

  useEffect(() => {
    let disposed = false
    let refreshing = false
    const refresh = async () => {
      if (refreshing || document.visibilityState === 'hidden') return
      refreshing = true
      try {
        const list = await api.recentExperiments()
        if (!disposed) setRecent(list)
      } catch {
        // 暫時連線失敗時保留最近一次成功取得的列表。
      } finally {
        refreshing = false
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    window.addEventListener('aeval:archive-changed', refresh)
    window.addEventListener('aeval:experiments-changed', refresh)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      disposed = true
      window.clearInterval(timer)
      window.removeEventListener('aeval:archive-changed', refresh)
      window.removeEventListener('aeval:experiments-changed', refresh)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [route.name])

  // 麵包屑最後一層是實體名稱，不是「詳情」
  useEffect(() => {
    setEntityName(null)
    if (route.name === 'testset-detail') {
      api.testSetDetail(route.id).then((set) => setEntityName(set.name)).catch(() => setEntityName(null))
    } else if (route.name === 'agent-detail') {
      api.agentDetail(route.id).then((detail) => setEntityName(detail.config.name)).catch(() => setEntityName(null))
    } else if (route.name === 'experiment-detail' || route.name === 'report-detail') {
      api.experiment(route.id).then((detail) => setEntityName(detail.name)).catch(() => setEntityName(null))
    }
  }, [route])

  useEffect(() => {
    if (route.name !== 'report-detail') {
      setReportMeta(null)
      return
    }
    api
      .experiment(route.id)
      .then((detail) =>
        setReportMeta({
          name: detail.name,
          failed: detail.trials.some((t) => t.status === 'failed'),
        }),
      )
      .catch(() => setReportMeta(null))
  }, [route])

  useEffect(() => {
    setShareOpen(false)
  }, [route])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((open) => !open)
      } else if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        openNewExperiment()
      } else if (mod && e.key === 'Enter') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('aeval:run'))
      } else if (e.key === 'Escape') {
        setPaletteOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const breadcrumb = crumbs(route, entityName)
  const isListPage = LIST_ROUTES.includes(route.name)

  const navButton = (key: string, label: string, path: string, icon: string, shortcut?: string) => (
    <button
      type="button"
      className={`nav-item ${current === key ? 'active' : ''}`}
      aria-current={current === key ? 'page' : undefined}
      onClick={() => navigate(path)}
    >
      <Icon name={icon} size={16} />
      <span className="nav-label" title={label}>{label}</span>
      {shortcut && <Kbd>{shortcut}</Kbd>}
    </button>
  )

  return (
    <div className={`shell ${sidebarCollapsed ? 'side-collapsed' : 'side-expanded'} ${narrow ? 'narrow' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">DE</span>
          <span className="brand-title">Daoeval</span>
          <button
            type="button"
            className="sidebar-toggle"
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? '展開側邊欄' : '收起側邊欄'}
            aria-expanded={!sidebarCollapsed}
            title={sidebarCollapsed ? '展開側邊欄' : '收起側邊欄'}
          >
            <Icon name={sidebarCollapsed ? 'expand' : 'collapse'} size={15} />
          </button>
        </div>

        <button type="button" className="new-item" onClick={openNewExperiment} title="新建實驗">
          <Icon name="plus" size={14} /> <span className="new-label">新建實驗</span>
          <Kbd>⌘N</Kbd>
        </button>

        <nav className="nav" aria-label="主導航">
          {navButton('overview', '概覽', '/', 'overview')}
          {navButton('agents', 'Agent', '/agents', 'agents')}
          {navButton('testsets', '測試集', '/testsets', 'testsets')}
          {navButton('experiments', '實驗', '/experiments', 'experiments')}
          {navButton('report', '報告', '/report', 'report')}
          {navButton('models', '評估模型', '/models', 'star')}
          {navButton('settings', '操作審計', '/settings', 'settings')}

          {recent.length > 0 && (
            <>
              <div className="nav-group">最近實驗</div>
              {recent.map((exp) => (
                <button
                  key={exp.id}
                  type="button"
                  className={`nav-item exp-item ${route.name === 'experiment-detail' && route.id === exp.id ? 'active-soft' : ''}`}
                  onClick={() => navigate(`/experiments/${exp.id}`)}
                  title={exp.name}
                >
                  <span className={`nav-dot ${statusDot(exp.status)}`} />
                  <span className="ellipsis nav-label" title={exp.name}>{exp.name}</span>
                  <span className="nav-status">{statusLabel(exp.status)}</span>
                </button>
              ))}
            </>
          )}
        </nav>

        <div className="sidebar-foot">
          <span className="version">V2.0</span>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="crumb">
            {isListPage ? (
              <span className="topbar-page">{pageName(current)}</span>
            ) : (
              <div className="breadcrumb">
                {breadcrumb.slice(1).map((item, index) => (
                  <span key={`${item.label}-${index}`} className="row-tight">
                    {index > 0 && <span className="sep">/</span>}
                    {item.onClick ? (
                      <button type="button" onClick={item.onClick}>
                        {item.label}
                      </button>
                    ) : (
                      <span className="current" style={{ maxWidth: 360 }}>
                        {item.label}
                      </span>
                    )}
                  </span>
                ))}
              </div>
            )}
            {reportMeta && <Badge tone={reportMeta.failed ? 'warn' : 'ok'}>{reportMeta.failed ? '部分失敗' : '已完成'}</Badge>}
          </div>
          <div className="topbar-actions">
            <Button size="sm" onClick={() => void auth.logout()} title={auth.username}>登出</Button>
            <div className="topbar-action-group">
              <Button variant="icon" onClick={() => setPaletteOpen(true)} aria-label="搜尋">
                <Icon name="search" size={15} />
              </Button>
              <Button variant="icon" aria-label="更多">
                <Icon name="more" size={15} />
              </Button>
              {route.name === 'report-detail' && (
                <Button onClick={() => setShareOpen(true)}>
                  <Icon name="share" size={14} /> 分享
                </Button>
              )}
            </div>
            {workbench ? null : route.name !== 'models' ? (
              <Button variant="primary" onClick={openNewExperiment}>
                新建
              </Button>
            ) : null}
          </div>
        </header>

        <main className={workbench ? 'content workbench' : 'content'}>
          {workbench ? <Page route={route} /> : <div className="content-inner"><Page route={route} /></div>}
        </main>
      </div>

      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
      {shareOpen && route.name === 'report-detail' && (
        <ShareDialog
          experimentId={route.id}
          experimentName={reportMeta?.name ?? '這份報告'}
          onClose={() => setShareOpen(false)}
        />
      )}
    </div>
  )
}
