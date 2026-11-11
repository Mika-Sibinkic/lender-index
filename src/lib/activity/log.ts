import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Writes one row to activity_log — the table behind the Activity page.
 *
 * Two rules, both learned the hard way in this repo:
 *
 * 1. It cannot break the caller. Logging is never the reason a search or an
 *    import fails, so everything is inside a try/catch and the worst outcome is
 *    a console.warn.
 *
 * 2. It cannot silently swallow its own failure either. supabase-js `.insert()`
 *    resolves with `{ error }` instead of throwing, so a bare
 *    `await supabase.from(x).insert(y)` reports success on a rejected insert.
 *    That exact pattern hid a two-month outage in parse_logs: every Past-Deal
 *    spreadsheet import wrote input_modality='spreadsheet', the CHECK rejected
 *    it, and nobody found out until 2026-09-08 because the returned error was
 *    never read. A trail that loses rows without saying so is the bug class
 *    this table exists to remove, so destructure `error` and check it.
 */

export type ActivityKind =
  | 'search'
  | 'import'
  | 'parse'
  | 'record_create'
  | 'record_update'
  | 'record_delete'
  | 'report_export'

export interface ActivityEntry {
  kind: ActivityKind
  /** One human-readable line. Shown verbatim on the Activity page. */
  summary: string
  /** The exact input that produced the row — the point of the whole table. */
  detail?: Record<string, unknown>
  /** users.id uuid, never the Clerk id. Null when the actor could not be resolved. */
  userId?: string | null
  fundingSourceId?: string | null
  ok?: boolean
  error?: string | null
}

/** Postgres text columns are unbounded, but a runaway payload in a UI table is
 *  its own kind of unreadable. Trim the two free-text columns, not `detail`. */
const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export async function logActivity(
  supabase: SupabaseClient,
  entry: ActivityEntry,
): Promise<void> {
  try {
    const { error } = await supabase.from('activity_log').insert({
      user_id: entry.userId ?? null,
      kind: entry.kind,
      summary: cap(entry.summary, 1000),
      detail: entry.detail ?? {},
      funding_source_id: entry.fundingSourceId ?? null,
      ok: entry.ok ?? true,
      error: entry.error ? cap(entry.error, 2000) : null,
    })
    if (error) console.warn('activity_log insert failed:', error.message)
  } catch (e) {
    // Table missing (migration not applied yet), network gone, anything.
    console.warn('activity_log insert threw:', e instanceof Error ? e.message : e)
  }
}
