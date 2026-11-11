import { describe, it, expect, vi } from 'vitest'
import { ClosedDealExtractSchema, resolveFundingSourceId, normalizeClosedOn, blankToNull } from './closed-deal-extract'

describe('ClosedDealExtractSchema', () => {
  it('accepts a fully-populated record', () => {
    const out = ClosedDealExtractSchema.parse({
      asset_year: 1987,
      asset_make: 'Caterpillar',
      asset_model: '320',
      loan_amount_usd: 1_250_000,
      purchase_price_usd: 1_500_000,
      rate_pct: 8.25,
      ltv_pct: 83.3,
      prepayment_penalty: '3% Y1, 2% Y2, 1% Y3',
      fees: { origination: 0.005, doc: 1500 },
      closed_on: '2024-09-12',
      bank_name: 'Altair Bank',
    })
    expect(out.asset_year).toBe(1987)
    expect(out.fees).toEqual({ origination: 0.005, doc: 1500 })
  })

  it('accepts nulls everywhere', () => {
    const out = ClosedDealExtractSchema.parse({
      asset_year: null,
      asset_make: null,
      asset_model: null,
      loan_amount_usd: null,
      purchase_price_usd: null,
      rate_pct: null,
      ltv_pct: null,
      prepayment_penalty: null,
      fees: null,
      closed_on: null,
      bank_name: null,
    })
    expect(out.asset_year).toBeNull()
  })

  // The schema no longer rejects a malformed closed_on — a regex here crashes the
  // on-prem model runner (see the normalizeClosedOn block below). The guarantee
  // that a junk date never reaches the DB moved to normalizeClosedOn, which the
  // extractor applies to every result.
  it('a malformed closed_on becomes null rather than reaching the row', () => {
    const parsed = ClosedDealExtractSchema.parse({
      asset_year: null,
      asset_make: null,
      asset_model: null,
      loan_amount_usd: null,
      purchase_price_usd: null,
      rate_pct: null,
      ltv_pct: null,
      prepayment_penalty: null,
      fees: null,
      closed_on: 'September 2024',
      bank_name: null,
    })
    expect(normalizeClosedOn(parsed.closed_on)).toBeNull()
  })

  it('rejects unknown fields not in schema', () => {
    // Zod object is strict by default? It's not — z.object accepts extras
    // unless .strict() is used. This test just documents that behavior so
    // anyone tightening the schema later sees it explicitly.
    const out = ClosedDealExtractSchema.parse({
      asset_year: null,
      asset_make: null,
      asset_model: null,
      loan_amount_usd: null,
      purchase_price_usd: null,
      rate_pct: null,
      ltv_pct: null,
      prepayment_penalty: null,
      fees: null,
      closed_on: null,
      bank_name: null,
      stray_field: 'ignored',
    } as never)
    expect((out as Record<string, unknown>).stray_field).toBeUndefined()
  })
})

describe('resolveFundingSourceId', () => {
  /**
   * Builds a Supabase mock whose two ILIKE passes resolve in order:
   *   pass 1 (exact)    → .ilike(...).limit(1).maybeSingle()  → exactRow
   *   pass 2 (fallback) → .ilike(...).limit(2)  (awaited array) → fuzzyRows
   * Captures every (column, pattern) pair the code asks ILIKE for.
   */
  function makeSupabase(opts: {
    exactRow?: { id: string } | null
    fuzzyRows?: Array<{ id: string }>
  }) {
    const ilikeCalls: Array<[string, string]> = []
    let call = 0
    const select = vi.fn(() => ({
      ilike: (column: string, pattern: string) => {
        ilikeCalls.push([column, pattern])
        call += 1
        if (call === 1) {
          // Exact pass: .limit(1).maybeSingle()
          return {
            limit: () => ({
              maybeSingle: vi
                .fn()
                .mockResolvedValue({ data: opts.exactRow ?? null, error: null }),
            }),
          }
        }
        // Fallback pass: .limit(2) is itself awaited (thenable resolving to rows).
        return {
          limit: () =>
            Promise.resolve({ data: opts.fuzzyRows ?? [], error: null }),
        }
      },
    }))
    const from = vi.fn(() => ({ select }))
    return { sb: { from } as never, ilikeCalls }
  }

  it('returns null when bankName is null', async () => {
    const sb = { from: vi.fn() } as never
    expect(await resolveFundingSourceId(sb, null)).toBeNull()
  })

  it('returns null when bankName is empty', async () => {
    const sb = { from: vi.fn() } as never
    expect(await resolveFundingSourceId(sb, '')).toBeNull()
  })

  it('returns null when bankName is whitespace-only', async () => {
    const sb = { from: vi.fn() } as never
    expect(await resolveFundingSourceId(sb, '   ')).toBeNull()
  })

  it('returns the exact (case-insensitive, trimmed) match without a fallback pass', async () => {
    const { sb, ilikeCalls } = makeSupabase({ exactRow: { id: 'fs-1' } })
    const id = await resolveFundingSourceId(sb, '  Altair Bank  ')
    expect(id).toBe('fs-1')
    // Only the exact pass should have run — literal name, no % wildcards.
    expect(ilikeCalls).toEqual([['company_name', 'Altair Bank']])
  })

  it('falls back to a single substring candidate when there is no exact match', async () => {
    const { sb, ilikeCalls } = makeSupabase({
      exactRow: null,
      fuzzyRows: [{ id: 'fs-7' }],
    })
    const id = await resolveFundingSourceId(sb, 'Altair')
    expect(id).toBe('fs-7')
    expect(ilikeCalls).toEqual([
      ['company_name', 'Altair'],
      ['company_name', '%Altair%'],
    ])
  })

  it('returns null when the substring fallback is AMBIGUOUS (never guesses the lender)', async () => {
    const { sb } = makeSupabase({
      exactRow: null,
      fuzzyRows: [{ id: 'fs-1' }, { id: 'fs-2' }],
    })
    expect(await resolveFundingSourceId(sb, 'Bank')).toBeNull()
  })

  it('returns null when neither pass matches', async () => {
    const { sb } = makeSupabase({ exactRow: null, fuzzyRows: [] })
    expect(await resolveFundingSourceId(sb, 'No Such Bank')).toBeNull()
  })

  it('escapes ilike wildcards in bank name across both passes', async () => {
    const { sb, ilikeCalls } = makeSupabase({ exactRow: null, fuzzyRows: [] })
    await resolveFundingSourceId(sb, '100% Bank_Co')
    // % and _ escaped with backslash; exact pass uses the literal, fallback wraps it.
    expect(ilikeCalls).toEqual([
      ['company_name', '100\\% Bank\\_Co'],
      ['company_name', '%100\\% Bank\\_Co%'],
    ])
  })
})

