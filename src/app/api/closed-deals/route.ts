/**
 * POST /api/closed-deals
 *
 * Body shapes:
 *   - multipart/form-data with a `file` (PDF, < 4.5 MB) — extract via unpdf + llm
 *   - application/json with `storage_path` — large PDF uploaded to Supabase
 *     Storage first (bypasses Vercel's 4.5 MB body limit); fetched + deleted here
 *   - application/json with `text` — extract direct
 *   - application/json with already-structured fields — insert verbatim
 *
 * On insert:
 *   - tries to resolve funding_source_id from extracted bank_name
 *   - if explicit `funding_source_id` provided in the body, it wins
 *
 * Returns the inserted closed_deal row.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuthorizedApiUser } from '@/lib/auth/require-authorized'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { extractClosedDeal, resolveFundingSourceId } from '@/lib/parse/closed-deal-extract'
import { classifyAiError, aiFailureMessage, aiFailureStatus } from '@/lib/ai/failure'
import { extractPdfText } from '@/lib/parse/pdf-text'
import { spreadsheetToText } from '@/lib/parse/spreadsheet-text'
import { indexGraphForClosedDeal } from '@/lib/graph/index-funding-source'

/**
 * The already-structured insert path ("Path 4"), validated.
 *
 * Every field optional because callers legitimately post partial deals, but the
 * SHAPE is now checked and unknown keys are stripped. An empty result is
 * rejected below rather than inserted as a row of nulls.
 */
const DirectInsert = z
  .object({
    funding_source_id: z.string().uuid().nullable().optional(),
    source_kind: z.enum(['term_sheet', 'proposal', 'loan_doc', 'manual']).optional(),
    bank_name: z.string().max(200).nullable().optional(),
    asset_year: z.number().int().min(1950).max(2100).nullable().optional(),
    asset_make: z.string().max(120).nullable().optional(),
    asset_model: z.string().max(120).nullable().optional(),
    loan_amount_usd: z.number().nonnegative().nullable().optional(),
    purchase_price_usd: z.number().nonnegative().nullable().optional(),
    rate_pct: z.number().nonnegative().max(100).nullable().optional(),
    ltv_pct: z.number().nonnegative().max(100).nullable().optional(),
    prepayment_penalty: z.string().max(500).nullable().optional(),
    fees: z.record(z.string(), z.unknown()).nullable().optional(),
    closed_on: z.string().max(40).nullable().optional(),
  })
  .strip()

/** Real closed deals are often leasing spreadsheets (e.g. a Portuguese-language leasing
 *  model), not PDFs — accept xlsx/xls/csv on the Past Deals path too. */
function isSpreadsheet(nameOrMime: string): boolean {
  return /\.(xlsx|xls|csv)$/i.test(nameOrMime) || /(spreadsheet|ms-excel|csv)/i.test(nameOrMime)
}

// 180s to match the parse routes. At 60s this route can hang up on a small
// self-hosted model mid-extraction — a term sheet is far longer than a business
// card. Accuracy mandate: raise timeouts on the extraction path rather than
// truncate the work.
export const maxDuration = 180
export const runtime = 'nodejs'

const PARSE_BUCKET = 'parse-uploads'
const MAX_UPLOAD_MB = 25

/**
 * The AI hop is the one step here that can fail for reasons the operator can
 * actually act on (AI server offline, model not installed, overloaded).
 * Before this, any of those threw → HTTP 500 → the client showed "Could not
 * import deal / Something went wrong on our end", with no way to know the real
 * cause was, say, a model never pulled onto the model host. Now the response
 * names the cause and the fix.
 */
async function extractOr503(
  admin: ReturnType<typeof getSupabaseAdmin>,
  text: string,
): Promise<{ ok: true; extracted: Awaited<ReturnType<typeof extractClosedDeal>> } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, extracted: await extractClosedDeal(admin, text) }
  } catch (e) {
    const failure = classifyAiError(e)
    console.error('closed-deals.extract failed', failure.kind, e)
    return {
      ok: false,
      response: NextResponse.json(
        { error: aiFailureMessage(failure, { action: 'The deal was not imported.' }) },
        { status: aiFailureStatus(failure) },
      ),
    }
  }
}

