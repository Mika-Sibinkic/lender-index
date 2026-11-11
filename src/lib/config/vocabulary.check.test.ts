/**
 * Validates YOUR vocabulary (src/lib/config/vocabulary.ts).
 *
 * Imported relatively on purpose: everywhere else in the suite the alias in
 * vitest.config.ts swaps in the shipped defaults (src/test/default-vocabulary.ts),
 * so behaviour tests stay green whatever categories a deployment configures.
 * This file is the one that checks the deployment's own edits.
 */

import { describe, it, expect } from 'vitest'
import * as vocab from './vocabulary'
import { ASSET_ICONS } from '@/lib/funding-sources/asset-visuals'

const all = [...vocab.ASSET_CATEGORIES, ...vocab.RETIRED_ASSET_CATEGORIES]
const dupes = (xs: string[]) => xs.filter((x, i) => xs.indexOf(x) !== i)

describe('vocabulary.ts is internally consistent', () => {
  it('has at least one active category', () => {
    expect(vocab.ASSET_CATEGORIES.length).toBeGreaterThan(0)
  })

  it('category ids are unique snake_case', () => {
    const ids = all.map((c) => c.id)
    expect(dupes(ids)).toEqual([])
    for (const id of ids) expect(id, id).toMatch(/^[a-z][a-z0-9_]*$/)
  })

  it('every parent exists, is not itself a child, and is not the category', () => {
    const byId = new Map(all.map((c) => [c.id, c]))
    for (const c of all) {
      if (!c.parent) continue
      const p = byId.get(c.parent)
      expect(p, `${c.id} → ${c.parent}`).toBeDefined()
      expect(c.parent, c.id).not.toBe(c.id)
      expect(p?.parent, `${c.parent} is a child; only one level is supported`).toBeUndefined()
    }
  })

  it('every icon name resolves (add new ones to ASSET_ICONS in asset-visuals.ts)', () => {
    for (const c of all) {
      if (c.icon) expect(ASSET_ICONS[c.icon], `${c.id}: ${c.icon}`).toBeDefined()
    }
  })

  it('keywords and makes are lowercase and non-empty', () => {
    for (const c of all) {
      for (const w of [...c.keywords, ...(c.makes ?? [])]) {
        expect(w.trim(), c.id).not.toBe('')
        expect(w, c.id).toBe(w.toLowerCase())
      }
    }
  })

  it('usage codes and operation categories are unique', () => {
    expect(dupes(vocab.USAGE_CODES.map((u) => u.code))).toEqual([])
    expect(dupes(vocab.OPERATION_CATEGORIES.map((o) => o.value))).toEqual([])
  })

  it('asset age config is sane', () => {
    const { oldestYear, bands } = vocab.ASSET_AGE
    expect(oldestYear).toBeGreaterThan(1000)
    expect(oldestYear).toBeLessThanOrEqual(new Date().getUTCFullYear())
    for (const b of bands) {
      expect(b.minAge, b.label).toBeGreaterThanOrEqual(0)
      if (b.maxAge !== null) expect(b.maxAge, b.label).toBeGreaterThan(b.minAge)
    }
  })

  it('has a description and a demo query', () => {
    expect(vocab.DOMAIN_DESCRIPTION.trim()).not.toBe('')
    expect(vocab.DEMO_QUERY.trim()).not.toBe('')
  })
})
