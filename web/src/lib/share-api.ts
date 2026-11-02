/**
 * 分享連結的前端接口。獨立於 `api.ts`，避免和正在改導入頁的同事撞檔。
 */
export interface ShareLink {
  id: string
  path: string | null
  status: 'active' | 'revoked' | 'expired'
  createdAt: string
  expiresAt: string
  revokedAt: string | null
}

export interface ShareFailure {
  caseName: string
  branchName: string
  reason: string
  owner: string
  hint: string
  expected: string
  actual: string | null
}

export interface ShareSnapshot {
  schemaVersion: number
  generatedAt: string
  title: string
  kindLabel: string
  headline: string
  passRateText: string
  sampleText: string
  totals: { cases: number; judged: number; passed: number; failed: number; unknown: number }
  branches: Array<{
    name: string
    headline: string
    passRateText: string
    passedCases: number
    judgedCases: number
    unknownCases: number
    avgLatencyText: string
    sampleText: string
  }>
  failuresTotal: number
  evidenceListed: number
  failures: ShareFailure[]
  trialCount: number
  unknownSummary: Array<{ label: string; hint: string; cases: number }>
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    const error = new Error(data?.message ?? data?.error ?? `請求失敗（${res.status}）`)
    ;(error as Error & { status?: number }).status = res.status
    throw error
  }
  return data as T
}

export const shareApi = {
  create: (experimentId: string, days: number) =>
    request<{ id: string; path: string; createdAt: string; expiresAt: string; days: number }>(`/api/experiments/${experimentId}/shares`, {
      method: 'POST',
      body: JSON.stringify({ days }),
    }),
  list: (experimentId: string) => request<{ links: ShareLink[] }>(`/api/experiments/${experimentId}/shares`),
  revoke: (id: string) => request<{ ok: boolean }>(`/api/share-links/${id}`, { method: 'DELETE' }),
  read: (token: string) => request<{ snapshot: ShareSnapshot; expiresAt: string }>(`/api/share/${encodeURIComponent(token)}`),
}
