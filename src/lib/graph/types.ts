/**
 * GraphRAG types — closed taxonomies for entity kinds + edge relations.
 *
 * The strings here are the source of truth referenced by:
 *   - migration 0011 check constraints (must match exactly)
 *   - the LLM extractor's system prompt (so the model knows the menu)
 *   - the retrieval traversal (so callers can ask for specific rels)
 *
 * Any change here = update the migration check constraint too.
 */

import { z } from 'zod'

export const ENTITY_KINDS = [
  'funder',
  'contact',
  'asset_family',
  'asset_model',
  'geo',
  'industry',
  'doc_kind',
  'borrower_profile',
] as const
export type EntityKind = (typeof ENTITY_KINDS)[number]

export const EDGE_RELS = [
  'employs',
  'operates_in',
  'serves',
  'funded',
  'capped_at',
  'works_at',
  'is_a',
  'emitted',
] as const
export type EdgeRel = (typeof EDGE_RELS)[number]

/** Borrower-profile is bucketed; closed set to keep edges deterministic. */
export const BORROWER_PROFILES = ['lt_5m', '5m_25m', '25m_100m', 'gt_100m'] as const
export type BorrowerProfile = (typeof BORROWER_PROFILES)[number]

/** Document source kinds — mirrors closed_deal.source_kind enum. */
export const DOC_KINDS = ['term_sheet', 'proposal', 'loan_doc', 'manual'] as const
export type DocKind = (typeof DOC_KINDS)[number]

// ---- Zod schemas ---------------------------------------------------------

const naturalKey = z
  .string()
  .min(1)
  .max(200)
  // ascii + simple punctuation; keeps keys URL-safe and grep-able.
  // @ allowed for contact emails; + tolerated for plus-addressing.
  .regex(/^[\w.:@+\-/]+$/, 'natural_key allows: word chars, . : @ + - _ /')

export const EntityInputSchema = z.object({
  kind: z.enum(ENTITY_KINDS),
  natural_key: naturalKey,
  label: z.string().min(1).max(500),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
})
// Use z.input so callers can omit fields that have defaults (weight,
// confidence, metadata). repo.ts runs .parse() to materialize the
// defaults before DB writes.
export type EntityInput = z.input<typeof EntityInputSchema>

export const EdgeInputSchema = z.object({
  src_natural_key: naturalKey,
  dst_natural_key: naturalKey,
  rel: z.enum(EDGE_RELS),
  confidence: z.number().min(0).max(1).default(1),
  weight: z.number().min(0).default(1),
  source_table: z.string().min(1).max(100),
  source_id: z.string().uuid().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
})
export type EdgeInput = z.input<typeof EdgeInputSchema>

/** Bundle returned by the LLM extractor. */
export const ExtractionResultSchema = z.object({
  entities: z.array(EntityInputSchema).default([]),
  edges: z.array(EdgeInputSchema).default([]),
})
export type ExtractionResult = z.input<typeof ExtractionResultSchema>

// ---- Natural-key helpers ------------------------------------------------
// Centralized so extractors and the bootstrap script can't drift.

/**
 * Strip any char outside the natural_key allowed set
 * (`[\w.:@+\-/]`). Real lender contacts carry apostrophes, ampersands,
 * parentheses, accents — none of which belong in a grep-able key.
 * The `@` and `.` are preserved so email-derived contact keys survive.
 */
function scrubKey(s: string): string {
  return s.replace(/[^\w.:@+\-/]/g, '').slice(0, 180)
}

export const naturalKeys = {
  funder: (funding_source_id: string) => `funder.${funding_source_id}`,
  contact: (email_or_name_slug: string) => `contact.${scrubKey(email_or_name_slug.toLowerCase())}`,
  geo: (region: string) => `geo.${scrubKey(region.toUpperCase().replace(/\s+/g, '_'))}`,
  industry: (name: string) => `industry.${slugify(name)}`,
  asset_family: (family: string) => `asset_family.${slugify(family)}`,
  asset_model: (model: string) => `asset_model.${slugify(model)}`,
  doc_kind: (kind: DocKind) => `doc_kind.${kind}`,
  borrower_profile: (band: BorrowerProfile) => `borrower_profile.${band}`,
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^\w\s.-]/g, '')
    .replace(/\s+/g, '_')
    .replace(/-+/g, '-')
    .slice(0, 80)
}

/** Bucket a USD revenue number into the borrower_profile enum. */
export function bucketRevenue(usd: number | null | undefined): BorrowerProfile | null {
  if (usd == null || !Number.isFinite(usd)) return null
  if (usd < 5_000_000) return 'lt_5m'
  if (usd < 25_000_000) return '5m_25m'
  if (usd < 100_000_000) return '25m_100m'
  return 'gt_100m'
}
