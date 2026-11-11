import { describe, it, expect } from 'vitest'
import { chunkText } from './chunks'

describe('chunkText', () => {
  it('returns single chunk for short text', () => {
    expect(chunkText('hello world')).toEqual(['hello world'])
  })

  it('returns empty for empty input', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n  ')).toEqual([])
  })

  it('produces overlapping windows on long text', () => {
    const para = ('Sentence one. Sentence two. Sentence three. '.repeat(60)).trim()
    const chunks = chunkText(para, { windowChars: 400, overlapChars: 50 })
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.length).toBeLessThan(20)
    // chunks should cover the full text — every char appears in at least one chunk
    const union = chunks.join(' ')
    expect(union).toContain('Sentence one.')
    expect(union).toContain('Sentence three.')
  })

  it('respects maxChunks ceiling', () => {
    const huge = 'word '.repeat(5000)
    const chunks = chunkText(huge, { windowChars: 200, overlapChars: 20, maxChunks: 8 })
    expect(chunks.length).toBeLessThanOrEqual(8)
  })

  it('prefers sentence boundaries when ending a window', () => {
    const text =
      'This is sentence one. This is sentence two. This is sentence three. ' +
      'And this is a much longer fourth sentence that runs on quite a bit ' +
      'so we have something for the second chunk to grab.'
    const chunks = chunkText(text, { windowChars: 90, overlapChars: 10 })
    // First chunk should end at a period+space, not mid-word
    expect(/[.!?]\s*$/.test(chunks[0])).toBe(true)
  })
})
