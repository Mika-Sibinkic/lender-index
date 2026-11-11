'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { browserNavigation, cameFromList } from '@/lib/ui/return-to-list'

/**
 * The record page's way back to the list.
 *
 * `href="/"` stays as the declared target, so a cold-opened record, a
 * middle-click and a no-JS render all still land somewhere sensible. When the
 * entry behind this one is the list, the click traverses back to it instead —
 * which is what keeps the search sentence, the ranked `ids` and the fit chips
 * the operator was working. Why, at length: `src/lib/ui/return-to-list.ts`.
 */
export function BackToList() {
  const router = useRouter()
  return (
    <Link
      href="/"
      className="mt-4 inline-block text-[10px] uppercase tracking-[0.18em] text-muted-foreground/80 transition-colors hover:text-foreground"
      onClick={(e) => {
        // Cmd/ctrl/shift-click is "open this elsewhere", and elsewhere has no
        // history of ours — let the href do its job.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
        if (!cameFromList(browserNavigation(), window.location.origin)) return
        e.preventDefault()
        router.back()
      }}
    >
      ← All sources
    </Link>
  )
}
