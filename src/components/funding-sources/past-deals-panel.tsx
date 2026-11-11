import { getSupabaseServer } from '@/lib/supabase/server'
import { PastDealUpload } from '@/components/funding-sources/past-deal-upload'
import { formatUsdCompact as formatUSD } from '@/lib/format/currency'

export interface ClosedDealRow {
  id: string
  asset_year: number | null
  asset_make: string | null
  asset_model: string | null
  loan_amount_usd: number | null
  rate_pct: number | null
  ltv_pct: number | null
  prepayment_penalty: string | null
  closed_on: string | null
  source_kind: string | null
}

function formatClosedOn(d: string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short' })
}

function formatAsset(d: ClosedDealRow): string {
  const parts: string[] = []
  if (d.asset_year) parts.push(String(d.asset_year))
  if (d.asset_make) parts.push(d.asset_make)
  if (d.asset_model) parts.push(d.asset_model)
  return parts.length ? parts.join(' ') : '—'
}

export async function PastDealsPanel({ fundingSourceId }: { fundingSourceId: string }) {
  const sb = await getSupabaseServer()
  const { data, error } = await sb
    .from('closed_deal')
    .select('id, asset_year, asset_make, asset_model, loan_amount_usd, rate_pct, ltv_pct, prepayment_penalty, closed_on, source_kind')
    .eq('funding_source_id', fundingSourceId)
    .order('closed_on', { ascending: false })
    .limit(50)
  if (error) {
    return (
      <div className="text-[12px] text-red-600">
        Failed to load past deals: {error.message}
      </div>
    )
  }
  const rows = (data ?? []) as ClosedDealRow[]

  if (rows.length === 0) {
    return (
      <div>
        <PastDealUpload fundingSourceId={fundingSourceId} />
        <div className="rounded-md border border-border/60 bg-card/40 px-5 py-10 text-center text-[13px] text-muted-foreground">
          No past deals on file with this funder yet.
        </div>
      </div>
    )
  }

  return (
    <div>
      <PastDealUpload fundingSourceId={fundingSourceId} />
      <div className="overflow-hidden rounded-md border border-border/70 bg-card/60">
      <div className="hidden sm:grid sm:grid-cols-[minmax(0,1.4fr)_minmax(0,0.9fr)_minmax(0,0.7fr)_minmax(0,0.7fr)_minmax(0,0.9fr)] gap-4 border-b border-border/60 bg-muted/40 px-5 py-2 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        <div>Asset</div>
        <div className="text-right">Loan</div>
        <div className="text-right">Rate</div>
        <div className="text-right">LTV</div>
        <div className="text-right">Closed</div>
      </div>
      <ul className="divide-y divide-border/45">
        {rows.map((d, i) => (
          <li key={d.id} className={i % 2 === 1 ? 'bg-muted/15' : ''}>
            <div className="grid grid-cols-1 gap-2 px-5 py-3 text-[13px] sm:grid-cols-[minmax(0,1.4fr)_minmax(0,0.9fr)_minmax(0,0.7fr)_minmax(0,0.7fr)_minmax(0,0.9fr)] sm:gap-4">
              <div className="font-medium text-foreground/90">{formatAsset(d)}</div>
              <div className="text-right font-mono tabular-nums text-foreground/85">{formatUSD(d.loan_amount_usd)}</div>
              <div className="text-right font-mono tabular-nums text-muted-foreground">
                {d.rate_pct === null ? '—' : `${d.rate_pct.toFixed(2)}%`}
              </div>
              <div className="text-right font-mono tabular-nums text-muted-foreground">
                {d.ltv_pct === null ? '—' : `${d.ltv_pct.toFixed(0)}%`}
              </div>
              <div className="text-right text-muted-foreground">
                {formatClosedOn(d.closed_on)}
              </div>
            </div>
            {d.prepayment_penalty && (
              <div className="px-5 pb-2 text-[11px] text-muted-foreground">
                Prepayment: {d.prepayment_penalty}
              </div>
            )}
          </li>
        ))}
      </ul>
      </div>
    </div>
  )
}
