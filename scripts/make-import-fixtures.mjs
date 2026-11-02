import ExcelJS from 'exceljs'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:5280'
const dir = mkdtempSync(join(tmpdir(), 'daoeval-fixtures-'))

const sampleResponse = await fetch(`${BASE}/api/test-sets/template.xlsx?kind=sample`)
const sample = Buffer.from(await sampleResponse.arrayBuffer())
writeFileSync(join(dir, 'sample-good.xlsx'), sample)

const workbook = new ExcelJS.Workbook()
await workbook.xlsx.load(sample)
const sheet = workbook.getWorksheet('案例')
// 第 5 行（Excel 行號 5）：判定方式填了不認識的值
sheet.getCell('E5').value = '必须很准'
// 第 6 行：輸入清空
sheet.getCell('C6').value = ''
// 第 7 行：不超過字數但填了中文數字
sheet.getCell('E7').value = '不超過字數'
sheet.getCell('F7').value = '二十'
// 第 8 行：優先級不在允許值內
sheet.getCell('I8').value = '緊急'
// 第 9 行：案例名稱與第 3 行重複
sheet.getCell('A9').value = sheet.getCell('A3').value
writeFileSync(join(dir, 'sample-errors.xlsx'), Buffer.from(await workbook.xlsx.writeBuffer()))

console.log(dir)
