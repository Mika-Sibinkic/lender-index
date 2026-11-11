import { notFound } from 'next/navigation'
import { auth } from '@clerk/nextjs/server'
import { getSupabaseServer } from '@/lib/supabase/server'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { BackToList } from '@/components/funding-sources/back-to-list'
import { DetailView } from '@/components/funding-sources/detail-view'
import { EditHistory, type EditEntry } from '@/components/funding-sources/edit-history'
import { PastDealsPanel } from '@/components/funding-sources/past-deals-panel'
import { TagEditor } from '@/components/funding-sources/tag-editor'
import { TriggerOutreachButton } from '@/components/funding-sources/trigger-outreach-button'
import { Card } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { listTags, tagsForSource } from '@/lib/tags/repo'

function formatRelative(iso: string | null): string {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  const days = Math.round((Date.now() - then) / (1000 * 86400))
  if (days < 1) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  if (days < 365) return `${Math.round(days / 30)} months ago`
  return `${Math.round(days / 365)} years ago`
}

const OUTREACH_STATUS_STYLE: Record<string, string> = {
  current: 'text-green-700 ring-green-500/30 bg-green-500/10',
  stale: 'text-amber-700 ring-amber-500/30 bg-amber-500/10',
  bouncing: 'text-red-700 ring-red-500/30 bg-red-500/10',
  do_not_contact: 'text-slate-700 ring-slate-500/30 bg-slate-500/10',
}

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const sb = await getSupabaseServer()
  const { data, error } = await sb
    .from('funding_sources')
    .select('*')
    .eq('id', id)
    .single()
  if (error || !data) notFound()

  const [edits, allTags, applied] = await Promise.all([
    sb
      .from('funding_source_edits')
      .select('id, field_name, old_value, new_value, edited_at, users(email)')
      .eq('funding_source_id', id)
      .order('edited_at', { ascending: false })
      .limit(50),
    listTags(sb),
    tagsForSource(sb, id),
  ])
  const normalized: EditEntry[] = (edits.data ?? []).map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (e: any) => ({ ...e, user_email: e.users?.email ?? null }),
  )
  // EditHistory renders "No edits recorded yet." for an empty array, which is the
  // wrong answer — and an authoritative-sounding one — when the query failed.
  const editsError = edits.error

  const outreachStatus: string = data.outreach_status ?? 'current'
  const lastContact: string | null = data.last_contact_at ?? null

  // Admin-only check for the trigger button
  let isAdmin = false
  try {
    const { userId } = await auth()
    if (userId) {
      const admin = getSupabaseAdmin()
      const { data: u } = await admin
        .from('users')
        .select('role')
        .eq('clerk_user_id', userId)
        .single()
      isAdmin = u?.role === 'admin'
    }
  } catch {
    isAdmin = false
  }

  return (
    <Tabs defaultValue="overview" className="mx-auto max-w-3xl px-4">
      <BackToList />
      <TabsList className="mt-4">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="past-deals">Past deals</TabsTrigger>
        <TabsTrigger value="history">Edit history</TabsTrigger>
      </TabsList>

      <TabsContent value="overview">
        <div className="mx-auto max-w-3xl px-5 sm:px-8 pt-6">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-border/60 bg-card/40 px-4 py-2.5 text-[12px]">
            <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/80">
              Outreach
            </span>
            <span
              className={`inline-flex items-center rounded-full ring-1 px-2 py-0.5 text-[11px] ${
                OUTREACH_STATUS_STYLE[outreachStatus] ?? OUTREACH_STATUS_STYLE.current
              }`}
            >
              {outreachStatus.replace('_', ' ')}
            </span>
            <span className="text-muted-foreground">
              last contact: <span className="text-foreground/80">{formatRelative(lastContact)}</span>
            </span>
            {isAdmin && (
              <div className="ml-auto">
                <TriggerOutreachButton fundingSourceId={id} />
              </div>
            )}
          </div>
          <div className="mt-4">
            <div className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/90">
              Tags
            </div>
            <TagEditor fundingSourceId={id} appliedTags={applied} allTags={allTags} />
          </div>
        </div>
        <DetailView row={data} />
      </TabsContent>

      <TabsContent value="past-deals" className="pb-8 pt-4">
        <PastDealsPanel fundingSourceId={id} />
      </TabsContent>

      <TabsContent value="history" className="pb-8 pt-4">
        {editsError ? (
          <Card className="p-8 text-center text-sm text-rose-600">
            Could not load the edit history — {editsError.message}
          </Card>
        ) : (
          <EditHistory edits={normalized} />
        )}
      </TabsContent>
    </Tabs>
  )
}
