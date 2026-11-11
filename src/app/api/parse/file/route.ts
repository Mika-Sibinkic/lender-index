import { NextRequest, NextResponse } from 'next/server'
import { requireAuthorizedApiUser } from '@/lib/auth/require-authorized'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { aiExtract } from '@/lib/parse/ai-extract'
import { aiExtractFromImage } from '@/lib/parse/ai-extract-image'
import { classifyExtractFailure, aiFailureMessage, aiFailureStatus } from '@/lib/ai/failure'
import { spreadsheetToText } from '@/lib/parse/spreadsheet-text'
import { extractPdfText } from '@/lib/parse/pdf-text'
import { ocrImage, shouldPreferOcr } from '@/lib/parse/ocr'
import { decodeQr } from '@/lib/parse/qr'
import { parseVCard, hasUsableContact, type VCardContact } from '@/lib/parse/vcard'
import { applyQrContact } from '@/lib/parse/qr-merge'
import { verifyContactDomain, type ContactVerification } from '@/lib/parse/verify-contact'
import {
  KNOWN_FUNDING_SOURCE_FIELDS,
  proposeUnmappedFields,
} from '@/lib/parse/schema-extension'

export const maxDuration = 180
// unpdf (pdfjs) runs in the Node runtime
export const runtime = 'nodejs'

const PARSE_BUCKET = 'parse-uploads'
const MAX_UPLOAD_MB = 25


/**
 * Same uncaught gap `/api/closed-deals` had, on the other upload path.
 *
 * `extractPdfText` and `spreadsheetToText` throw on a locked or damaged file.
 * Neither call was wrapped and the handler has no catch of its own, so a
 * password-protected term sheet dropped on New Funding Source became a bare 500
 * — which `humanError` renders as "Something went wrong on our end." The operator was told to retry a file that will never parse.
 *
 * The wording differs from the closed-deals copy in one place on purpose. That
 * route reads PDFs and spreadsheets only, so it cannot suggest a photograph.
 * This route DOES support image OCR and vision, so for a scan with no text
 * layer "convert to an image" is real advice here — and that message is left
 * exactly as it was.
 */
const looksEncrypted = (e: unknown): boolean =>
  /password|encrypt/i.test(e instanceof Error ? `${e.name}: ${e.message}` : String(e))

