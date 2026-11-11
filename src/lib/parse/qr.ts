/**
 * QR decoding for image intake.
 *
 * Business cards collected at conferences almost always carry a QR code, and it
 * almost always holds a vCard. Until now we ignored it entirely and ran OCR over
 * a photograph of the same text — guessing at data that was already present in
 * machine-readable form. On a card photographed at a trade show (an angled,
 * glare-lit phone photo) that is the difference between exact contact details
 * and a best-effort read.
 *
 * Pure JS on purpose (jimp + jsqr, no native bindings) so it runs unchanged on
 * Vercel and on a self-hosted box.
 *
 * Best-effort throughout: any failure returns null so the caller falls through
 * to OCR / vision rather than losing the upload.
 */

import { Jimp } from 'jimp'
import jsQR from 'jsqr'

/** Cap the working image so a 12-megapixel phone photo can't stall the request. */
const MAX_DIM = 1600

export interface QrResult {
  text: string
  /** Which pass found it — useful when diagnosing a card that scans poorly. */
  via: 'direct' | 'downscaled' | 'inverted'
}

/**
 * Only the raw bitmap is needed, so this takes that rather than a Jimp instance
 * — `clone().scale()` and `clone().greyscale()` return different generic shapes
 * and typing against any one of them fights the library for no benefit.
 */
interface Bitmap {
  bitmap: { width: number; height: number; data: Buffer }
}

function scan(image: Bitmap): string | null {
  const { width, height, data } = image.bitmap
  const res = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width, height, {
    inversionAttempts: 'attemptBoth',
  })
  return res?.data ?? null
}

/**
 * Find and decode a QR code in an image. Returns null when there isn't one —
 * which is the common case for a term sheet or a plain photo, and is not an error.
 */
export async function decodeQr(buffer: Buffer): Promise<QrResult | null> {
  try {
    const image = await Jimp.read(buffer)

    const direct = scan(image)
    if (direct) return { text: direct, via: 'direct' }

    // Phone photos are far larger than jsQR needs, and the extra pixels hurt more
    // than they help — downscaling often locks onto a code the full-size pass missed.
    const longest = Math.max(image.bitmap.width, image.bitmap.height)
    if (longest > MAX_DIM) {
      const scaled = image.clone().scale(MAX_DIM / longest)
      const hit = scan(scaled)
      if (hit) return { text: hit, via: 'downscaled' }
    }

    // Cards printed light-on-dark decode only after inversion. jsQR's own
    // attemptBoth covers most of these, but greyscale+contrast rescues the
    // low-contrast laminated ones that catch glare.
    const boosted = image.clone().greyscale().contrast(0.3)
    const hit = scan(boosted)
    if (hit) return { text: hit, via: 'inverted' }

    return null
  } catch (e) {
    console.warn(`decodeQr failed: ${(e as Error).message}`)
    return null
  }
}
