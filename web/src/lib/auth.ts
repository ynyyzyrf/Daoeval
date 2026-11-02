export function notifyUnauthorized(status: number): void {
  if (status === 401) window.dispatchEvent(new Event('aeval:unauthorized'))
}

export async function authRequest(path: string, body?: unknown): Promise<{ username: string }> {
  const response = await fetch(`/api/auth/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? '請求失敗，請稍後再試')
  return result
}
