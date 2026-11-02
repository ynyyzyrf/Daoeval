import { useRef, useState } from 'react'
import { api, type AgentSummary } from '../api.ts'
import { navigate } from '../lib/router.ts'
import { Button, Field, Notice, Progress, Stepper } from './ui.tsx'

type ImportStep = 'download' | 'select' | 'uploading' | 'result'
type ImportError = { row: number; column: string; message: string }
type ActiveVersion = { id: string; label: string }
type ImportSummary = {
  total: number
  byType: Array<{ label: string; count: number }>
  byMethod: Array<{ label: string; count: number }>
}
type ImportResult = { testSetId: string; imported: number; name: string; duplicateOf: string | null; summary: ImportSummary }

export function formatImportError(error: ImportError) {
  const where = error.row > 0 ? `第 ${error.row} 行 · ${error.column}` : error.column
  return `${where}：${error.message}`
}

function errorsToCsv(errors: ImportError[]) {
  const rows = [['行號', '列', '欄位', '錯誤原因'], ...errors.map((error) => [error.row ? String(error.row) : '', error.column, error.column, error.message])]
  return rows.map((cells) => cells.map((cell) => `"${cell.replace(/"/gu, '""')}"`).join(',')).join('\r\n')
}

function downloadCsv(errors: ImportError[]) {
  const blob = new Blob([`\ufeff${errorsToCsv(errors)}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'daoeval-import-errors.csv'
  link.click()
  URL.revokeObjectURL(url)
}

function errorText(error: unknown) {
  return error instanceof Error && error.message ? error.message : '暫時無法完成，請稍後再試。'
}

function readAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('無法讀取檔案，請重新選擇。'))
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.readAsDataURL(file)
  })
}

function uploadExcel(filename: string, dataBase64: string, onProgress: (value: number) => void) {
  return new Promise<{ testSetId: string; imported: number; name: string; duplicateOf: string | null; summary: ImportSummary }>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/test-sets/import-excel')
    xhr.setRequestHeader('content-type', 'application/json')
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.max(1, Math.round((event.loaded / event.total) * 85)))
    }
    xhr.onerror = () => reject(new Error('上傳連線中斷，請重新再試。'))
    xhr.onload = () => {
      let body: unknown = null
      try { body = xhr.responseText ? JSON.parse(xhr.responseText) : null } catch { reject(new Error('伺服器回覆無法辨識。')); return }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as { testSetId: string; imported: number; name: string; duplicateOf: string | null; summary: ImportSummary })
      else reject(Object.assign(new Error((body as { error?: string })?.error ?? '導入失敗，請檢查檔案。'), { payload: body }))
    }
    xhr.send(JSON.stringify({ filename, dataBase64 }))
  })
}

export function ExcelImport({ onImported }: { onImported?: (testSetId: string) => void }) {
  const [step, setStep] = useState<ImportStep>('download')
  const [file, setFile] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)
  const [progress, setProgress] = useState(0)
  const [validated, setValidated] = useState(0)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [copied, setCopied] = useState(false)
  const [errors, setErrors] = useState<ImportError[]>([])
  const [expanded, setExpanded] = useState<number | null>(null)
  const [flow, setFlow] = useState<'idle' | 'publishing' | 'agents' | 'form' | 'creating' | 'starting'>('idle')
  const [flowError, setFlowError] = useState('')
  const [versions, setVersions] = useState<ActiveVersion[]>([])
  const [agentVersionId, setAgentVersionId] = useState('')
  const [datasetVersionId, setDatasetVersionId] = useState('')
  const [repeats, setRepeats] = useState(1)
  const [concurrency, setConcurrency] = useState(2)
  const inputRef = useRef<HTMLInputElement>(null)

  const choose = (next: File | undefined) => {
    if (!next) return
    if (!next.name.toLowerCase().endsWith('.xlsx')) {
      setErrors([{ row: 0, column: '檔案', message: '請選擇 .xlsx 檔案。' }])
      setStep('result')
      return
    }
    setFile(next)
    setStep('select')
  }

  const startImport = async () => {
    if (!file) return
    setStep('uploading'); setProgress(1); setValidated(0); setErrors([])
    try {
      const response = await uploadExcel(file.name, await readAsBase64(file), setProgress)
      setProgress(100); setValidated(response.imported)
      setResult({ testSetId: response.testSetId, imported: response.imported, name: response.name, duplicateOf: response.duplicateOf, summary: response.summary })
      onImported?.(response.testSetId)
    } catch (error) {
      const payload = (error as { payload?: { errors?: ImportError[] } }).payload
      setErrors((payload?.errors ?? []).slice().sort((a, b) => a.row - b.row))
      if (!payload?.errors?.length) setErrors([{ row: 0, column: '導入', message: errorText(error) }])
    } finally { setStep('result') }
  }

  const loadVersions = async () => {
    setFlow('agents'); setFlowError('')
    try {
      const agents = await api.agents()
      const all = await Promise.all(agents.map(async (agent: AgentSummary) => {
        const response = await api.agentVersions(agent.id)
        return response.versions.filter((version) => version.status === 'active').map((version) => ({ id: version.id, label: `${agent.name} v${version.versionNo}` }))
      }))
      const next = all.flat()
      setVersions(next); setAgentVersionId(next[0]?.id ?? ''); setFlow('form')
    } catch (error) { setFlowError(errorText(error)); setFlow('idle') }
  }

  const publishAndRun = async () => {
    if (!result) return
    setFlow('publishing'); setFlowError('')
    try {
      const published = await api.publish(result.testSetId)
      setDatasetVersionId(published.versionId)
      await loadVersions()
    }
    catch (error) { setFlowError(errorText(error)); setFlow('idle') }
  }

  const createAndStart = async () => {
    if (!result || !agentVersionId) return
    setFlow('creating'); setFlowError('')
    try {
      const scoring = await api.scoringVersions()
      if (!datasetVersionId || !scoring[0]) throw new Error('尚未準備好可執行的版本，請稍後重試。')
      const created = await api.createExperiment({ name: `${result.name} 首次執行`, kind: 'A', datasetVersionId, scoringProfileVersionId: scoring[0].id, repeats, branches: [{ role: 'baseline', agentVersionId }] })
      setFlow('starting'); await api.startRun(created.experimentId, { repeats, concurrency }); navigate(`/report/${created.experimentId}`)
    } catch (error) { setFlowError(errorText(error)); setFlow('form') }
  }

  return <div className="stack excel-import">
    <Stepper steps={['下載模板', '選擇檔案', '上傳與解析', '結果']} current={step === 'download' ? 0 : step === 'select' ? 1 : step === 'uploading' ? 2 : 3} />
    {step === 'download' && <><p className="muted">按模板填寫，最多 500 行；模板改動過的檔案會被拒絕。</p><div className="excel-import-links"><a href="/api/test-sets/template.xlsx?kind=blank">下載空白模板</a><a href="/api/test-sets/template.xlsx?kind=sample">下載標準範例集（16 條，範例，可刪）</a></div><Button variant="primary" onClick={() => setStep('select')}>下一步</Button></>}
    {step === 'select' && <><input ref={inputRef} className="sr-only" type="file" accept=".xlsx" onChange={(event) => choose(event.target.files?.[0])} /><button type="button" className={`excel-dropzone ${dragging ? 'dragging' : ''}`} onClick={() => inputRef.current?.click()} onDragOver={(event) => { event.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); choose(event.dataTransfer.files[0]) }}>將 .xlsx 檔案拖到這裡，或點擊選擇檔案</button>{file && <Notice>{file.name} · {(file.size / 1024).toFixed(1)} KB</Notice>}<Button variant="primary" disabled={!file} onClick={() => void startImport()}>開始導入</Button></>}
    {step === 'uploading' && <><div className="excel-progress-label"><span>正在上傳與解析</span><strong>{progress}%</strong></div><Progress value={progress} /><p className="muted">正在校驗 {validated || 16} 條案例…</p></>}
    {step === 'result' && result && <><h2 className="section-title">已新建測試集「{result.name}」，{result.imported} 條用例</h2>{result.duplicateOf && <Notice tone="warn">已有同名測試集「{result.duplicateOf}」，本次新建的是第 2 個同名測試集「{result.name}」，檢查清單時請看名稱後面的序號</Notice>}{flowError && <Notice tone="err">{flowError}</Notice>}
      <div className="excel-summary">
        <div className="excel-summary-head"><strong>導入摘要</strong><span className="muted">{result.summary.total} 條用例</span></div>
        <div className="excel-summary-row"><span className="muted">案例類型</span><span>{result.summary.byType.map((item) => `${item.label} ${item.count}`).join(' · ') || '—'}</span></div>
        <div className="excel-summary-row"><span className="muted">判定方式</span><span>{result.summary.byMethod.map((item) => `${item.label} ${item.count}`).join(' · ') || '—'}</span></div>
        <div className="excel-summary-row"><span className="muted">狀態</span><span>草稿：尚未發佈，發佈後才能執行</span></div>
      </div>
      {flow === 'idle' && <div className="excel-import-actions"><Button variant="primary" onClick={() => void publishAndRun()}>發佈並執行</Button><Button onClick={() => navigate(`/testsets/${result.testSetId}`)}>查看測試集</Button></div>}{flow !== 'idle' && <div className="excel-run-flow"><span className={flow === 'publishing' ? 'active' : 'done'}>1. 發佈測試集</span><span className={flow === 'agents' ? 'active' : flow === 'form' || flow === 'creating' || flow === 'starting' ? 'done' : ''}>2. 載入可用 Agent</span>{flow === 'form' && (versions.length ? <><Field label="Agent 版本"><select value={agentVersionId} onChange={(event) => setAgentVersionId(event.target.value)}>{versions.map((version) => <option key={version.id} value={version.id}>{version.label}</option>)}</select></Field><div className="excel-number-fields"><Field label="重複次數"><input type="number" min="1" value={repeats} onChange={(event) => setRepeats(Math.max(1, Number(event.target.value)))} /></Field><Field label="並發"><input type="number" min="1" value={concurrency} onChange={(event) => setConcurrency(Math.max(1, Number(event.target.value)))} /></Field></div><Button variant="primary" onClick={() => void createAndStart()}>建立並開始執行</Button></> : <><Notice tone="warn">還沒有可用的 Agent，先去接入</Notice><Button variant="primary" onClick={() => navigate('/agents/new')}>去接入 Agent</Button></>)}{flow === 'creating' && <span className="active">3. 建立首次執行</span>}{flow === 'starting' && <span className="active">4. 開始執行</span>}</div>}</>}
    {step === 'result' && !result && <><h2 className="section-title">未導入任何數據（整批拒絕）</h2><p className="muted">以下 {errors.length} 處需要修正。修正後重新選擇檔案即可，資料庫裡沒有寫入任何一條。</p><div className="excel-error-list">{errors.map((error, index) => <div key={`${error.row}-${error.column}-${index}`} id={`error-${index}`}><button type="button" onClick={() => setExpanded(expanded === index ? null : index)}>{formatImportError(error)}</button>{expanded === index && <p className="muted">{error.row > 0 ? `到第 ${error.row} 行的「${error.column}」格修正這一條。` : error.message}</p>}</div>)}</div>
      <div className="excel-import-actions">
        <Button onClick={() => setStep('select')}>重新選擇檔案</Button>
        <Button onClick={() => downloadCsv(errors)}>下載錯誤清單（CSV）</Button>
        <Button onClick={() => { void navigator.clipboard.writeText(errors.map(formatImportError).join('\n')).then(() => setCopied(true)).catch(() => setCopied(false)) }}>{copied ? '已複製' : '複製清單'}</Button>
      </div></>}
  </div>
}
