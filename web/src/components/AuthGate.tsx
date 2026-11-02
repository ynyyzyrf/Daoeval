import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { authRequest } from '../lib/auth.ts'
import { Button } from './ui.tsx'

const AuthContext = createContext({ username: '', logout: async () => {} })
export const useAuth = () => useContext(AuthContext)

export function AuthGate({ children }: { children: ReactNode }) {
  const [username, setUsername] = useState<string | null>(null)
  const [checking, setChecking] = useState(true)
  const [account, setAccount] = useState('admin')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    const reset = () => { setUsername(null); setPassword(''); setError('登入已失效，請重新登入') }
    window.addEventListener('aeval:unauthorized', reset)
    authRequest('session').then((session) => { if (active) setUsername(session.username) }).catch(() => {}).finally(() => { if (active) setChecking(false) })
    return () => { active = false; window.removeEventListener('aeval:unauthorized', reset) }
  }, [])
  async function login(event: FormEvent) {
    event.preventDefault()
    setBusy(true); setError('')
    try { const session = await authRequest('login', { username: account, password }); setUsername(session.username); setPassword('') }
    catch (reason) { setError(reason instanceof Error ? reason.message : '登入失敗') }
    finally { setBusy(false) }
  }
  async function logout() {
    try { await authRequest('logout', {}); setUsername(null); setError(''); setPassword('') }
    catch (reason) { window.alert(reason instanceof Error ? reason.message : '登出失敗，請稍後再試') }
  }
  if (username) return <AuthContext.Provider value={{ username, logout }}>{children}</AuthContext.Provider>
  return <main className="login-page"><section className="login-card" aria-labelledby="login-title">
    <div className="login-brand">Daoeval</div>
    <h1 id="login-title">登入工作區</h1>
    <p className="muted">管理 Agent、測試集與評測實驗。</p>
    {checking ? <p role="status">正在確認登入狀態…</p> : <form onSubmit={login} className="login-form">
      <label>帳號<input name="username" autoComplete="username" required maxLength={128} value={account} onChange={(event) => setAccount(event.target.value)} /></label>
      <label>密碼<input name="password" type="password" autoComplete="current-password" required maxLength={1024} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      {error && <p className="login-error" role="alert">{error}</p>}
      <Button type="submit" variant="primary" disabled={busy}>{busy ? '登入中…' : '登入'}</Button>
    </form>}
  </section></main>
}
