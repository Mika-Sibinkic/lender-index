/**
 * Graph extractors.
 *
 * Splits work between:
 *   - Deterministic extractors over structured columns
 *     (extractFromFundingSource / extractFromClosedDeal /
 *     extractFromContact). No LLM call; fast; cheap; correct.
 *   - LLM augmentation over free-text columns (augmentFromText) —
 *     pulls additional geos / asset / industry mentions from
 *     internal_notes + rate_notes that the structured columns missed.
 *
 * The deterministic path covers most edges on a typical roster, so the
 * LLM-cost budget stays small even after a full bootstrap.
 */

import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { llm } from '@/lib/llm/client'
import { DOMAIN_DESCRIPTION, promptMakes } from '@/lib/config/domain'
import {
  type EntityInput,
  type EdgeInput,
  type ExtractionResult,
  naturalKeys,
  slugify,
  bucketRevenue,
  type DocKind,
  DOC_KINDS,
} from './types'

// ---- Deterministic extractors -------------------------------------------

export interface FundingSourceCols {
  id: string
  company_name: string
  primary_contact_name: string | null
  primary_contact_title: string | null
  primary_contact_email: string | null
  asset_classes: string[] | null
  geographic_scope: string[] | null
  industry_filters: string[] | null
  borrower_revenue_min_usd: number | null
}

export function extractFromFundingSource(row: FundingSourceCols): ExtractionResult {
  const entities: EntityInput[] = []
  const edges: EdgeInput[] = []

  // Funder entity
  const funderKey = naturalKeys.funder(row.id)
  entities.push({
    kind: 'funder',
    natural_key: funderKey,
    label: row.company_name,
    metadata: { funding_source_id: row.id },
  })

  // Contact entity + employs edge
  if (row.primary_contact_name || row.primary_contact_email) {
    const slug = (row.primary_contact_email ?? row.primary_contact_name ?? '').trim()
    if (slug) {
      const contactKey = naturalKeys.contact(slug)
      entities.push({
        kind: 'contact',
        natural_key: contactKey,
        label: row.primary_contact_name ?? row.primary_contact_email ?? slug,
        metadata: {
          email: row.primary_contact_email ?? null,
          title: row.primary_contact_title ?? null,
        },
      })
      edges.push({
        src_natural_key: funderKey,
        dst_natural_key: contactKey,
        rel: 'employs',
        confidence: 1,
        source_table: 'funding_sources',
        source_id: row.id,
        metadata: {},
      })
      edges.push({
        src_natural_key: contactKey,
        dst_natural_key: funderKey,
        rel: 'works_at',
        confidence: 1,
        source_table: 'funding_sources',
        source_id: row.id,
        metadata: {},
      })
    }
  }

  // Geo edges
  for (const geo of row.geographic_scope ?? []) {
    if (!geo.trim()) continue
    const k = naturalKeys.geo(geo)
    entities.push({ kind: 'geo', natural_key: k, label: geo, metadata: {} })
    edges.push({
      src_natural_key: funderKey,
      dst_natural_key: k,
      rel: 'operates_in',
      confidence: 1,
      source_table: 'funding_sources',
      source_id: row.id,
      metadata: {},
    })
  }

  // Industry edges
  for (const ind of row.industry_filters ?? []) {
    if (!ind.trim()) continue
    const k = naturalKeys.industry(ind)
    entities.push({ kind: 'industry', natural_key: k, label: ind, metadata: {} })
    edges.push({
      src_natural_key: funderKey,
      dst_natural_key: k,
      rel: 'serves',
      confidence: 1,
      source_table: 'funding_sources',
      source_id: row.id,
      metadata: {},
    })
  }

  // Asset families (from asset_classes — buckets like 'equipment',
  // 'commercial_trucks', 'real_estate'). Family-level only here; closed_deal
  // augments with specific models.
  for (const ac of row.asset_classes ?? []) {
    if (!ac.trim()) continue
    const k = naturalKeys.asset_family(ac)
    entities.push({ kind: 'asset_family', natural_key: k, label: ac, metadata: {} })
    edges.push({
      src_natural_key: funderKey,
      dst_natural_key: k,
      rel: 'serves',
      confidence: 0.7,
      source_table: 'funding_sources',
      source_id: row.id,
      metadata: { from: 'asset_classes' },
    })
  }

  // Borrower profile (revenue band)
  const band = bucketRevenue(row.borrower_revenue_min_usd)
  if (band) {
    const k = naturalKeys.borrower_profile(band)
    entities.push({
      kind: 'borrower_profile',
      natural_key: k,
      label: band,
      metadata: {},
    })
    edges.push({
      src_natural_key: funderKey,
      dst_natural_key: k,
      rel: 'capped_at',
      confidence: 1,
      source_table: 'funding_sources',
      source_id: row.id,
      metadata: { min_usd: row.borrower_revenue_min_usd },
    })
  }

  return { entities: dedupEntities(entities), edges }
}

