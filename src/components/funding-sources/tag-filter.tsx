'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback } from 'react'
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

export function TagFilter({ tags }: { tags: Tag[] }) {
  const router = useRouter()
  const params = useSearchParams()
  const activeIds = (params.get('tags') ?? '').split(',').filter(Boolean)

  const toggle = useCallback(
    (id: string) => {
      const next = new URLSearchParams(params)
      const set = new Set((next.get('tags') ?? '').split(',').filter(Boolean))
      if (set.has(id)) set.delete(id)
      else set.add(id)
      if (set.size) next.set('tags', [...set].join(','))
      else next.delete('tags')
      router.replace(`?${next.toString()}`)
    },
    [params, router],
  )

  if (tags.length === 0) return null

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/80">
        Tags
      </span>
      {tags.map((t) => {
        const active = activeIds.includes(t.id)
        return (
          <button
            key={t.id}
            type="button"
            aria-pressed={active}
            onClick={() => toggle(t.id)}
            className={cn(
              'inline-flex items-center gap-1.5 text-[12px] tracking-tight transition-colors',
              active
                ? 'text-foreground underline decoration-accent decoration-2 underline-offset-[6px]'
                : 'text-muted-foreground hover:text-foreground/85',
            )}
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', COLOR_DOT[t.color])} aria-hidden />
            {t.name}
          </button>
        )
      })}
    </div>
  )
}