/**
 * The file itself can defeat the reader before the AI is ever reached: a PDF
 * that is password-protected, bytes that are not really a PDF, a pure scan with
 * no text layer, a workbook with nothing in it. None of those were caught —
 * `extractPdfText` and `spreadsheetToText` sat outside any try/catch and POST
 * has none of its own — so each one threw out of the route as an unhandled 500,
 * and `humanError()` renders a plain 500 as "Something went wrong on our end".
 * That is the message users reported for the Past Deals import
 * and it survived the AI-hop fix above, because these failures never get as far
 * as the AI hop.
 *
 * 422 keeps them on the 4xx path `humanError()` passes through verbatim, and
 * matches the two file-content 422s this route already returned.
 */
type FileParseFailure =
  | 'pdf_encrypted'
  | 'pdf_unreadable'
  | 'pdf_no_text_layer'
  | 'spreadsheet_encrypted'
  | 'spreadsheet_unreadable'
  | 'spreadsheet_empty'

/**
 * One sentence each: what happened, and the next move. The scan is the one
 * worth naming exactly — it is the only failure whose fix is to go back for a
 * different copy of the document rather than to repair the file in hand. It
 * deliberately does not suggest photographing the pages: this route reads PDFs
 * and spreadsheets only, so an uploaded image comes back as `pdf_unreadable`.
 */
const FILE_PARSE_MESSAGE: Record<FileParseFailure, string> = {
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
}

/** `name: message` off a thrown value, without assuming it is an Error. */
function errorText(e: unknown): string {
  if (typeof e === 'string') return e
  if (e && typeof e === 'object') {
    const o = e as { name?: unknown; message?: unknown }
    const parts = [o.name, o.message].filter((v): v is string => typeof v === 'string')
    if (parts.length) return parts.join(': ')
  }
  return String(e)
}

/**
 * Locked, or merely broken. Both readers say which in the thrown message, so
 * one predicate covers both formats.
 *
 * [VERIFIED against real files rather than docs: a genuine
 *  loan doc encrypted with qpdf AES-256 throws pdfjs
 *  `PasswordException: No password given` (code 1) while the same file reads
 *  back 169,053 characters unencrypted; garbage bytes and JPEG bytes renamed
 *  .pdf both throw `InvalidPDFException: Invalid PDF structure.`; a zero-byte
 *  PDF throws `InvalidPDFException: The PDF file is empty…`; a truncated
 *  workbook throws `Error: Unsupported ZIP file`; and a real leasing
 *  model, AES-encrypted, throws SheetJS's `Error: File is password-protected`
 *  while the unencrypted original still parses to its Portuguese summary rows.]
 * SheetJS also phrases a lock as "Password is incorrect" / "Unsupported ZIP
 * encryption" / "ECMA-376 Encrypted file …", all of which land here too.
 */
function looksEncrypted(e: unknown): boolean {
  return /password|encrypt/i.test(errorText(e))
}

/**
 * Record the failure, then answer with the sentence for it.
 *
 * The row matters as much as the message. A parse that dies here never reaches
 * `writeParseLog`, so a failed import used to leave nothing behind at all: no
 * count, no filename, no reason — the same blind spot that hid two months of
 * rejected 'spreadsheet' rows (0021_audit_integrity.sql). `llm_provider` and
 * `llm_model` are 'none' because no model ran, which is also how these rows are
 * told apart from real parses when reading the table.
 */
