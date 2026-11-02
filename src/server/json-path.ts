/** 取 JSON 路徑值，支援 a.b[0].c 與 $.a.b 形式；取不到返回 undefined */
export function getPath(root: unknown, path: string | null | undefined): unknown {
  if (!path) return undefined
  const tokens = path.replace(/^\$\.?/, '').match(/[^.[\]]+/g)
  if (!tokens) return undefined
  let cur: unknown = root
  for (const token of tokens) {
    if (cur === null || cur === undefined) return undefined
    if (typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[token]
  }
  return cur
}

/** 深層替換字符串中的佔位符：{{input}} {{sessionId}} {{caseName}} */
export function fillTemplate(node: unknown, vars: Record<string, string>): unknown {
  if (typeof node === 'string') {
    let out = node
    for (const [k, v] of Object.entries(vars)) {
      out = out.split(`{{${k}}}`).join(v)
    }
    return out
  }
  if (Array.isArray(node)) return node.map((x) => fillTemplate(x, vars))
  if (node && typeof node === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      result[k] = fillTemplate(v, vars)
    }
    return result
  }
  return node
}
