/**
 * 截圖工具：用 Edge headless 直接開網址，可選先執行一段 JS 再截（例如打開抽屜）。
 * 用法：node scripts/shot.mjs <url> <out.png> [--js "expression"] [--wait ms]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const args = process.argv.slice(2)
const url = args[0]
const out = args[1]
if (!url || !out) {
  console.error('用法：node scripts/shot.mjs <url> <out.png> [--js "expression"] [--wait ms]')
  process.exit(1)
}
const jsIndex = args.indexOf('--js')
const script = jsIndex >= 0 ? args[jsIndex + 1] : undefined
const waitIndex = args.indexOf('--wait')
const waitMs = waitIndex >= 0 ? Number(args[waitIndex + 1]) || 1200 : 1200

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const profile = mkdtempSync(join(tmpdir(), 'aeval-shot-'))
const port = 9300 + Math.floor(Math.random() * 400)
const proc = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
)

async function target() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find((item) => item.type === 'page')
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      /* 瀏覽器還沒起來，等下一輪 */
    }
    await sleep(200)
  }
  throw new Error('找不到可除錯的頁面')
}

let ws
try {
  const page = await target()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map()
  let seq = 0
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const settle = pending.get(message.id)
      pending.delete(message.id)
      settle(message)
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, (message) => (message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)))
      ws.send(JSON.stringify({ id, method, params }))
    })
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url })
  await sleep(waitMs)
  if (script) {
    const result = await send('Runtime.evaluate', { expression: script, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(`腳本執行失敗：${result.exceptionDetails.text ?? ''}`)
    await sleep(600)
  }
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log(`${out}  ${Buffer.from(shot.data, 'base64').length} bytes`)
} finally {
  ws?.close()
  proc.kill()
  await sleep(800)
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    // 瀏覽器還在釋放 profile 目錄，殘留交給系統暫存清理
  }
}