async function fileParseFailure(
  admin: ReturnType<typeof getSupabaseAdmin>,
  userId: string,
  f: {
    kind: FileParseFailure
    modality: 'pdf' | 'spreadsheet'
    filename: string
    bytes: number
    cause: unknown
  },
): Promise<NextResponse> {
  const detail = f.cause === null ? '' : errorText(f.cause)
  console.error('closed-deals.file-parse failed', f.kind, f.filename, detail)
  try {
    const { error } = await admin.from('parse_logs').insert({
      user_id: userId,
      raw_input: `[unreadable upload: ${f.kind}] ${f.filename} (${f.bytes} bytes)`,
      input_modality: f.modality,
      llm_provider: 'none',
      llm_model: 'none',
      parsed_output: { error: f.kind },
      raw_response_text: detail.slice(0, 50_000) || null,
      fallback_used: false,
    })
    // supabase-js resolves with { error } rather than throwing, so this warn is
    // the only place a rejected row is ever visible — same reason as the one in
    // writeParseLog below.
    if (error) console.warn('parse_logs insert failed (closed_deals file parse):', error.message)
  } catch (e) {
    console.error('closed_deals file-parse parse_logs insert failed:', e)
  }
  return NextResponse.json({ error: FILE_PARSE_MESSAGE[f.kind] }, { status: 422 })
}

interface Insert {
  funding_source_id?: string | null
  asset_year: number | null
  asset_make: string | null
  asset_model: string | null
  loan_amount_usd: number | null
  purchase_price_usd: number | null
  rate_pct: number | null
  ltv_pct: number | null
  prepayment_penalty: string | null
  fees: Record<string, unknown> | null
  closed_on: string | null
  source_document_url: string | null
  source_kind: 'term_sheet' | 'proposal' | 'loan_doc' | 'manual'
  created_by: string | null
}

export async function POST(req: NextRequest) {
  const authz = await requireAuthorizedApiUser()
  if (!authz.ok) return authz.response
  const { userId } = authz

  const admin = getSupabaseAdmin()
  const { data: user } = await admin
    .from('users')
    .select('id, role')
    .eq('clerk_user_id', userId)
    .single()
  if (!user || !['admin', 'editor'].includes(user.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const ct = req.headers.get('content-type') ?? ''

  // --- Path 1: PDF upload via multipart (small files, < 4.5 MB) ---
  if (ct.includes('multipart/form-data')) {
    const form = await req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'no file' }, { status: 400 })
    }
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      return NextResponse.json({ error: `file too large (max ${MAX_UPLOAD_MB}MB)` }, { status: 413 })
    }
    const buf = Buffer.from(await file.arrayBuffer())
    return await extractAndInsert(admin, user.id, buf, {
      explicit_funding_source_id: (form.get('funding_source_id') as string | null) ?? null,
      source_kind: (form.get('source_kind') as string | null) ?? 'term_sheet',
      filename: file.name,
      mime: file.type,
    })
  }

  // --- Path 2 + 3 + 4: JSON ---
  const body = await req.json().catch(() => ({}))

  // Path 2: large PDF uploaded to Supabase Storage to bypass the 4.5 MB limit.
  if (typeof body?.storage_path === 'string' && body.storage_path) {
    // Per-resource authz: paths are minted as `deal/<userId>/…` by
    // /api/uploads/sign. Reject anything this user doesn't own.
    if (!body.storage_path.startsWith(`deal/${userId}/`)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    const { data: blob, error } = await admin.storage.from(PARSE_BUCKET).download(body.storage_path)
    if (error || !blob) {
      return NextResponse.json(
        { error: `could not read upload: ${error?.message ?? 'not found'}` },
        { status: 400 },
      )
    }
    const buf = Buffer.from(await blob.arrayBuffer())
    try {
      await admin.storage.from(PARSE_BUCKET).remove([body.storage_path])
    } catch {
      /* orphan cleanup is best-effort */
    }
    if (buf.length > MAX_UPLOAD_MB * 1024 * 1024) {
      return NextResponse.json({ error: `file too large (max ${MAX_UPLOAD_MB}MB)` }, { status: 413 })
    }
    return await extractAndInsert(admin, user.id, buf, {
      explicit_funding_source_id: body.funding_source_id ?? null,
      source_kind: body.source_kind ?? 'term_sheet',
      filename: body.file_name ?? body.storage_path,
    })
  }

  // Path 3: raw text.
  if (typeof body?.text === 'string' && body.text.trim()) {
    const t0 = Date.now()
    const attempt = await extractOr503(admin, body.text)
    if (!attempt.ok) return attempt.response
    const extracted = attempt.extracted
    const latencyMs = Date.now() - t0
    await writeParseLog(admin, user.id, {
      raw_input: body.text.slice(0, 50_000),
      input_modality: 'text',
      parsed_output: extracted,
      latencyMs,
    })
    return await insertAndReturn(admin, user.id, extracted, {
      explicit_funding_source_id: body.funding_source_id ?? null,
      source_kind: body.source_kind ?? 'manual',
    })
  }

  // Path 4: direct insert (no extraction).
  //
  // This used to be `if (body && typeof body === 'object')`. `body` comes from
  // `req.json().catch(() => ({}))`, and `{}` is both truthy and an object — so a
  // malformed, empty or non-JSON request fell through to here, inserted a row of
  // all-nulls, and returned 201. The operator saw success and got a blank past
  // deal attached to the lender list. Every other mutating route in the app
  // validates its body; this was the one that did not.
  const direct = DirectInsert.safeParse(body)
  if (direct.success && Object.keys(direct.data).length > 0) {
    return await insertAndReturn(admin, user.id, direct.data, {
      explicit_funding_source_id: direct.data.funding_source_id ?? null,
      source_kind: direct.data.source_kind ?? 'manual',
    })
  }
  if (!direct.success) {
    return NextResponse.json(
      { error: 'Those deal details could not be read.', detail: direct.error.flatten() },
      { status: 400 },
    )
  }

  return NextResponse.json({ error: 'bad request' }, { status: 400 })
}

