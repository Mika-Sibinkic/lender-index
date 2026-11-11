import { describe, it, expect } from 'vitest'
import { cn } from '@/lib/utils'

/**
 * CurrencyInput renders "$" absolutely positioned at left-3 and relies on the
 * input carrying pl-7 to keep the typed digits clear of it.
 *
 * The bug (reported 2026-08-03 with a screenshot of "$100,000" whose 1 sat on
 * top of the $): the component composed `cn('pl-7', className)`. EditableField
 * passes `px-3`, and tailwind-merge drops an earlier class that a later one
 * supersedes — so pl-7 vanished, the padding fell back to 12px, and the digits
 * started exactly where the $ was drawn.
 *
 * This is a class-composition ordering bug, which is invisible in review and
 * only shows up on screen. Pin it.
 */
const CALLER = 'border-border/65 bg-card/60 px-3 placeholder:text-muted-foreground/60'

describe('CurrencyInput padding composition', () => {
  it('keeps pl-7 when the caller passes px-3', () => {
    expect(cn(CALLER, 'pl-7 tabular-nums')).toContain('pl-7')
  })

  it('documents the broken order that caused the overlap', () => {
    // Ours-first is what shipped and what dropped the padding.
    expect(cn('pl-7 tabular-nums', CALLER)).not.toContain('pl-7')
  })

  it('still lets the caller keep its other styling', () => {
    const out = cn(CALLER, 'pl-7 tabular-nums')
    expect(out).toContain('bg-card/60')
    expect(out).toContain('px-3') // right padding still comes from the caller
    expect(out).toContain('tabular-nums')
  })
})
