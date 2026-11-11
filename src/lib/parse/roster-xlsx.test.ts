import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import {
  parseLoanAmount,
  parseAssetClasses,
  parseUsage,
  parseGeo,
  parseAssetSubtypes,
  parseIntlDomestic,
  parseOperationCategory,
  normalizeUsageText,
  parseRosterWorkbook,
  inferInternational,
} from './roster-xlsx'

describe('parseLoanAmount — banking notation', () => {
  it('M = thousand, MM = million', () => {
    expect(parseLoanAmount('$500M')).toBe(500_000)
    expect(parseLoanAmount('$1MM')).toBe(1_000_000)
    expect(parseLoanAmount('$10MM')).toBe(10_000_000)
    expect(parseLoanAmount('$35MM')).toBe(35_000_000)
  })
  it('K + B suffixes', () => {
    expect(parseLoanAmount('$500K')).toBe(500_000)
    expect(parseLoanAmount('1B')).toBe(1_000_000_000)
  })
  it('plain numbers + junk', () => {
    expect(parseLoanAmount('5000000')).toBe(5_000_000)
    expect(parseLoanAmount(null)).toBeNull()
    expect(parseLoanAmount('')).toBeNull()
    expect(parseLoanAmount('n/a')).toBeNull()
  })
})

describe('parseAssetClasses — config ids or labels', () => {
  it('maps ids and labels from src/lib/config/vocabulary.ts', () => {
    expect(parseAssetClasses('equipment, construction_equipment / Medical equipment').sort()).toEqual(
      ['construction_equipment', 'equipment', 'medical_equipment'].sort(),
    )
    expect(parseAssetClasses('Commercial trucks, real estate')).toEqual(['commercial_trucks', 'real_estate'])
  })
  it('ignores unknown tokens', () => {
    expect(parseAssetClasses('vehicles, spaceships')).toEqual(['vehicles'])
  })
})

describe('parseUsage — usage codes', () => {
  it('maps codes, labels and keywords', () => {
    expect(parseUsage('owner, Rental fleet, leased out')).toEqual(['owner', 'lease', 'rental'])
  })
  it('ignores junk', () => {
    expect(parseUsage('n/a')).toEqual([])
  })
})

describe('parseGeo', () => {
  it('drops the CATEGORY word from Target but keeps a real place there', () => {
    // Geographic Target should be US or International; Specific Geography
    // should be states or countries. US is the category and already lives in intl_domestic, so unioning it in duplicated it. Canada is
    // a real place in the same cell and must survive.
    expect(parseGeo('US, Canada', 'IL, WI').sort()).toEqual(['Canada', 'IL', 'WI'].sort())
    expect(parseGeo('All', null)).toEqual([])
  })
})

describe('inferInternational', () => {
  it('detects from filename', () => {
    expect(inferInternational('international-roster.xlsx')).toBe(true)
    expect(inferInternational('domestic-roster.xlsx')).toBe(false)
  })
})

describe('0017 structured-field mappers', () => {
  it('parseAssetSubtypes keeps the configured subtypes, canonical spelling', () => {
    expect(parseAssetSubtypes('new, USED / Refurbished')).toEqual(['New', 'Used', 'Refurbished'])
    expect(parseAssetSubtypes('X,Y')).toEqual([])
    expect(parseAssetSubtypes(null)).toEqual([])
  })
  it('parseIntlDomestic', () => {
    expect(parseIntlDomestic('I')).toBe('International')
    expect(parseIntlDomestic('D')).toBe('Domestic')
    expect(parseIntlDomestic('I, D')).toBe('Both')
    expect(parseIntlDomestic(null)).toBeNull()
  })
  it('parseOperationCategory', () => {
    expect(parseOperationCategory('Personal')).toBe('Personal')
    expect(parseOperationCategory('commercial use')).toBe('Commercial')
    expect(parseOperationCategory('Commercial, Personal')).toBe('Personal, Commercial')
    expect(parseOperationCategory('Both')).toBe('Personal, Commercial')
    expect(parseOperationCategory('unknown')).toBeNull()
    expect(parseOperationCategory(null)).toBeNull()
  })
  it('normalizeUsageText keeps known usage codes only, config order', () => {
    expect(normalizeUsageText('lease,owner')).toBe('owner, lease')
    expect(normalizeUsageText('Owner-operated; Rental fleet')).toBe('owner, rental')
    expect(normalizeUsageText('n/a')).toBeNull()
  })
})

