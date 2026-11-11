import { NextRequest, NextResponse } from 'next/server'
import { requireAuthorizedApiUser } from '@/lib/auth/require-authorized'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { findLenderMatch } from '@/lib/funding-sources/match'

/**
 * Proactive dedup probe — "is this lender already in the list?".
 *
 * Called once, on submit of an add. Returns a high-precision
 * normalized-name (or exact-email) match so the operator can update in place
 * instead of creating a duplicate. Suggestion only; the human confirms.
 * Authz-gated like every other route (whitelist in app code, not RLS alone).
 */
export async function GET(req: NextRequest) {
  const authz = await requireAuthorizedApiUser()
  if (!authz.ok) return authz.response

  const url = new URL(req.url)
  const company_name = (url.searchParams.get('company_name') ?? '').trim()
  const email = (url.searchParams.get('email') ?? '').trim()
  if (!company_name && !email) return NextResponse.json({ match: null })

  const admin = getSupabaseAdmin()
  // The lender set is small (hundreds); fetch names + emails and match in-process
  // so normalization (legal-suffix / punctuation) stays identical to the client.
  const { data, error } = await admin
    .from('funding_sources')
    .select('id, company_name, primary_contact_email')
    .neq('status', 'archived') // don't steer an update onto an archived record
  // A probe that FAILED is not a lender that isn't there. The error used to be
  // swallowed into `match: null`, which the add form reads as "no existing
  // lender" — it then skips the reconcile dialog and a duplicate lands in the
  // index. Fail loud: non-200, an explicit code, and deliberately NO `match`
  // key, so no caller can read absence out of a failure.
  if (error || !data) {
    return NextResponse.json(
      { error: 'probe_failed', detail: error?.message ?? 'lender lookup returned no data' },
      { status: 503 },
    )
  }
  const match = findLenderMatch(
    { company_name, primary_contact_email: email },
    data,
  )
  return NextResponse.json({ match })
}

// Not implemented: AI ranking requires borrower-side data.
export async function POST() {
  return NextResponse.json(
    { error: 'not_implemented', detail: 'Not implemented: AI ranking requires borrower-side data.' },
    { status: 501 },
  )
}
