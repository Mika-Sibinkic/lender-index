import * as XLSX from 'xlsx'

/**
 * Flatten an uploaded spreadsheet (xlsx / xls / csv) into text for the AI
 * extractor. Term sheets such as an equipment leasing model put the
 * indicative summary (currency, amount, product, term, residual) in the TOP
 * rows of each sheet, then long amortization/payment schedules below. We keep
 * the summary-dense head of each sheet and drop the repetitive schedule rows so
 * the model isn't buried in noise.
 *
 * The filename is prepended as a hint — assets are often only named there
 * (e.g. "Caterpillar 320" = an excavator), not in the sheet body.
 */
export function spreadsheetToText(
  input: Buffer | ArrayBuffer,
  filename: string,
  opts: { maxRowsPerSheet?: number; maxChars?: number; maxCellLen?: number } = {},
): string {
  const maxRows = opts.maxRowsPerSheet ?? 30
  const maxChars = opts.maxChars ?? 12_000
  const maxCellLen = opts.maxCellLen ?? 120
  const wb = XLSX.read(input, { type: 'buffer' })
  const hasWord = (s: string) => /[a-zà-ú]{3,}/i.test(s)
  const parts: string[] = [`Filename: ${filename}`]
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name]
    if (!ws) continue
    // raw:false → formatted strings ("2.50%", "1,500,000.00") instead of raw floats.
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false, raw: false })
    const lines: string[] = []
    for (const row of rows.slice(0, maxRows)) {
      // Keep label/value cells; drop empties (CSV comma-runs) and giant cells
      // (long legal/tax boilerplate) that are noise for field extraction.
      const cells = (row ?? [])
        .map((c) => (c == null ? '' : String(c).replace(/\s+/g, ' ').trim()))
        .filter((c) => c && c.length <= maxCellLen)
      // Skip number/date-only rows (amortization schedules) — keep rows with a
      // real label/word so the indicative summary survives, the schedule doesn't.
      if (cells.length && cells.some(hasWord)) lines.push(cells.join(' | '))
    }
    if (lines.length) parts.push(`--- Sheet: ${name} ---\n${lines.join('\n')}`)
  }
  return parts.join('\n\n').slice(0, maxChars)
}
