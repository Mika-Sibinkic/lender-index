import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getSupabaseAdmin } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

interface RunRow {
  id: string
  status: string
  missing_fields: string[]
  created_at: string
  updated_at: string
  error: string | null
  funding_source: { id: string; company_name: string; primary_contact_email: string | null } | null
  outreach_draft: Array<{ subject: string; body_text: string; questions: string[]; model: string; prompt_version: string }>
  outreach_sent: Array<{ kind: string; sent_at: string; dry_run: boolean }>
}

const STATUS_COLORS: Record<string, string> = {
  queued: 'bg-slate-100 text-slate-700 border-slate-300',
  drafting: 'bg-blue-50 text-blue-700 border-blue-300',
  awaiting_approval: 'bg-amber-50 text-amber-700 border-amber-300',
  sent: 'bg-emerald-50 text-emerald-700 border-emerald-300',
  declined: 'bg-zinc-100 text-zinc-600 border-zinc-300',
  expired: 'bg-zinc-100 text-zinc-500 border-zinc-300',
  error: 'bg-rose-50 text-rose-700 border-rose-300',
}

export default async function OutreachPage() {
  const { userId } = await auth()
  if (!userId) redirect('/sign-in')

  const admin = getSupabaseAdmin()
  const { data: user } = await admin
    .from('users')
    .select('role')
    .eq('clerk_user_id', userId)
    .single()
  if (!user || user.role !== 'admin') {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16 text-center">
        <div className="text-sm text-muted-foreground">Admin only.</div>
      </div>
    )
  }

  const { data: runs, error } = await admin
    .from('outreach_run')
    .select(`
      id, status, missing_fields, created_at, updated_at, error,
      funding_source:funding_sources!inner ( id, company_name, primary_contact_email ),
      outreach_draft ( subject, body_text, questions, model, prompt_version ),
      outreach_sent ( kind, sent_at, dry_run )
    `)
    .order('created_at', { ascending: false })
    .limit(100)
    .returns<RunRow[]>()

  // Every counter below is derived from this one array, so a failed query paints
  // a calm, fully-loaded page reporting zero outreach across the board.
  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16 text-center">
        <div className="text-sm text-rose-700">
          Could not load outreach runs — {error.message}
        </div>
      </div>
    )
  }

  const rows = runs ?? []

  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1
    return acc
  }, {})

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <div className="mb-6">
        <h1 className="font-heading text-[28px] leading-tight tracking-[-0.01em]">Outreach</h1>
        <div className="mt-1 text-[13px] text-muted-foreground">
          A draft per stale lender goes to an operator for approval, once a day.
        </div>
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        {['queued', 'drafting', 'awaiting_approval', 'sent', 'declined', 'expired', 'error'].map((s) => (
          <div
            key={s}
            className={`rounded-md border px-3 py-1.5 text-[12px] ${STATUS_COLORS[s] ?? 'border-border'}`}
          >
            <span className="font-mono tabular-nums">{counts[s] ?? 0}</span>{' '}
            <span className="uppercase tracking-[0.12em] text-[10px]">{s.replace('_', ' ')}</span>
          </div>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-md border border-border/60 bg-card/40 p-12 text-center text-sm text-muted-foreground">
          No runs yet. Trigger one from a lender&rsquo;s page, or wait for the daily run.
        </div>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => {
            const draft = r.outreach_draft?.[0]
            const approvalSent = r.outreach_sent?.find((s) => s.kind === 'approval')
            const lenderSent = r.outreach_sent?.find((s) => s.kind === 'lender')
            return (
              <li
                key={r.id}
                className="rounded-md border border-border/70 bg-card/60 px-5 py-4 shadow-[0_1px_2px_rgba(15,20,35,0.025)]"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <div className="min-w-0">
                    {r.funding_source ? (
                      <Link
                        href={`/source/${r.funding_source.id}`}
                        className="font-heading text-[17px] tracking-[-0.005em] hover:underline"
                      >
                        {r.funding_source.company_name}
                      </Link>
                    ) : (
                      <span className="font-heading text-[17px] text-muted-foreground">(deleted)</span>
                    )}
                    {r.funding_source?.primary_contact_email && (
                      <span className="ml-2 text-[12px] text-muted-foreground">
                        → {r.funding_source.primary_contact_email}
                      </span>
                    )}
                  </div>
                  <span
                    className={`shrink-0 rounded-sm border px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] ${STATUS_COLORS[r.status] ?? 'border-border'}`}
                  >
                    {r.status.replace('_', ' ')}
                  </span>
                </div>

                {r.missing_fields?.length > 0 && (
                  <div className="mt-2 text-[12px] text-muted-foreground">
                    Gaps: {r.missing_fields.join(' · ')}
                  </div>
                )}

                {draft && (
                  <details className="mt-3 group">
                    <summary className="flex cursor-pointer items-baseline gap-1.5 text-[12px] text-foreground/85 hover:text-foreground [&::-webkit-details-marker]:hidden">
                      <span
                        aria-hidden
                        className="inline-block text-muted-foreground/70 transition-transform group-open:rotate-90"
                      >
                        ▸
                      </span>
                      <span>
                        Draft preview — “{draft.subject}”{' '}
                        <span className="text-muted-foreground/70">
                          ({draft.model} · {draft.prompt_version})
                        </span>
                      </span>
                    </summary>
                    <div className="mt-2 whitespace-pre-wrap rounded-sm border border-border/50 bg-muted/30 p-3 font-mono text-[12px] leading-relaxed text-foreground/90">
                      {draft.body_text}
                    </div>
                    {draft.questions?.length > 0 && (
                      <div className="mt-2 text-[11px] text-muted-foreground">
                        Questions: {draft.questions.join(' · ')}
                      </div>
                    )}
                  </details>
                )}

                {r.error && (
                  <div className="mt-3 rounded-sm border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
                    {r.error}
                  </div>
                )}

                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground/85">
                  <span>Queued {new Date(r.created_at).toLocaleString()}</span>
                  {approvalSent && (
                    <span>
                      Approval email {approvalSent.dry_run ? '(dry-run)' : 'sent'}{' '}
                      {new Date(approvalSent.sent_at).toLocaleString()}
                    </span>
                  )}
                  {lenderSent && (
                    <span>
                      Lender email {lenderSent.dry_run ? '(dry-run)' : 'sent'}{' '}
                      {new Date(lenderSent.sent_at).toLocaleString()}
                    </span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