export async function POST(req: NextRequest) {
  const authz = await requireAuthorizedApiUser()
  if (!authz.ok) return authz.response
  const { userId } = authz

  // Role gate: a parse burns on-prem LLM inference and writes parse_logs +
  // proposed_field rows, so it matches the other mutating/AI routes
  // (e.g. /api/contacts/normalize) — admin or editor only.
  const admin = getSupabaseAdmin()
  const { data: user } = await admin
    .from('users')
    .select('id, role')
    .eq('clerk_user_id', userId)
    .single()
  if (!user || !['admin', 'editor'].includes(user.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Acquire the file from one of two transports:
  //   - multipart/form-data: small files (< 4.5 MB) posted directly
  //   - application/json { storage_path }: large files uploaded to Supabase
  //     Storage first, to bypass Vercel's hard 4.5 MB request-body limit
  //     (FUNCTION_PAYLOAD_TOO_LARGE). We fetch + delete the object here.
  const ct = req.headers.get('content-type') ?? ''
  let file: File
  let cleanup: (() => Promise<void>) | null = null

  if (ct.includes('application/json')) {
    const body = await req.json().catch(() => ({}))
    const sp = typeof body?.storage_path === 'string' ? body.storage_path : ''
    if (!sp) {
      return NextResponse.json({ error: 'no file' }, { status: 400 })
    }
    // Per-resource authz: the path is minted server-side as `parse/<userId>/…`
    // (see /api/uploads/sign). Reject any path not owned by this user so a
    // whitelisted user can't read or delete another user's in-flight upload.
    if (!sp.startsWith(`parse/${userId}/`)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    const { data: blob, error } = await admin.storage.from(PARSE_BUCKET).download(sp)
    if (error || !blob) {
      return NextResponse.json(
        { error: `could not read upload: ${error?.message ?? 'not found'}` },
        { status: 400 },
      )
    }
    const name =
      typeof body?.file_name === 'string' ? body.file_name : (sp.split('/').pop() ?? 'upload')
    const type = (typeof body?.content_type === 'string' && body.content_type) || blob.type || ''
    file = new File([blob], name, { type })
    cleanup = async () => {
      try {
        await admin.storage.from(PARSE_BUCKET).remove([sp])
      } catch {
        /* orphan cleanup is best-effort */
      }
    }
  } else {
    const form = await req.formData()
    const f = form.get('file')
    if (!(f instanceof File)) {
      return NextResponse.json({ error: 'no file' }, { status: 400 })
    }
    file = f
  }

  const sizeMb = file.size / 1024 / 1024
  if (sizeMb > MAX_UPLOAD_MB) {
    if (cleanup) await cleanup()
    return NextResponse.json(
      { error: `file too large (${sizeMb.toFixed(1)}MB; max ${MAX_UPLOAD_MB}MB)` },
      { status: 413 },
    )
  }

  try {
    return await runExtraction(file, userId)
  } finally {
    if (cleanup) await cleanup()
  }
}

async function runExtraction(file: File, userId: string): Promise<NextResponse> {
  const mime = file.type
  const sizeMb = file.size / 1024 / 1024

  let result
  let modality: 'image' | 'pdf' | 'spreadsheet' = 'image'
  let rawSummary = ''
  let extractedText = ''
  // Exact fields lifted from a business-card QR, if there was one. These
  // override the model's reading of the same card — see the QR block below.
  let qrContact: VCardContact | null = null
  let qrWebsite: string | null = null
  const lowerName = file.name.toLowerCase()

  if (mime === 'application/pdf' || lowerName.endsWith('.pdf')) {
    modality = 'pdf'
    const buf = Buffer.from(await file.arrayBuffer())
    let text: string
    try {
      text = (await extractPdfText(buf)).slice(0, 50_000)
    } catch (e) {
      console.error('parse.file pdf read failed', file.name, e)
      return NextResponse.json(
        {
          error: looksEncrypted(e)
            ? 'This PDF is password-protected, so remove the password in your PDF reader and upload it again.'
            : 'This file could not be opened as a PDF, so it is damaged or is not a PDF; upload the original, or a photo of the card or term sheet.',
        },
        { status: 422 },
      )
    }
    rawSummary = text.slice(0, 2_000)
    extractedText = text
    if (!text.trim()) {
      return NextResponse.json(
        { error: 'PDF appears to have no text layer. Convert to image and retry.' },
        { status: 422 },
      )
    }
    const admin = getSupabaseAdmin()
    result = await aiExtract(`Filename: ${file.name}\n\n${text}`, {
      supabase: admin,
      module: 'parse.pdf',
    })
  } else if (mime.startsWith('image/')) {
    modality = 'image'
    const buf = Buffer.from(await file.arrayBuffer())
    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`
    rawSummary = `[IMAGE ${mime} ${sizeMb.toFixed(2)}MB ${file.name}]`
    const admin = getSupabaseAdmin()

    // QR FIRST — deterministic beats probabilistic on the extraction path.
    // Conference business cards nearly always encode a vCard in their QR, so the
    // contact details are already machine-readable while OCR/vision guesses at a
    // photograph of the same text. A typical trade-show card photo is exactly
    // this: a hand-held, angled, glare-lit phone photo with the data sitting in
    // a QR in the corner.
    //
    // Whatever comes out here is EXACT, so it is merged over the model's output
    // below rather than under it. A QR holding only a URL is kept as an
    // enrichment hint, not promoted into a contact.
    const qr = await decodeQr(buf)
    if (qr) {
      const parsed = parseVCard(qr.text)
      if (hasUsableContact(parsed)) {
        qrContact = parsed
        rawSummary = `[QR ${qr.via} vCard] ${parsed.fullName ?? ''} · ${parsed.organization ?? ''}`
      } else if (/^https?:\/\//i.test(qr.text.trim())) {
        qrWebsite = qr.text.trim()
      }
    }

    // OCR-first fallback: when running on on-prem box-class
    // hardware that can't host a vision LLM, run Tesseract WASM to
    // pull text out of the image and then hand the text to the
    // existing text extractor. Privacy-preserving (WASM, in-process).
    if (shouldPreferOcr()) {
      const ocr = await ocrImage(buf)
      if (ocr.text.trim()) {
        rawSummary = `[OCR ${mime} ${sizeMb.toFixed(2)}MB ${file.name} conf=${ocr.confidence.toFixed(2)} latency=${ocr.latencyMs}ms]\n\n${ocr.text.slice(0, 2000)}`
        result = await aiExtract(ocr.text, { supabase: admin, module: 'parse.ocr' })
      } else {
        // OCR failed to extract anything; fall through to vision LLM
        result = await aiExtractFromImage(dataUrl, undefined, {
          supabase: admin,
          module: 'parse.image',
        })
      }
    } else {
      result = await aiExtractFromImage(dataUrl, undefined, {
        supabase: admin,
        module: 'parse.image',
      })
    }
  } else if (
    mime.includes('spreadsheet') ||
    mime === 'application/vnd.ms-excel' ||
    mime === 'text/csv' ||
    /\.(xlsx|xls|csv)$/.test(lowerName)
  ) {
    // Spreadsheet term sheets (e.g. a leasing model in any language). Flatten
    // the summary-dense top of each sheet + filename hint, then text-extract.
    modality = 'spreadsheet'
    const buf = Buffer.from(await file.arrayBuffer())
    try {
      extractedText = spreadsheetToText(buf, file.name)
    } catch (e) {
      console.error('parse.file spreadsheet read failed', file.name, e)
      return NextResponse.json(
        {
          error: looksEncrypted(e)
            ? 'This spreadsheet is password-protected, so remove the password in Excel and upload it again.'
            : 'This spreadsheet could not be opened, so re-save it as .xlsx or .csv and upload it again.',
        },
        { status: 422 },
      )
    }
    rawSummary = extractedText.slice(0, 2_000)
    if (!extractedText.replace(`Filename: ${file.name}`, '').trim()) {
      return NextResponse.json(
        {
          error:
            'This spreadsheet has no readable rows, so check the details are in the file and upload it again.',
        },
        { status: 422 },
      )
    }
    const admin = getSupabaseAdmin()
    result = await aiExtract(extractedText, { supabase: admin, module: 'parse.xlsx' })
  } else {
    return NextResponse.json(
      { error: `unsupported file type: ${mime || lowerName}` },
      { status: 415 },
    )
  }

  // On-prem AI failed in an actionable way (offline / model not installed /
  // timed out) → 503 instead of persisting a regex-only fallback as if it were a
  // clean extraction. The uploaded file is re-selectable client-side, so retrying
  // loses nothing. A reachable model that merely returned unparseable output
  // still falls through to the existing best-effort behavior.
  const failure = classifyExtractFailure(result)

  // Closed-loop log — written BEFORE the failure return, deliberately.
  //
  // It used to sit after it, so an honest AI failure produced no row at all.
  // The irony is that making errors honest is what created the blind spot: the
  // old code logged these because it fell through to the regex path and logged
  // that. A PDF that timed out left zero forensic trace, while older failures
  // (a 404 model, a 530 from the proxy) were logged because they took the old
  // path. A timeout is the most common failure, so it is the one we can least
  // afford to be blind to.
  const admin = getSupabaseAdmin()
  const { data: user } = await admin
    .from('users')
    .select('id')
    .eq('clerk_user_id', userId)
    .single()

  let logId: string | null = null
  try {
    const { data: logRow, error: logError } = await admin
      .from('parse_logs')
      .insert({
        user_id: user?.id ?? null,
        raw_input: rawSummary,
        // Was `modality === 'spreadsheet' ? 'mixed' : modality` —
        // a workaround for the 0002 CHECK, which did not list 'spreadsheet'.
        // 0021_audit_integrity.sql added it, so record the real modality:
        // filing xlsx term sheets under 'mixed' made the eval set's
        // per-modality accuracy numbers wrong for both buckets.
        input_modality: modality,
        llm_provider: result.provider,
        llm_model: result.model,
        parsed_output: result.parsed,
        raw_response_text: result.rawResponse.slice(0, 50_000),
        parse_latency_ms: result.latencyMs,
        fallback_used: result.fallbackUsed,
      })
      .select('id')
      .single()
    // supabase-js resolves with { error }; it does not throw on a rejected
    // insert, so this catch never fires for a constraint violation. An unread
    // error is what hid /api/closed-deals' rejected 'spreadsheet' rows from
    // 2026-07-17 to 2026-09-08 (see 0021_audit_integrity.sql). Warn, never
    // throw — losing the closed-loop log must not lose the user's parse.
    if (logError) console.warn('parse_logs insert failed (parse.file):', logError.message)
    logId = logRow?.id ?? null
  } catch (e) {
    console.error('parse_logs insert failed:', e)
  }

  // On-prem AI failed in an actionable way (offline / model not installed /
  // timed out) → 503 instead of persisting a regex-only fallback as if it were a
  // clean extraction. The uploaded file is re-selectable client-side, so retrying
  // loses nothing. A reachable model that merely returned unparseable output
  // still falls through to the existing best-effort behavior.
  if (failure) {
    return NextResponse.json(
      { error: aiFailureMessage(failure, { action: 'Nothing was filled in.' }) },
      { status: aiFailureStatus(failure) },
    )
  }

  try {
    const { error: costError } = await admin.from('cost_log').insert({
      operation_type:
        modality === 'image'
          ? 'parse.image'
          : modality === 'spreadsheet'
            ? 'parse.xlsx'
            : 'parse.pdf',
      cost_usd_equivalent: 0,
      latency_ms: result.latencyMs,
    })
    // Same swallowed-error class as the parse_logs insert above: { error } is
    // returned, not thrown, so this catch never saw it.
    if (costError) console.warn('cost_log insert failed (parse.file):', costError.message)
  } catch {
    /* never fail on telemetry */
  }

  // Schema-extension: look for keys the LLM emitted that don't match
  // an existing funding_sources column. Persist as pending
  // proposed_field rows; surface in the response so the create dialog
  // can render a "Add new field?" pill.
  // Deterministic QR data lands on top of the model's reading of the same card.
  const merged = applyQrContact(result.parsed as Record<string, unknown>, qrContact, qrWebsite)
  result = { ...result, parsed: merged.parsed }

  // Deterministic domain check, image path only. A PDF's text layer is not
  // garbled; a photograph's is. The same OCR→LLM design elsewhere has shipped
  // many differently-misspelled copies of one person into a CRM after tesseract
  // read `examplefleet` as `samplefleet` — a difference no reviewer can eyeball, and one a resolver
  // settles outright. Flags only: it never corrects or drops the value, and any
  // DNS trouble on our side comes back "unchecked" rather than casting doubt on
  // a real lender. verifyContactDomain never throws and is bounded well inside
  // this route's budget, so the success path is not at risk either way.
  let contactCheck: ContactVerification | null = null
  if (modality === 'image') {
    contactCheck = await verifyContactDomain(
      merged.parsed.primary_contact_email as string | null,
      merged.parsed.website as string | null,
    )
  }

  let proposedFields: { name: string; data_type: string; example_value: string }[] = []
  try {
    proposedFields = await proposeUnmappedFields(
      admin,
      result.parsed as Record<string, unknown>,
      KNOWN_FUNDING_SOURCE_FIELDS,
    )
  } catch (e) {
    console.warn('proposeUnmappedFields failed:', e)
  }

  return NextResponse.json({
    parsed: result.parsed,
    provider: result.provider,
    model: result.model,
    fallbackUsed: result.fallbackUsed,
    // Whether the contact's domain actually resolves. Null on the PDF and
    // spreadsheet paths, where there is no OCR to garble it. `not-found` means
    // the resolver denied the name; `unchecked` means we could not find out —
    // the UI must keep those two apart.
    contactCheck,
    latencyMs: result.latencyMs,
    modality,
    parseLogId: logId,
    proposedFields,
    // Fields read exactly from the card's own QR rather than inferred from
    // pixels — the UI marks these so a reviewer knows what not to second-guess.
    fromQr: merged.fromQr,
    body_text: extractedText || null,
    file_type: mime,
  })
}