/**
 * Shared extract path: PDF (unpdf) OR spreadsheet (xlsx/csv flatten) → LLM
 * extract → telemetry → insert. Used by the multipart + storage transports.
 */
async function extractAndInsert(
  admin: ReturnType<typeof getSupabaseAdmin>,
  userId: string,
  buf: Buffer,
  opts: {
    explicit_funding_source_id: string | null
    source_kind: string
    filename?: string
    mime?: string
  },
) {
  const sheet = isSpreadsheet(opts.mime ?? '') || isSpreadsheet(opts.filename ?? '')
  let text: string
  let modality: 'pdf' | 'spreadsheet'
  if (sheet) {
    const name = opts.filename ?? 'upload.xlsx'
    let flattened: string
    try {
      flattened = spreadsheetToText(buf, name)
    } catch (e) {
      return await fileParseFailure(admin, userId, {
        kind: looksEncrypted(e) ? 'spreadsheet_encrypted' : 'spreadsheet_unreadable',
        modality: 'spreadsheet',
        filename: name,
        bytes: buf.length,
        cause: e,
      })
    }
    text = flattened.trim()
    modality = 'spreadsheet'
    // `spreadsheetToText` always prepends `Filename: …`, so `text` is never
    // empty and the old `if (!text)` here never fired once: an empty, blank-row
    // or numbers-only workbook went to the model with nothing but a filename to
    // read, and whatever it returned was saved as a past deal. [VERIFIED
    // 2026-09-09: all three of those cases return exactly "Filename: deal.xlsx".]
    // Strip the header before deciding, the way /api/parse/file already does.
    if (!flattened.replace(`Filename: ${name}`, '').trim()) {
      return await fileParseFailure(admin, userId, {
        kind: 'spreadsheet_empty',
        modality: 'spreadsheet',
        filename: name,
        bytes: buf.length,
        cause: null,
      })
    }
  } else {
    const name = opts.filename ?? 'upload.pdf'
    try {
      text = (await extractPdfText(buf)).trim()
    } catch (e) {
      return await fileParseFailure(admin, userId, {
        kind: looksEncrypted(e) ? 'pdf_encrypted' : 'pdf_unreadable',
        modality: 'pdf',
        filename: name,
        bytes: buf.length,
        cause: e,
      })
    }
    modality = 'pdf'
    if (!text) {
      return await fileParseFailure(admin, userId, {
        kind: 'pdf_no_text_layer',
        modality: 'pdf',
        filename: name,
        bytes: buf.length,
        cause: null,
      })
    }
  }

  const t0 = Date.now()
  const attempt = await extractOr503(admin, text)
  if (!attempt.ok) return attempt.response
  const extracted = attempt.extracted
  const latencyMs = Date.now() - t0

  await writeParseLog(admin, userId, {
    raw_input: text.slice(0, 50_000),
    input_modality: modality,
    parsed_output: extracted,
    latencyMs,
  })

  return await insertAndReturn(admin, userId, extracted, opts)
}

