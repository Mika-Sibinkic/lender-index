'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import imageCompression from 'browser-image-compression'
import { Input } from '@/components/ui/input'
import { CurrencyInput } from '@/components/ui/currency-input'
import { MultiValueInput } from '@/components/ui/multi-value-input'
import { vintageOptions } from '@/lib/funding-sources/vintage'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ASSET_CLASSES } from '@/lib/types/funding-source'
import {
  INTL_DOMESTIC_CHOICES,
  LENDER_TYPE_CHOICES,
  LENDING_STATUS_CHOICES,
  OPERATION_CHOICES,
} from '@/lib/funding-sources/vocabularies'
import { quickExtract } from '@/lib/parse/quick-extract'
import { uploadToStorage, LARGE_FILE_THRESHOLD } from '@/lib/upload/storage-upload'
import { parseUsageCodes, toggleUsageCode } from '@/lib/funding-sources/usage-codes'
import { ASSET_SUBTYPES, USAGE_CODES } from '@/lib/config/domain'
import {
  computeRequiredGaps,
  requiredFieldsFor,
  isInternational,
  REQUIRED_CORE_FIELDS,
  CONDITIONAL_REQUIRED_FIELDS,
} from '@/lib/funding-sources/required-fields'
import {
  computeFieldChanges,
  type LenderMatch,
  type FieldChange,
} from '@/lib/funding-sources/match'
import { toast } from 'sonner'
import { humanError } from '@/lib/ui/error-message'
import {
  ProposedFieldPill,
  type ProposedFieldInDialog,
} from '@/components/funding-sources/proposed-field-pill'

// Controlled vocabularies for the classification dropdowns. Values mirror the
// AI extractor's canonical outputs (src/lib/parse/ai-extract.ts) so manual
// entries and AI-prefilled ones line up exactly.
type SelectOption = { value: string; label: string }
const opt = (v: string, label?: string): SelectOption => ({ value: v, label: label ?? v })

/**
 * The four controlled columns come from `lib/funding-sources/vocabularies.ts`,
 * which the detail page also reads. They were once duplicated here as literals
 * — two screens, one column, two lists, which is precisely the drift that
 * module was created to stop. (The Geographic Target label reads "US" or
 * "International": the stored value stays `Domestic`, only the
 * word on screen is "US". Rewriting the data would buy a label and cost a
 * matching dimension.)
 */
const fromChoices = (choices: readonly (readonly [string, string])[]): readonly SelectOption[] =>
  choices.map(([value, label]) => opt(value, label))

const LENDER_TYPE_OPTS = fromChoices(LENDER_TYPE_CHOICES)
const INTL_DOMESTIC_OPTS = fromChoices(INTL_DOMESTIC_CHOICES)
const OPERATION_OPTS = fromChoices(OPERATION_CHOICES)
/**
 * Lending status was a free-text `<Input>` on this card while the detail page
 * used the controlled set. Ranking demotes a lender only when the column reads
 * exactly "No", so "not lending", "paused" or "no longer lending" typed here all
 * left the lender ranking as though it were open for business — the
 * stale-lending-status failure, still reachable through intake.
 */
const LENDING_STATUS_OPTS = fromChoices(LENDING_STATUS_CHOICES)
// Operator-facing names for the fields a business-card QR can fill exactly.
const QR_FIELD_LABELS: Record<string, string> = {
  company_name: 'company',
  primary_contact_name: 'contact name',
  primary_contact_title: 'title',
  primary_contact_email: 'email',
  primary_contact_phone: 'phone',
  website: 'website',
}

// Yearly, newest first (5-year steps could not express a
// real cutoff like "2003 or newer"). See lib/funding-sources/vintage.ts.
const VINTAGE_OPTS: readonly SelectOption[] = vintageOptions(new Date().getFullYear()).map((v) =>
  opt(v),
)
// 0.5% increments through 5%, plus None (per the bank-paid-fee spec).
const FEE_OPTS: readonly SelectOption[] = [
  opt('None'),
  ...Array.from({ length: 10 }, (_, i) => {
    const pct = (i + 1) * 0.5
    return opt(`${pct}%`)
  }),
]

type FieldState = {
  company_name: string
  primary_contact_name: string
  primary_contact_title: string
  primary_contact_email: string
  primary_contact_phone: string
  asset_classes: string[]
  deal_size_min_usd: string
  deal_size_max_usd: string
  borrower_revenue_min_usd: string
  borrower_years_in_business_min: string
  borrower_capex_min_usd: string
  // Spreadsheet template fields (migration 0017)
  lender_type: string
  intl_domestic: string
  geographic_scope: string[]
  specific_geographic: string
  asset_subtypes: string[]
  usage_codes: string
  operation_category: string
  vintage_restriction: string
  lending_status: string
  bank_paid_fee: string
  rate_notes: string
  internal_notes: string
}

