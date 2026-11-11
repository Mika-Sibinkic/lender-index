import { z } from 'zod'
import { ASSET_CLASS_IDS, RETIRED_ASSET_CATEGORIES } from '@/lib/config/domain'

export const STATUSES = ['active', 'dormant', 'do_not_contact', 'archived'] as const
export type Status = (typeof STATUSES)[number]

/**
 * The asset vocabulary operators narrow by. The ids and their hierarchy live in
 * src/lib/config/vocabulary.ts; this export keeps its name so callers do not change.
 */
export const ASSET_CLASSES: readonly string[] = ASSET_CLASS_IDS

/**
 * Retired classes kept readable so a legacy row or a shared link that still
 * carries one renders as a word rather than a raw token. They are not offered
 * anywhere and nothing writes them.
 */
export const RETIRED_ASSET_CLASSES: readonly string[] = RETIRED_ASSET_CATEGORIES.map((c) => c.id)

const numberFromInput = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : Number(v)),
  z.number().nonnegative().optional()
)

const intFromInput = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : Number(v)),
  z.number().int().nonnegative().optional()
)

const emailOptional = z
  .union([z.string().email(), z.literal(''), z.null()])
  .optional()

const urlOptional = z.union([z.string().url(), z.literal(''), z.null()]).optional()

export const fundingSourceCreateSchema = z.object({
  company_name: z.string().min(1).max(200),
  primary_contact_name: z.string().max(200).optional().nullable(),
  primary_contact_title: z.string().max(200).optional().nullable(),
  primary_contact_email: emailOptional,
  primary_contact_phone: z.string().max(50).optional().nullable(),
  primary_contact_calendar_link: urlOptional,
  asset_classes: z.array(z.string()).default([]),
  deal_size_min_usd: numberFromInput,
  deal_size_max_usd: numberFromInput,
  borrower_revenue_min_usd: numberFromInput,
  borrower_years_in_business_min: intFromInput,
  borrower_capex_min_usd: numberFromInput,
  required_documents: z.array(z.string()).default([]),
  geographic_scope: z.array(z.string()).default([]),
  industry_filters: z.array(z.string()).default([]),
  // Spreadsheet template fields (migration 0017)
  lender_type: z.string().optional().nullable(),
  intl_domestic: z.string().optional().nullable(),
  specific_geographic: z.string().optional().nullable(),
  asset_subtypes: z.array(z.string()).default([]),
  usage_codes: z.string().optional().nullable(),
  operation_category: z.string().optional().nullable(),
  vintage_restriction: z.string().optional().nullable(),
  lending_status: z.string().optional().nullable(),
  bank_paid_fee: z.string().optional().nullable(),
  rate_notes: z.string().optional().nullable(),
  internal_notes: z.string().optional().nullable(),
  introduced_via: z.string().optional().nullable(),
  introduced_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
  status: z.enum(STATUSES).default('active'),
})

/**
 * PATCH schema. Every field optional, and — critically — NO DEFAULTS.
 *
 * `.partial()` alone is not enough. In Zod a field carrying `.default(...)` is
 * already optional on input, and `.partial()` does not strip the default: the
 * field is simply FILLED IN when absent. So
 * `fundingSourceCreateSchema.partial().parse({ geographic_scope: ['CA'] })`
 * returned
 *
 *   { geographic_scope: ['CA'], asset_classes: [], asset_subtypes: [],
 *     required_documents: [], industry_filters: [], status: 'active' }
 *
 * and `PATCH /api/funding-sources/[id]` writes `parsed.data` straight to the
 * row. So editing ONE field on the detail page silently wiped all four array
 * columns and forced `status` back to 'active'.
 *
 * That is not theoretical. An operator edited one lender's geography and the
 * same save cleared its `asset_subtypes` and `asset_classes` to `[]`.
 * `asset_classes` is the column assetDim hard-filters on, so that lender
 * stopped matching any asset search at all — a wrong-lender failure caused by
 * the act of curating the record. Several records were hit the same way in
 * one session; their edits sit in `funding_source_edits` with identical
 * microsecond timestamps, which is the signature of one request writing
 * several columns.
 *
 * Every field that carries a default in the create schema is restated here
 * WITHOUT one. Deliberately explicit rather than derived: a reflective
 * `removeDefault()` pass does not typecheck under Zod 4, and more importantly a
 * list you can read is a list a reviewer can check against the create schema.
 * `fundingSourceUpdateSchema.test.ts` fails if a new defaulted field is added
 * above and not mirrored here, so this cannot silently drift back.
 *
 * Clearing a field on purpose still works — the caller sends `[]` explicitly.
 */
export const fundingSourceUpdateSchema = fundingSourceCreateSchema.partial().extend({
  asset_classes: z.array(z.string()).optional(),
  required_documents: z.array(z.string()).optional(),
  geographic_scope: z.array(z.string()).optional(),
  industry_filters: z.array(z.string()).optional(),
  asset_subtypes: z.array(z.string()).optional(),
  status: z.enum(STATUSES).optional(),
})

export type FundingSourceCreate = z.infer<typeof fundingSourceCreateSchema>
export type FundingSourceUpdate = z.infer<typeof fundingSourceUpdateSchema>

export type FundingSourceRow = {
  id: string
  company_name: string
  primary_contact_name: string | null
  primary_contact_title: string | null
  primary_contact_email: string | null
  primary_contact_phone: string | null
  primary_contact_calendar_link: string | null
  asset_classes: string[]
  deal_size_min_usd: number | null
  deal_size_max_usd: number | null
  borrower_revenue_min_usd: number | null
  borrower_years_in_business_min: number | null
  borrower_capex_min_usd: number | null
  required_documents: string[]
  geographic_scope: string[]
  industry_filters: string[]
  lender_type: string | null
  intl_domestic: string | null
  specific_geographic: string | null
  asset_subtypes: string[]
  usage_codes: string | null
  operation_category: string | null
  vintage_restriction: string | null
  lending_status: string | null
  bank_paid_fee: string | null
  rate_notes: string | null
  internal_notes: string | null
  introduced_via: string | null
  introduced_date: string | null
  status: Status
  last_contact_at: string | null
  outreach_status: 'current' | 'stale' | 'bouncing' | 'do_not_contact'
  required_field_gaps: string[]
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
}
