import { describe, it, expect } from 'vitest'
import QRCode from 'qrcode'
import { Jimp } from 'jimp'
import { decodeQr } from './qr'
import { parseVCard, hasUsableContact } from './vcard'

/**
 * End-to-end proof of the deterministic intake path: a real QR image in, exact
 * contact fields out, no model involved.
 *
 * The card this exists for is one photographed at a trade show — a
 * hand-held, angled, glare-lit phone photo whose QR carries the
 * contact data verbatim while OCR guesses at the printed text beside it.
 */
const CARD_VCARD = `BEGIN:VCARD
VERSION:3.0
N:Dupont;Jean;;;
FN:Jean Dupont
ORG:Vega Equipment Solutions
TITLE:Senior Advisor - Brazil
TEL;TYPE=CELL:+55 11 55501-0157
EMAIL:jean.dupont-ext@example.com
URL:https://equipmentsolutions.example.com
END:VCARD`

/** Render a QR to a JPEG buffer, optionally padded onto a larger canvas. */
async function qrJpeg(payload: string, opts: { scale?: number; canvas?: number } = {}) {
  const png = await QRCode.toBuffer(payload, {
    type: 'png',
    scale: opts.scale ?? 8,
    margin: 2,
    errorCorrectionLevel: 'M',
  })
  if (!opts.canvas) return await (await Jimp.read(png)).getBuffer('image/jpeg')
  // Composite onto a bigger off-white "card" so the QR is a small region of a
  // large photo — the realistic case, not a cropped code filling the frame.
  const bg = new Jimp({ width: opts.canvas, height: opts.canvas, color: 0xf2f0ebff })
  const code = await Jimp.read(png)
  bg.composite(code, 40, 40)
  return await bg.getBuffer('image/jpeg')
}

describe('decodeQr', () => {
  it('reads a vCard QR out of a JPEG and yields exact contact fields', async () => {
    const buf = await qrJpeg(CARD_VCARD)
    const qr = await decodeQr(buf)
    expect(qr).not.toBeNull()
    expect(qr!.text).toContain('Vega Equipment Solutions')

    const c = parseVCard(qr!.text)
    expect(hasUsableContact(c)).toBe(true)
    expect(c.fullName).toBe('Jean Dupont')
    expect(c.email).toBe('jean.dupont-ext@example.com')
    expect(c.phone).toBe('+55 11 55501-0157')
    expect(c.title).toBe('Senior Advisor - Brazil')
  }, 30_000)

  it('finds a small QR inside a large photo-sized image', async () => {
    const buf = await qrJpeg(CARD_VCARD, { scale: 6, canvas: 2000 })
    const qr = await decodeQr(buf)
    expect(qr).not.toBeNull()
    expect(parseVCard(qr!.text).organization).toBe('Vega Equipment Solutions')
  }, 45_000)

  it('returns null for an image with no QR rather than throwing', async () => {
    // A term sheet or a plain photo — the common case. Must fall through to
    // OCR/vision, not fail the upload.
    const plain = await new Jimp({ width: 400, height: 300, color: 0xffffffff }).getBuffer(
      'image/jpeg',
    )
    expect(await decodeQr(plain)).toBeNull()
  }, 30_000)

  it('returns null on a corrupt buffer rather than throwing', async () => {
    expect(await decodeQr(Buffer.from('not an image at all'))).toBeNull()
  }, 30_000)

  it('passes through a non-vCard QR without inventing a contact', async () => {
    // Many cards encode just a URL. That is an enrichment hint, not contact data.
    const qr = await decodeQr(await qrJpeg('https://equipmentsolutions.example.com'))
    expect(qr!.text).toBe('https://equipmentsolutions.example.com')
    expect(hasUsableContact(parseVCard(qr!.text))).toBe(false)
  }, 30_000)
})
