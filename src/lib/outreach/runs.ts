import type { SupabaseClient } from '@supabase/supabase-js'
import { llm, LLM_MODELS } from '@/lib/llm/client'
import { getEmailClient } from '@/lib/email/client'
import { isStale, missingFieldsFor, type StalenessRow } from './staleness'
import { mintActionToken } from './tokens'
import { draftSchema, renderDraftPrompt, SYSTEM_PROMPT, PROMPT_VERSION, type Draft } from './prompts'
import { renderApprovalEmail } from './approval-email'

const OPEN_STATUSES = ['queued', 'drafting', 'awaiting_approval'] as const

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback
  if (!v) throw new Error(`Missing env: ${name}`)
  return v
}

function dryRun(): boolean {
  return (process.env.OUTREACH_DRY_RUN ?? 'true') === 'true'
}

interface FundingSourceRow extends StalenessRow {
  id: string
  company_name: string
  primary_contact_name: string | null
  primary_contact_email: string | null
  internal_notes: string | null
  rate_notes: string | null
}

export interface EnqueueResult {
  scanned: number
  queued: number
  skipped: number
}

/**
 * Scan funding_sources and queue an outreach_run for every stale lender
 * that doesn't already have an open run. Cap at MAX_DAILY new runs per
 * invocation so a backlog can't burst the principal's inbox.
 */
export async function enqueueRuns(
  supabase: SupabaseClient,
  opts: { now?: Date; maxDaily?: number } = {},
): Promise<EnqueueResult> {
  const now = opts.now ?? new Date()
  const cap = opts.maxDaily ?? Number(process.env.MAX_DAILY ?? '30')

  const { data: sources, error } = await supabase
    .from('funding_sources')
    .select(
      'id, company_name, primary_contact_name, primary_contact_email, internal_notes, rate_notes, last_contact_at, outreach_status, required_field_gaps',
    )
    .neq('outreach_status', 'do_not_contact')
    .neq('outreach_status', 'bouncing')
  if (error) throw new Error(`enqueueRuns: ${error.message}`)

  const candidates = (sources ?? []).filter((s) =>
    isStale(s as StalenessRow, now),
  ) as FundingSourceRow[]

  if (candidates.length === 0) return { scanned: sources?.length ?? 0, queued: 0, skipped: 0 }

  const { data: open, error: openErr } = await supabase
    .from('outreach_run')
    .select('funding_source_id, status')
    .in('status', OPEN_STATUSES as unknown as string[])
  if (openErr) throw new Error(`enqueueRuns: ${openErr.message}`)
  const openIds = new Set((open ?? []).map((r) => r.funding_source_id))

  const toInsert = candidates
    .filter((c) => !openIds.has(c.id))
    .slice(0, cap)
    .map((c) => ({
      funding_source_id: c.id,
      status: 'queued' as const,
      missing_fields: missingFieldsFor(c, now),
    }))

  if (toInsert.length === 0) {
    return { scanned: sources?.length ?? 0, queued: 0, skipped: candidates.length }
  }

  const { error: insErr } = await supabase.from('outreach_run').insert(toInsert)
  if (insErr) throw new Error(`enqueueRuns: ${insErr.message}`)

  return {
    scanned: sources?.length ?? 0,
    queued: toInsert.length,
    skipped: candidates.length - toInsert.length,
  }
}

/**
 * Move a single run from `queued` → `awaiting_approval`. Returns the
 * draft id on success. Idempotent: a second call on a non-queued run
 * is a no-op and returns null.
 */
