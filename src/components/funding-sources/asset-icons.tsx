import { assetVisual, orderAssets } from '@/lib/funding-sources/asset-visuals'
import { cn } from '@/lib/utils'

/**
 * Asset-focus as glyph + label chips instead of a "·"-separated word list, so a
 * lender's asset focus reads at a glance. Server-renderable (pure props). Each
 * glyph pairs with a visible label (learnability) and a title tooltip.
 */
export function AssetIcons({
  classes,
  max = 3,
  size = 14,
  className,
}: {
  classes: string[]
  max?: number
  size?: number
  className?: string
}) {
  if (!classes?.length) {
    return <span className="text-[12px] text-muted-foreground/60">—</span>
  }
  const ordered = orderAssets(classes)
  const shown = ordered.slice(0, max)
  const extra = ordered.length - shown.length

  return (
    <div className={cn('flex flex-wrap items-center gap-x-2.5 gap-y-1', className)}>
      {shown.map((c) => {
        const { label, Icon } = assetVisual(c)
        return (
          <span
            key={c}
            title={label}
            className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground"
          >
            <Icon size={size} strokeWidth={1.75} aria-hidden className="shrink-0 text-foreground/55" />
            <span className="leading-none">{label}</span>
          </span>
        )
      })}
      {extra > 0 && (
        <span className="text-[11px] text-muted-foreground/60" title={ordered.slice(max).map((c) => assetVisual(c).label).join(', ')}>
          +{extra}
        </span>
      )}
    </div>
  )
}