function mergeProposals(
  existing: ProposedFieldInDialog[],
  incoming: ProposedFieldInDialog[],
): ProposedFieldInDialog[] {
  const byName = new Map<string, ProposedFieldInDialog>()
  for (const p of existing) byName.set(p.name, p)
  for (const p of incoming) byName.set(p.name, p)
  return [...byName.values()]
}

const EMPTY: FieldState = {
  company_name: '',
  primary_contact_name: '',
  primary_contact_title: '',
  primary_contact_email: '',
  primary_contact_phone: '',
  asset_classes: [],
  deal_size_min_usd: '',
  deal_size_max_usd: '',
  borrower_revenue_min_usd: '',
  borrower_years_in_business_min: '',
  borrower_capex_min_usd: '',
  lender_type: '',
  intl_domestic: '',
  geographic_scope: [],
  specific_geographic: '',
  asset_subtypes: [],
  usage_codes: '',
  operation_category: '',
  vintage_restriction: '',
  lending_status: '',
  bank_paid_fee: '',
  rate_notes: '',
  internal_notes: '',
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-border/50 bg-card/60 p-5 shadow-[0_1px_0_0_rgba(15,23,42,0.02)]">
      <div className="mb-3 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
        {title}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return <label className="block text-xs text-muted-foreground/90 mb-1">{children}</label>
}

// Amber ring for an empty REQUIRED field (full-field discipline). One helper so
// every required control highlights identically.
const GAP_RING = 'ring-1 ring-amber-400/80 focus-visible:ring-amber-400'

