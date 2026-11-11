'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Input } from '@/components/ui/input'
import { CurrencyInput } from '@/components/ui/currency-input'
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'
import { humanError } from '@/lib/ui/error-message'
import { splitMultiValue } from '@/lib/format/multi-value'

type Props = {
  id: string
  field: string
  value: string | number | string[] | null
  type?: 'text' | 'number' | 'currency' | 'textarea' | 'email' | 'array' | 'select' | 'multiselect'
  placeholder?: string
  className?: string
  monoOnDisplay?: boolean
  /**
   * Allowed values for a controlled field, as [storedValue, labelShown].
   *
   * These columns are compared by EXACT string downstream — structured-filter's
   * intlDim tests `norm(intl_domestic) === 'domestic' | 'international' | 'both'`
   * and anything else falls through and is treated as blank. The detail page
   * rendered them as free text with a placeholder reading "US / International /
   * Both", so an operator who typed the word the placeholder suggested silently
   * voided the international hard-exclude for that lender — and the field then
   * displayed "US" and looked correct forever. The intake card already had this
   * right; the detail page did not.
   */
  options?: ReadonlyArray<readonly [string, string]>
}

export function EditableField({
  id,
  field,
  value,
  type = 'text',
  placeholder,
  className,
  monoOnDisplay,
  options,
}: Props) {
  const toDisplay = (v: Props['value']) => (Array.isArray(v) ? v.join(', ') : (v ?? ''))
  const [draft, setDraft] = useState<string | number>(toDisplay(value))
  const [saving, setSaving] = useState(false)
  const router = useRouter()
  const initial = useRef<string | number>(toDisplay(value))

  // `next` lets a control that changes and commits in one gesture (the <select>
  // below) pass its new value directly. Reading `draft` from the closure would
  // read the value from BEFORE the state update and save the wrong thing.
  async function save(next?: string | number) {
    const value = next ?? draft
    if (String(value) === String(initial.current)) return
    setSaving(true)
    try {
      // Same liberal normalisation as the intake card, so a value typed or
      // pasted as "US / Brazil" means the same thing on both screens.
      const payload =
        type === 'array'
          ? splitMultiValue(String(value))
          : value === ''
            ? null
            : value
      const res = await fetch(`/api/funding-sources/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [field]: payload }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        // Never dump the raw payload at the operator — a stringified Zod error
        // blob is noise they cannot act on.
        toast.error('Save failed', { description: humanError(res.status, err.error) })
        setDraft(initial.current)
      } else {
        initial.current = value
        router.refresh()
        // The server says the row saved but could not be re-indexed. Search will
        // not find it until that succeeds, which the operator has no other way
        // of knowing — the warning was being authored and thrown away.
        const body = (await res.json().catch(() => null)) as { warning?: string } | null
        if (body?.warning) toast.warning(body.warning)
      }
    } catch (e) {
      // fetch() THROWS on a network failure — offline, DNS, TLS, aborted, or a
      // connection killed mid-flight. With only try/finally, control skipped
      // both the toast and the revert, so the input kept rendering the new value
      // exactly as if it had saved. The operator tabs away believing the edit
      // landed and nothing was written: no row, no audit entry, no trace.
      setDraft(initial.current)
      toast.error('Save failed — not saved', {
        description:
          e instanceof Error && e.name === 'AbortError'
            ? 'The request was cancelled. Try again.'
            : 'Could not reach the server. Check your connection and try again.',
      })
    } finally {
      setSaving(false)
    }
  }

  const baseInputClasses =
    'border-border/65 bg-card/60 px-3 placeholder:text-muted-foreground/60 focus-visible:bg-card focus-visible:ring-accent/40'

  if (type === 'multiselect' && options) {
    // A tick list for the values the matcher knows, plus a box for anything else.
    //
    // This field hard-excludes: a value outside the vocabulary silently drops the
    // lender from every search naming an asset type. Free text made that a typo
    // away. The "other" box still accepts anything — refusing it would lose real
    // data staff have no other place to put — but it is visibly separate from the
    // values that actually drive matching, so the difference is legible.
    const current = splitMultiValue(String(draft))
    const known = new Set(options.map(([v]) => v))
    const picked = new Set(current.filter((v) => known.has(v)))
    const extras = current.filter((v) => !known.has(v))

    const commit = (nextPicked: Set<string>, nextExtras: string[]) => {
      const merged = [...options.map(([v]) => v).filter((v) => nextPicked.has(v)), ...nextExtras]
      const joined = merged.join(', ')
      setDraft(joined)
      void save(joined)
    }

    return (
      <div className={className}>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
          {options.map(([stored, label]) => (
            <label key={stored} className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <input
                type="checkbox"
                checked={picked.has(stored)}
                disabled={saving}
                onChange={(e) => {
                  const next = new Set(picked)
                  if (e.target.checked) next.add(stored)
                  else next.delete(stored)
                  commit(next, extras)
                }}
                className="h-3.5 w-3.5 rounded border-border/70 accent-foreground"
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <div className="mt-2.5">
          <span className="block text-[10px] uppercase tracking-[0.16em] text-muted-foreground/80 mb-1">
            Other (not used for matching)
          </span>
          <Input
            defaultValue={extras.join(', ')}
            placeholder="anything the list above does not cover"
            disabled={saving}
            onBlur={(e) => commit(picked, splitMultiValue(e.target.value))}
            className={`h-8 text-sm ${baseInputClasses}`}
          />
        </div>
      </div>
    )
  }

  if (options) {
    // Save on change, not on blur: a <select> has no meaningful "typing" state,
    // and waiting for blur leaves the operator unsure whether the pick stuck.
    return (
      <select
        value={String(draft)}
        disabled={saving}
        onChange={(e) => {
          setDraft(e.target.value)
          void save(e.target.value)
        }}
        className={`h-9 w-full rounded-md border text-sm ${baseInputClasses} ${className ?? ''}`}
      >
        <option value="">—</option>
        {options.map(([stored, label]) => (
          <option key={stored} value={stored}>
            {label}
          </option>
        ))}
        {/* A legacy value outside the vocabulary stays visible and selected
            rather than silently resetting to blank on first render. */}
        {String(draft) !== '' && !options.some(([v]) => v === String(draft)) && (
          <option value={String(draft)}>{String(draft)} (unrecognised)</option>
        )}
      </select>
    )
  }

  if (type === 'textarea') {
    return (
      <Textarea
        value={draft as string}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void save()}
        disabled={saving}
        className={`${baseInputClasses} ${className ?? ''}`}
      />
    )
  }
  if (type === 'currency') {
    return (
      <CurrencyInput
        value={draft}
        placeholder={placeholder}
        onChange={(v) => setDraft(v)}
        onBlur={() => void save()}
        disabled={saving}
        className={`${baseInputClasses} font-mono tabular-nums ${className ?? ''}`}
      />
    )
  }
  const inputType =
    type === 'number' ? 'number' : type === 'email' ? 'email' : 'text'
  const monoClass =
    monoOnDisplay && type === 'number'
      ? 'font-mono text-[15px] tabular-nums'
      : ''
  return (
    <Input
      type={inputType}
      value={draft}
      placeholder={placeholder}
      onChange={(e) =>
        setDraft(
          type === 'number'
            ? e.target.value === ''
              ? ''
              : Number(e.target.value)
            : e.target.value
        )
      }
      onBlur={() => void save()}
      disabled={saving}
      className={`${baseInputClasses} ${monoClass} ${className ?? ''}`}
    />
  )
}
