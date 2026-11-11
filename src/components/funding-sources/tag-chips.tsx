import { cn } from '@/lib/utils'
import type { TagColor } from '@/lib/tags/repo'

const COLOR_STYLES: Record<TagColor, string> = {
  red: 'bg-red-500/12 text-red-700 ring-red-500/30 dark:text-red-300',
  amber: 'bg-amber-500/12 text-amber-700 ring-amber-500/30 dark:text-amber-300',
  green: 'bg-green-500/12 text-green-700 ring-green-500/30 dark:text-green-300',
  blue: 'bg-blue-500/12 text-blue-700 ring-blue-500/30 dark:text-blue-300',
  violet: 'bg-violet-500/12 text-violet-700 ring-violet-500/30 dark:text-violet-300',
  slate: 'bg-slate-500/12 text-slate-700 ring-slate-500/30 dark:text-slate-300',
}

export function TagChip({
  name,
  color,
  onRemove,
  className,
  size = 'sm',
}: {
  name: string
  color: TagColor
  onRemove?: () => void
  className?: string
  size?: 'xs' | 'sm'
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full ring-1 leading-none',
        size === 'xs' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]',
        COLOR_STYLES[color],
        className,
      )}
    >
      <span className="tracking-tight">{name}</span>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onRemove()
          }}
          aria-label={`Remove ${name}`}
          className="text-current/70 hover:text-current"
        >
          ×
        </button>
      )}
    </span>
  )
}

export function TagChipList({
  tags,
  size = 'xs',
  className,
}: {
  tags: { id: string; name: string; color: TagColor }[]
  size?: 'xs' | 'sm'
  className?: string
}) {
  if (tags.length === 0) return null
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)}>
      {tags.map((t) => (
        <TagChip key={t.id} name={t.name} color={t.color} size={size} />
      ))}
    </span>
  )
}
