import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 憑證加密：AES-256-GCM，金鑰由環境變數 AEVAL_ENC_KEY（base64 32 bytes）注入。
 * 未注入時，僅在本地開發環境自動生成 .data/dev-enc.key，並在啟動日誌提示。
 */
function loadKey(): { key: Buffer; source: 'env' | 'dev-file' } {
  const env = process.env.AEVAL_ENC_KEY
  if (env) {
    const key = Buffer.from(env, 'base64')
    if (key.length !== 32) throw new Error('AEVAL_ENC_KEY 必須是 base64 編碼的 32 bytes 金鑰')
    return { key, source: 'env' }
  }
  const dataDir = process.env.AEVAL_DATA_DIR ?? join(process.cwd(), '.data')
  mkdirSync(dataDir, { recursive: true })
  const file = join(dataDir, 'dev-enc.key')
  if (existsSync(file)) {
    return { key: Buffer.from(readFileSync(file, 'utf8').trim(), 'base64'), source: 'dev-file' }
  }
  const key = randomBytes(32)
  writeFileSync(file, key.toString('base64'), { encoding: 'utf8', mode: 0o600 })
  return { key, source: 'dev-file' }
}

const loaded = loadKey()
export const keySource = loaded.source
const KEY = loaded.key

export interface SealedSecret {
  cipher: string
  iv: string
  tag: string
  mask: string
}

export function maskSecret(plain: string): string {
  const trimmed = plain.trim()
  if (trimmed.length <= 4) return '****'
  return `••••${trimmed.slice(-4)}`
}

export function sealSecret(plain: string): SealedSecret {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', KEY, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return {
    cipher: enc.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    mask: maskSecret(plain),
  }
}

export function openSecret(sealed: { cipher: string; iv: string; tag: string }): string {
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(sealed.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.cipher, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

/** Bind persisted sessions to the current administrator credentials without storing them. */
export function authCredentialFingerprint(username: string, password: string): string {
  return createHmac('sha256', KEY).update(JSON.stringify([username, password])).digest('hex')
}
