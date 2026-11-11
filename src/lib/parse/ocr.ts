/**
 * Tesseract OCR fallback for image parse.
 *
 * Privacy-preserving alternative to a vision LLM. Runs as WASM in the
 * Node process — no cloud egress, no native binary required (works on
 * Vercel Functions, on-prem box, and Mac dev without extra deps).
 *
 * Used when:
 *   - PARSE_OCR_FIRST=true is set (explicit preference for OCR), OR
 *   - LLM_VISION_MODEL is unset / blank (no vision model configured),
 *     OR
 *   - the vision LLM call fails and we want a graceful fallback.
 *
 * Output: plain extracted text, ready for the existing
 * /api/parse text-extraction pipeline.
 *
 * tesseract.js was chosen over native Tesseract or a smaller VLM: it runs
 * in-process with no system dependency.
 */

import { createWorker, type Worker } from 'tesseract.js'

let _worker: Worker | null = null

/**
 * Languages Tesseract loads.
 *
 * This was hard-coded to `eng`, which quietly mangled every non-English scan:
 * English training data drops or substitutes accented characters, so a
 * photographed card in Portuguese came back with corrupted names and the
 * extractor downstream had garbage to work with. Cross-border deal flow is
 * multilingual, so English-only is the wrong default.
 *
 * The default adds the common Latin-script languages (German, French,
 * Portuguese, Spanish). The image prompt already told the model
 * to expect French and German while OCR could not read them — so the model was
 * being handed mangled text and asked to be careful with it.
 *
 * The cost is real but bounded: each language adds roughly 1.5 s to the one-time
 * worker init (the worker is long-lived and reused across calls), and
 * multi-language mode can very slightly reduce accuracy on pure-English text.
 * Correct text from a French document is worth more than a marginal gain on an
 * English one.
 *
 * Italian is deliberately absent: its pack emits `failed to load
 * ./ita.special-words` in tesseract.js 7, and adding it to a six-language set
 * hung worker init for minutes. Measured on a real screenshot, the set below
 * costs 0.9 s against 0.8 s for eng+por+spa, at identical confidence (90) and
 * identical character count — French and German are effectively free.
 *
 * ARABIC AND OTHER NON-LATIN SCRIPTS ARE DELIBERATELY NOT HERE. Mixing a
 * right-to-left, non-Latin script into a Latin-script combo measurably degrades
 * recognition of every other language in the set, and Tesseract's Arabic accuracy
 * on a photographed document is poor regardless. Genuine coverage beyond Latin
 * script is a cloud-vision decision, not a language-pack change.
 * `OCR_LANGS=eng+ara` remains available if someone wants to try it on a specific
 * document.
 *
 * Override with OCR_LANGS (Tesseract syntax, e.g. "eng" or "eng+por+spa+fra").
 */
export const DEFAULT_OCR_LANGS = 'eng+deu+fra+por+spa'

export function ocrLangs(): string {
  const raw = process.env.OCR_LANGS?.trim()
  if (!raw) return DEFAULT_OCR_LANGS
  // Accept comma or plus separated; Tesseract wants plus.
  const parts = raw
    .split(/[+,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[a-z]{3}$/.test(s))
  return parts.length ? [...new Set(parts)].join('+') : DEFAULT_OCR_LANGS
}

/**
 * Lazy-init a long-lived worker. Tesseract's startup cost (~1.5 s per language
 * data file) dominates total OCR time on short inputs, so we reuse across calls.
 */
async function getWorker(): Promise<Worker> {
  if (_worker) return _worker
  _worker = await createWorker(ocrLangs(), undefined, {
    // Quieter logger; surface only errors. tesseract.js spams progress.
    logger: () => {},
  })
  return _worker
}

export interface OcrResult {
  text: string
  confidence: number
  latencyMs: number
}

/**
 * Extract text from an image buffer via Tesseract OCR.
 *
 * Best-effort — returns empty text on failure rather than throwing,
 * so callers can fall back to other parse paths without try/catch
 * sprawl.
 */
export async function ocrImage(buffer: Buffer): Promise<OcrResult> {
  const t0 = Date.now()
  try {
    const worker = await getWorker()
    const { data } = await worker.recognize(buffer)
    return {
      text: data.text.trim(),
      confidence: data.confidence / 100,
      latencyMs: Date.now() - t0,
    }
  } catch (e) {
    console.warn(`ocrImage failed: ${(e as Error).message}`)
    return { text: '', confidence: 0, latencyMs: Date.now() - t0 }
  }
}

/**
 * Test hook — drop the cached worker so a new createWorker call runs
 * with fresh config. Not used in production.
 */
export async function _resetOcrWorker(): Promise<void> {
  if (_worker) {
    try {
      await _worker.terminate()
    } catch {
      /* swallow */
    }
    _worker = null
  }
}

/**
 * Returns true when env says to use OCR as the first vision-extraction
 * path instead of an LLM vision call. Two triggers:
 *   - PARSE_OCR_FIRST=true (explicit)
 *   - LLM_VISION_MODEL is unset / blank (no vision model configured)
 */
export function shouldPreferOcr(): boolean {
  if (process.env.PARSE_OCR_FIRST === 'true') return true
  const visionModel = process.env.LLM_VISION_MODEL?.trim()
  return !visionModel
}
