import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { toReportRow, toCsv, toXlsxBuffer, REPORT_COLUMNS } from './funding-source-report'

// Synthetic row (a Canadian lender's geography, a lending status, array fields
// as Postgres returns them).
const SOURCE = {
  company_name: 'Wasat Bank',
  lender_type: 'Bank',
  lending_status: 'Yes',
  status: 'active',
  primary_contact_name: 'Jane Roe',
  primary_contact_title: 'VP',
  primary_contact_email: 'jane@example.com',
  primary_contact_phone: '+1 555 0100',
  intl_domestic: 'International',
  geographic_scope: ['International', 'Canada'],
  specific_geographic: 'Canada',
  deal_size_min_usd: '250000',
  deal_size_max_usd: '10000000',
  asset_subtypes: ['New', 'Used'],
  asset_classes: ['equipment', 'construction_equipment'],
  usage_codes: 'owner',
  operation_category: 'Personal',
  vintage_restriction: '2003 or newer',
  bank_paid_fee: 'Yes',
  last_contact_at: '2026-06-01T12:34:56.000Z',
  outreach_status: 'current',
  internal_notes: 'Prefers email',
  rate_notes: 'SOFR + 250',
  updated_at: '2026-08-01T09:00:00.000Z',
}

describe('funding-source report', () => {
  it('uses roster template column names, not our internal ones', () => {
    // The team ran this business on a spreadsheet with these headers. A report
    // they have to translate is a report they will not use.
    for (const col of [
      'Account Name', 'Loan Minimum', 'Loan Maximum', 'Asset Subtypes',
      // Geographic Target is the category, Specific Geography is the
      // states-or-countries list.
      'Operation Category', 'Geographic Target',
      'Specific Geography', 'Geography Detail', 'Vintage Restriction',
      'Lending Status', 'Bank Paid Fee',
    ]) {
      expect(REPORT_COLUMNS).toContain(col)
    }
    expect(REPORT_COLUMNS).not.toContain('deal_size_min_usd')
    expect(REPORT_COLUMNS).not.toContain('company_name')
  })

  it('flattens arrays and keeps money numeric so Excel can sort it', () => {
    const r = toReportRow(SOURCE, ['bank', 'preferred'])
    expect(r['Account Name']).toBe('Wasat Bank')
    expect(r['Specific Geography']).toBe('International, Canada')
    expect(r['Asset Subtypes']).toBe('New, Used')
    expect(r.Tags).toBe('bank, preferred')
    // Numbers, not strings — "sort by deal size" has to actually sort.
    expect(r['Loan Minimum']).toBe(250000)
    expect(r['Loan Maximum']).toBe(10000000)
    expect(r['Last Contact']).toBe('2026-06-01')
  })

  it('names the blank required fields — this is the "what needs updating" column', () => {
    const sparse = { company_name: 'Half A Record', intl_domestic: 'Domestic' }
    const r = toReportRow(sparse, [])
    expect(r['Missing Count']).toBeGreaterThan(5)
    expect(String(r['Missing Required Fields'])).toContain('Loan Minimum')
    expect(String(r['Missing Required Fields'])).toContain('Main Contact')
    // A complete-enough record should not be flagged for the same field.
    expect(String(toReportRow(SOURCE, [])['Missing Required Fields'])).not.toContain('Loan Minimum')
  })

  it('never emits null/undefined text into a cell', () => {
    const r = toReportRow({ company_name: 'Blank Co' }, [])
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === 'string') {
        expect(v, `${k} leaked a placeholder`).not.toMatch(/null|undefined/i)
      }
    }
  })

  it('round-trips through a real workbook', () => {
    const rows = [toReportRow(SOURCE, ['bank'])]
    const wb = XLSX.read(toXlsxBuffer(rows), { type: 'buffer' })
    expect(wb.SheetNames).toContain('Funding Sources')
    const back = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Funding Sources'])
    expect(back).toHaveLength(1)
    expect(back[0]['Account Name']).toBe('Wasat Bank')
    expect(back[0]['Loan Maximum']).toBe(10000000)
  })

  it('emits a CSV with a header row', () => {
    const csv = toCsv([toReportRow(SOURCE, [])])
    expect(csv.split('\n')[0]).toContain('Account Name')
    expect(csv).toContain('Wasat Bank')
  })
})
