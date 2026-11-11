import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { toActivityRow, toCsv, toXlsxBuffer, ACTIVITY_COLUMNS } from './activity-report'

// Shaped like the rows the two live call sites actually write: /api/search logs
// the effective criteria + the degradation flags, /api/import logs the whole
// per-file reconciliation. Both come back with the `user:user_id ( email )`
// embed PostgREST returns.
const SEARCH = {
  occurred_at: '2026-09-08T14:22:01.000Z',
  kind: 'search',
  summary: '$4M Caterpillar 320 for a leased fleet in Texas',
  ok: true,
  error: null,
  user: { email: 'pat@yourcompany.example' },
  detail: {
    q: '$4M Caterpillar 320 for a leased fleet in Texas',
    effective: { asset_classes: ['construction_equipment'], us_states: ['TX'], deal_size_max_usd: 4000000 },
    resultCount: 12,
    embedFailed: null,
    graphFailed: null,
    rerankFailed: null,
    totalMs: 2380,
  },
}

const IMPORT_FAILED = {
  occurred_at: '2026-09-07T09:00:00.000Z',
  kind: 'import',
  summary: 'Imported Domestic.xlsx: 120 rows, 100 upserted, 20 skipped',
  ok: false,
  error: 'rows did not reconcile',
  user: [{ email: 'owner@yourcompany.example' }],
  detail: {
    file: 'Domestic.xlsx',
    rowsInSheet: 120,
    rowsParsed: 100,
    rowsSkipped: 20,
    upserted: 100,
    unmappedColumns: ['Broker Notes'],
    reconciles: false,
  },
}

describe('activity report', () => {
  it('uses human column names, not our internal ones', () => {
    for (const col of [
      'Time (UTC)', 'User', 'Action', 'Summary', 'Result', 'Error',
      'Search Query', 'Results Returned', 'File', 'Rows In File',
      'Rows Imported', 'Rows Skipped', 'Funding Source', 'Details',
    ]) {
      expect(ACTIVITY_COLUMNS).toContain(col)
    }
    expect(ACTIVITY_COLUMNS).not.toContain('occurred_at')
    expect(ACTIVITY_COLUMNS).not.toContain('kind')
    expect(ACTIVITY_COLUMNS).not.toContain('detail')
  })

  it('maps a search row, including the criteria the server actually ran on', () => {
    const r = toActivityRow(SEARCH)
    expect(r['Time (UTC)']).toBe('2026-09-08 14:22:01')
    expect(r.User).toBe('pat@yourcompany.example')
    expect(r.Action).toBe('Search')
    expect(r.Result).toBe('OK')
    expect(r['Search Query']).toBe('$4M Caterpillar 320 for a leased fleet in Texas')
    // Numeric, so "which searches returned nothing" sorts in Excel.
    expect(r['Results Returned']).toBe(12)
    expect(r['Duration (s)']).toBe(2.4)
    // `effective` is the whole reason a wrong-results report can be replayed.
    expect(String(r.Details)).toContain('"us_states":["TX"]')
  })

  it('records a failure — the half cost_log cannot, because it only logs successes', () => {
    const r = toActivityRow(IMPORT_FAILED)
    expect(r.Action).toBe('Import')
    expect(r.Result).toBe('Failed')
    expect(r.Error).toBe('rows did not reconcile')
    // The embed arrives as a one-element array on this relationship.
    expect(r.User).toBe('owner@yourcompany.example')
    expect(r.File).toBe('Domestic.xlsx')
    expect(r['Rows In File']).toBe(120)
    expect(r['Rows Imported']).toBe(100)
    expect(r['Rows Skipped']).toBe(20)
    expect(String(r.Details)).toContain('Broker Notes')
  })

  it('never emits null/undefined text into a cell', () => {
    const r = toActivityRow({ occurred_at: '2026-09-08T00:00:00.000Z', kind: 'parse', summary: 'x' })
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === 'string') {
        expect(v, `${k} leaked a placeholder`).not.toMatch(/null|undefined/i)
      }
    }
    // An empty row must still produce every column, or ACTIVITY_COLUMNS is a lie.
    expect(Object.keys(r)).toEqual([...ACTIVITY_COLUMNS])
  })

  it('round-trips through a real workbook', () => {
    const rows = [toActivityRow(SEARCH), toActivityRow(IMPORT_FAILED)]
    const wb = XLSX.read(toXlsxBuffer(rows), { type: 'buffer' })
    expect(wb.SheetNames).toContain('Activity')
    const back = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Activity'])
    expect(back).toHaveLength(2)
    expect(back[0]['User']).toBe('pat@yourcompany.example')
    expect(back[1]['Rows In File']).toBe(120)
  })

  it('emits a CSV with a header row', () => {
    const csv = toCsv([toActivityRow(SEARCH)])
    expect(csv.split('\n')[0]).toContain('Time (UTC)')
    expect(csv).toContain('pat@yourcompany.example')
  })
})
