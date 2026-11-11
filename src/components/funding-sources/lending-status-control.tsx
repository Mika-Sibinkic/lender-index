'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { humanError } from '@/lib/ui/error-message'
import { LENDING_STATUS_CHOICES } from '@/lib/funding-sources/vocabularies'
import { cn } from '@/lib/utils'

/**
 * "Lending now?" as a one-click control at the top of the record.
 *
 * This column is maintained by hand: staff learn a lender has paused or reopened
 * from a phone call, and nothing in the product can discover it. It was buried
 * as one field among twenty in Lending parameters, which is a lot of friction
 * for the single most perishable fact on the card — and it MATTERS to ranking,
 * because a lender marked "No" sorts below every lending one.
 *
 * The cost of that friction is real: a lender whose `lending_status` reads "Yes"
 * while its own notes say it "stopped renewing loans and stopped funding new
 * loans" can rank second on a Texas search.
 *
 * Optimistic, with a revert on failure — and a real `catch`, because `fetch`
 * throws on a network error and the inline editor used to swallow exactly that
 * and leave the new value on screen as though it had saved.
 */
export function LendingStatusControl({
  id,
  value,
}: {
  id: string
  value: string | null
}) {
  const [current, setCurrent] = useState<string>(value ?? '')
  const [saving, setSaving] = useState(false)
  const router = useRouter()

  async function set(next: string) {
    if (saving || next === current) return
    const previous = current
    setCurrent(next)
    setSaving(true)
    try {
      const res = await fetch(`/api/funding-sources/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lending_status: next || null }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        setCurrent(previous)
        toast.error('Could not update lending status', {
          description: humanError(res.status, err.error),
        })
        return
      }
      router.refresh()
    } catch {
      setCurrent(previous)
      toast.error('Could not update lending status', {
        description: 'Could not reach the server. Check your connection and try again.',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
        Lending now?
      </span>
      <div className="inline-flex rounded-lg border border-border/70 bg-card/60 p-0.5">
        {LENDING_STATUS_CHOICES.map(([stored, label]) => {
          const active = current === stored
          // The full labels ("Yes — actively lending") are right on a dropdown
          // and far too long for a segmented control.
          const short = stored === 'Currently Inactive' ? 'Inactive' : stored
          return (
            <button
              key={stored}
              type="button"
              disabled={saving}
              onClick={() => void set(stored)}
              title={label}
              aria-pressed={active}
              className={cn(
                'rounded-md px-2.5 py-1 text-[12px] transition-colors disabled:opacity-50',
                active
                  ? stored === 'Yes'
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                    : 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {short}
            </button>
          )
        })}
      </div>
      {current === '' && (
        <span className="text-[11px] text-muted-foreground/80">not recorded</span>
      )}
    </div>
  )
}
