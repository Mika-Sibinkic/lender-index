/**
 * vCard parser for business-card QR codes.
 *
 * Conference badges and cards overwhelmingly encode a vCard in their QR — which
 * means the contact details are sitting there in machine-readable form while we
 * OCR a photograph of the same text and guess. A card photographed at a trade
 * show is exactly this: an angled, glare-lit phone photo with a QR code in the
 * corner carrying the data verbatim.
 *
 * Deterministic beats probabilistic on the extraction path (accuracy mandate),
 * so whatever comes out of here outranks anything the AI inferred from pixels.
 *
 * Handles vCard 2.1/3.0/4.0: parameterised types (TEL;TYPE=CELL), quoted-printable
 * encoding (common in 2.1 exports from Outlook), and line folding.
 */

export interface VCardContact {
  fullName: string | null
  organization: string | null
  title: string | null
  email: string | null
  phone: string | null
  website: string | null
  /** Every phone found, most-specific first — cards often list mobile + office. */
  phones: string[]
  emails: string[]
}

const EMPTY: VCardContact = {
  fullName: null,
  organization: null,
  title: null,
  email: null,
  phone: null,
  website: null,
  phones: [],
  emails: [],
}

export function isVCard(text: string): boolean {
  return /^\s*BEGIN:VCARD/i.test(text)
}

/** RFC 6350 line folding: a CRLF followed by a space/tab continues the line. */
function unfold(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

/** Outlook's vCard 2.1 export encodes accented names as =C3=A9 etc. */
function decodeQuotedPrintable(s: string): string {
  const bytes: number[] = []
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9A-F]{2}$/i.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      bytes.push(s.charCodeAt(i))
    }
  }
  try {
    return new TextDecoder('utf-8').decode(Uint8Array.from(bytes))
  } catch {
    return s
  }
}

interface Line {
  name: string
  params: string[]
  value: string
}

function parseLine(raw: string): Line | null {
  const colon = raw.indexOf(':')
  if (colon < 0) return null
  const left = raw.slice(0, colon)
  let value = raw.slice(colon + 1).trim()
  const [name, ...params] = left.split(';')
  const upperParams = params.map((p) => p.toUpperCase())
  if (upperParams.some((p) => p.includes('QUOTED-PRINTABLE'))) {
    value = decodeQuotedPrintable(value)
  }
  return { name: name.toUpperCase().replace(/^ITEM\d+\./, ''), params: upperParams, value }
}

/** Rank a TEL by how likely it is the number a broker should call first. */
function phoneRank(params: string[]): number {
  const p = params.join(' ')
  if (p.includes('CELL') || p.includes('MOBILE')) return 0
  if (p.includes('WORK') || p.includes('VOICE')) return 1
  if (p.includes('FAX')) return 9
  return 2
}

export function parseVCard(text: string): VCardContact {
  if (!isVCard(text)) return { ...EMPTY }

  const out: VCardContact = { ...EMPTY, phones: [], emails: [] }
  const tels: Array<{ rank: number; value: string }> = []
  let structuredName: string | null = null

  for (const raw of unfold(text)) {
    const line = parseLine(raw)
    if (!line || !line.value) continue

    switch (line.name) {
      case 'FN':
        out.fullName = line.value
        break
      case 'N': {
        // N is Family;Given;Middle;Prefix;Suffix — only used if FN is absent.
        const [family, given] = line.value.split(';')
        const joined = [given, family].filter(Boolean).join(' ').trim()
        if (joined) structuredName = joined
        break
      }
      case 'ORG':
        // ORG may be "Company;Department" — the company is what we index.
        out.organization = line.value.split(';')[0].trim() || null
        break
      case 'TITLE':
        out.title = line.value
        break
      case 'EMAIL':
        if (!out.emails.includes(line.value)) out.emails.push(line.value)
        break
      case 'TEL':
        tels.push({ rank: phoneRank(line.params), value: line.value })
        break
      case 'URL':
        if (!out.website) out.website = line.value
        break
    }
  }

  if (!out.fullName && structuredName) out.fullName = structuredName
  tels.sort((a, b) => a.rank - b.rank)
  out.phones = tels.map((t) => t.value)
  out.phone = out.phones[0] ?? null
  out.email = out.emails[0] ?? null
  return out
}

/** True when the parse actually yielded something worth trusting over OCR. */
export function hasUsableContact(c: VCardContact): boolean {
  return Boolean(c.fullName || c.organization || c.email || c.phone)
}