// The schema must stay free of regex patterns. The on-prem backend turns this
// schema into a GBNF grammar; a pattern made it emit the literal "\dddd-\dd-\dd"
// on a short prompt and crash the model runner on a real document. Date shape is
// enforced by normalizeClosedOn afterwards instead.
describe('closed_on — normalized in code, never constrained in the schema', () => {
  it('the schema itself does not constrain the date string', () => {
    const parsed = ClosedDealExtractSchema.parse({
      asset_year: null, asset_make: null, asset_model: null,
      loan_amount_usd: null, purchase_price_usd: null, rate_pct: null, ltv_pct: null,
      prepayment_penalty: null, fees: null, closed_on: '31/05/2026', bank_name: null,
    })
    expect(parsed.closed_on).toBe('31/05/2026')
  })

  it('passes ISO through', () => {
    expect(normalizeClosedOn('2026-05-31')).toBe('2026-05-31')
    expect(normalizeClosedOn('2026-5-3')).toBe('2026-05-03')
  })

  it('reads an ambiguous slash date day-first (Brazil / Europe deal flow)', () => {
    expect(normalizeClosedOn('05/06/2026')).toBe('2026-06-05')
    expect(normalizeClosedOn('31/05/2026')).toBe('2026-05-31')
    expect(normalizeClosedOn('31.05.2026')).toBe('2026-05-31')
  })

  it('flips to month-first only when day-first is impossible', () => {
    expect(normalizeClosedOn('05/31/2026')).toBe('2026-05-31')
  })

  it('returns null rather than a wrong date', () => {
    for (const bad of ['', null, undefined, 'sometime in May', '2026-13-01', '31/02/2026', '\\dddd-\\dd-\\dd']) {
      expect(normalizeClosedOn(bad as string | null)).toBeNull()
    }
  })
})

// Observed on a real deal sheet: the model returned prepayment_penalty "None"
// and the broker's own name as bank_name for a document that states neither. A placeholder
// string reads as data downstream and gets indexed; null reads as a gap the
// intake card asks a human to fill.
describe('blankToNull — a placeholder is not a value', () => {
  it('nulls the usual placeholders', () => {
    for (const p of ['', '  ', 'N/A', 'n/a', 'unknown', 'Not specified', 'TBD', '-', 'null', 'None']) {
      expect(blankToNull(p)).toBeNull()
    }
    expect(blankToNull(null)).toBeNull()
    expect(blankToNull(undefined)).toBeNull()
  })

  it('keeps a real value', () => {
    expect(blankToNull('Altair Bank')).toBe('Altair Bank')
    expect(blankToNull('  Caterpillar 320  ')).toBe('Caterpillar 320')
  })

  it('keeps "none" for prepayment_penalty, where it is a real answer', () => {
    expect(blankToNull('none', { keepNone: true })).toBe('none')
    expect(blankToNull('N/A', { keepNone: true })).toBeNull()
  })
})