/**
 * Closed-loop telemetry: store the raw input + the LLM output so a
 * future eval pass can compute corrections (mirrors /api/parse).
 */
async function writeParseLog(
  admin: ReturnType<typeof getSupabaseAdmin>,
  userId: string,
  entry: {
    raw_input: string
    input_modality: 'pdf' | 'text' | 'spreadsheet'
    parsed_output: unknown
    latencyMs: number
  },
): Promise<void> {
  try {
    const { error } = await admin.from('parse_logs').insert({
      user_id: userId,
      raw_input: entry.raw_input,
      input_modality: entry.input_modality,
      llm_provider: 'ai-sdk-v6',
      llm_model: process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-4-6',
      parsed_output: entry.parsed_output,
      parse_latency_ms: entry.latencyMs,
      fallback_used: false,
    })
    // supabase-js resolves with { error }; it does not throw on a rejected
    // insert, so this catch has never fired. That is why nobody noticed that
    // every spreadsheet import since 2026-07-17 was rejected by the
    // 0002 input_modality CHECK, which did not list 'spreadsheet' — the count
    // for that modality was still 0 on 2026-09-08. Constraint widened in
    // 0021_audit_integrity.sql; this line is what makes the next such break
    // visible. Warn, never throw — a lost log must not lose the import.
    if (error) console.warn('parse_logs insert failed (closed_deals):', error.message)
  } catch (e) {
    console.error('closed_deals parse_logs insert failed:', e)
  }
}

type Extracted = Partial<{
  bank_name: string | null
  asset_year: number | null
  asset_make: string | null
  asset_model: string | null
  loan_amount_usd: number | null
  purchase_price_usd: number | null
  rate_pct: number | null
  ltv_pct: number | null
  prepayment_penalty: string | null
  fees: Record<string, unknown> | null
  closed_on: string | null
}>

async function insertAndReturn(
  admin: ReturnType<typeof getSupabaseAdmin>,
  userId: string,
  extracted: Extracted,
  opts: {
    explicit_funding_source_id: string | null
    source_kind: string
  },
) {
  let fsId: string | null = opts.explicit_funding_source_id
  if (!fsId) {
    fsId = await resolveFundingSourceId(admin, extracted.bank_name ?? null)
  }

  const sourceKind: Insert['source_kind'] =
    opts.source_kind === 'proposal' || opts.source_kind === 'loan_doc' || opts.source_kind === 'manual'
      ? opts.source_kind
      : 'term_sheet'

  const row: Insert = {
    funding_source_id: fsId,
    asset_year: extracted.asset_year ?? null,
    asset_make: extracted.asset_make ?? null,
    asset_model: extracted.asset_model ?? null,
    loan_amount_usd: extracted.loan_amount_usd ?? null,
    purchase_price_usd: extracted.purchase_price_usd ?? null,
    rate_pct: extracted.rate_pct ?? null,
    ltv_pct: extracted.ltv_pct ?? null,
    prepayment_penalty: extracted.prepayment_penalty ?? null,
    fees: extracted.fees ?? null,
    closed_on: extracted.closed_on ?? null,
    source_document_url: null,
    source_kind: sourceKind,
    created_by: userId,
  }

  const { data, error } = await admin.from('closed_deal').insert(row).select('*').single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Fire-and-forget graph re-extract for the new closed_deal row.
  // Adds asset_family / asset_model edges + a funder--funded-->model
  // edge that the search past-deal-boost can lean on.
  void indexGraphForClosedDeal(admin, data)

  return NextResponse.json(data, { status: 201 })
}
