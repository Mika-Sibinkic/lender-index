/**
 * Deterministic extractor for the Quick-Add NL paste surface.
 *
 * Pulled out of raw text (email body, term sheet OCR, signature blocks):
 *   - email
 *   - phone (US-format friendly)
 *   - person name (best-guess from signature)
 *   - title (best-guess from signature)
 *   - company (best-guess from signature / "from {Company}" patterns)
 *   - asset_classes (keyword pass)
 *   - deal_size_min/max (USD ranges in prose)
 *   - borrower_revenue_min, borrower_years_in_business_min, borrower_capex_min
 *
 * Intentionally NO LLM call, so nothing leaves the machine. Imperfect — designed to scaffold
 * a record that the operator reviews and corrects in the editable form.
 *
 * Upgrade path (deferred): same shape, but parse() routes to a on-prem box
 * ollama endpoint when available.
 */

import type { FundingSourceCreate } from '@/lib/types/funding-source'
import { ASSET_CATEGORIES } from '@/lib/config/domain'

// [keyword, class id] from src/lib/config/vocabulary.ts. Space-padded keywords
// (' car ') only match whole words, so the haystack is space-padded too.
const ASSET_KEYWORDS: Array<[string, string]> = ASSET_CATEGORIES.flatMap((c) =>
  c.keywords.map((k) => [k, c.id] as [string, string]),
)

const STOP_WORDS = new Set([
  'best', 'regards', 'thanks', 'thank', 'sincerely', 'cheers',
  'sent', 'from', 'subject', 'date', 'to', 'cc', 'bcc',
  're:', 'fw:', 'fwd:',
])

function extractEmail(text: string): string | null {
  const m = text.match(/[\w.+\-]+@[\w-]+(?:\.[\w-]+)+/)
  return m ? m[0] : null
}

