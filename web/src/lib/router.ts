import { useEffect, useState } from 'react'

export type Route =
  | { name: 'overview' }
  | { name: 'agents' }
  | { name: 'agent-new' }
  | { name: 'agent-detail'; id: string }
  | { name: 'agent-version'; id: string }
  | { name: 'testsets' }
  | { name: 'testset-detail'; id: string }
  | { name: 'experiments' }
  | { name: 'experiment-detail'; id: string }
  | { name: 'report' }
  | { name: 'report-detail'; id: string; trialId?: string }
  | { name: 'settings' }
  | { name: 'models' }

/**
 * 由網址解析路由。接受路徑形式（/report/exp_1?trial=trial_1）與舊的 hash 形式（#/report/exp_1），
 * 直接貼上、書籤、重新整理都走同一套解析。
 */
export function parseRoute(url: string): Route {
  const withoutHash = url.startsWith('#') ? url.slice(1) : url
  const [rawPath = '', rawQuery = ''] = withoutHash.split('?')
  const query = new URLSearchParams(rawQuery)
  const path = rawPath.replace(/^\/+/, '').replace(/\/+$/, '')
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 0) return { name: 'overview' }
  const [head, second, third] = parts
  if (head === 'agents') {
    if (!second) return { name: 'agents' }
    if (second === 'new') return { name: 'agent-new' }
    if (third === 'new-version') return { name: 'agent-version', id: second }
    return { name: 'agent-detail', id: second }
  }
  if (head === 'testsets') {
    return second ? { name: 'testset-detail', id: second } : { name: 'testsets' }
  }
  if (head === 'experiments') {
    return second ? { name: 'experiment-detail', id: second } : { name: 'experiments' }
  }
  if (head === 'report') {
    return second
      ? { name: 'report-detail', id: second, trialId: query.get('trial') ?? undefined }
      : { name: 'report' }
  }
  if (head === 'settings') return { name: 'settings' }
  if (head === 'models') return { name: 'models' }
  return { name: 'overview' }
}

const ROUTE_EVENT = 'aeval:route'

export function navigate(to: string): void {
  const target = to.startsWith('/') ? to : `/${to}`
  window.history.pushState(null, '', target)
  window.dispatchEvent(new Event(ROUTE_EVENT))
  window.scrollTo({ top: 0 })
}

function currentUrl(): string {
  return `${window.location.pathname}${window.location.search}`
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(currentUrl()))
  useEffect(() => {
    const onChange = () => {
      setRoute(parseRoute(currentUrl()))
      window.scrollTo({ top: 0 })
    }
    window.addEventListener('popstate', onChange)
    window.addEventListener(ROUTE_EVENT, onChange)
    return () => {
      window.removeEventListener('popstate', onChange)
      window.removeEventListener(ROUTE_EVENT, onChange)
    }
  }, [])
  return route
}
