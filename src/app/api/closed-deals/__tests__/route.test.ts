// @vitest-environment node
/**
 * The six ways a Past Deals upload dies before the AI is ever reached — pinned.
 *
 * Users reported "Past Deals document importing does not work". The AI hop had already been given its own 503,
 * but these failures happen EARLIER than the AI hop: `extractPdfText` and
 * `spreadsheetToText` sat outside any try/catch, so a locked PDF, a scan, or a
 * broken workbook threw out of POST as an unhandled 500, which `humanError()`
 * renders to the operator as "Something went wrong on our end." The fix
 * gave each one a 422 and a sentence naming the next move.
 *
 * WHY THIS FILE IS DRIVEN THROUGH THE REAL PARSERS.
 * One of those six guards — the empty-workbook one — already existed before
 * that fix and had never fired once, because `spreadsheetToText` always prepends
 * `Filename: <name>` so the old `if (!text)` could not be true. Empty workbooks
 * went to the model with nothing but a filename, and whatever it invented was
 * saved as a past deal; past deals feed the search ranking boost, so a guard
 * that merely LOOKED correct was an accuracy defect. Two of the guards standing
 * today are that same `!text` shape and can rot back into dead code under a
 * green suite. So `unpdf` and `xlsx` are REAL here and every fixture is real
 * bytes built in-process — mocking the readers would rebuild the exact hole
 * this file exists to cover. Only the four boundaries are mocked: auth, the
 * database, the LLM extractor, and the graph indexer.
 *
 * Fixture provenance, all [VERIFIED] by running the real readers:
 *   - PDF with an /Encrypt trailer entry → pdfjs `PasswordException: No
 *     password given`, the same throw the route's docblock records for a real
 *     loan doc encrypted with qpdf AES-256.
 *   - non-PDF bytes            → pdfjs `InvalidPDFException: Invalid PDF structure.`
 *   - blank single-page PDF    → resolves to '' (no throw)
 *   - half an .xlsx            → SheetJS `Error: Unsupported ZIP file`
 *   - .xlsx with the ZIP encryption bit set → SheetJS `Error: Unsupported ZIP encryption`
 *   - workbook of empty rows   → exactly "Filename: deal.xlsx", nothing else
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import * as XLSX from 'xlsx'

const DB_USER_ID = '11111111-2222-3333-4444-555555555555'

/**
 * Only the boundaries. The extractor stands in for the on-prem LLM hop, and the
 * spy on it is the actual assertion in the empty-workbook case: the bug was not
 * a wrong message, it was reaching the model at all.
 */
const H = vi.hoisted(() => {
  const parseLogRows: Record<string, unknown>[] = []
  const closedDealRows: Record<string, unknown>[] = []
  const extractClosedDeal = vi.fn()
  const resolveFundingSourceId = vi.fn()
  const indexGraphForClosedDeal = vi.fn()

  const admin = {
    from(table: string) {
      if (table === 'users') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: '11111111-2222-3333-4444-555555555555', role: 'admin' },
                error: null,
              }),
            }),
          }),
        }
      }
      if (table === 'parse_logs') {
        return {
          // supabase-js RESOLVES with { error }; it does not throw. Modelled that
          // way on purpose — the route's own comment records that the difference
          // is what hid two months of rejected 'spreadsheet' rows.
          insert: async (row: Record<string, unknown>) => {
            parseLogRows.push(row)
            return { error: null }
          },
        }
      }
      if (table === 'closed_deal') {
        return {
          insert: (row: Record<string, unknown>) => {
            closedDealRows.push(row)
            return {
              select: () => ({
                single: async () => ({ data: { id: 'cd-0001', ...row }, error: null }),
              }),
            }
          },
        }
      }
      throw new Error(`unexpected table in test: ${table}`)
    },
  }

  return { parseLogRows, closedDealRows, extractClosedDeal, resolveFundingSourceId, indexGraphForClosedDeal, admin }
})

vi.mock('@/lib/auth/require-authorized', () => ({
  requireAuthorizedApiUser: async () => ({
    ok: true,
    userId: 'user_2fOperatorTest',
    email: 'pat@yourcompany.example',
  }),
}))
vi.mock('@/lib/supabase/admin', () => ({ getSupabaseAdmin: () => H.admin }))
vi.mock('@/lib/parse/closed-deal-extract', () => ({
  extractClosedDeal: H.extractClosedDeal,
  resolveFundingSourceId: H.resolveFundingSourceId,
}))
vi.mock('@/lib/graph/index-funding-source', () => ({
  indexGraphForClosedDeal: H.indexGraphForClosedDeal,
}))

import { POST } from '../route'

/**
 * The exact sentences the operator reads. Copied verbatim out of
 * FILE_PARSE_MESSAGE in the route — if a word of one changes, that is a
 * client-facing copy change and it should have to be made in two places.
 */
