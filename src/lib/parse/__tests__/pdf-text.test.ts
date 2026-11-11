import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractPdfText, toPlainUint8Array } from '../pdf-text'

// Hermetic fixture: a 648-byte single-page PDF with a known text layer.
// (Real loan PDFs are private and never committed, so CI needs its own
// synthetic sample.)
const sampleLoan = readFileSync(join(__dirname, 'fixtures/sample-loan.pdf'))

describe('extractPdfText', () => {
  it('extracts the text layer from a PDF in a Node runtime (no DOMMatrix/pdfjs-browser dep)', async () => {
    const text = await extractPdfText(sampleLoan)
    // The exact strings the downstream LLM extractor needs to see.
    expect(text).toContain('Caterpillar 320')
    expect(text).toContain('450000')
    expect(text.length).toBeGreaterThan(20)
  })

  it('returns a string (empty, not a throw) for a valid PDF with no text layer', async () => {
    // Regression guard for the route contract: routes do `if (!text.trim()) → 422`,
    // so the helper must resolve to '' rather than reject on a text-less PDF.
    const blankPdf = makeBlankPdf()
    const text = await extractPdfText(blankPdf)
    expect(typeof text).toBe('string')
    expect(text.trim()).toBe('')
  })

  it('rejects on bytes that are not a PDF (surfaced as a parse failure, not a silent success)', async () => {
    await expect(extractPdfText(Buffer.from('this is not a pdf'))).rejects.toBeInstanceOf(Error)
  })
})

describe('toPlainUint8Array', () => {
  // The serverless-only bug: unpdf/pdfjs rejects a Node Buffer. Routes
  // hand it a Buffer (from file.arrayBuffer() / storage download), so the
  // helper MUST strip the Buffer identity into a plain Uint8Array.
  it('converts a Node Buffer to a plain Uint8Array (not a Buffer)', () => {
    const buf = Buffer.from([1, 2, 3, 4])
    const out = toPlainUint8Array(buf)
    expect(out).toBeInstanceOf(Uint8Array)
    expect(Buffer.isBuffer(out)).toBe(false)
    expect(out.constructor).toBe(Uint8Array)
    expect(Array.from(out)).toEqual([1, 2, 3, 4])
  })

  it('wraps an ArrayBuffer as a plain Uint8Array', () => {
    const ab = new Uint8Array([9, 8, 7]).buffer
    const out = toPlainUint8Array(ab)
    expect(out).toBeInstanceOf(Uint8Array)
    expect(Buffer.isBuffer(out)).toBe(false)
    expect(Array.from(out)).toEqual([9, 8, 7])
  })
})

// Minimal valid single-page PDF with no content stream → no text layer.
function makeBlankPdf(): Buffer {
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((body, i) => {
    offsets[i] = Buffer.byteLength(pdf, 'latin1')
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefStart = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  offsets.forEach((off) => {
    pdf += String(off).padStart(10, '0') + ' 00000 n \n'
  })
  pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`
  return Buffer.from(pdf, 'latin1')
}
