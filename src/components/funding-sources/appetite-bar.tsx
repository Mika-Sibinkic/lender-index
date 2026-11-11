'use client'

import { bandGeometry, formatUsdCompact } from '@/lib/funding-sources/appetite-band'
import { useSearchFit } from '@/components/funding-sources/search-fit'
import { cn } from '@/lib/utils'

/**
 * Deal-size appetite bar — the redesign's signature device. A log-scaled track
 * shows the lender's min–max band; during a search a marker shows where THIS
 * deal sits and whether it lands inside the band. On a plain browse (no search
 * stash) it's just the band. Geometry + formatting are unit-tested in
 * lib/funding-sources/appetite-band.
 */
export function AppetiteBar({
  min,
  max,
  rowId,
  className,
}: {
  min: number | null
  max: number | null
  rowId: string
  className?: string
}) {
  const sf = useSearchFit(rowId)
  // A bare "$8M" query sets both bounds to the target; prefer max, else min.
  const dealAmount = sf?.deal ? (sf.deal.max ?? sf.deal.min ?? null) : null

  const g = bandGeometry({ lenderMin: min, lenderMax: max, dealAmount })
  if (!g.hasBand) {
    return <span className={cn('font-mono text-[12px] text-muted-foreground/50', className)}>—</span>
  }

  const width = Math.max(g.endPct - g.startPct, 1.5)
  const inBand = g.dealPosition === 'in'
  const summary =
    `Appetite ${formatUsdCompact(min)} to ${max ? formatUsdCompact(max) : 'open'}` +
    (g.dealPosition ? `; this deal sits ${g.dealPosition === 'in' ? 'within the band' : `${g.dealPosition} the band`}` : '')

  return (
    <div className={cn('w-full min-w-[7rem]', className)}>
      <div
        className="relative h-1.5 w-full overflow-visible rounded-full bg-muted/70"
        role="img"
        aria-label={summary}
      >
        <div
          className="absolute inset-y-0 rounded-full bg-foreground/25"
          style={{ left: `${g.startPct}%`, width: `${width}%` }}
        />
        {g.dealPct !== null && (
          <span
            className={cn(
              'absolute top-1/2 h-3.5 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-background',
              inBand ? 'bg-emerald-500' : 'bg-amber-500'
            )}
            style={{ left: `${g.dealPct}%` }}
          />
        )}
      </div>
      <div className="mt-1 flex items-baseline justify-between font-mono text-[11px] tabular-nums text-muted-foreground/75">
        <span>{formatUsdCompact(min)}</span>
        <span>{max ? formatUsdCompact(max) : <span className="text-muted-foreground/50">open</span>}</span>
      </div>
    </div>
  )
}