const MSG = {
  pdf_encrypted:
    'This PDF is password-protected, so remove the password in your PDF reader and upload it again.',
  pdf_unreadable:
    'This file could not be opened as a PDF, so it is damaged or is not a PDF; upload the original as a PDF or Excel file.',
  pdf_no_text_layer:
    'This PDF is a scan with no selectable text, so upload a copy exported from the original document rather than a scan.',
  spreadsheet_encrypted:
    'This spreadsheet is password-protected, so remove the password in Excel and upload it again.',
  spreadsheet_unreadable:
    'This spreadsheet could not be opened, so re-save it as .xlsx or .csv and upload it again.',
  spreadsheet_empty:
    'This spreadsheet has no readable rows, so check the deal details are in the file and upload it again.',
} as const

/** What a clean term-sheet extraction returns — a typical working example. */
const CLEAN_EXTRACT = {
  bank_name: 'Canopus Equipment Capital',
  asset_year: 2005,
  asset_make: 'Caterpillar',
  asset_model: '320',
  loan_amount_usd: 4_200_000,
  purchase_price_usd: 5_250_000,
  rate_pct: 6.75,
  ltv_pct: 80,
  prepayment_penalty: '3% Y1, 2% Y2, 1% Y3',
  fees: { origination: 0.005 },
  closed_on: '2026-05-14',
}

