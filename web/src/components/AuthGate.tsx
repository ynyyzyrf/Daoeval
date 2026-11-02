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
  return <main className="login-page"><div className="login-layout">
    <div className="login-brand">
      <span className="login-brand-mark" aria-hidden="true">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path d="M3 12h3l3-7 5 14 3-7h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span>Daoeval</span>
    </div>
    <section className="login-card" aria-labelledby="login-title" aria-describedby="login-description">
      <header className="login-heading">
        <h1 id="login-title">欢迎回来</h1>
        <p id="login-description">登录工作区，开始管理和评测你的 AI Agent</p>
      </header>
      {checking ? <p className="login-checking" role="status">正在确认登录状态…</p> : <form onSubmit={login} className="login-form" aria-busy={busy}>
        <label htmlFor="login-account">账号<input id="login-account" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={128} value={account} aria-describedby={error ? 'login-error' : undefined} onChange={(event) => setAccount(event.target.value)} /></label>
        <label htmlFor="login-password">密码<input id="login-password" name="password" type="password" autoComplete="current-password" placeholder="请输入密码" required maxLength={1024} value={password} aria-describedby={error ? 'login-error' : undefined} onChange={(event) => setPassword(event.target.value)} /></label>
        {error && <p id="login-error" className="login-error" role="alert">{error}</p>}
        <Button className="login-submit" type="submit" variant="primary" disabled={busy} aria-label={busy ? '登录中，请稍候' : '登录'}>
          {busy && <span className="login-spinner" aria-hidden="true" />}{busy ? '登录中…' : '登录'}
        </Button>
      </form>}
    </section>
    <p className="login-footer">Daoeval · AI Agent 评测与验收平台</p>
  </div></main>
}