describe('parseRosterWorkbook — full row maps every 0017 column', () => {
  // Template headers (irregular whitespace on purpose — exercises the resolver).
  const HEADERS = [
    'Type:   (B) Bank (C) Credit Union (NB) Non Bank (PE) Private Equity',
    'Account Name',
    'First Name',
    'Last Name',
    'Main Contact ',
    'Email',
    'Loan Minimum MM',
    'Loan Maximum MM',
    '(I) International (D) Domestic    ',
    'Geographic  Target',
    'Specific Geographic',
    'Asset  Classes',
    'Asset Subtypes ',
    'Usage:  owner, lease, rental',
    'Operation Category   ',
    'Vintage Restriction ',
    'Lending Status ',
    'Bank Paid Fee',
    'Notes:',
  ]
  const ROW = [
    'NB',
    '1st Deneb Bank',
    'Charlie',
    'Sample',
    'Casey Sample',
    'csample@1stdenebbank.example.com',
    '$500M',
    '$10MM',
    'D',
    'US',
    'IL, WI, IA',
    'construction_equipment, Medical equipment',
    'New, Used',
    'owner,lease',
    'Commercial',
    '2000 or newer',
    'Yes',
    'Y',
    'Great relationship.',
  ]

  it('populates all structured columns from the spreadsheet row', () => {
    const ws = XLSX.utils.aoa_to_sheet([HEADERS, ROW])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
    const { rows } = parseRosterWorkbook(wb, { isInternational: false })
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.company_name).toBe('1st Deneb Bank')
    expect(r.primary_contact_name).toBe('Casey Sample')
    expect(r.primary_contact_email).toBe('csample@1stdenebbank.example.com')
    expect(r.deal_size_min_usd).toBe(500_000)
    expect(r.deal_size_max_usd).toBe(10_000_000)
    expect(r.lender_type).toBe('Non Bank')
    expect(r.intl_domestic).toBe('Domestic')
    // US is NOT here: it is the category, stored in intl_domestic. Specific
    // Geographic names the places, and those are the places.
    expect(r.geographic_scope).not.toContain('US')
    expect(r.geographic_scope).toEqual(['IL', 'WI', 'IA'])
    expect(r.specific_geographic).toBe('IL, WI, IA')
    expect(r.asset_classes).toEqual(['construction_equipment', 'medical_equipment'])
    expect(r.asset_subtypes).toEqual(['New', 'Used'])
    expect(r.usage_codes).toBe('owner, lease')
    expect(r.operation_category).toBe('Commercial')
    expect(r.vintage_restriction).toBe('2000 or newer')
    expect(r.lending_status).toBe('Yes')
    expect(r.bank_paid_fee).toBe('Y')
    expect(r.internal_notes).toBe('Great relationship.')
  })
})

describe('parseRosterWorkbook — a gap in the header row', () => {
  // Seen on real Domestic/International workbooks:
  //   TypeError: Cannot read properties of undefined (reading 'toLowerCase')
  // A header row with an EMPTY cell between populated ones makes
  // sheet_to_json(header:1) return a SPARSE array. Array.map preserves holes,
  // so the column list carried an undefined; Array.find visits holes, and the
  // resolver called .toLowerCase() on it. Crashes the drag-drop import too,
  // since both paths share this parser.
  function sheetWithHeaderGap(): XLSX.WorkBook {
    const ws = XLSX.utils.aoa_to_sheet([
      // index 1 is deliberately absent, not empty-string — that is what makes
      // the row sparse rather than merely blank.
      ['Type', undefined, 'Account Name', 'Main Contact', 'Lending Status'],
      ['B', undefined, 'Gap Test Bank', 'A Person', 'Yes'],
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
    return wb
  }

  it('does not throw, and still reads the row', () => {
    expect(() => parseRosterWorkbook(sheetWithHeaderGap(), { isInternational: false })).not.toThrow()
    const res = parseRosterWorkbook(sheetWithHeaderGap(), { isInternational: false })
    expect(res.rows).toHaveLength(1)
    expect(res.rows[0].company_name).toBe('Gap Test Bank')
    expect(res.rows[0].primary_contact_name).toBe('A Person')
  })
})

describe('parseGeo — Target is the category, Specific is the place list', () => {
  // A Domestic sheet row: D | US | IL, WI, IA, MO,KY, IN, MI
  // The union used to produce ["US","IL",…], re-adding the redundant US that the
  // stored record had correctly without — a sync proposing a regression.
  it('uses Specific alone when it names places', () => {
    expect(parseGeo('US', 'IL, WI, IA, MO,KY, IN, MI')).toEqual([
      'IL', 'WI', 'IA', 'MO', 'KY', 'IN', 'MI',
    ])
  })

  it('falls back to Target when Specific is blank', () => {
    expect(parseGeo('US', '')).toEqual(['US'])
    expect(parseGeo('Brazil, Mexico', null)).toEqual(['Brazil', 'Mexico'])
  })

  it('still drops the empty word "All"', () => {
    expect(parseGeo('US', 'All')).toEqual(['US'])
    expect(parseGeo('All', '')).toEqual([])
  })
})
