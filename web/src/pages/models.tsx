import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api } from '../api.ts'
import type { JudgeModelProfile, JudgeSettings } from '../../../src/shared/ai-evaluation.ts'
import { Badge, Button, Card, Drawer, Field, Icon, Notice, PageTitle, useToast } from '../components/ui.tsx'

type Draft = { name: string; model: string; endpoint: string }
const blank: Draft = { name: '', model: '', endpoint: '' }
const deepseek: Draft = { name: 'DeepSeek', model: 'deepseek-flash', endpoint: 'https://api.deepseek.com/chat/completions' }

function ModelEditor({ profile, onClose, onSaved }: {
  profile: JudgeModelProfile | null; onClose: () => void; onSaved: (value: JudgeSettings) => void
}) {
  const original = profile ? { name: profile.name, model: profile.model, endpoint: profile.endpoint } : blank
  const [draft, setDraft] = useState<Draft>(original)
  const [provider, setProvider] = useState<'custom' | 'deepseek'>('custom')
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<{ type: 'close' } | { type: 'provider'; provider: 'custom' | 'deepseek' } | null>(null)
  const continueRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (pending) continueRef.current?.focus() }, [pending])
  const dirty = Boolean(key) || Object.keys(original).some((field) => draft[field as keyof Draft] !== original[field as keyof Draft])
  const valid = draft.name.trim() && draft.model.trim() && draft.endpoint.trim() && (profile || key.trim())
  function close() {
    if (saving) return
    if (pending) { setPending(null); return }
    if (dirty) setPending({ type: 'close' })
    else onClose()
  }
  function applyProvider(next: 'custom' | 'deepseek') { setProvider(next); setDraft(next === 'deepseek' ? deepseek : blank); setKey(''); setError(''); setPending(null) }
  function chooseProvider(next: 'custom' | 'deepseek') {
    if (next === provider) return
    if (dirty) setPending({ type: 'provider', provider: next })
    else applyProvider(next)
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (saving || !valid || pending) return
    setSaving(true); setError('')
    try {
      const value = await api.saveJudgeModel(profile?.id ?? null, { name: draft.name.trim(), model: draft.model.trim(), endpoint: draft.endpoint.trim(), apiKey: key.trim() || undefined })
      setKey(''); onSaved(value)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '儲存失敗，請重試') }
    finally { setSaving(false) }
  }
  return <Drawer title={profile ? '編輯評估模型' : '添加評估模型'} onClose={close} footer={<>
    {pending ? <>
      <button type="button" className="btn" ref={continueRef} onClick={() => setPending(null)}>繼續編輯</button>
      <Button variant="danger" onClick={() => pending.type === 'close' ? onClose() : applyProvider(pending.provider)}>放棄變更</Button>
    </> : <>
      <Button disabled={saving} onClick={close}>取消</Button>
      <Button variant="primary" type="submit" form="model-editor-form" loading={saving} disabled={!valid || !dirty}>儲存模型</Button>
    </>}
  </>}>
    {pending && <div role="alert"><Notice tone="warn">尚有未儲存的變更。{pending.type === 'close' ? '放棄後將關閉此表單。' : '切換連線方式會清空這些內容。'}</Notice></div>}
    <p className="muted sm">{profile ? '更新模型資訊或連線憑證。' : '接入模型服務，供 AI 回答評估使用。'}</p>
    <form id="model-editor-form" onSubmit={(event) => void save(event)} className="model-editor-form">
      {!profile && <fieldset className="model-provider-fieldset" disabled={saving}>
        <legend>連線方式</legend>
        <div className="model-provider-options">
          <button type="button" aria-pressed={provider === 'custom'} onClick={() => chooseProvider('custom')}><strong>自定義服務</strong><span>OpenAI 相容接口</span></button>
          <button type="button" aria-pressed={provider === 'deepseek'} onClick={() => chooseProvider('deepseek')}><strong>DeepSeek</strong><span>使用官方服務地址</span></button>
        </div>
      </fieldset>}
      <div className="model-form-section">
        <h3>模型資訊</h3>
        <Field label="顯示名稱"><input name="name" required maxLength={100} placeholder="例如：客服評估模型" value={draft.name} disabled={saving} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
        <Field label="模型 ID" hint="填寫模型服務提供的 ID。"><input name="model" required maxLength={200} placeholder="例如：deepseek-flash" value={draft.model} disabled={saving} onChange={(event) => setDraft({ ...draft, model: event.target.value })} /></Field>
      </div>
      <div className="model-form-section">
        <h3>連線設定</h3>
        <Field label="API 地址" hint="支援基礎地址或完整的 /chat/completions 地址。"><input name="endpoint" type="url" required maxLength={2000} placeholder="https://your-provider.com/v1" value={draft.endpoint} disabled={saving} onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })} /></Field>
        <Field label="API Key" hint={profile ? `已儲存 ${profile.keyMask}。留空保留，變更地址時請重新填寫。` : '加密保存，僅用於連接此模型服務。'}><input name="apiKey" type="password" required={!profile} maxLength={1000} autoComplete="new-password" placeholder={profile ? '留空以保留現有 Key' : '輸入 API Key'} value={key} disabled={saving} onChange={(event) => setKey(event.target.value)} /></Field>
      </div>
      <details className="model-advanced"><summary>相容性與資料使用</summary><p>服務需支援 Chat Completions 與 JSON 輸出。評估時會傳送問題、參考回答與實際回答，可能產生用量費用。儲存後可在列表測試連線。</p></details>
      {error && <div role="alert"><Notice tone="err">{error}</Notice></div>}
    </form>
  </Drawer>
}