export interface ClosedDealCols {
  id: string
  funding_source_id: string | null
  asset_year: number | null
  asset_make: string | null
  asset_model: string | null
  source_kind: string | null
}

export function extractFromClosedDeal(row: ClosedDealCols): ExtractionResult {
  const entities: EntityInput[] = []
  const edges: EdgeInput[] = []
  if (!row.funding_source_id) return { entities, edges }
  const funderKey = naturalKeys.funder(row.funding_source_id)

  // Asset family + model
  if (row.asset_make) {
    const familyKey = naturalKeys.asset_family(row.asset_make)
    entities.push({
      kind: 'asset_family',
      natural_key: familyKey,
      label: row.asset_make,
      metadata: {},
    })

    if (row.asset_model) {
      const modelLabel = [row.asset_make, row.asset_model].filter(Boolean).join(' ')
      const modelKey = naturalKeys.asset_model(modelLabel)
      entities.push({
        kind: 'asset_model',
        natural_key: modelKey,
        label: modelLabel,
        metadata: { make: row.asset_make, model: row.asset_model, year: row.asset_year },
      })
      edges.push({
        src_natural_key: modelKey,
        dst_natural_key: familyKey,
        rel: 'is_a',
        confidence: 1,
        source_table: 'closed_deal',
        source_id: row.id,
        metadata: {},
      })
      edges.push({
        src_natural_key: funderKey,
        dst_natural_key: modelKey,
        rel: 'funded',
        confidence: 1,
        source_table: 'closed_deal',
        source_id: row.id,
        metadata: { year: row.asset_year },
      })
    } else {
      edges.push({
        src_natural_key: funderKey,
        dst_natural_key: familyKey,
        rel: 'funded',
        confidence: 0.8,
        source_table: 'closed_deal',
        source_id: row.id,
        metadata: {},
      })
    }
  }

  // Doc kind
  if (row.source_kind && (DOC_KINDS as readonly string[]).includes(row.source_kind)) {
    const k = naturalKeys.doc_kind(row.source_kind as DocKind)
    entities.push({ kind: 'doc_kind', natural_key: k, label: row.source_kind, metadata: {} })
    edges.push({
      src_natural_key: funderKey,
      dst_natural_key: k,
      rel: 'emitted',
      confidence: 1,
      source_table: 'closed_deal',
      source_id: row.id,
      metadata: {},
    })
  }

  return { entities: dedupEntities(entities), edges }
}

export interface ContactCols {
  id: string
  funding_source_id: string
  name: string | null
  title: string | null
  email: string | null
}

export function extractFromContact(row: ContactCols): ExtractionResult {
  const entities: EntityInput[] = []
  const edges: EdgeInput[] = []
  const slug = (row.email ?? row.name ?? '').trim()
  if (!slug) return { entities, edges }
  const funderKey = naturalKeys.funder(row.funding_source_id)
  const contactKey = naturalKeys.contact(slug)
  entities.push({
    kind: 'contact',
    natural_key: contactKey,
    label: row.name ?? row.email ?? slug,
    metadata: { email: row.email ?? null, title: row.title ?? null },
  })
  edges.push({
    src_natural_key: funderKey,
    dst_natural_key: contactKey,
    rel: 'employs',
    confidence: 1,
    source_table: 'funding_source_contacts',
    source_id: row.id,
    metadata: {},
  })
  edges.push({
    src_natural_key: contactKey,
    dst_natural_key: funderKey,
    rel: 'works_at',
    confidence: 1,
    source_table: 'funding_source_contacts',
    source_id: row.id,
    metadata: {},
  })
  return { entities, edges }
}

