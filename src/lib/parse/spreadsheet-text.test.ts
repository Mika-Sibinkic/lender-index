import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { spreadsheetToText } from './spreadsheet-text'

function wbBuffer(rows: unknown[][], sheetName = 'Sheet1'): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

describe('spreadsheetToText', () => {
  it('prepends the filename hint and includes summary rows', () => {
    const buf = wbBuffer([
      ['Amount (USD)', '1,500,000.00'],
      ['Product', 'Lease'],
      ['Term (months)', 60],
    ])
    const text = spreadsheetToText(buf, 'Caterpillar 320 leasing model.xlsx')
    expect(text).toContain('Filename: Caterpillar 320 leasing model.xlsx')
    expect(text).toContain('Lease')
    expect(text).toContain('1,500,000')
    expect(text).toContain('Sheet: Sheet1')
  })

  it('caps rows per sheet to drop long schedules', () => {
    const rows = [['header', 'x']]
    for (let i = 0; i < 200; i++) rows.push([`row${i}`, String(i)])
    const text = spreadsheetToText(wbBuffer(rows), 'big.xlsx', { maxRowsPerSheet: 10 })
    expect(text).toContain('row0')
    expect(text).not.toContain('row50')
  })
})
