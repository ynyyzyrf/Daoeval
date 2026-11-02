#!/usr/bin/env node
/** 由 src/shared/skin.ts 生成 web/src/tokens.css，確保頁面與導出件同一份 token。 */
import { writeFileSync } from 'node:fs'
import { renderTokensCss } from '../src/shared/skin.ts'

const header = '/* 由 src/shared/skin.ts 生成；請改 skin.ts 後執行 node scripts/gen-tokens.mjs */\n'
writeFileSync('web/src/tokens.css', header + renderTokensCss(), 'utf8')
console.log('tokens.css 已生成')
