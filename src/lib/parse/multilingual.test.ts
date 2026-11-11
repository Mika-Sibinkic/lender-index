import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ocrLangs, DEFAULT_OCR_LANGS } from './ocr'

/**
 * Cross-border deal flow reaches Brazil, Mexico and Europe. Source documents
 * arrive in Portuguese and Spanish — the retrieval golden set carries a
 * Portuguese Brazil case.
 *
 * The text extractor was told to expect any language from the start; the past-deal
 * and image extractors never were, and Tesseract was pinned to English. Those
 * gaps are invisible in review (the code runs fine — it just produces worse
 * fields), so they get pinned here.
 */
const src = (p: string) => readFileSync(join(process.cwd(), 'src/lib/parse', p), 'utf8')

describe('every extraction prompt tells the model to expect other languages', () => {
  const PROMPTS: Array<[string, string]> = [
    ['ai-extract.ts', 'pasted text / email body'],
    ['closed-deal-extract.ts', 'Past Deals import'],
    ['ai-extract-image.ts', 'business cards and scans'],
  ]

  for (const [file, what] of PROMPTS) {
    it(`${file} (${what})`, () => {
      expect(src(file)).toMatch(/may be in any language/i)
    })
  }

  it('past-deal extraction is told how to read localised numbers and dates', () => {
    // "R$ 1.500.000,00" read as US formatting is 1.5, not 1,500,000 — a
    // six-orders-of-magnitude error on a loan amount. Worth being explicit.
    const s = src('closed-deal-extract.ts')
    expect(s).toMatch(/1\.500\.000,00/)
    expect(s).toMatch(/day-first/i)
  })

  it('keeps proper nouns verbatim rather than translating company names', () => {
    for (const [file] of PROMPTS) {
      // [\s\S] rather than the `s` flag — tsconfig targets ES2017.
      expect(src(file)).toMatch(/proper nouns[\s\S]*?verbatim/i)
    }
  })
})

describe('ocrLangs', () => {
  const original = process.env.OCR_LANGS
  afterEach(() => {
    if (original === undefined) delete process.env.OCR_LANGS
    else process.env.OCR_LANGS = original
  })

  it('defaults to English plus the common Latin-script languages', () => {
    delete process.env.OCR_LANGS
    expect(ocrLangs()).toBe(DEFAULT_OCR_LANGS)
    expect(ocrLangs()).toContain('por')
    expect(ocrLangs()).toContain('spa')
  })

  it('accepts an override in either comma or plus form', () => {
    process.env.OCR_LANGS = 'eng+fra'
    expect(ocrLangs()).toBe('eng+fra')
    process.env.OCR_LANGS = 'eng, deu'
    expect(ocrLangs()).toBe('eng+deu')
  })

  it('de-duplicates and normalises case', () => {
    process.env.OCR_LANGS = 'ENG+eng+Por'
    expect(ocrLangs()).toBe('eng+por')
  })

  it('falls back to the default rather than passing junk to Tesseract', () => {
    // A bad value would make createWorker throw and take image parse down
    // entirely — worse than ignoring the override.
    for (const bad of ['', '   ', 'english+portuguese', '!!']) {
      process.env.OCR_LANGS = bad
      expect(ocrLangs()).toBe(DEFAULT_OCR_LANGS)
    }
  })
})