function extractPhone(text: string): string | null {
  // Try various US phone shapes; international permitted via leading +
  const patterns = [
    /(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/,
    /\+\d{1,3}[\s.\-]?\d{2,4}[\s.\-]?\d{3,4}[\s.\-]?\d{3,4}/,
  ]
  for (const p of patterns) {
    const m = text.match(p)
    if (m) return m[0].replace(/\s+/g, ' ').trim()
  }
  return null
}

function looksLikePersonName(line: string): boolean {
  if (!line) return false
  const trimmed = line.trim()
  if (trimmed.length < 3 || trimmed.length > 80) return false
  if (/[@\d]/.test(trimmed)) return false
  if (STOP_WORDS.has(trimmed.toLowerCase().split(/\s+/)[0])) return false
  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length < 2 || words.length > 5) return false
  // At least two words start with a capital letter
  const caps = words.filter((w) => /^[A-Z][a-zA-Z'\-.]+/.test(w)).length
  return caps >= 2
}

function extractFromSignature(text: string): {
  name: string | null
  title: string | null
  company: string | null
} {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    // Drop the "Filename: …" hint line the file-parse route prepends for the AI.
    // It's not signature content, and the tail-scan would otherwise read it as a
    // person name when a PDF's text is dense/short. Regression: a flyer parsed
    // primary_contact_name = "Filename: Mirach Asset Finance Flyer.pdf".
    .filter((l) => Boolean(l) && !/^filename:/i.test(l))
  // Walk lines, looking for a name → title → company sequence near a phone/email
  let name: string | null = null
  let title: string | null = null
  let company: string | null = null

  // Find last 12 lines (signatures usually at end)
  const tail = lines.slice(-12)
  for (let i = 0; i < tail.length; i++) {
    const line = tail[i]
    if (!name && looksLikePersonName(line)) {
      name = line
      // Title is usually the next non-contact line. Allow lines that
      // also "look like a person name" because titles often contain
      // capitalized words ("Director, Sample Programs", "Managing Director").
      for (let j = i + 1; j < tail.length; j++) {
        const next = tail[j]
        if (!next) continue
        if (/[@\d]/.test(next)) continue
        if (next.length > 3 && next.length < 120) {
          title = next
          // Company may follow title — heuristic: line after title
          // that doesn't contain @, digits, or contact-boilerplate
          for (let k = j + 1; k < tail.length; k++) {
            const c = tail[k]
            if (!c) continue
            if (/[@]/.test(c)) continue
            if (/\b(office|direct|cell|mobile|tel|phone|fax|email|www|http)\b/i.test(c)) continue
            if (c.length > 3 && c.length < 120 && !/^\d/.test(c)) {
              company = c
              break
            }
          }
          break
        }
      }
      break
    }
  }
  return { name, title, company }
}

function extractCompanyFromSubject(text: string): string | null {
  // "Intro from {Company}", "from {Company}", "From: {Person} <{...}@{company}.com>"
  const introMatch = text.match(/\b(?:intro from|from)\s+([A-Z][\w&.\- ]{2,60}?)(?:[.,;\n]|$)/i)
  if (introMatch) return introMatch[1].trim()
  return null
}

function extractCompanyFromEmailDomain(email: string | null): string | null {
  if (!email) return null
  const domain = email.split('@')[1]?.split('.')[0]
  if (!domain) return null
  // Skip generic personal providers
  const generic = new Set(['gmail', 'yahoo', 'hotmail', 'outlook', 'icloud', 'aol', 'proton', 'protonmail'])
  if (generic.has(domain.toLowerCase())) return null
  return domain.charAt(0).toUpperCase() + domain.slice(1)
}

function extractAssetClasses(text: string): string[] {
  const lower = ` ${text.toLowerCase().replace(/[,.;:!?()\s]+/g, ' ')} `
  const seen = new Set<string>()
  for (const [kw, canonical] of ASSET_KEYWORDS) {
    if (lower.includes(kw)) seen.add(canonical)
  }
  return [...seen]
}

function parseDollarAmount(s: string): number | null {
  const m = s.match(/(\$?\s*[\d,.]+)\s*([kKmMbB]?(?:m|M|MM|mm|k|K|b|B)?)/)
  if (!m) return null
  const num = parseFloat(m[1].replace(/[^\d.]/g, ''))
  if (Number.isNaN(num)) return null
  const unit = (m[2] ?? '').toLowerCase()
  if (unit.includes('b')) return num * 1_000_000_000
  if (unit.startsWith('m')) return num * 1_000_000
  if (unit.startsWith('k')) return num * 1_000
  // Plain digits — if huge enough, accept as-is, else assume already dollars
  return num
}

function extractDealSize(text: string): { min: number | null; max: number | null } {
  // Range patterns: "$1M-$10M", "$500k to $5M", "deal sizes 5-50 million"
  const range = text.match(
    /\$?\s*([\d,.]+\s*[kKmMbB]?M?M?m?)\s*[-–—to]+\s*\$?\s*([\d,.]+\s*[kKmMbB]?M?M?m?)/
  )
  if (range) {
    return { min: parseDollarAmount(range[1]), max: parseDollarAmount(range[2]) }
  }
  // Single floor: "deals of $20M+", "$5MM minimum"
  const min = text.match(/\$?\s*([\d,.]+\s*[kKmMbB]?M?M?m?)\s*(?:\+|minimum|min|or more|and up)/i)
  if (min) return { min: parseDollarAmount(min[1]), max: null }
  return { min: null, max: null }
}

function extractRevenueRequirement(text: string): number | null {
  // Pattern A: "$15MM+ in revenue" (amount before keyword)
  const before = text.match(
    /(\$?\s*[\d,.]+\s*(?:mm|m|b|k))[^.\n]{0,30}?\b(?:revenue|sales|top\s*line|gross\s*receipts)\b/i
  )
  if (before) return parseDollarAmount(before[1])
  // Pattern B: "revenue requirement: $20M" (amount after keyword)
  const after = text.match(
    /\b(?:revenue|sales|top\s*line|gross\s*receipts)\b[^.\n$]{0,30}?(\$?\s*[\d,.]+\s*(?:mm|m|b|k))/i
  )
  if (after) return parseDollarAmount(after[1])
  return null
}

function extractYearsInBusiness(text: string): number | null {
  // Match "2-3 years in business" or "3+ years operating" — take the lower bound
  const m = text.match(
    /(\d+)(?:\s*[-–—to]+\s*\d+)?\s*(?:\+\s*)?(?:years?|yrs?)\s*(?:in\s*business|operating|of\s*operating)/i
  )
  if (m) return parseInt(m[1], 10)
  return null
}

function extractCapexRequirement(text: string): number | null {
  // Amount before "CapEx"
  const before = text.match(
    /(\$?\s*[\d,.]+\s*(?:mm|m|b|k))[^.\n]{0,30}?\b(?:capex|cap\s*ex|capital\s*expenditure)\b/i
  )
  if (before) return parseDollarAmount(before[1])
  // Amount after "CapEx"
  const after = text.match(
    /\b(?:capex|cap\s*ex|capital\s*expenditure)\b[^.\n$]{0,30}?(\$?\s*[\d,.]+\s*(?:mm|m|b|k))/i
  )
  if (after) return parseDollarAmount(after[1])
  return null
}

export type QuickParseResult = {
  parsed: Partial<FundingSourceCreate>
  confidence: number  // 0..1, rough — based on how many fields populated
  rawSnippet: string  // first 200 chars for context
}

export function quickExtract(text: string): QuickParseResult {
  if (!text.trim()) {
    return { parsed: {}, confidence: 0, rawSnippet: '' }
  }

  const email = extractEmail(text)
  const phone = extractPhone(text)
  const sig = extractFromSignature(text)
  const companyFallback =
    sig.company ?? extractCompanyFromSubject(text) ?? extractCompanyFromEmailDomain(email)
  const dealRange = extractDealSize(text)

  const parsed: Partial<FundingSourceCreate> = {
    company_name: companyFallback ?? undefined,
    primary_contact_name: sig.name ?? undefined,
    primary_contact_title: sig.title ?? undefined,
    primary_contact_email: email ?? undefined,
    primary_contact_phone: phone ?? undefined,
    asset_classes: extractAssetClasses(text),
    deal_size_min_usd: dealRange.min ?? undefined,
    deal_size_max_usd: dealRange.max ?? undefined,
    borrower_revenue_min_usd: extractRevenueRequirement(text) ?? undefined,
    borrower_years_in_business_min: extractYearsInBusiness(text) ?? undefined,
    borrower_capex_min_usd: extractCapexRequirement(text) ?? undefined,
    internal_notes: `[QUICK-ADD] Pasted ${new Date().toISOString().slice(0, 10)}\n\n${text.slice(0, 1500)}`,
  }

  // Confidence: fraction of high-value fields populated
  const weights: Array<[keyof FundingSourceCreate, number]> = [
    ['company_name', 0.25],
    ['primary_contact_name', 0.20],
    ['primary_contact_email', 0.20],
    ['primary_contact_phone', 0.10],
    ['primary_contact_title', 0.10],
    ['asset_classes', 0.10],
    ['deal_size_min_usd', 0.05],
  ]
  let confidence = 0
  for (const [k, w] of weights) {
    const v = parsed[k]
    if (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '') {
      confidence += w
    }
  }

  return {
    parsed,
    confidence,
    rawSnippet: text.slice(0, 200),
  }
}