export async function draftRun(
  supabase: SupabaseClient,
  runId: string,
): Promise<{ draftId: string } | null> {
  // Conditional transition queued → drafting; bail if someone beat us to it.
  const { data: claimed, error: claimErr } = await supabase
    .from('outreach_run')
    .update({ status: 'drafting' })
    .eq('id', runId)
    .eq('status', 'queued')
    .select('id, funding_source_id, missing_fields')
    .maybeSingle()
  if (claimErr) throw new Error(`draftRun: claim: ${claimErr.message}`)
  if (!claimed) return null

  try {
    const { data: fs, error: fsErr } = await supabase
      .from('funding_sources')
      .select(
        'id, company_name, primary_contact_name, primary_contact_email, internal_notes, rate_notes, last_contact_at',
      )
      .eq('id', claimed.funding_source_id)
      .single()
    if (fsErr || !fs) throw new Error(`draftRun: load source: ${fsErr?.message ?? 'not found'}`)
    if (!fs.primary_contact_email) {
      throw new Error('funding_source has no primary_contact_email')
    }

    const promptInput = {
      lender: {
        name: fs.company_name,
        contact_name: fs.primary_contact_name,
        contact_email: fs.primary_contact_email,
        last_contact_at: fs.last_contact_at,
        notes: fs.internal_notes ?? fs.rate_notes ?? null,
      },
      missing_fields: claimed.missing_fields ?? [],
    }

    const res = await llm.object<Draft>({
      schema: draftSchema,
      system: SYSTEM_PROMPT,
      prompt: renderDraftPrompt(promptInput),
      supabase,
      module: 'outreach.draft',
    })
    const draft = res.object

    const { data: draftRow, error: draftErr } = await supabase
      .from('outreach_draft')
      .insert({
        run_id: runId,
        to_email: fs.primary_contact_email,
        subject: draft.subject,
        body_text: draft.body_text,
        body_html: draft.body_html,
        questions: draft.questions,
        model: LLM_MODELS.text,
        prompt_version: PROMPT_VERSION,
      })
      .select('id')
      .single()
    if (draftErr || !draftRow) throw new Error(`draftRun: persist draft: ${draftErr?.message}`)

    const baseUrl = env('PUBLIC_BASE_URL').replace(/\/$/, '')
    const approveToken = await mintActionToken(supabase, { runId, action: 'approve' })
    const declineToken = await mintActionToken(supabase, { runId, action: 'decline' })

    const approval = renderApprovalEmail({
      draft,
      recipient: { name: fs.primary_contact_name, email: fs.primary_contact_email },
      lender: { name: fs.company_name },
      approveUrl: `${baseUrl}/api/outreach/act/${approveToken}`,
      declineUrl: `${baseUrl}/api/outreach/act/${declineToken}`,
    })

    const principalEmail = env('PRINCIPAL_INBOX_EMAIL')
    const email = getEmailClient()
    const sendResult = await email.sendOnBehalf({
      from: principalEmail,
      to: principalEmail,
      subject: approval.subject,
      html: approval.html,
      text: approval.text,
    })

    // supabase-js resolves with { error }; it does not throw. A discarded error
    // here means the approval email went out with no record that it did — the
    // same swallowed-write class that hid the rejected 'spreadsheet' parse_logs
    // inserts from 2026-07-17 to 2026-09-08 (see 0021_audit_integrity.sql).
    // Warn, don't
    // throw: the mail is already sent, failing the run now would only strand
    // the state machine.
    const { error: sentErr } = await supabase.from('outreach_sent').insert({
      run_id: runId,
      kind: 'approval',
      to_email: principalEmail,
      subject: approval.subject,
      body_text: approval.text,
      body_html: approval.html,
      graph_message_id: sendResult.messageId,
      dry_run: dryRun(),
    })
    if (sentErr) console.warn('outreach_sent insert failed (approval):', sentErr.message)

    const { error: doneErr } = await supabase
      .from('outreach_run')
      .update({ status: 'awaiting_approval' })
      .eq('id', runId)
    if (doneErr) throw new Error(`draftRun: transition: ${doneErr.message}`)

    return { draftId: draftRow.id }
  } catch (e) {
    await supabase
      .from('outreach_run')
      .update({ status: 'error', error: (e as Error).message })
      .eq('id', runId)
    throw e
  }
}

/**
 * Dispatch the most recent draft for a run. Atomic transition
 * `awaiting_approval` → `sent`. Sends the lender email (or, under
 * OUTREACH_DRY_RUN=true, records the would-be email without calling
 * Graph). Refreshes funding_sources.last_contact_at on success.
 */
export async function dispatchRun(
  supabase: SupabaseClient,
  runId: string,
): Promise<{ dispatched: boolean }> {
  const { data: claimed, error: claimErr } = await supabase
    .from('outreach_run')
    .update({ status: 'sent' })
    .eq('id', runId)
    .eq('status', 'awaiting_approval')
    .select('id, funding_source_id')
    .maybeSingle()
  if (claimErr) throw new Error(`dispatchRun: claim: ${claimErr.message}`)
  if (!claimed) return { dispatched: false }

  try {
    const { data: draft, error: draftErr } = await supabase
      .from('outreach_draft')
      .select('to_email, subject, body_text, body_html')
      .eq('run_id', runId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()
    if (draftErr || !draft) throw new Error(`dispatchRun: load draft: ${draftErr?.message ?? 'not found'}`)

    const principalEmail = env('PRINCIPAL_INBOX_EMAIL')
    const email = getEmailClient()
    const sendResult = await email.sendOnBehalf({
      from: principalEmail,
      to: draft.to_email,
      subject: draft.subject,
      html: draft.body_html,
      text: draft.body_text,
    })

    // Same as the approval write above: { error } is returned, not thrown. This
    // is the send-record for a real lender email, so a silent loss here is the
    // costliest one in the file — warn, but do not throw after the send.
    const { error: sentErr } = await supabase.from('outreach_sent').insert({
      run_id: runId,
      kind: 'lender',
      to_email: draft.to_email,
      subject: draft.subject,
      body_text: draft.body_text,
      body_html: draft.body_html,
      graph_message_id: sendResult.messageId,
      dry_run: dryRun(),
    })
    if (sentErr) console.warn('outreach_sent insert failed (lender):', sentErr.message)

    await supabase
      .from('funding_sources')
      .update({
        last_contact_at: new Date().toISOString(),
        outreach_status: 'current',
      })
      .eq('id', claimed.funding_source_id)

    return { dispatched: true }
  } catch (e) {
    await supabase
      .from('outreach_run')
      .update({ status: 'error', error: (e as Error).message })
      .eq('id', runId)
    throw e
  }
}

export async function declineRun(
  supabase: SupabaseClient,
  runId: string,
): Promise<{ declined: boolean }> {
  const { data: claimed, error } = await supabase
    .from('outreach_run')
    .update({ status: 'declined' })
    .eq('id', runId)
    .eq('status', 'awaiting_approval')
    .select('id')
    .maybeSingle()
  if (error) throw new Error(`declineRun: ${error.message}`)
  return { declined: !!claimed }
}
