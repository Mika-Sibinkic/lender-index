'use client'

import { useState } from 'react'
import { toast } from 'sonner'

export function TriggerOutreachButton({ fundingSourceId }: { fundingSourceId: string }) {
  const [busy, setBusy] = useState(false)

  async function trigger() {
    if (busy) return
    setBusy(true)
    try {
      const res = await fetch('/api/outreach/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ funding_source_id: fundingSourceId }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`)
      if (json.reused) {
        toast.info(`Already has an open run — status: ${json.status}`)
      } else if (json.drafted) {
        toast.success('Drafted. Check the Outreach tab for the preview.')
      } else {
        toast.warning(`Run ${json.run_id} queued, draft pending.`)
      }
    } catch (e) {
      toast.error(`Outreach trigger failed: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={trigger}
      disabled={busy}
      className="rounded-sm border border-border/70 bg-background/60 px-2.5 py-1 text-[11px] uppercase tracking-[0.12em] text-foreground/85 transition-colors hover:bg-accent/[0.08] disabled:opacity-50"
    >
      {busy ? 'Drafting…' : 'Outreach →'}
    </button>
  )
}
