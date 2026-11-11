'use client'

import { forwardRef, useLayoutEffect, useRef } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { digitsOnly, groupThousands, formatCurrencyInput } from '@/lib/format/currency'

/**
 * Dollar input that adds thousands-commas LIVE as you type, while storing the raw
 * digit string (no commas) so the value submits cleanly to the API (the Zod
 * `numberFromInput` coerces "10000000", not "10,000,000").
 *
 * Uses type=text (browsers reject commas in type=number) + inputMode=numeric for
 * the numeric mobile keypad. Cursor position is preserved across each reformat by
 * counting the digits left of the caret — so editing mid-number doesn't jump you
 * to the end. Whole dollars only (deal sizes have no cents).
 */
export interface CurrencyInputProps
  extends Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange' | 'type'> {
  /** raw value — digit string ("10000000") or number, never comma-formatted. */
  value: string | number | null | undefined
  /** called with the raw digit string (no commas). */
  onChange: (rawDigits: string) => void
}

export const CurrencyInput = forwardRef<HTMLInputElement, CurrencyInputProps>(
  function CurrencyInput({ value, onChange, className, ...rest }, forwardedRef) {
    const innerRef = useRef<HTMLInputElement | null>(null)
    const pendingCaret = useRef<number | null>(null)

    const setRefs = (el: HTMLInputElement | null) => {
      innerRef.current = el
      if (typeof forwardedRef === 'function') forwardedRef(el)
      else if (forwardedRef)
        (forwardedRef as React.RefObject<HTMLInputElement | null>).current = el
    }

    const display = formatCurrencyInput(value)

    useLayoutEffect(() => {
      const el = innerRef.current
      if (el && pendingCaret.current !== null) {
        el.setSelectionRange(pendingCaret.current, pendingCaret.current)
        pendingCaret.current = null
      }
    })

    function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
      const el = e.target
      const caret = el.selectionStart ?? el.value.length
      const digitsBeforeCaret = digitsOnly(el.value.slice(0, caret)).length
      const nextRaw = digitsOnly(el.value)
      const nextDisplay = groupThousands(nextRaw)
      // Re-place the caret after the same number of digits in the regrouped string.
      let pos = 0
      let seen = 0
      while (pos < nextDisplay.length && seen < digitsBeforeCaret) {
        if (/\d/.test(nextDisplay[pos])) seen++
        pos++
      }
      pendingCaret.current = pos
      onChange(nextRaw)
    }

    return (
      <div className="relative">
        <span
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground"
        >
          $
        </span>
        <Input
          ref={setRefs}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={display}
          onChange={handleChange}
          // The caller's className goes FIRST on purpose. The left padding is not
          // a style choice here — it is what keeps the typed digits clear of the
          // absolutely-positioned "$". With it written first, a caller passing
          // `px-3` (which EditableField does, via baseInputClasses) made twMerge
          // drop `pl-7` as superseded, and "$100,000" rendered with the 1 sitting
          // on top of the $. Ours must win.
          className={cn(className, 'pl-7 tabular-nums')}
          {...rest}
        />
      </div>
    )
  }
)