// Human labels for the dedup diff. Reuse the required-field labels; prettify any
// other key ("rate_notes" → "Rate Notes").
const KEY_LABELS: Record<string, string> = Object.fromEntries(
  [...REQUIRED_CORE_FIELDS, ...CONDITIONAL_REQUIRED_FIELDS].map((f) => [f.key, f.label]),
)
function fieldLabel(key: string): string {
  return KEY_LABELS[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
function fmtVal(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (Array.isArray(v)) return v.length ? v.join(', ') : '—'
  return String(v)
}

function EnumSelect({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  highlight = false,
}: {
  value: string
  onChange: (v: string) => void
  options: readonly SelectOption[]
  placeholder?: string
  highlight?: boolean
}) {
  // Surface an AI-extracted value that isn't one of the canonical options so it
  // stays visible and selected — never silently drop a parsed value.
  const known = options.some((o) => o.value === value)
  const opts = value && !known ? [opt(value), ...options] : options
  return (
    <Select
      items={opts as SelectOption[]}
      value={value || null}
      onValueChange={(v) => onChange((v ?? '') as string)}
    >
      <SelectTrigger className={'w-full' + (highlight ? ' ' + GAP_RING : '')}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {opts.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function QuickAddForm({
  isAdmin = false,
  onCreated,
  onCancel,
  initialPaste,
  initialFile,
}: {
  isAdmin?: boolean
  onCreated?: (id: string) => void
  onCancel?: () => void
  /** Seed the intake from the Search/Add bar: NL text or a dropped file,
   *  auto-parsed on mount so the card opens pre-filled. */
  initialPaste?: string
  initialFile?: File | null
} = {}) {
  const router = useRouter()
  const [paste, setPaste] = useState(initialPaste ?? '')
  const [fields, setFields] = useState<FieldState>(EMPTY)
  const [submitting, setSubmitting] = useState(false)
  const [parsing, setParsing] = useState(false)
  // Proactive-dedup reconcile prompt: set when a submit matches an existing lender.
  const [reconcile, setReconcile] = useState<{ match: LenderMatch; changes: FieldChange[] } | null>(
    null,
  )
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [proposedFields, setProposedFields] = useState<ProposedFieldInDialog[]>([])
  /**
   * A DNS answer about the domain in the extracted email, on the IMAGE path only.
   *
   * The same tesseract → LLM card pipeline elsewhere read `examplefleet` as
   * `samplefleet` on a tilted photo, the model structured the garble
   * confidently, and with nothing checking it, many differently garbled copies
   * of one person reached a CRM. A reviewer cannot eyeball that difference. A
   * resolver can: a real domain resolves, its garbled twin is NXDOMAIN.
   *
   * Only `not-found` is ever shown. `unchecked` stays silent on purpose — it is
   * exactly the information state we were already in, there is no action to
   * take, and surfacing it on every parse would train the team to scroll past
   * the one that matters.
   */
  const [contactCheck, setContactCheck] = useState<{
    status: 'resolved' | 'not-found' | 'unchecked'
    domain: string | null
    source: 'email' | 'website' | null
  } | null>(null)
  const [parseMeta, setParseMeta] = useState<{
    populated: number
    provider: string
    model: string
    fallbackUsed: boolean
    latencyMs: number
    parseLogId: string | null
  } | null>(null)
  // Holds the raw body text from the last parse (paste or file) so we can
  // also chunk + embed it into funding_source_doc_chunks on save.
  const [extractedDoc, setExtractedDoc] = useState<{
    body_text: string
    file_type: string
    provider: string
  } | null>(null)

  function update<K extends keyof FieldState>(k: K, v: FieldState[K]) {
    setFields((f) => ({ ...f, [k]: v }))
  }

  // Seed from the Search/Add bar: parse the handed-off text or file once, so the
  // card opens already populated (with gaps highlighted). Runs a single time.
  const seededRef = useRef(false)
  useEffect(() => {
    if (seededRef.current) return
    seededRef.current = true
    if (initialFile) void handleFile(initialFile)
    else if (initialPaste && initialPaste.trim()) void handleParse(initialPaste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Full-field discipline: staff log every core template
  // field for every lender. The card highlights the empty required fields and
  // gates the primary Save; "Save incomplete" is the only, explicit bypass.
  const fieldsForGaps = fields as unknown as Record<string, unknown>
  const gapSet = new Set(computeRequiredGaps(fieldsForGaps))
  const complete = gapSet.size === 0
  const missingLabels = requiredFieldsFor(fieldsForGaps)
    .filter((f) => gapSet.has(f.key))
    .map((f) => f.label)
  const gap = (key: string) => (gapSet.has(key) ? ' ' + GAP_RING : '')

  /**
   * Apply a parse result to the card and report how many fields it filled.
   *
   * The count is deliberately computed OUTSIDE the state updater. It used to be
   * incremented inside `setFields(prev => …)`, but React runs that callback
   * during the next render, long after this function has already returned — so
   * the caller always got the initial 0. That is why a parse that filled nine
   * fields reported "0 fields populated" to the operator.
   */
  function applyParsedToFields(parsed: Record<string, unknown>): number {
    let populatedCount = 0
    const apply = (prev: FieldState): FieldState => {
      const next = { ...prev }
      const stringFields: Array<keyof FieldState> = [
        'company_name',
        'primary_contact_name',
        'primary_contact_title',
        'primary_contact_email',
        'primary_contact_phone',
        'lender_type',
        'intl_domestic',
        'specific_geographic',
        'usage_codes',
        'operation_category',
        'vintage_restriction',
        'lending_status',
        'bank_paid_fee',
        'rate_notes',
        'internal_notes',
      ]
      for (const k of stringFields) {
        const v = parsed[k]
        if (v !== undefined && v !== null && v !== '') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(next as any)[k] = String(v)
          populatedCount++
        }
      }
      const numFields: Array<keyof FieldState> = [
        'deal_size_min_usd',
        'deal_size_max_usd',
        'borrower_revenue_min_usd',
        'borrower_years_in_business_min',
        'borrower_capex_min_usd',
      ]
      for (const k of numFields) {
        const v = parsed[k]
        if (typeof v === 'number' && !Number.isNaN(v)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(next as any)[k] = String(v)
          populatedCount++
        }
      }
      const ac = parsed.asset_classes
      if (Array.isArray(ac) && ac.length) {
        next.asset_classes = ac.filter((c): c is string => typeof c === 'string')
        populatedCount++
      }
      const at = parsed.asset_subtypes
      if (Array.isArray(at) && at.length) {
        next.asset_subtypes = at.filter((c): c is string => typeof c === 'string')
        populatedCount++
      }
      const geo = parsed.geographic_scope
      if (Array.isArray(geo) && geo.length) {
        next.geographic_scope = geo.filter((c): c is string => typeof c === 'string')
        populatedCount++
      }
      return next
    }
    // Run it now so the count is real, then hand React the already-computed
    // state. `apply` is pure apart from the counter, so this is safe.
    setFields((prev) => apply(prev))
    return populatedCount
  }

  async function handleParse(text?: string) {
    const src = (text ?? paste).trim()
    if (!src) {
      toast.message('Paste some text first')
      return
    }
    setParsing(true)
    try {
      const res = await fetch('/api/parse', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: src, modality: 'text' }),
      })
      if (!res.ok) {
        // The server now explains actionable AI failures (offline / model not
        // installed / timed out) in plain words. Show that instead of quietly
        // regex-parsing and presenting the result as if the AI had read the
        // text — the operator must always know what actually filled these
        // fields (accuracy mandate: AI proposes, a human confirms).
        const err = await res.json().catch(() => ({}))
        if (typeof err?.error === 'string' && err.error) {
          toast.error('AI could not read this', { description: humanError(res.status, err.error) })
          return
        }
        const local = quickExtract(src).parsed as Record<string, unknown>
        const populated = applyParsedToFields(local)
        setParseMeta({
          populated,
          provider: 'regex-client',
          model: 'quick-extract',
          fallbackUsed: true,
          latencyMs: 0,
          parseLogId: null,
        })
        toast.warning('Parsed locally (AI unavailable)', {
          description: `${populated} fields populated by pattern matching, not the AI — check every field.`,
        })
        return
      }
      const json = await res.json()
      const populated = applyParsedToFields(json.parsed ?? {})
      setParseMeta({
        populated,
        provider: json.provider,
        model: json.model,
        fallbackUsed: !!json.fallbackUsed,
        latencyMs: json.latencyMs ?? 0,
        parseLogId: json.parseLogId ?? null,
      })
      // Pasted text becomes the source body for doc-chunk indexing.
      setExtractedDoc({
        body_text: src,
        file_type: 'text/plain',
        provider: json.provider ?? 'parse',
      })
      if (Array.isArray(json.proposedFields)) {
        setProposedFields((existing) => mergeProposals(existing, json.proposedFields))
      }
      if (json.fallbackUsed) {
        toast.warning('Parsed via fallback', {
          description: `${populated} fields populated. AI parser returned unparseable output — regex used as backup.`,
        })
      } else {
        toast.success('Parsed', {
          description: `${populated} fields populated · ${json.provider} · ${json.latencyMs}ms. Review and edit before saving.`,
        })
      }
    } finally {
      setParsing(false)
    }
  }

  // Build the API payload from the current fields (drop empty strings; keep
  // arrays; attach the parse-log id for closed-loop correction tracking).
  function buildPayload(): Record<string, unknown> {
    const payload: Record<string, unknown> = { ...fields }
    for (const k of Object.keys(payload)) if (payload[k] === '') delete payload[k]
    if (parseMeta?.parseLogId) payload.parseLogId = parseMeta.parseLogId
    return payload
  }

  // Chunk + embed the original source text so it's RAG-searchable. Best-effort.
  async function indexDoc(id: string) {
    if (!extractedDoc?.body_text || !id) return
    try {
      const docRes = await fetch(`/api/funding-sources/${id}/documents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(extractedDoc),
      })
      if (docRes.ok) {
        const docJson = await docRes.json()
        if (docJson.ok > 0) toast.info(`Indexed ${docJson.ok} doc chunks`)
      }
    } catch (e) {
      console.warn('doc indexing failed (non-fatal):', e)
    }
  }

  async function doCreate(payload: Record<string, unknown>) {
    setSubmitting(true)
    try {
      const res = await fetch('/api/funding-sources', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        if (res.status === 409 && err.code === 'duplicate_company' && err.existing_id) {
          // Backstop (the proactive probe should catch this first): point the
          // operator at the existing record rather than a dead-end.
          toast.error(err.error ?? 'That lender already exists.', {
            action: { label: 'Open lender', onClick: () => router.push(`/source/${err.existing_id}`) },
          })
        } else {
          toast.error('Save failed', { description: humanError(res.status, err.error) })
        }
        return
      }
      const created = await res.json()
      if (!complete) {
        toast.warning('Saved as incomplete', {
          description: `${missingLabels.length} required field${missingLabels.length === 1 ? '' : 's'} still empty, flagged for follow-up.`,
        })
      } else {
        toast.success('Funding source created')
      }
      await indexDoc(created.id)
      if (onCreated) onCreated(created.id)
      else router.push(`/source/${created.id}`)
    } finally {
      setSubmitting(false)
    }
  }

  // Update-in-place (dedup "Update it"): merge mode so blank incoming fields
  // never blank a populated value; the server re-indexes + recomputes gaps.
  async function doUpdate(id: string, payload: Record<string, unknown>, name: string) {
    setSubmitting(true)
    try {
      const res = await fetch(`/api/funding-sources/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, merge: true }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error('Update failed', { description: humanError(res.status, err?.error) })
        return
      }
      toast.success(`Updated ${name}`)
      await indexDoc(id)
      if (onCreated) onCreated(id)
      else router.push(`/source/${id}`)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleSubmit(e: { preventDefault: () => void }, allowIncomplete = false) {
    e.preventDefault()
    if (submitting) return
    if (!fields.company_name.trim()) {
      toast.error('Company name is required')
      return
    }
    // Full-field discipline: the primary Save is gated on completeness; the only
    // path through with gaps is the explicit "Save incomplete" (allowIncomplete).
    if (!complete && !allowIncomplete) {
      toast.error('Some required fields are still empty', {
        description: missingLabels.join(', '),
      })
      return
    }
    const payload = buildPayload()
    // Hold the button through the dedup probe so a rapid double-click can't fire
    // a second create. Released when the dialog opens; doCreate re-holds otherwise.
    setSubmitting(true)
    // Proactive dedup — ONE high-precision probe, on submit. If the lender is
    // already in the list, surface a reconcile choice instead of blind-inserting.
    try {
      const qs = new URLSearchParams({
        company_name: fields.company_name.trim(),
        email: fields.primary_contact_email.trim(),
      })
      const res = await fetch(`/api/funding-sources/match?${qs.toString()}`)
      // A probe that did not RUN is not a probe that found nothing. Falling
      // through to create on a non-200 turns "we could not check" into "there is
      // no duplicate", and a second copy of a lender lands in the index — which
      // staff then have to spot by eye. Stop and let the operator retry.
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setSubmitting(false)
        toast.error('Could not check for an existing lender', {
          description:
            body.error === 'probe_failed'
              ? 'Try again — saving now could create a duplicate.'
              : `HTTP ${res.status}. Try again — saving now could create a duplicate.`,
        })
        return
      }
      {
        const { match } = (await res.json()) as { match: LenderMatch | null }
        if (match?.id) {
          let changes: FieldChange[] = []
          try {
            const beforeRes = await fetch(`/api/funding-sources/${match.id}`)
            if (beforeRes.ok) changes = computeFieldChanges(await beforeRes.json(), payload)
          } catch {
            /* diff is a nicety; proceed without it */
          }
          setReconcile({ match, changes })
          setSubmitting(false) // dialog open — its buttons take over
          return
        }
      }
    } catch (e) {
      // Same reasoning as the non-200 branch: a network failure is unknown, not
      // absent.
      console.warn('dedup probe failed:', e)
      setSubmitting(false)
      toast.error('Could not check for an existing lender', {
        description: 'Try again — saving now could create a duplicate.',
      })
      return
    }
    await doCreate(payload) // re-holds submitting until done
  }

  async function handleFile(file: File) {
    if (!file) return
    setParsing(true)
    try {
      let payload: File = file
      if (file.type.startsWith('image/')) {
        try {
          payload = await imageCompression(file, {
            maxSizeMB: 2,
            maxWidthOrHeight: 1800,
            useWebWorker: true,
            fileType: 'image/jpeg',
            initialQuality: 0.85,
          })
        } catch (e) {
          console.warn('image compression failed, sending original', e)
        }
      }
      // Large files bypass Vercel's 4.5 MB body limit by going through Supabase
      // Storage; small ones keep the direct multipart path (fallback if storage
      // hiccups). See src/lib/upload/storage-upload.ts.
      let res: Response
      try {
        if (payload.size >= LARGE_FILE_THRESHOLD) {
          const ref = await uploadToStorage(payload, 'parse')
          res = await fetch('/api/parse/file', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(ref),
          })
        } else {
          const fd = new FormData()
          fd.append('file', payload)
          res = await fetch('/api/parse/file', { method: 'POST', body: fd })
        }
      } catch (e) {
        toast.error('File parse failed', {
          description: e instanceof Error ? e.message : 'upload failed',
        })
        return
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error('File parse failed', { description: humanError(res.status, err?.error) })
        return
      }
      const json = await res.json()
      const populated = applyParsedToFields(json.parsed ?? {})
      setParseMeta({
        populated,
        provider: json.provider,
        model: json.model,
        fallbackUsed: !!json.fallbackUsed,
        latencyMs: json.latencyMs ?? 0,
        parseLogId: json.parseLogId ?? null,
      })
      setContactCheck(json.contactCheck ?? null)
      if (json.body_text) {
        setExtractedDoc({
          body_text: json.body_text,
          file_type: json.file_type ?? file.type,
          provider: json.provider ?? 'parse.file',
        })
      }
      if (Array.isArray(json.proposedFields)) {
        setProposedFields((existing) => mergeProposals(existing, json.proposedFields))
      }
      // Fields lifted from a business-card QR are exact, not inferred from
      // pixels. Say so — it tells the reviewer which values need no second
      // guessing, which is the whole point of reading the code instead of the
      // photograph of it.
      const fromQr: string[] = Array.isArray(json.fromQr) ? json.fromQr : []
      if (fromQr.length) {
        toast.success('Read the card’s QR code', {
          description: `${fromQr.length} field${fromQr.length === 1 ? '' : 's'} taken exactly from the card (${fromQr
            .map((f) => QR_FIELD_LABELS[f] ?? f.replaceAll('_', ' '))
            .join(', ')}). The rest came from the image.`,
        })
      } else {
        toast.success(`Parsed ${json.modality === 'pdf' ? 'PDF' : 'image'}`, {
          description: `${populated} fields populated · ${json.provider} · ${json.latencyMs}ms.`,
        })
      }
    } finally {
      setParsing(false)
    }
  }

  function toggleAssetClass(c: string) {
    setFields((f) => ({
      ...f,
      asset_classes: f.asset_classes.includes(c)
        ? f.asset_classes.filter((x) => x !== c)
        : [...f.asset_classes, c],
    }))
  }

  function toggleAssetSubtype(c: string) {
    setFields((f) => ({
      ...f,
      asset_subtypes: f.asset_subtypes.includes(c)
        ? f.asset_subtypes.filter((x) => x !== c)
        : [...f.asset_subtypes, c],
    }))
  }

  function toggleUsage(code: string) {
    setFields((f) => ({ ...f, usage_codes: toggleUsageCode(f.usage_codes, code) }))
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto max-w-3xl space-y-4 px-4 sm:px-6 py-6">
      <Section title="Quick add">
        <Textarea
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
          }}
          onDrop={async (e) => {
            const f = e.dataTransfer.files?.[0]
            if (!f) return
            e.preventDefault()
            await handleFile(f)
          }}
          placeholder="Paste text, or drop a business card or PDF"
          className="min-h-[140px] resize-y font-mono text-sm"
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,application/pdf,.pdf,.heic,.xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0]
            if (f) await handleFile(f)
            e.target.value = ''
          }}
        />
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground">
            {parseMeta ? (
              <>
                {parseMeta.populated} field{parseMeta.populated === 1 ? '' : 's'} populated ·{' '}
                {parseMeta.fallbackUsed ? 'fallback' : parseMeta.provider}
                {parseMeta.latencyMs > 0 ? ` · ${parseMeta.latencyMs}ms` : ''}
              </>
            ) : (
              ''
            )}
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => fileInputRef.current?.click()}
              disabled={parsing}
            >
              Upload file
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => handleParse()}
              disabled={!paste.trim() || parsing}
            >
              {parsing ? 'Parsing…' : 'Parse text'}
            </Button>
          </div>
        </div>
        {proposedFields.length > 0 && (
          <div className="mt-3 space-y-2">
            <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground/80">
              New fields the AI noticed
            </div>
            {proposedFields.map((p) => (
              <ProposedFieldPill
                key={p.name}
                proposal={p}
                isAdmin={isAdmin}
                onResolved={(name) =>
                  setProposedFields((arr) => arr.filter((x) => x.name !== name))
                }
              />
            ))}
          </div>
        )}
      </Section>

      {!complete && (
        <div
          role="status"
          className="rounded-xl border border-amber-400/50 bg-amber-400/10 px-4 py-3 text-xs text-amber-800 dark:text-amber-300"
        >
          <span className="font-medium">
            {missingLabels.length} required field{missingLabels.length === 1 ? '' : 's'} still empty:
          </span>{' '}
          {missingLabels.join(' · ')}
          <div className="mt-1 text-amber-700/80 dark:text-amber-400/70">
            All fields are required. If you don’t have them yet, “Save incomplete” saves
            it now and tags it <span className="font-medium">incomplete</span>.
          </div>
        </div>
      )}

      <Section title="Company">
        <Input
          value={fields.company_name}
          onChange={(e) => update('company_name', e.target.value)}
          placeholder="Company name *"
          required
          className={gap('company_name')}
        />
      </Section>

      <Section title="Primary contact">
        <Input value={fields.primary_contact_name} onChange={(e) => update('primary_contact_name', e.target.value)} placeholder="Name" className={gap('primary_contact_name')} />
        <Input value={fields.primary_contact_title} onChange={(e) => update('primary_contact_title', e.target.value)} placeholder="Title" />
        <Input
          type="email"
          value={fields.primary_contact_email}
          onChange={(e) => {
            // The warning describes the value we extracted. Once the operator
            // edits it, it describes nothing.
            if (contactCheck) setContactCheck(null)
            update('primary_contact_email', e.target.value)
          }}
          placeholder="Email"
          className={gap('primary_contact_email')}
        />
        {contactCheck?.status === 'not-found' && (
          <p className="-mt-1 text-[11px] text-amber-700 dark:text-amber-400">
            {contactCheck.domain
              ? `“${contactCheck.domain}” does not resolve — check the spelling against the card before saving.`
              : 'This address is not a valid email — check it against the card before saving.'}
          </p>
        )}
        <Input value={fields.primary_contact_phone} onChange={(e) => update('primary_contact_phone', e.target.value)} placeholder="Phone" />
        <div className="flex justify-end">
          <button
            type="button"
            onClick={async () => {
              const fullName = fields.primary_contact_name?.trim() || ''
              const [first, ...rest] = fullName.split(/\s+/)
              const body = {
                first_name: first || null,
                last_name: rest.length ? rest.join(' ') : null,
                full_name: fullName || null,
                company: fields.company_name?.trim() || null,
                email: fields.primary_contact_email?.trim() || null,
                title: fields.primary_contact_title?.trim() || null,
                force: false,
              }
              const res = await fetch('/api/contacts/normalize', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
              })
              const json = await res.json()
              if (!res.ok) {
                toast.error(`Normalize failed: ${json?.error ?? res.status}`)
                return
              }
              if (json.skipped) {
                toast.info('Looks clean. No changes suggested.')
                return
              }
              const n = json.normalized
              const applied: string[] = []
              if (n.full_name && n.full_name !== fullName) {
                update('primary_contact_name', n.full_name)
                applied.push('name')
              }
              if (n.company && n.company !== fields.company_name) {
                update('company_name', n.company)
                applied.push('company')
              }
              if (n.title && n.title !== fields.primary_contact_title) {
                update('primary_contact_title', n.title)
                applied.push('title')
              }
              if (n.email && n.email !== fields.primary_contact_email) {
                update('primary_contact_email', n.email)
                applied.push('email')
              }
              if (applied.length === 0) {
                toast.info('Cleanup ran. No field changes.')
              } else {
                toast.success(`Cleaned: ${applied.join(', ')}`, {
                  description: `confidence ${(n.confidence * 100).toFixed(0)}%`,
                })
              }
            }}
            className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:text-foreground"
          >
            AI Cleanup
          </button>
        </div>
      </Section>

      <Section title="Lending parameters">
        <div className="flex flex-wrap gap-1.5">
          {ASSET_CLASSES.map((c) => {
            const active = fields.asset_classes.includes(c)
            return (
              <button
                key={c}
                type="button"
                aria-pressed={active}
                onClick={() => toggleAssetClass(c)}
                className={
                  'rounded-full border px-3 py-1 text-xs transition-colors ' +
                  (active
                    ? 'border-foreground/85 bg-foreground/90 text-background'
                    : 'border-border/70 bg-card/40 text-muted-foreground hover:border-border hover:bg-card hover:text-foreground')
                }
              >
                {c.replaceAll('_', ' ')}
              </button>
            )
          })}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label>Deal min ($)</Label>
            <CurrencyInput value={fields.deal_size_min_usd} onChange={(v) => update('deal_size_min_usd', v)} className={gap('deal_size_min_usd')} />
          </div>
          <div>
            <Label>Deal max ($)</Label>
            <CurrencyInput value={fields.deal_size_max_usd} onChange={(v) => update('deal_size_max_usd', v)} className={gap('deal_size_max_usd')} />
          </div>
          <div>
            <Label>Borrower revenue min ($)</Label>
            <CurrencyInput value={fields.borrower_revenue_min_usd} onChange={(v) => update('borrower_revenue_min_usd', v)} />
          </div>
          <div>
            <Label>Years in business min</Label>
            <Input type="number" value={fields.borrower_years_in_business_min} onChange={(e) => update('borrower_years_in_business_min', e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <Label>Borrower CapEx min ($)</Label>
            <CurrencyInput value={fields.borrower_capex_min_usd} onChange={(v) => update('borrower_capex_min_usd', v)} />
          </div>
        </div>
        <div>
          <Label>Rate notes</Label>
          <Textarea value={fields.rate_notes} onChange={(e) => update('rate_notes', e.target.value)} />
        </div>
      </Section>

      <Section title="Classification">
        <div>
          <Label>Asset subtypes</Label>
          <div className={'flex flex-wrap gap-1.5' + (gapSet.has('asset_subtypes') ? ' rounded-lg p-2 ' + GAP_RING : '')}>
            {ASSET_SUBTYPES.map((c) => {
              const active = fields.asset_subtypes.includes(c)
              return (
                <button
                  key={c}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleAssetSubtype(c)}
                  className={
                    'rounded-full border px-3 py-1 text-xs transition-colors ' +
                    (active
                      ? 'border-foreground/85 bg-foreground/90 text-background'
                      : 'border-border/70 bg-card/40 text-muted-foreground hover:border-border hover:bg-card hover:text-foreground')
                  }
                >
                  {c}
                </button>
              )
            })}
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label>Lender type</Label>
            <EnumSelect
              value={fields.lender_type}
              onChange={(v) => update('lender_type', v)}
              options={LENDER_TYPE_OPTS}
              placeholder="Select type…"
              highlight={gapSet.has('lender_type')}
            />
          </div>
          <div>
            <Label>Geographic target</Label>
            <EnumSelect
              value={fields.intl_domestic}
              onChange={(v) => update('intl_domestic', v)}
              options={INTL_DOMESTIC_OPTS}
              highlight={gapSet.has('intl_domestic')}
            />
          </div>
          <div>
            <Label>Operation category</Label>
            <EnumSelect
              value={fields.operation_category}
              onChange={(v) => update('operation_category', v)}
              options={OPERATION_OPTS}
              highlight={gapSet.has('operation_category')}
            />
          </div>
          <div>
            <Label>Bank-paid fee{isInternational(fieldsForGaps) ? '' : ' (International only)'}</Label>
            <EnumSelect
              value={fields.bank_paid_fee}
              onChange={(v) => update('bank_paid_fee', v)}
              options={FEE_OPTS}
              highlight={gapSet.has('bank_paid_fee')}
            />
          </div>
          <div>
            <Label>Vintage restriction</Label>
            <EnumSelect
              value={fields.vintage_restriction}
              onChange={(v) => update('vintage_restriction', v)}
              options={VINTAGE_OPTS}
              highlight={gapSet.has('vintage_restriction')}
            />
          </div>
          <div>
            <Label>Specific geography</Label>
            <MultiValueInput
              value={fields.geographic_scope}
              onChange={(v) => update('geographic_scope', v)}
              placeholder="e.g. Texas, Florida, Brazil, Canada"
              className={gap('geographic_scope')}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Separate with a comma; spaces are fine, like “United States, New York”.
            </p>
          </div>
          <div className="sm:col-span-2">
            <Label>Usage</Label>
            <div className={'flex flex-wrap gap-1.5 pt-0.5' + (gapSet.has('usage_codes') ? ' rounded-lg p-2 ' + GAP_RING : '')}>
              {USAGE_CODES.map((u) => {
                const active = parseUsageCodes(fields.usage_codes).includes(u.code)
                return (
                  <button
                    key={u.code}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleUsage(u.code)}
                    className={
                      'rounded-full border px-3 py-1 text-xs transition-colors ' +
                      (active
                        ? 'border-foreground/85 bg-foreground/90 text-background'
                        : 'border-border/70 bg-card/40 text-muted-foreground hover:border-border hover:bg-card hover:text-foreground')
                    }
                  >
                    {u.label}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="sm:col-span-2">
            <Label>Lending status / appetite</Label>
            <EnumSelect
              value={fields.lending_status}
              onChange={(v) => update('lending_status', v)}
              options={LENDING_STATUS_OPTS}
              highlight={gapSet.has('lending_status')}
            />
          </div>
        </div>
      </Section>

      <Section title="Internal notes">
        <Textarea value={fields.internal_notes} onChange={(e) => update('internal_notes', e.target.value)} />
      </Section>

      <div className="flex items-center justify-end gap-3">
        <Button
          type="button"
          variant="ghost"
          onClick={() => (onCancel ? onCancel() : router.push('/'))}
        >
          Cancel
        </Button>
        {!complete && (
          <Button
            type="button"
            variant="outline"
            disabled={submitting || !fields.company_name.trim()}
            onClick={(e) => handleSubmit(e, true)}
            title={`Save now and flag ${missingLabels.length} empty required field${missingLabels.length === 1 ? '' : 's'} for later`}
          >
            {submitting ? 'Saving…' : 'Save incomplete'}
          </Button>
        )}
        <Button type="submit" disabled={submitting || !complete}>
          {submitting ? 'Saving…' : 'Create funding source'}
        </Button>
      </div>

      {reconcile && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-lg rounded-2xl border border-border bg-background p-6 shadow-xl">
            <div className="text-sm font-semibold">
              “{reconcile.match.company_name}” is already in your list
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {reconcile.match.matched_on === 'email'
                ? 'Matched on contact email. '
                : 'Matched on company name. '}
              Update the existing lender in place, or create a separate new one?
            </p>
            <div className="mt-3 max-h-56 overflow-auto rounded-lg border border-border/60 bg-card/50 p-3 text-xs">
              {reconcile.changes.length === 0 ? (
                <div className="text-muted-foreground">
                  No new field values to apply — what you entered already matches the existing record.
                </div>
              ) : (
                <>
                  <div className="mb-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                    {reconcile.changes.length} field{reconcile.changes.length === 1 ? '' : 's'} would change
                  </div>
                  <ul className="space-y-1.5">
                    {reconcile.changes.map((c) => (
                      <li key={c.key} className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-medium">{fieldLabel(c.key)}:</span>
                        <span className="text-muted-foreground line-through">{fmtVal(c.from)}</span>
                        <span aria-hidden>→</span>
                        <span className="text-foreground">{fmtVal(c.to)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Blank fields you left empty won’t overwrite existing values.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setReconcile(null)} disabled={submitting}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={submitting}
                onClick={async () => {
                  setReconcile(null)
                  await doCreate(buildPayload())
                }}
              >
                Create as new
              </Button>
              <Button
                type="button"
                disabled={submitting}
                onClick={async () => {
                  const m = reconcile.match
                  setReconcile(null)
                  await doUpdate(m.id, buildPayload(), m.company_name)
                }}
              >
                {submitting ? 'Updating…' : `Update ${reconcile.match.company_name}`}
              </Button>
            </div>
          </div>
        </div>
      )}
    </form>
  )
}
