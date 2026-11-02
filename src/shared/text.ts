/** 標題「輕重並置」拆分：回傳前半（輕）與主體（重）。 */
export function splitTitle(name: string, fallbackLead = '報告'): { lead: string; strong?: string } {
  const trimmed = name.trim()
  if (!trimmed) return { lead: fallbackLead }
  const separators = ['：', ':', '—', ' - ']
  for (const sep of separators) {
    const index = trimmed.indexOf(sep)
    if (index > 0 && index < trimmed.length - sep.length) {
      return { lead: trimmed.slice(0, index).trim(), strong: trimmed.slice(index + sep.length).trim() }
    }
  }
  const space = trimmed.indexOf(' ')
  if (space > 0) return { lead: trimmed.slice(0, space), strong: trimmed.slice(space + 1).trim() }
  return { lead: fallbackLead, strong: trimmed }
}
