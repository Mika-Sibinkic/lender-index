import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import { getSupabaseAdmin } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

/**
 * What the system did, newest first.
 *
 * The point is not observability for us — it is that the team can see their own
 * work and hand us a problem report with the input attached. Until activity_log
 * existed, a search wrote nothing at all and an import's reconciliation lived
 * only in the browser tab that triggered it, so "it came back wrong yesterday"
 * was unanswerable. Failures show here too, which is the half cost_log could
 * never cover: it is only written after a call succeeds.
 *
 * Deliberately not admin-gated. Authorized staff default to `editor`, and the
 * people who hit the problems are the people who need to report them.
 */

const PAGE_SIZE = 200

interface ActivityEvent {
  id: string
  occurred_at: string
  kind: string
  summary: string
  ok: boolean
  error: string | null
  user: { email: string } | { email: string }[] | null
}

const KIND_LABELS: Record<string, string> = {
  search: 'Search',
  import: 'Import',
  parse: 'AI parse',
  record_create: 'Record created',
  record_update: 'Record updated',
  record_delete: 'Record deleted',
  report_export: 'Report export',
}

/** UTC, and the header says so. A time that silently uses the server's timezone
 *  is worse than one that names the timezone it used. */
function fmtTime(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? ts : d.toISOString().slice(0, 19).replace('T', ' ')
}

function emailOf(u: ActivityEvent['user']): string {
  const flat = Array.isArray(u) ? u[0] : u
  return flat?.email ?? '—'
}

export default async function ActivityPage() {
  const { userId } = await auth()
  if (!userId) redirect('/sign-in')

  const admin = getSupabaseAdmin()
  const { data: events, error } = await admin
    .from('activity_log')
    .select('id, occurred_at, kind, summary, ok, error, user:user_id ( email )')
    .order('occurred_at', { ascending: false })
    .limit(PAGE_SIZE)
    .returns<ActivityEvent[]>()

  const rows = events ?? []

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-6 flex items-start justify-between gap-6">
        <div>
          <h1 className="font-heading text-[24px] tracking-[-0.01em] text-foreground/95">
            Activity
          </h1>
        </div>
        {/* Plain anchors, not next/link, so the browser treats them as downloads. */}
        <div className="hidden shrink-0 items-center gap-4 sm:flex">
          <a
            href="/api/reports/activity?format=csv"
            className="text-[13px] text-muted-foreground transition-colors hover:text-foreground"
            title="Last 30 days of activity as a CSV"
          >
            Download CSV
          </a>
          <a
            href="/api/reports/activity?format=xlsx"
            className="text-[13px] text-muted-foreground transition-colors hover:text-foreground"
            title="Last 30 days of activity as a spreadsheet"
          >
            Excel
          </a>
        </div>
      </div>

      <div className="overflow-hidden rounded-md border border-border/70 bg-card/40">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border/70 text-left text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Time (UTC)</th>
              <th className="px-4 py-2.5 font-medium">Who</th>
              <th className="px-4 py-2.5 font-medium">Action</th>
              <th className="px-4 py-2.5 font-medium">Summary</th>
              <th className="px-4 py-2.5 font-medium">Result</th>
            </tr>
          </thead>
          <tbody>
            {/* A failed read and an empty log are indistinguishable once the
                query has been coalesced to [], and this is the page the team is
                told to attach to a problem report. Say which one happened. */}
            {error && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-rose-600">
                  Could not load the activity log — {error.message}
                </td>
              </tr>
            )}
            {!error && rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                  Nothing recorded yet.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-border/50 last:border-0 align-top">
                <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-muted-foreground">
                  {fmtTime(r.occurred_at)}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">
                  {emailOf(r.user)}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5">
                  {KIND_LABELS[r.kind] ?? r.kind}
                </td>
                <td className="px-4 py-2.5">
                  <div className="max-w-xl truncate" title={r.summary}>
                    {r.summary}
                  </div>
                  {/* The error is the whole reason a failed row is worth showing. */}
                  {!r.ok && r.error && (
                    <div className="mt-0.5 text-[12px] text-rose-600">{r.error}</div>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5">
                  <span
                    className={
                      r.ok
                        ? 'rounded border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-700'
                        : 'rounded border border-rose-300 bg-rose-50 px-1.5 py-0.5 text-[11px] text-rose-700'
                    }
                  >
                    {r.ok ? 'OK' : 'Failed'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length === PAGE_SIZE && (
        <p className="mt-3 text-[12px] text-muted-foreground">
          Showing the latest {PAGE_SIZE}. The download covers the last 30 days.
        </p>
      )}
    </div>
  )
}
