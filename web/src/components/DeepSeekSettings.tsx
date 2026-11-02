import { useEffect, useState } from 'react'
import { api } from '../api.ts'
import type { JudgeSettings } from '../../../src/shared/ai-evaluation.ts'
import { Badge, Button, Card, Field, Notice, useToast } from './ui.tsx'

export function DeepSeekSettings() {
  const [settings, setSettings] = useState<JudgeSettings | null>(null)
  const [model, setModel] = useState('deepseek-flash')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toast = useToast()
  const load = () => {
    setError(null)
    api.judgeSettings().then((value) => { setSettings(value); setModel(value.model) }).catch((e: Error) => setError(e.message))
  }
  useEffect(load, [])
  const save = async () => {
    setBusy(true); setError(null)
    try { setSettings(await api.saveJudgeSettings(model.trim(), key.trim() || undefined)); setKey(''); toast.push('success', 'DeepSeek 評分設定已儲存') }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const test = async () => {
    setTesting(true); setError(null)
    try { await api.testJudge(); toast.push('success', '連線及結構化評估測試通過') }
    catch (e) { setError((e as Error).message) } finally { setTesting(false) }
  }
  return <Card title="AI 回答評估 · DeepSeek" subtitle="使用 DeepSeek 官方服務，比較參考回答與實際回答。與受測 Agent 的模型設定獨立。">
    <div className="stack-3">
      <div className="row"><Badge tone={settings?.configured ? 'ok' : 'muted'}>{settings?.configured ? '已設定' : '尚未設定'}</Badge><span className="sm muted">{settings?.keyMask ? `API Key：${settings.keyMask}` : 'API Key 加密儲存，不回傳明文'}</span></div>
      <div className="grid-2">
        <Field label="評分模型名稱" hint="使用帳戶可用的模型名稱，預設 deepseek-flash。"><input value={model} onChange={(event) => setModel(event.target.value)} disabled={busy || testing || !settings} /></Field>
        <Field label="DeepSeek API Key" hint={settings?.configured ? '留空保留現有金鑰；填寫新值可替換。' : '請在這裡填寫，不要貼在聊天中。'}><input type="password" autoComplete="new-password" value={key} onChange={(event) => setKey(event.target.value)} disabled={busy || testing || !settings} /></Field>
      </div>
      <p className="sm muted">評估會把問題、參考回答、實際回答與評分標準傳送給 DeepSeek，產生 API 用量。並發為 1；連線測試只傳送內建示例。</p>
      {error && <Notice tone="err">{error}</Notice>}
      <div className="row">
        <Button variant="primary" loading={busy} disabled={!settings || testing} onClick={() => void save()}>儲存設定</Button>
        <Button loading={testing} disabled={!settings?.configured || busy || Boolean(key) || model.trim() !== settings.model} onClick={() => void test()}>測試已儲存設定</Button>
        {!settings && error && <Button onClick={load}>重新載入</Button>}
      </div>
    </div>
  </Card>
}
