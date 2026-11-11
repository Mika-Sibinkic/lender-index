import Link from 'next/link'
import type { FundingSourceRow } from '@/lib/types/funding-source'
import type { Tag } from '@/lib/tags/repo'
import { TagChipList } from '@/components/funding-sources/tag-chips'
import { AssetIcons } from '@/components/funding-sources/asset-icons'
import { AppetiteBar } from '@/components/funding-sources/appetite-bar'
import { FitChips } from '@/components/funding-sources/search-fit'
import { tagsForListRow } from '@/lib/tags/display'

export type FundingSourceListRow = FundingSourceRow & {
  tags?: { id: string; name: string; color: Tag['color'] }[]
  /** Server-side fit from the browse path — see FundingSourceRowWithTags. */
  localToRequest?: boolean
  /** Signals read out of `internal_notes`, each carrying its source sentence. */
  notesPrefer?: string | null
  notesAvoid?: string | null
  notesPaused?: string | null
}

// Desktop grid: Company | Primary contact | Asset focus | Deal appetite
const GRID =
  'sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.15fr)]'

export function ListTable({ rows }: { rows: FundingSourceListRow[] }) {
  if (!rows.length) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-24 text-center text-sm text-muted-foreground">
        No funding sources match your filters.
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl px-3 sm:px-6 py-4">
      <div className="overflow-hidden rounded-md border border-border/70 bg-card/60 shadow-[0_1px_2px_rgba(15,20,35,0.025),0_0_0_1px_rgba(15,20,35,0.015)]">
        {/* Column header — small caps + tight tracking */}
        <div
          className={`hidden sm:grid ${GRID} gap-4 border-b border-border/60 bg-muted/40 px-5 py-2 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground`}
        >
          <div>Company</div>
          <div>Primary contact</div>
          <div>Asset focus</div>
          <div>Deal appetite</div>
        </div>
        <ul className="divide-y divide-border/45">
          {rows.map((r, i) => (
            <li key={r.id} className={i % 2 === 1 ? 'bg-muted/15' : ''}>
              <Link
                href={`/source/${r.id}`}
                className="group block px-5 py-3.5 transition-colors hover:bg-accent/[0.04]"
              >
                {/* Desktop: 4-column grid */}
                <div className={`hidden sm:grid ${GRID} sm:gap-4 sm:items-center`}>
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate font-heading text-[17px] leading-tight tracking-[-0.005em] text-foreground/95 group-hover:text-foreground">
                        {r.company_name}
                      </span>
                      {r.status !== 'active' && (
                        <span className="shrink-0 rounded-sm border border-border/70 bg-background/60 px-1.5 py-px text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
                          {r.status.replaceAll('_', ' ')}
                        </span>
                      )}
                      {r.outreach_status && r.outreach_status !== 'current' && (
                        <span
                          className={`shrink-0 rounded-sm border px-1.5 py-px text-[9px] uppercase tracking-[0.12em] ${
                            r.outreach_status === 'stale'
                              ? 'border-amber-300 bg-amber-50 text-amber-700'
                              : r.outreach_status === 'bouncing'
                                ? 'border-rose-300 bg-rose-50 text-rose-700'
                                : 'border-zinc-300 bg-zinc-100 text-zinc-600'
                          }`}
                        >
                          {r.outreach_status.replaceAll('_', ' ')}
                        </span>
                      )}
                    </div>
                    {/* Fit chips — only for the search that produced this list */}
                    <FitChips
                      rowId={r.id}
                      className="mt-1.5"
                      localFallback={r.localToRequest}
                      notLendingFallback={r.status !== 'active'}
                      notesFallback={{
                        prefer: r.notesPrefer,
                        avoid: r.notesAvoid,
                        paused: r.notesPaused,
                      }}
                    />
                    {r.tags && r.tags.length > 0 && (
                      <TagChipList tags={tagsForListRow(r.tags)} size="xs" className="mt-1.5" />
                    )}
                  </div>
                  <div className="min-w-0 text-[13px] leading-snug">
                    {r.primary_contact_name ? (
                      <>
                        <div className="truncate text-foreground/85">
                          {r.primary_contact_name}
                        </div>
                        {r.primary_contact_title && (
                          <div className="truncate text-[12px] text-muted-foreground">
                            {r.primary_contact_title}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="text-muted-foreground/60">—</div>
                    )}
                  </div>
                  <div className="min-w-0">
                    <AssetIcons classes={r.asset_classes} max={3} />
                  </div>
                  <AppetiteBar
                    min={r.deal_size_min_usd}
                    max={r.deal_size_max_usd}
                    rowId={r.id}
                  />
                </div>

                {/* Mobile: stacked */}
                <div className="sm:hidden space-y-2">
                  <div className="flex items-baseline gap-2">
                    <span className="font-heading text-[16px] tracking-[-0.005em] text-foreground/95">
                      {r.company_name}
                    </span>
                    {r.status !== 'active' && (
                      <span className="shrink-0 rounded-sm border border-border/70 bg-background/60 px-1.5 py-px text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
                        {r.status.replaceAll('_', ' ')}
                      </span>
                    )}
                  </div>
                  <FitChips
                    rowId={r.id}
                    localFallback={r.localToRequest}
                    notLendingFallback={r.status !== 'active'}
                    notesFallback={{
                      prefer: r.notesPrefer,
                      avoid: r.notesAvoid,
                      paused: r.notesPaused,
                    }}
                  />
                  {r.primary_contact_name && (
                    <div className="text-[12px] text-muted-foreground">
                      {r.primary_contact_name}
                      {r.primary_contact_title ? ` · ${r.primary_contact_title}` : ''}
                    </div>
                  )}
                  <AssetIcons classes={r.asset_classes} max={4} />
                  <AppetiteBar
                    min={r.deal_size_min_usd}
                    max={r.deal_size_max_usd}
                    rowId={r.id}
                    className="max-w-[16rem]"
                  />
                  {tagsForListRow(r.tags).length > 0 && (
                    <TagChipList tags={tagsForListRow(r.tags)} size="xs" />
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
        <div className="flex items-baseline justify-between border-t border-border/45 bg-muted/20 px-5 py-2 text-[11px]">
          <span className="text-muted-foreground">
            {rows.length} funding {rows.length === 1 ? 'source' : 'sources'}
          </span>
        </div>
      </div>
    </div>
  )
}