export function ModelsPage() {
  const [settings, setSettings] = useState<JudgeSettings | null>(null)
  const [error, setError] = useState('')
  const [editor, setEditor] = useState<{ profile: JudgeModelProfile | null } | null>(null)
  const [query, setQuery] = useState('')
  const [operation, setOperation] = useState<{ id: string; type: 'test' | 'activate' } | null>(null)
  const [tested, setTested] = useState<Record<string, 'ok' | 'failed'>>({})
  const toast = useToast()
  useEffect(() => {
    let alive = true
    api.judgeSettings().then((value) => { if (alive) setSettings(value) }).catch((reason: Error) => { if (alive) setError(reason.message) })
    return () => { alive = false }
  }, [])
  const profiles = settings?.profiles ?? []
  const active = profiles.find((profile) => profile.id === settings?.activeProfileId)
  const visible = profiles.filter((profile) => `${profile.name} ${profile.model}`.toLowerCase().includes(query.toLowerCase()))
  async function operate(profile: JudgeModelProfile, type: 'test' | 'activate') {
    if (operation) return
    setOperation({ id: profile.id, type }); setError('')
    try {
      if (type === 'activate') { setSettings(await api.activateJudgeModel(profile.id)); toast.push('success', `已將 ${profile.name} 設為預設模型`) }
      else { await api.testJudge(profile.id); setTested((values) => ({ ...values, [profile.id]: 'ok' })); toast.push('success', `${profile.name} 連線測試通過`) }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '操作失敗，請重試'
      setError(`${profile.name}：${message}`)
      if (type === 'test') setTested((values) => ({ ...values, [profile.id]: 'failed' }))
    } finally { setOperation(null) }
  }
  function saved(value: JudgeSettings) {
    const changedId = editor?.profile?.id
    if (changedId) setTested((values) => { const next = { ...values }; delete next[changedId]; return next })
    setSettings(value); setEditor(null); setError(''); setQuery(''); toast.push('success', '模型已儲存，可在列表中測試連線')
  }
  return <div className="stack page-stack models-page">
    <div className="page-head model-page-head">
      <PageTitle lead="評估模型" sub="管理用於 AI 回答評估的模型連線。" />
      {profiles.length > 0 && <Button variant="primary" disabled={Boolean(operation)} onClick={() => setEditor({ profile: null })}><Icon name="plus" size={14} />添加模型</Button>}
    </div>
    {error && <div role="alert"><Notice tone="err">{error}</Notice>{!settings && <Button onClick={() => window.location.reload()}>重新載入</Button>}</div>}
    {!settings && !error && <Card title="評估模型"><p className="muted" role="status">正在載入模型…</p></Card>}
    {settings && profiles.length === 0 && <section className="model-empty" aria-labelledby="model-empty-title">
      <div className="model-empty-icon"><Icon name="agents" size={28} /></div>
      <h2 id="model-empty-title">接入第一個評估模型</h2>
      <p>連接 DeepSeek 或自定義模型服務，<br />讓 AI 比較參考回答與實際回答。</p>
      <Button variant="primary" onClick={() => setEditor({ profile: null })}><Icon name="plus" size={14} />添加模型</Button>
      <span className="sm muted">支援 OpenAI 相容接口 · API Key 加密保存</span>
    </section>}
    {profiles.length > 0 && <>
      {active && <section className="model-default" aria-label="預設評估模型">
        <div className="model-default-icon"><Icon name="star" size={18} /></div>
        <div className="model-default-copy"><span className="sm muted">預設評估模型</span><div><strong>{active.name}</strong><span className="mono muted">{active.model}</span></div></div>
        <p className="sm muted">用於新開始的 AI 回答評估。<br />切換不影響已有批次。</p>
      </section>}
      <section className="model-list-panel" aria-label="已接入的模型">
        <div className="model-list-toolbar"><strong>全部模型 <span className="muted">{profiles.length}</span></strong><input type="search" aria-label="搜尋模型" placeholder="搜尋名稱或模型 ID" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <ul className="model-list">
          {visible.map((profile) => <li key={profile.id} className="model-row" aria-label={profile.name}>
            <div className="model-identity"><div className="model-provider-icon"><Icon name="agents" size={18} /></div><div className="model-description"><div className="model-name"><strong>{profile.name}</strong>{profile.id === settings?.activeProfileId && <Badge tone="accent">預設</Badge>}</div><div className="model-meta"><span className="mono">{profile.model}</span><span title={profile.endpoint}>{new URL(profile.endpoint).host}</span></div></div></div>
            <div className="model-test-state" aria-live="polite">{operation?.id === profile.id && operation.type === 'test' ? <Badge tone="info">測試中</Badge> : tested[profile.id] === 'ok' ? <Badge tone="ok">本次測試通過</Badge> : tested[profile.id] === 'failed' ? <Badge tone="err">測試失敗</Badge> : <span className="sm muted">尚未測試</span>}</div>
            <div className="model-row-actions">
              <Button size="sm" disabled={Boolean(operation)} loading={operation?.id === profile.id && operation.type === 'test'} onClick={() => void operate(profile, 'test')}>測試連線</Button>
              <Button size="sm" disabled={Boolean(operation)} onClick={() => setEditor({ profile })}>編輯</Button>
              {profile.id !== settings?.activeProfileId && <Button size="sm" disabled={Boolean(operation)} loading={operation?.id === profile.id && operation.type === 'activate'} onClick={() => void operate(profile, 'activate')}>設為預設</Button>}
            </div>
          </li>)}
        </ul>
        {visible.length === 0 && <p className="model-no-results muted">找不到符合「{query}」的模型。</p>}
      </section>
      <p className="sm muted">連線測試僅發送內建示例；測試結果僅顯示於本次頁面。模型設定與受測 Agent 相互獨立。</p>
    </>}
    {editor && <ModelEditor profile={editor.profile} onClose={() => setEditor(null)} onSaved={saved} />}
  </div>
}
