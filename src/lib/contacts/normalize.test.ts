import { describe, it, expect } from 'vitest'
import { needsNormalization } from './normalize'

describe('needsNormalization', () => {
  it('flags digits in first/last name', () => {
    expect(needsNormalization({ first_name: 'Patdoe56', last_name: 'Doe' })).toBe(true)
  })

  it('flags overlong first names (concatenation leak)', () => {
    expect(needsNormalization({ first_name: 'JohnSmithExtraordinarySomething', last_name: 'Doe' })).toBe(true)
  })

  it('flags @ inside company field', () => {
    expect(needsNormalization({ first_name: 'John', company: 'gmail.com@example' })).toBe(true)
  })

  it('flags signature debris', () => {
    expect(needsNormalization({ full_name: 'Sent from my iPhone' })).toBe(true)
  })

  it('flags empty contact', () => {
    expect(needsNormalization({})).toBe(true)
  })

  it('clean contact passes', () => {
    expect(
      needsNormalization({
        first_name: 'Bradley',
        last_name: 'Sampleton',
        company: 'Sampleton Leasing',
        email: 'b@sampleton.example.com',
      }),
    ).toBe(false)
  })
})
