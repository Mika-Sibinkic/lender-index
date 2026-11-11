import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { validateAndConsumeActionToken } from '@/lib/outreach/tokens'
import { declineRun, dispatchRun } from '@/lib/outreach/runs'

export const dynamic = 'force-dynamic'

// A confirmation page is per-token and single-use, and the pages below it are
// terminal states. Neither may be served to a second reader out of a corporate
// proxy cache.
const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
} as const

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function htmlPage(status: 'sent' | 'discarded' | 'used' | 'expired' | 'missing' | 'error', detail?: string): string {
  const titleByStatus: Record<typeof status, string> = {
    sent: 'Sent ✅',
    discarded: 'Discarded ❌',
    used: 'Link already used',
    expired: 'Link expired',
    missing: 'Link not found',
    error: 'Something went wrong',
  }
  const messageByStatus: Record<typeof status, string> = {
    sent: 'The email is on its way (or recorded in dry-run mode).',
    discarded: 'Draft discarded. No email was sent.',
    used: 'This action link has already been used.',
    expired: 'This action link has expired. Re-queue the lender if needed.',
    missing: 'No such action link.',
    error: detail ?? 'Unknown error.',
  }
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${titleByStatus[status]}</title></head>
<body style="margin:0;padding:48px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f7f7f8;color:#111;text-align:center;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:32px;">
    <div style="font-size:22px;font-weight:600;margin-bottom:12px;">${titleByStatus[status]}</div>
    <div style="font-size:14px;color:#374151;">${escapeHtml(messageByStatus[status])}</div>
  </div>
</body></html>`
}

/**
 * The confirmation page a GET renders. The form POSTs back to the same URL,
 * which is the whole point: Outlook Safe Links, a mail scanner and browser
 * link prefetch all issue GETs, and none of them submit a form. Deliberately
 * bare — lender, recipient, one button.
 */
function confirmPage(args: {
  action: 'approve' | 'decline'
  lender: string | null
  toEmail: string | null
  formAction: string
}): string {
  const send = args.action === 'approve'
  const heading = send ? 'Send email?' : 'Discard draft?'
  const label = send ? 'Send email' : 'Discard draft'
  const background = send ? '#16a34a' : '#dc2626'
  // Blank means unknown, never a guess: a field we could not load is omitted
  // rather than filled with a placeholder that reads as fact.
  const lenderLine = args.lender
    ? `<div style="font-size:16px;font-weight:600;margin-bottom:4px;">${escapeHtml(args.lender)}</div>`
    : ''
  const emailLine = args.toEmail
    ? `<div style="font-size:14px;color:#374151;margin-bottom:24px;">${escapeHtml(args.toEmail)}</div>`
    : ''
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>${heading}</title></head>
<body style="margin:0;padding:48px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f7f7f8;color:#111;text-align:center;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:32px;">
    ${lenderLine}
    ${emailLine}
    <form method="post" action="${escapeHtml(args.formAction)}">
      <button type="submit" style="display:inline-block;padding:12px 20px;background:${background};color:#fff;border:0;border-radius:6px;font-size:15px;font-weight:600;cursor:pointer;">${label}</button>
    </form>
  </div>
</body></html>`
}

type Peek =
  | { ok: true; runId: string; action: 'approve' | 'decline' }
  | { ok: false; reason: 'missing' | 'used' | 'expired' }

/**
 * Read-only sibling of validateAndConsumeActionToken. A GET has to answer
 * "is this link still good, and what would it do?" WITHOUT burning the single
 * use — a scanner that consumed the token would leave the human clicking a
 * dead link. Same three rejection reasons, so the terminal pages are identical
 * whichever verb reached them.
 */
async function peekActionToken(supabase: SupabaseClient, token: string): Promise<Peek> {
  const { data, error } = await supabase
    .from('outreach_action_token')
    .select('token, run_id, action, expires_at, used_at')
    .eq('token', token)
    .maybeSingle()
  if (error || !data) return { ok: false, reason: 'missing' }
  if (data.used_at) return { ok: false, reason: 'used' }
  if (new Date(data.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' }
  return { ok: true, runId: data.run_id, action: data.action as 'approve' | 'decline' }
}

/**
 * Lender + recipient for the confirmation page. Best-effort and never throws:
 * a GET must render regardless, and this is display only — the address that
 * actually gets mailed is re-read inside dispatchRun. The draft query mirrors
 * dispatchRun's ordering (newest draft for the run) so the page cannot show
 * one address while a different one is sent.
 */
async function loadRunSummary(
  supabase: SupabaseClient,
  runId: string,
): Promise<{ lender: string | null; toEmail: string | null }> {
  try {
    const { data: draft } = await supabase
      .from('outreach_draft')
      .select('to_email')
      .eq('run_id', runId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const { data: run } = await supabase
      .from('outreach_run')
      .select('funding_source_id')
      .eq('id', runId)
      .maybeSingle()

    let lender: string | null = null
    if (run?.funding_source_id) {
      const { data: source } = await supabase
        .from('funding_sources')
        .select('company_name')
        .eq('id', run.funding_source_id)
        .maybeSingle()
      lender = source?.company_name ?? null
    }

    return { lender, toEmail: draft?.to_email ?? null }
  } catch {
    return { lender: null, toEmail: null }
  }
}

type Params = { params: Promise<{ token: string }> }

/**
 * Safe by contract: idempotent, sends nothing, consumes nothing. Everything a
 * link-follower can reach is here; the send lives under POST.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { token } = await params
  if (!token) {
    return new NextResponse(htmlPage('missing'), { status: 404, headers: HTML_HEADERS })
  }

  const admin = getSupabaseAdmin()
  const peek = await peekActionToken(admin, token)
  if (!peek.ok) {
    const statusCode = peek.reason === 'missing' ? 404 : 410
    return new NextResponse(htmlPage(peek.reason), { status: statusCode, headers: HTML_HEADERS })
  }

  const { lender, toEmail } = await loadRunSummary(admin, peek.runId)
  return new NextResponse(
    confirmPage({
      action: peek.action,
      lender,
      toEmail,
      formAction: req.nextUrl.pathname,
    }),
    { status: 200, headers: HTML_HEADERS },
  )
}

/**
 * The side effect. Only reachable by submitting the form on the GET page, so a
 * real lender email needs a deliberate human click. Token semantics are
 * unchanged from when this body was the GET handler: 32-byte token, 24h TTL,
 * consumed exactly once here.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { token } = await params
  if (!token) {
    return new NextResponse(htmlPage('missing'), { status: 404, headers: HTML_HEADERS })
  }

  const admin = getSupabaseAdmin()
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    null

  const validation = await validateAndConsumeActionToken(admin, { token, ip })
  if (!validation.ok) {
    const statusCode = validation.reason === 'missing' ? 404 : 410
    return new NextResponse(htmlPage(validation.reason as 'used' | 'expired' | 'missing'), {
      status: statusCode,
      headers: HTML_HEADERS,
    })
  }

  try {
    if (validation.action === 'approve') {
      await dispatchRun(admin, validation.runId)
      return new NextResponse(htmlPage('sent'), { status: 200, headers: HTML_HEADERS })
    } else {
      await declineRun(admin, validation.runId)
      return new NextResponse(htmlPage('discarded'), { status: 200, headers: HTML_HEADERS })
    }
  } catch (e) {
    return new NextResponse(htmlPage('error', (e as Error).message), {
      status: 500,
      headers: HTML_HEADERS,
    })
  }
}
