'use client'

import { forwardRef, useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { splitMultiValue, joinMultiValue, multiValueMatches } from '@/lib/format/multi-value'

/**
 * Text input backing a `string[]` field (Geographic target, etc).
 *
 * The whole point is the RAW BUFFER. A controlled input that re-derives its
 * value from the array on every keystroke (`value={arr.join(', ')}`) deletes the
 * space you just typed before it can render, making "United States" untypable —
 * the bug users reported as "Geographic Target area will not allow spaces".
 *
 * So: while focused, the box shows exactly what was typed. Values are committed
 * on blur (and on Enter) via splitMultiValue, which accepts comma, semicolon,
 * slash and newline. `onChange` still fires per keystroke so a parent that
 * validates or gates Save stays live — it just is not the source of the
 * displayed text.
 *
 * An external update (an AI parse filling the card) flows in only when it
 * genuinely differs from what is in the box, so it can never clobber typing.
 */
export interface MultiValueInputProps
  extends Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange'> {
  value: readonly string[]
  onChange: (values: string[]) => void
}

export const MultiValueInput = forwardRef<HTMLInputElement, MultiValueInputProps>(
  function MultiValueInput({ value, onChange, onBlur, onKeyDown, ...rest }, ref) {
    const [text, setText] = useState(() => joinMultiValue(value))
    const focused = useRef(false)

    // Adopt an external change (AI parse, reset) — but never while the user is
    // mid-entry, and never when it would say the same thing they already typed.
    useEffect(() => {
      if (focused.current) return
      if (multiValueMatches(text, value)) return
      setText(joinMultiValue(value))
      // `text` is deliberately not a dependency: this effect exists to react to
      // the incoming array, not to fight the buffer it just set.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value])

    function commit(next: string) {
      setText(next)
      onChange(splitMultiValue(next))
    }

    return (
      <Input
        ref={ref}
        type="text"
        autoComplete="off"
        value={text}
        onFocus={() => {
          focused.current = true
        }}
        onChange={(e) => commit(e.target.value)}
        onBlur={(e) => {
          focused.current = false
          // Tidy to canonical form only once the user has left the field.
          setText(joinMultiValue(splitMultiValue(e.target.value)))
          onBlur?.(e)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            setText(joinMultiValue(splitMultiValue(e.currentTarget.value)))
          }
          onKeyDown?.(e)
        }}
        {...rest}
      />
    )
  }
)
