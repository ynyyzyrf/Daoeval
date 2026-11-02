import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { renderTokensCss } from '../src/shared/skin.ts'

const root = process.cwd()
const webSrc = join(root, 'web', 'src')
const issues: string[] = []

function filesIn(directory: string, extension: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return filesIn(path, extension)
    return entry.isFile() && path.endsWith(extension) ? [path] : []
  })
}

function addLineIssues(path: string, matcher: RegExp, message: string) {
  readFileSync(path, 'utf8').split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('*/')) return
    if (matcher.test(line)) issues.push(`${relative(root, path)}:${index + 1} ${message}`)
    matcher.lastIndex = 0
  })
}

for (const path of filesIn(webSrc, '.tsx')) {
  addLineIssues(path, /#[0-9a-fA-F]{3,8}\b/g, '不可硬編碼色值')
  addLineIssues(path, /\b(?:padding|margin|gap)(?:[A-Z-][\w-]*)?\s*:\s*[^;},]*\b20px\b/g, '不可使用 20px 間距')

  const source = readFileSync(path, 'utf8')
  const inlineStyles = source.match(/style=\{\{[\s\S]*?\}\}/g) ?? []
  for (const style of inlineStyles) {
    if (!/\b(?:height|lineHeight)\s*:\s*\d+(?:\.\d+)?\b/.test(style)) continue
    const offset = source.indexOf(style)
    const line = source.slice(0, offset).split(/\r?\n/).length
    issues.push(`${relative(root, path)}:${line} inline style 不可使用固定 height 或 lineHeight`)
  }
}

for (const path of filesIn(webSrc, '.css')) {
  addLineIssues(path, /\b(?:padding|margin|gap)(?:-[\w-]+)?\s*:\s*[^;{}]*\b20px\b/g, '不可使用 20px 間距')
}

const tokensCss = readFileSync(join(webSrc, 'tokens.css'), 'utf8')
const generatedStart = tokensCss.indexOf(':root {')
const tokenBody = generatedStart >= 0 ? tokensCss.slice(generatedStart) : tokensCss
if (tokenBody.trimEnd() !== renderTokensCss().trimEnd()) {
  issues.push('web/src/tokens.css 與 src/shared/skin.ts 不同步；請執行 node scripts/gen-tokens.mjs')
}

if (issues.length > 0) {
  console.error('設計規範檢查失敗：')
  for (const issue of issues) console.error(`- ${issue}`)
  process.exit(1)
}

console.log('設計規範檢查通過：4 項')
