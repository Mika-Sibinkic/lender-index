/**
 * Serverless-safe PDF text extraction.
 *
 * Single source of truth for turning a PDF byte buffer into text. Used by
 * `/api/parse/file` (New Funding Source upload) and `/api/closed-deals`
 * (Past Deals upload).
 *
 * WHY unpdf and not pdf-parse:
 *   `pdf-parse@2.x` resolves to a *browser* pdfjs build under Turbopack
 *   (its package `exports` lists the `browser` condition first), which
 *   references `DOMMatrix` — a canvas global absent in Vercel's Node
 *   serverless runtime — at module-eval time. So `await import('pdf-parse')`
 *   threw `ReferenceError: DOMMatrix is not defined` and every PDF upload
 *   500'd in production. `unpdf` ships a serverless build of pdfjs with no
 *   DOM/canvas dependency, so it evaluates and runs cleanly in Node.
 */

/**
 * Normalize any binary input to a *plain* `Uint8Array`.
 *
 * pdfjs (unpdf's serverless build) hard-rejects a Node `Buffer` with
 * "Please provide binary data as `Uint8Array`, rather than `Buffer`". A Buffer
 * IS a `Uint8Array` subclass, so a bare `instanceof Uint8Array` check lets it
 * slip through — it works locally (local pdfjs is lenient) but 500s in Vercel
 * serverless. Copy into a fresh Uint8Array to shed the Buffer identity.
 * (Caught by a serverless probe; regression-tested in pdf-text.test.ts.)
 */
export function toPlainUint8Array(
  bytes: Buffer | Uint8Array | ArrayBuffer,
): Uint8Array {
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes)
  return Uint8Array.from(bytes)
}

/**
 * Extract the concatenated text layer from a PDF.
 *
 * @param bytes  the PDF file as a Buffer / Uint8Array / ArrayBuffer
 * @returns the merged text across all pages. Empty string when the PDF has
 *          no text layer (e.g. a pure scan) — callers convert that to a 422.
 * @throws  if `bytes` is not a parseable PDF (surfaced, not swallowed).
 */
export async function extractPdfText(
  bytes: Buffer | Uint8Array | ArrayBuffer,
): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(toPlainUint8Array(bytes))
  const { text } = await extractText(pdf, { mergePages: true })
  return text ?? ''
}
