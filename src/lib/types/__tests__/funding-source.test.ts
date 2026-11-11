import { describe, it, expect } from 'vitest'
import {
  fundingSourceCreateSchema,
  fundingSourceUpdateSchema,
} from '@/lib/types/funding-source'

describe('fundingSourceCreateSchema', () => {
  it('requires company_name', () => {
    const r = fundingSourceCreateSchema.safeParse({})
    expect(r.success).toBe(false)
  })

  it('accepts a minimal valid record', () => {
    const r = fundingSourceCreateSchema.safeParse({ company_name: 'AlkaidBank' })
    expect(r.success).toBe(true)
  })

  it('rejects invalid status', () => {
    const r = fundingSourceCreateSchema.safeParse({
      company_name: 'X',
      status: 'pending',
    })
    expect(r.success).toBe(false)
  })

  it('coerces deal_size string to number', () => {
    const r = fundingSourceCreateSchema.safeParse({
      company_name: 'X',
      deal_size_min_usd: '500000',
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.deal_size_min_usd).toBe(500000)
  })
})

describe('fundingSourceUpdateSchema', () => {
  it('allows partial', () => {
    const r = fundingSourceUpdateSchema.safeParse({ rate_notes: 'Updated' })
    expect(r.success).toBe(true)
  })
})
