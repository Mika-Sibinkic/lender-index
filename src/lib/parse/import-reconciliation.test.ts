/**
 * Every input row is accounted for.
 *
 * An earlier importer turned two roster sheets into far fewer lenders than
 * they had rows. The missing rows disappeared and
 * nothing anywhere recorded it — no log, no counter, no table, no line in the
 * response. The UI reported the post-discard count as "rows parsed", so it read
 * as success. These tests exist so that cannot happen silently again.
 */

import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { parseRosterWorkbook, parseLoanAmount } from '@/lib/parse/roster-xlsx'
import { mergeRows } from '@/lib/parse/roster-persist'
import type { ParsedFundingRow } from '@/lib/parse/roster-xlsx'

const HDR = [
  'Type:  (B) Bank  (C) Credit Union  (NB) Non Bank  (PE) Private Equity',
  'Account Name', 'Main Contact', 'Email', 'Loan Minimum MM', 'Loan Maximum MM',
  '(I) International  (D) Domestic', 'Geographic Target', 'Specific Geographic',
  'Asset Classes', 'Usage', 'Operation Category',
  'Vintage Restriction', 'Lending Status', 'Notes:',
].join(',')
const R1 = 'B,Acme Equipment Bank,Jane Doe,jane@acme.example,1MM,10MM,D,US,TX,construction_equipment,owner,Personal,20 Years,Yes,note one'
const R2 = 'B,Beta Commercial Capital,John Roe,john@beta.example,5,25,I,Brazil,Sao Paulo,construction_equipment,lease,Commercial,None,Yes,note two'

const parse = (csv: string) =>
  parseRosterWorkbook(XLSX.read(Buffer.from(csv), { type: 'buffer' }), { isInternational: false })

describe('the header row is found, not assumed', () => {
  it('reads a clean sheet', () => {
    const { rows, report } = parse([HDR, R1, R2].join('\n'))
    expect(rows).toHaveLength(2)
    expect(report.headerRowIndex).toBe(0)
  })

  it('survives a title row above the header', () => {
    // This used to produce ZERO rows and report success: sheet_to_json took its
    // headers from the title line, every lookup missed, and every row was
    // skipped for having no Account Name.
    const { rows, report } = parse(['Domestic Lender Roster', HDR, R1, R2].join('\n'))
    expect(rows).toHaveLength(2)
    expect(report.headerRowIndex).toBe(1)
    expect(rows.map((r) => r.company_name)).toContain('Acme Equipment Bank')
  })

  it('survives a blank line above the header', () => {
    const { rows } = parse(['', HDR, R1, R2].join('\n'))
    expect(rows).toHaveLength(2)
  })
})

describe('nothing is dropped silently', () => {
  it('counts a skipped row and says which row and why', () => {
    const blank = 'B,,Nobody,x@y.example,1MM,2MM,D,US,TX,construction_equipment,owner,Personal,None,Yes,'
    const { rows, report } = parse([HDR, R1, blank].join('\n'))
    expect(rows).toHaveLength(1)
    expect(report.skipped).toHaveLength(1)
    expect(report.skipped[0].sheetRow).toBe(3)
    expect(report.skipped[0].reason).toMatch(/Account Name/)
  })

  it('reconciles: parsed + skipped equals what the sheet held', () => {
    const blank = 'B,,Nobody,x@y.example,1MM,2MM,D,US,TX,construction_equipment,owner,Personal,None,Yes,'
    const { report } = parse([HDR, R1, R2, blank].join('\n'))
    expect(report.parsedRows + report.skipped.length).toBe(report.inputRows)
  })

  it('names columns it does not read', () => {
    const { report } = parse([`${HDR},Secondary Contact`, `${R1},someone`].join('\n'))
    expect(report.unmapped).toContain('Secondary Contact')
    expect(report.warnings.join(' ')).toMatch(/not read by the importer/)
  })
})

describe('the MM column header means millions', () => {
  it('reads a bare number in an MM column as millions', () => {
    const { rows } = parse([HDR, R2].join('\n'))
    const beta = rows.find((r) => r.company_name === 'Beta Commercial Capital')!
    expect(beta.deal_size_min_usd).toBe(5_000_000)
    expect(beta.deal_size_max_usd).toBe(25_000_000)
  })

  it('lets an explicit suffix in the cell win', () => {
    const { rows } = parse([HDR, R1].join('\n'))
    const acme = rows.find((r) => r.company_name === 'Acme Equipment Bank')!
    expect(acme.deal_size_min_usd).toBe(1_000_000)
    expect(acme.deal_size_max_usd).toBe(10_000_000)
  })

  it('keeps banking notation when the column does not declare a unit', () => {
    expect(parseLoanAmount('$500M')).toBe(500_000)
    expect(parseLoanAmount('$10MM')).toBe(10_000_000)
    expect(parseLoanAmount('5')).toBe(5)
    expect(parseLoanAmount('5', true)).toBe(5_000_000)
  })
})

describe('a company on several rows keeps every row’s information', () => {
  const row = (over: Partial<ParsedFundingRow>): ParsedFundingRow =>
    ({
      company_name: 'Same Bank',
      primary_contact_name: null,
      primary_contact_email: null,
      asset_classes: [],
      geographic_scope: [],
      internal_notes: '',
      ...over,
    }) as ParsedFundingRow

  it('fills blanks from later rows instead of overwriting with them', () => {
    // Last-wins replaced a complete record with a sparser one whenever the
    // sparser row happened to come second.
    const merged = mergeRows([
      row({ primary_contact_name: 'Jane', asset_classes: ['construction_equipment'] }),
      row({ primary_contact_email: 'john@bank.example', geographic_scope: ['US'] }),
    ])
    expect(merged.primary_contact_name).toBe('Jane')
    expect(merged.primary_contact_email).toBe('john@bank.example')
    expect(merged.asset_classes).toEqual(['construction_equipment'])
    expect(merged.geographic_scope).toEqual(['US'])
  })

  it('never lets a blank in a later row erase an earlier value', () => {
    const merged = mergeRows([
      row({ primary_contact_name: 'Jane', internal_notes: 'real note' }),
      row({ primary_contact_name: null, internal_notes: '' }),
    ])
    expect(merged.primary_contact_name).toBe('Jane')
    expect(merged.internal_notes).toBe('real note')
  })
})