// ---- LLM augmentation over free text ------------------------------------

const LLMAugmentSchema = z.object({
  geos: z.array(z.string()).default([]),
  asset_families: z.array(z.string()).default([]),
  asset_models: z.array(z.string()).default([]),
  industries: z.array(z.string()).default([]),
})

const AUGMENT_SYSTEM = `You extract structured entities from ${DOMAIN_DESCRIPTION} notes.

Return ONLY a JSON object matching the schema. Be conservative — only list entities that are explicitly mentioned in the text. Do not invent.

Fields:
- geos: places mentioned — US states, regions, countries. Use canonical short forms ("Florida", "Texas", "Midwest US", "Canada"). NOT cities.
- asset_families: asset brand/family mentions (${promptMakes(4)}). NOT specific models.
- asset_models: specific model designators (a make plus its model number or name). Include the family in the string for disambiguation.
- industries: customer industries the lender funds ("logistics", "construction", "healthcare", "agriculture"). Lowercase.

Empty arrays for fields not mentioned.`

export async function augmentFromText(
  supabase: SupabaseClient,
  text: string,
  ctx: { funding_source_id: string },
): Promise<ExtractionResult> {
  if (!text || !text.trim()) return { entities: [], edges: [] }
  const trimmed = text.slice(0, 4000)
  const { object } = await llm.object({
    supabase,
    module: 'graph.augment',
    schema: LLMAugmentSchema,
    system: AUGMENT_SYSTEM,
    prompt: trimmed,
  })

  const entities: EntityInput[] = []
  const edges: EdgeInput[] = []
  const funderKey = naturalKeys.funder(ctx.funding_source_id)

  for (const g of object.geos) {
    if (!g.trim()) continue
    const k = naturalKeys.geo(g)
    entities.push({ kind: 'geo', natural_key: k, label: g, metadata: {} })
    edges.push({
      src_natural_key: funderKey,
      dst_natural_key: k,
      rel: 'operates_in',
      confidence: 0.6,
      source_table: 'funding_sources',
      source_id: ctx.funding_source_id,
      metadata: { from: 'llm.augment' },
    })
  }
  for (const f of object.asset_families) {
    if (!f.trim()) continue
    const k = naturalKeys.asset_family(f)
    entities.push({ kind: 'asset_family', natural_key: k, label: f, metadata: {} })
    edges.push({
      src_natural_key: funderKey,
      dst_natural_key: k,
      rel: 'serves',
      confidence: 0.6,
      source_table: 'funding_sources',
      source_id: ctx.funding_source_id,
      metadata: { from: 'llm.augment' },
    })
  }
  for (const m of object.asset_models) {
    if (!m.trim()) continue
    const k = naturalKeys.asset_model(m)
    entities.push({ kind: 'asset_model', natural_key: k, label: m, metadata: {} })
    edges.push({
      src_natural_key: funderKey,
      dst_natural_key: k,
      rel: 'funded',
      confidence: 0.4,                                    // weaker — text mention, not closed_deal evidence
      source_table: 'funding_sources',
      source_id: ctx.funding_source_id,
      metadata: { from: 'llm.augment' },
    })
  }
  for (const ind of object.industries) {
    if (!ind.trim()) continue
    const k = naturalKeys.industry(ind)
    entities.push({ kind: 'industry', natural_key: k, label: ind, metadata: {} })
    edges.push({
      src_natural_key: funderKey,
      dst_natural_key: k,
      rel: 'serves',
      confidence: 0.6,
      source_table: 'funding_sources',
      source_id: ctx.funding_source_id,
      metadata: { from: 'llm.augment' },
    })
  }

  return { entities: dedupEntities(entities), edges }
}

// ---- helpers -------------------------------------------------------------

function dedupEntities<T extends { natural_key: string }>(arr: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const e of arr) {
    if (seen.has(e.natural_key)) continue
    seen.add(e.natural_key)
    out.push(e)
  }
  return out
}

// re-export slugify for the build script
export { slugify }