beforeEach(() => {
  H.parseLogRows.length = 0
  H.closedDealRows.length = 0
  vi.clearAllMocks()
  H.extractClosedDeal.mockResolvedValue(CLEAN_EXTRACT)
  H.resolveFundingSourceId.mockResolvedValue(null)
  H.indexGraphForClosedDeal.mockResolvedValue({ entities: 0, edges: 0 })
  // The route console.errors every one of these on purpose (it is the only
  // signal when the parse_logs write also fails). Keep it out of the run output.
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** The Past Deals uploader posts multipart with a `file` part. Nothing else. */
function upload(bytes: Buffer, filename: string, mime: string): NextRequest {
  const form = new FormData()
  form.append('file', new File([new Uint8Array(bytes)], filename, { type: mime }))
  form.append('source_kind', 'term_sheet')
  return new NextRequest('https://your-app.vercel.app/api/closed-deals', {
    method: 'POST',
    body: form,
  })
}

async function post(bytes: Buffer, filename: string, mime: string) {
  const res = await POST(upload(bytes, filename, mime))
  return { status: res.status, body: (await res.json()) as { error?: string } }
}

describe('Past Deals upload — a PDF the reader cannot open', () => {
  it('names the password instead of showing "Something went wrong on our end"', async () => {
    // Real bytes: a PDF carrying an /Encrypt entry in its trailer, which is what
    // makes pdfjs throw PasswordException before it reads a single page. Same
    // throw as the qpdf AES-256 loan doc in the route's docblock, and
    // the reason `looksEncrypted` matches on the message rather than the type.
    const { status, body } = await post(makeEncryptedPdf(), 'locked term sheet.pdf', 'application/pdf')
    expect(status).toBe(422)
    expect(body.error).toBe(MSG.pdf_encrypted)
  })

  it('does not blame the password when the file simply is not a PDF', async () => {
    // A .pdf that is really a phone photo or a truncated download. Distinct
    // message because the fix is different: re-export, not unlock. This route
    // reads PDFs and spreadsheets only, so a JPEG renamed .pdf lands here.
    const { status, body } = await post(
      Buffer.from('\xff\xd8\xff\xe0 not a pdf at all', 'latin1'),
      'scan.pdf',
      'application/pdf',
    )
    expect(status).toBe(422)
    expect(body.error).toBe(MSG.pdf_unreadable)
  })

  it('tells a scan apart from a broken file — the one failure whose fix is a different copy', async () => {
    // The `!text` guard. `extractPdfText` RESOLVES with '' for a text-less PDF
    // rather than throwing, so this branch is only reachable through the empty
    // string — exactly the shape that went dead on the spreadsheet side.
    const { status, body } = await post(makeBlankPdf(), 'closing binder scan.pdf', 'application/pdf')
    expect(status).toBe(422)
    expect(body.error).toBe(MSG.pdf_no_text_layer)
  })
})

describe('Past Deals upload — a workbook the reader cannot open', () => {
  it('answers a corrupt or half-transferred .xlsx with a re-save, not a 500', async () => {
    // Real bytes: the first half of a genuine xlsx. SheetJS throws
    // "Unsupported ZIP file" — no "password"/"encrypt" in it, so it must NOT be
    // classified as locked.
    const good = workbook([['Bank', 'Example Capital'], ['Amount', '1,000,000']])
    const { status, body } = await post(
      good.subarray(0, Math.floor(good.length / 2)),
      'Caterpillar 320 leasing model.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    expect(status).toBe(422)
    expect(body.error).toBe(MSG.spreadsheet_unreadable)
  })

  it('routes a locked workbook to the Excel-password sentence, not the re-save one', async () => {
    // Real bytes, real throw: a genuine xlsx with the ZIP general-purpose
    // encryption bit set, which SheetJS rejects with "Unsupported ZIP
    // encryption". A real AES-encrypted leasing model throws SheetJS's other
    // phrasing, "File is password-protected"; both are /password|encrypt/i, which
    // is why `looksEncrypted` is one predicate over the message and not a list of
    // error types. This fixture pins the encryption-bit phrasing only — an
    // ECMA-376 AES workbook cannot be written without adding a dependency.
    const { status, body } = await post(
      zipEncryptionBitSet(workbook([['Amount (USD)', '1,500,000.00'], ['Product', 'Lease']])),
      'Caterpillar 320 leasing model.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    expect(status).toBe(422)
    expect(body.error).toBe(MSG.spreadsheet_encrypted)
  })
})

describe('Empty workbook — the guard that existed and had never once fired', () => {
  /**
   * The regression this whole file is for. `spreadsheetToText` always prepends
   * `Filename: <name>`, so the pre-fix `if (!text)` could never be true. An
   * empty workbook was handed to the model as the literal string
   * "Filename: deal.xlsx", and whatever the model returned from a filename was
   * written to closed_deal — which the search ranking then boosts on. The fix
   * strips the header before deciding; these two tests are what keep it stripped.
   */
  it('stops an empty workbook BEFORE the model, not after', async () => {
    const { status, body } = await post(
      workbook([]),
      'deal.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    expect(status).toBe(422)
    expect(body.error).toBe(MSG.spreadsheet_empty)
    // The load-bearing line. A 422 that still burned an LLM call and still wrote
    // a row would pass every assertion above and reproduce the original bug.
    expect(H.extractClosedDeal).not.toHaveBeenCalled()
    expect(H.closedDealRows).toHaveLength(0)
  })

  it('also catches the blank-row and numbers-only workbooks that flatten to the same thing', async () => {
    // [VERIFIED] all three of these return exactly "Filename: deal.xlsx":
    // no rows, three empty rows, and a sheet of bare numbers (spreadsheetToText
    // drops rows with no word-like cell as amortization-schedule noise).
    for (const rows of [[[], [], []], [[1, 2], [3, 4]]]) {
      const { status, body } = await post(
        workbook(rows),
        'deal.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      )
      expect(status).toBe(422)
      expect(body.error).toBe(MSG.spreadsheet_empty)
    }
    expect(H.extractClosedDeal).not.toHaveBeenCalled()
  })
})

describe('A failed import leaves a row behind', () => {
  it('logs the unreadable upload to parse_logs with no model attributed to it', async () => {
    // A parse that dies here never reaches writeParseLog, so before the fix a
    // failed import left nothing at all: no count, no filename, no reason. The
    // 'none' provider/model is how these rows are told apart from real parses.
    await post(makeBlankPdf(), 'closing binder scan.pdf', 'application/pdf')
    expect(H.parseLogRows).toHaveLength(1)
    expect(H.parseLogRows[0]).toMatchObject({
      user_id: DB_USER_ID,
      input_modality: 'pdf',
      llm_provider: 'none',
      llm_model: 'none',
      parsed_output: { error: 'pdf_no_text_layer' },
      fallback_used: false,
    })
    expect(String(H.parseLogRows[0].raw_input)).toContain('[unreadable upload: pdf_no_text_layer]')
    expect(String(H.parseLogRows[0].raw_input)).toContain('closing binder scan.pdf')
  })
})

describe('Control — a readable file still imports', () => {
  it('reaches the extractor and returns the inserted deal unchanged', async () => {
    // If any guard above starts firing on a good file, the six 422s stop being
    // guards and become an outage. This is the case that would catch that.
    const res = await POST(
      upload(
        workbook([
          ['Lender', 'Canopus Equipment Capital'],
          ['Asset', '2005 Caterpillar 320'],
          ['Loan amount', '4,200,000'],
        ]),
        'Caterpillar 320 term sheet.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
    )
    expect(res.status).toBe(201)

    expect(H.extractClosedDeal).toHaveBeenCalledTimes(1)
    // The real spreadsheetToText output, not a stub: filename hint + sheet rows.
    const textSentToModel = H.extractClosedDeal.mock.calls[0][1] as string
    expect(textSentToModel).toContain('Filename: Caterpillar 320 term sheet.xlsx')
    expect(textSentToModel).toContain('Canopus Equipment Capital')

    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      id: 'cd-0001',
      funding_source_id: null,
      asset_year: 2005,
      asset_make: 'Caterpillar',
      asset_model: '320',
      loan_amount_usd: 4_200_000,
      purchase_price_usd: 5_250_000,
      rate_pct: 6.75,
      ltv_pct: 80,
      prepayment_penalty: '3% Y1, 2% Y2, 1% Y3',
      fees: { origination: 0.005 },
      closed_on: '2026-05-14',
      source_document_url: null,
      source_kind: 'term_sheet',
      created_by: DB_USER_ID,
    })
    // bank_name is resolved to a funding_source_id, never stored as free text.
    expect(body).not.toHaveProperty('bank_name')
    expect(H.resolveFundingSourceId).toHaveBeenCalledWith(H.admin, 'Canopus Equipment Capital')

    // Success writes the real telemetry row, with a model attributed.
    expect(H.parseLogRows).toHaveLength(1)
    expect(H.parseLogRows[0]).toMatchObject({ input_modality: 'spreadsheet', llm_provider: 'ai-sdk-v6' })
    // Past deals feed the search ranking boost, so the new row gets graphed.
    expect(H.indexGraphForClosedDeal).toHaveBeenCalledTimes(1)
  })

  it('imports a readable PDF too — the guards are per-format, not a blanket reject', async () => {
    // The committed sample with a known text layer, the same fixture
    // pdf-text.test.ts asserts "Caterpillar 320" out of.
    const sampleLoan = readFileSync(join(__dirname, '../../../../lib/parse/__tests__/fixtures/sample-loan.pdf'))
    const res = await POST(upload(sampleLoan, 'Caterpillar 320 loan.pdf', 'application/pdf'))
    expect(res.status).toBe(201)
    expect(H.extractClosedDeal).toHaveBeenCalledTimes(1)
    expect(H.extractClosedDeal.mock.calls[0][1] as string).toContain('Caterpillar 320')
    expect(H.parseLogRows[0]).toMatchObject({ input_modality: 'pdf' })
  })
})

// ---------------------------------------------------------------------------
// Fixtures. All generated in-process: no binary files committed, no external
// tool (qpdf, Excel) required to run the suite.
// ---------------------------------------------------------------------------

/** A real .xlsx as bytes, same helper shape as spreadsheet-text.test.ts. */
function workbook(rows: unknown[][], sheetName = 'Sheet1'): Buffer {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName)
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

/**
 * Flip the ZIP general-purpose "encrypted" bit on every local header and
 * central-directory entry, which is what an unreadable locked workbook looks
 * like to SheetJS from the outside.
 */
function zipEncryptionBitSet(xlsx: Buffer): Buffer {
  const out = Buffer.from(xlsx)
  for (let i = 0; i + 4 <= out.length; i++) {
    const sig = out.readUInt32LE(i)
    if (sig === 0x04034b50) out.writeUInt16LE(out.readUInt16LE(i + 6) | 1, i + 6)
    else if (sig === 0x02014b50) out.writeUInt16LE(out.readUInt16LE(i + 8) | 1, i + 8)
  }
  return out
}

/**
 * Minimal valid single-page PDF with no content stream → no text layer.
 * Copied verbatim from `src/lib/parse/__tests__/pdf-text.test.ts`, where the
 * same bytes pin `extractPdfText` resolving to '' instead of throwing. Kept in
 * sync by hand: that file does not export it, and this file is the only one
 * that may change in this task.
 */
function makeBlankPdf(): Buffer {
  return assemblePdf([
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>',
  ])
}

/**
 * The same PDF with a standard-security /Encrypt dictionary referenced from the
 * trailer. pdfjs reads the trailer before any page, sees the encrypt dict and
 * no password, and throws `PasswordException: No password given` (code 1) —
 * byte-for-byte the classification path a real qpdf AES-256 file takes.
 */
function makeEncryptedPdf(): Buffer {
  return assemblePdf(
    [
      '<</Type/Catalog/Pages 2 0 R>>',
      '<</Type/Pages/Kids[3 0 R]/Count 1>>',
      '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>',
      `<</Filter/Standard/V 1/R 2/O <${'a1'.repeat(32)}>/U <${'b2'.repeat(32)}>/P -1>>`,
    ],
    '/Encrypt 4 0 R/ID[<0102030405060708090a0b0c0d0e0f10><0102030405060708090a0b0c0d0e0f10>]',
  )
}

/** Objects → a byte-accurate xref table → trailer. */
function assemblePdf(objs: string[], extraTrailer = ''): Buffer {
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((body, i) => {
    offsets[i] = Buffer.byteLength(pdf, 'latin1')
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefStart = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  offsets.forEach((off) => {
    pdf += String(off).padStart(10, '0') + ' 00000 n \n'
  })
  pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R${extraTrailer}>>\nstartxref\n${xrefStart}\n%%EOF`
  return Buffer.from(pdf, 'latin1')
}
