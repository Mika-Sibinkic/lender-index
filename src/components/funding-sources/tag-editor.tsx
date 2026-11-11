'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { TagChip } from '@/components/funding-sources/tag-chips'
import type { Tag } from '@/lib/tags/repo'
import { cn } from '@/lib/utils'

const COLOR_DOT: Record<Tag['color'], string> = {
  red: 'bg-red-500',
  amber: 'bg-amber-500',
  green: 'bg-green-500',
  blue: 'bg-blue-500',
  violet: 'bg-violet-500',
  slate: 'bg-slate-500',
}

/**
 * In-place tag editor for the detail page.
 *
 * Shows applied tags as removable chips, plus a "+ Add tag" combobox
 * with the unused tags from the org's palette. Editors and admins
 * both have access (matches funding_source_tag RLS).
 */
export function TagEditor({
  fundingSourceId,
  appliedTags,
  allTags,
}: {
  fundingSourceId: string
  appliedTags: { id: string; name: string; color: Tag['color'] }[]
  allTags: Tag[]
}) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)

  const appliedIds = new Set(appliedTags.map((t) => t.id))
  const candidates = allTags.filter((t) => !appliedIds.has(t.id))

  async function apply(tagId: string) {
    setBusy(true)
    try {
      const res = await fetch(`/api/funding-sources/${fundingSourceId}/tags`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tagId }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        toast.error('Could not apply tag', { description: j.error })
        return
      }
      startTransition(() => router.refresh())
    } finally {
      setBusy(false)
      setAdding(false)
    }
  }

  async function remove(tagId: string) {
    setBusy(true)
    try {
      const res = await fetch(
        `/api/funding-sources/${fundingSourceId}/tags?tagId=${encodeURIComponent(tagId)}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        toast.error('Could not remove tag', { description: j.error })
        return
      }
      startTransition(() => router.refresh())
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {appliedTags.map((t) => (
        <TagChip
          key={t.id}
          name={t.name}
          color={t.color}
          onRemove={() => remove(t.id)}
        />
      ))}
      {appliedTags.length === 0 && !adding && (
        <span className="text-[12px] text-muted-foreground/70">No tags applied.</span>
      )}
      {!adding && candidates.length > 0 && (
        <button
          type="button"
          disabled={busy}
          onClick={() => setAdding(true)}
          className="rounded-full border border-dashed border-border/70 px-2 py-0.5 text-[11px] text-muted-foreground hover:border-border hover:text-foreground"
        >
          + Add tag
        </button>
      )}
      {adding && (
        <div className="flex flex-wrap items-center gap-1.5">
          {candidates.map((t) => (
            <button
              key={t.id}
              type="button"
              disabled={busy}
              onClick={() => apply(t.id)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card/60 px-2 py-0.5 text-[11px] text-foreground/85 hover:border-foreground/60',
                busy && 'opacity-50',
              )}
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', COLOR_DOT[t.color])} aria-hidden />
              {t.name}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setAdding(false)}
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            cancel
          </button>
        </div>
      )}
    </div>
  )
}
