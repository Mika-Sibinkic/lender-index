import { NextRequest, NextResponse } from 'next/server'
import { requireAuthorizedApiUser } from '@/lib/auth/require-authorized'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { aiExtract } from '@/lib/parse/ai-extract'
import { classifyExtractFailure, aiFailureMessage, aiFailureStatus } from '@/lib/ai/failure'
import {
  KNOWN_FUNDING_SOURCE_FIELDS,
  proposeUnmappedFields,
} from '@/lib/parse/schema-extension'

export const maxDuration = 180

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

  const body = await req.json().catch(() => ({}))
  const text: string = typeof body?.text === 'string' ? body.text : ''
  const modality: 'text' | 'image' | 'pdf' | 'mixed' =
    body?.modality === 'image' || body?.modality === 'pdf' || body?.modality === 'mixed'
      ? body.modality
      : 'text'

  if (!text.trim()) {
    return NextResponse.json({ error: 'empty input' }, { status: 400 })
  }

  const result = await aiExtract(text, { supabase: admin, module: 'parse.text' })

  // On-prem AI failed in an actionable way (offline / model not installed /
  // timed out) → fail loud instead of returning the regex-only fallback as if it
  // were a clean extraction. The user's pasted text is untouched client-side, so
  // a retry loses nothing. Widened from unreachable-only on 2026-08-03: a model
  // that was never pulled answers 404, which slipped through and let Add mode
  // silently present regex output as an AI parse.
  const failure = classifyExtractFailure(result)

  // Closed-loop log — written BEFORE the failure return, so an honest AI
  // failure still leaves a forensic trail. See the same note in
  // /api/parse/file: making errors honest is what created the blind spot,
  // because the old regex-fallback path logged them on its way through.
  let logId: string | null = null
  try {
    const { data: logRow, error: logError } = await admin
      .from('parse_logs')
      .insert({
        user_id: user?.id ?? null,
        raw_input: text.slice(0, 50_000),
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
    // insert, so the catch below never fires for a constraint violation. That
    // is precisely how /api/closed-deals writing input_modality='spreadsheet'
    // against a CHECK that disallowed it stayed invisible from 2026-07-17 to
    // 2026-09-08 (see 0021_audit_integrity.sql). Warn, never throw — losing the
    // closed-loop log must not lose the user's parse.
    if (logError) console.warn('parse_logs insert failed (parse.text):', logError.message)
    logId = logRow?.id ?? null
  } catch (e) {
    // parse_logs table may not exist yet — never fail the parse on logging
    console.error('parse_logs insert failed:', e)
  }

  if (failure) {
    return NextResponse.json(
      { error: aiFailureMessage(failure, { action: 'Nothing was filled in.' }) },
      { status: aiFailureStatus(failure) },
    )
  }

  try {
    const { error: costError } = await admin.from('cost_log').insert({
      operation_type: result.fallbackUsed ? 'parse.fallback' : 'parse.ai',
      cost_usd_equivalent: 0,
      latency_ms: result.latencyMs,
    })
    // Same swallowed-error class as the parse_logs insert above: { error } is
    // returned, not thrown, so this catch never saw it.
    if (costError) console.warn('cost_log insert failed (parse.text):', costError.message)
  } catch {
    /* never fail the parse on telemetry */
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
    latencyMs: result.latencyMs,
    parseLogId: logId,
    proposedFields,
  })
}
