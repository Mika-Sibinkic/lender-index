/**
 * A PATCH must write only the field that was sent.
 *
 * `fundingSourceUpdateSchema` was `fundingSourceCreateSchema.partial()`. In Zod
 * a field carrying `.default(...)` is already optional on input, and
 * `.partial()` does not strip the default — the field is FILLED IN when absent.
 * `PATCH /api/funding-sources/[id]` writes `parsed.data` straight to the row, so
 * editing one field on the detail page also wrote `asset_classes: []`,
 * `asset_subtypes: []`, `required_documents: []`, `industry_filters: []` and
 * `status: 'active'`.
 *
 * Live consequence: an operator edited one lender's geography and the same
 * save cleared its asset_subtypes and asset_classes to []. assetDim
 * hard-filters on asset_classes, so the lender stopped matching any asset
 * search — caused by the act of curating the record. Other records were hit
 * identically in the same session.
 *
 * The last test is the one that matters long-term: it fails if someone adds a
 * new `.default()` to the create schema without restating it here, which is
 * exactly how this returns.
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  fundingSourceCreateSchema,
  fundingSourceUpdateSchema,
} from '@/lib/types/funding-source'

describe('a single-field PATCH parses to a single field', () => {
  it('does not invent the four array columns', () => {
    const r = fundingSourceUpdateSchema.safeParse({ geographic_scope: ['CA'] })
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(Object.keys(r.data).sort()).toEqual(['geographic_scope'])
  })

  it('does not resurrect a soft-deleted row by forcing status', () => {
    // status carries .default('active'). An edit to a note on an archived
    // lender was silently setting it active again.
    const r = fundingSourceUpdateSchema.safeParse({ internal_notes: 'called 9/9' })
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.data).not.toHaveProperty('status')
    expect(Object.keys(r.data)).toEqual(['internal_notes'])
  })

  it.each([
    'asset_classes',
    'asset_subtypes',
    'required_documents',
    'industry_filters',
  ])('leaves %s absent when it was not sent', (field) => {
    const r = fundingSourceUpdateSchema.safeParse({ rate_notes: 'SOFR + 250' })
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.data).not.toHaveProperty(field)
  })
})

describe('clearing a field on purpose still works', () => {
  it('an explicit empty array is preserved', () => {
    const r = fundingSourceUpdateSchema.safeParse({ asset_classes: [] })
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.data).toEqual({ asset_classes: [] })
  })

  it('an explicit null is preserved', () => {
    const r = fundingSourceUpdateSchema.safeParse({ internal_notes: null })
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.data).toEqual({ internal_notes: null })
  })
})

describe('the create schema still defaults, because a new row needs a shape', () => {
  it('fills the arrays and the status', () => {
    const r = fundingSourceCreateSchema.safeParse({ company_name: 'Test Bank' })
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.data.asset_classes).toEqual([])
    expect(r.data.status).toBe('active')
  })
})

describe('drift guard', () => {
  it('every defaulted create field is restated without a default on update', () => {
    // This is the test that stops the bug coming back. Add a `.default()` above
    // and forget to mirror it in fundingSourceUpdateSchema, and this fails with
    // the offending field named.
    const defaulted = Object.entries(fundingSourceCreateSchema.shape)
      .filter(([, v]) => v instanceof z.ZodDefault)
      .map(([k]) => k)

    // Sanity: if this is empty the assertion below would pass vacuously.
    expect(defaulted.length).toBeGreaterThan(0)

    const probe: Record<string, unknown> = { company_name: 'Probe Bank' }
    const r = fundingSourceUpdateSchema.safeParse(probe)
    expect(r.success).toBe(true)
    if (!r.success) return

    const injected = defaulted.filter((k) => k in r.data)
    expect(injected).toEqual([])
  })
})
