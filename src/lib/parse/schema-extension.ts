/**
 * Schema-extension detector for the multimodal parse pipeline.
 *
 * The AI should suggest new fields when a term sheet contains data that
 * doesn't fit the existing schema (e.g. prepayment_penalty). This
 * module:
 *   1. Diffs the LLM-extracted object against the known column set
 *   2. Writes a `proposed_field` row per unmapped key (increments
 *      `occurrences` if it already exists pending)
 *   3. Returns the proposals so the create-dialog can render a pill
 *
 * Admin approval happens elsewhere via apply_proposed_field RPC.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type ProposedFieldType = 'text' | 'numeric' | 'boolean' | 'date' | 'jsonb'

export interface ProposedField {
  /** uuid present once the row has been persisted */
  id?: string
  name: string
  data_type: ProposedFieldType
  example_value: string
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(:\d{2})?)?$/

export function inferType(v: unknown): ProposedFieldType {
  if (typeof v === 'number') return 'numeric'
  if (typeof v === 'boolean') return 'boolean'
  if (v instanceof Date) return 'date'
  if (typeof v === 'string' && ISO_DATE.test(v)) return 'date'
  if (v !== null && typeof v === 'object') return 'jsonb'
  return 'text'
}

function exampleValueOf(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v.slice(0, 200)
  try {
    return JSON.stringify(v).slice(0, 200)
  } catch {
    return String(v).slice(0, 200)
  }
}

/**
 * Find keys in `extracted` that are not in `knownFields` and have a
 * non-null value, persist them as pending proposals, and return the
 * proposals.
 *
 * If a pending proposal for the same name already exists, increments
 * occurrences via the same row; new pending row created otherwise.
 */
export async function proposeUnmappedFields(
  supabase: SupabaseClient,
  extracted: Record<string, unknown>,
  knownFields: Set<string>,
): Promise<ProposedField[]> {
  const unknowns = Object.entries(extracted).filter(
    ([k, v]) => !knownFields.has(k) && v !== null && v !== undefined && v !== '',
  )
  if (unknowns.length === 0) return []

  const proposals: ProposedField[] = unknowns.map(([name, value]) => ({
    name,
    data_type: inferType(value),
    example_value: exampleValueOf(value),
  }))

  for (const p of proposals) {
    // upsert by `name` — bump occurrences if already pending
    const { data: existing } = await supabase
      .from('proposed_field')
      .select('id, occurrences, status')
      .eq('name', p.name)
      .eq('status', 'pending')
      .maybeSingle()

    if (existing) {
      await supabase
        .from('proposed_field')
        .update({ occurrences: (existing.occurrences ?? 1) + 1 })
        .eq('id', existing.id)
      p.id = existing.id as string
    } else {
      const { data: created } = await supabase
        .from('proposed_field')
        .insert({
          name: p.name,
          data_type: p.data_type,
          example_value: p.example_value,
        })
        .select('id')
        .single()
      if (created?.id) p.id = created.id as string
    }
  }

  return proposals
}

/**
 * The canonical known-field set for funding_sources. Used by the parse
 * pipeline to decide whether a key is novel.
 *
 * Kept in sync with migration 0001 + 0002 columns. Future v2 fields
 * approved via apply_proposed_field land here through code, not
 * dynamic introspection (intentional — admin should review before the
 * field becomes "expected").
 */
export const KNOWN_FUNDING_SOURCE_FIELDS = new Set<string>([
  'company_name',
  'primary_contact_name',
  'primary_contact_title',
  'primary_contact_email',
  'primary_contact_phone',
  'primary_contact_calendar_link',
  'asset_classes',
  'deal_size_min_usd',
  'deal_size_max_usd',
  'borrower_revenue_min_usd',
  'borrower_years_in_business_min',
  'borrower_capex_min_usd',
  'required_documents',
  'geographic_scope',
  'industry_filters',
  'rate_notes',
  'internal_notes',
  'introduced_via',
  'introduced_date',
  'status',
  // 0002 additions
  'interest_rate_notes',
  'prepayment_penalty',
  'ltv_min_pct',
  'ltv_max_pct',
  'term_min_months',
  'term_max_months',
  'down_payment_notes',
  'last_contact_at',
  'outreach_status',
])
