/**
 * Golden-set accuracy eval harness — the keystone that makes the accuracy-first
 * mandate ("no wrong lender, ever") MEASURABLE instead of assumed.
 *
 * Two evals:
 *   1. Retrieval — drives the live search pipeline through the bearer-gated
 *      /api/search/debug endpoint and asserts the firing-level guarantee:
 *      a returned shortlist NEVER contains a lender that contradicts a stated
 *      deal constraint (geo / asset / size hard-exclude). This is rule-based and
 *      needs no ground truth. Optional expected/forbidden lender IDs add
 *      recall + negative-case checks once an operator supplies them.
 *      It ALSO asserts what the query was UNDERSTOOD to mean (`expect_extraction`),
 *      because the zero-contradiction guarantee alone is vacuously satisfiable:
 *      every dimension in structured-filter.ts returns 'unknown' when the deal
 *      criterion is empty, so a query that parses to NOTHING scores zero
 *      contradictions and passes. A case that asserts no criteria is a case that
 *      passes by understanding nothing. See scripts/eval/README.md.
 *   2. Parse — runs the doc→field extractor on golden docs and checks field-level
 *      accuracy, with `critical_fields` that must match exactly (a wrong asset
 *      class or geography is a firing-level error).
 *
 * A FAIL on any hard constraint exits non-zero (wire into CI later). WARN never
 * fails the run.
 *
 * Usage (from repo root):
 *   set -a && source .env.local && set +a && \
 *     EVAL_BASE_URL=https://your-project.vercel.app pnpm eval
 *   # or just retrieval / just parse:
 *   pnpm eval -- --retrieval-only
 *   pnpm eval -- --parse-only
 *
 * Env:
 *   EVAL_BASE_URL          default http://localhost:3000
 *   SEARCH_DEBUG_TOKEN     required for retrieval eval
 *   NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY   required for parse eval
 *   (+ the usual LLM_BACKEND / OPENAI_COMPAT_BASE_URL / OPENAI_COMPAT_API_KEY /
 *    EMBED_MODEL / LLM_MODEL for the AI backend)
 */

import * as fs from 'fs'
import * as path from 'path'
import { createClient } from '@supabase/supabase-js'
import { aiExtract } from '../../src/lib/parse/ai-extract'

const ROOT = path.resolve(__dirname, 'golden')
const BASE_URL = process.env.EVAL_BASE_URL ?? 'http://localhost:3000'

type Dim = 'match' | 'unknown' | 'contradict'
interface Fit {
  score: number
  asset: Dim
  geo: Dim
  size: Dim
  intl?: Dim
  reasons: string[]
}
interface RankedRow {
  rank: number
  id: string
  fit: Fit
}

/**
 * What the search actually RAN ON — /api/search/debug `effective` (the parse
 * plus any operator chip edits), falling back to `extraction` (the raw parse)
 * on an older deployment that predates `effective`.
 */
interface ParsedCriteria {
  semantic_query?: string
  asset_classes?: string[]
  geographic_scope?: string[]
  deal_size_min_usd?: number | null
  deal_size_max_usd?: number | null
  asset_year?: number | null
  us_states?: string[]
  intl_required?: boolean
  removed?: string[]
}

/**
 * Assertions on the UNDERSTANDING, not the verdict. Every key is optional; every
 * key present is a HARD failure when unmet. This is what stops a case passing
 * because the query parsed to nothing (all-empty criteria → every dimension
 * 'unknown' → zero contradictions → green).
 */
interface ExpectExtraction {
  /** Every listed asset class must be present in the effective criteria. */
  asset_classes?: string[]
  /** Every listed geography must be present. */
  geographic_scope?: string[]
  /**
   * Geographies that must NOT be present. A mis-parsed geography is not a
   * missing filter, it is the wrong filter: it hard-excludes exactly the lenders
   * who could write the deal (e.g. the ' us ' token in "US$ 3 milhoes no Brasil"
   * reading as United States and suppressing Brazil).
   */
  not_geographic_scope?: string[]
  /** Must equal — this arms/disarms the Domestic-only hard-exclude. */
  intl_required?: boolean
  /** Must equal exactly (deterministic parser — no tolerance). `null` = unstated. */
  deal_size_min_usd?: number | null
  deal_size_max_usd?: number | null
  asset_year?: number | null
}

interface RetrievalCase {
  name: string
  query: string
  asset_classes?: string[]
  /** Lenders that must NEVER appear (operator-supplied negatives). */
  must_not_include_ids?: string[]
  /** Lenders that should appear (operator-supplied positives — recall). */
  expected_lender_ids?: string[]
  /** What the query must be understood to mean. Unmet = hard FAIL. */
  expect_extraction?: ExpectExtraction
  /** Hard FAIL when fewer results come back — an empty shortlist is a wrong shortlist. */
  min_results?: number
  max_results?: number
  note?: string
}

interface ParseCase {
  name: string
  doc_text: string
  expected_fields: Record<string, unknown>
  /** Fields where a mismatch is a firing-level FAIL (not just a WARN). */
  critical_fields?: string[]
  /** Numeric tolerance (fraction) for currency/size fields. Default 0.02 (2%). */
  numeric_tolerance?: number
  synthetic?: boolean
  pending?: boolean
  note?: string
}

// ---------- reporting ----------
let hardFailures = 0
let warnings = 0
const RED = (s: string) => `\x1b[31m${s}\x1b[0m`
const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`
const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`
function pass(msg: string) {
  console.log(`  ${GREEN('PASS')} ${msg}`)
}
function fail(msg: string) {
  hardFailures++
  console.log(`  ${RED('FAIL')} ${msg}`)
}
function warn(msg: string) {
  warnings++
  console.log(`  ${YELLOW('WARN')} ${msg}`)
}

function loadCases<T>(dir: string): { file: string; data: T }[] {
  const full = path.join(ROOT, dir)
  if (!fs.existsSync(full)) return []
  return fs
    .readdirSync(full)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({
      file: f,
      data: JSON.parse(fs.readFileSync(path.join(full, f), 'utf8')) as T,
    }))
}

// ---------- extraction assertions (the "did it understand?" half) ----------
const normList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x).toLowerCase().trim()) : []

const fmtNum = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : v.toLocaleString('en-US')

/** One human-readable line of what the query was understood to mean. */
function summarizeParse(p: ParsedCriteria | undefined, source: string): string {
  if (!p) return 'parse: (endpoint returned no effective/extraction — cannot see the understanding)'
  const list = (v: unknown) => (Array.isArray(v) && v.length ? v.join(',') : '—')
  const size =
    p.deal_size_min_usd === null || p.deal_size_min_usd === undefined
      ? p.deal_size_max_usd === null || p.deal_size_max_usd === undefined
        ? '—'
        : `≤${fmtNum(p.deal_size_max_usd)}`
      : `${fmtNum(p.deal_size_min_usd)}–${fmtNum(p.deal_size_max_usd)}`
  const parts = [
    `assets=[${list(p.asset_classes)}]`,
    `geo=[${list(p.geographic_scope)}]`,
    `intl=${p.intl_required === undefined ? '?' : p.intl_required}`,
    `size=${size}`,
    `year=${p.asset_year ?? '—'}`,
  ]
  if (p.us_states?.length) parts.push(`states=[${p.us_states.join(',')}]`)
  if (p.removed?.length) parts.push(`removed=[${p.removed.join(',')}]`)
  return `parse[${source}]: ${parts.join(' ')}`
}

/**
 * Hard-fails when the parse does not contain what the case says it must. Missing
 * parse data is itself a failure — "could not check" must never read as "passed".
 */
function checkExpectExtraction(exp: ExpectExtraction, parsed: ParsedCriteria | undefined): void {
  if (!parsed) {
    fail('expect_extraction set but /api/search/debug returned no `effective`/`extraction` — cannot verify understanding')
    return
  }
  const misses: string[] = []
  let checks = 0

  const contains = (key: 'asset_classes' | 'geographic_scope', want: string[]) => {
    checks++
    const have = normList(parsed[key])
    const missing = want.filter((w) => !have.includes(w.toLowerCase().trim()))
    if (missing.length)
      misses.push(`${key} missing ${JSON.stringify(missing)} (got ${JSON.stringify(parsed[key] ?? [])})`)
  }
  if (exp.asset_classes?.length) contains('asset_classes', exp.asset_classes)
  if (exp.geographic_scope?.length) contains('geographic_scope', exp.geographic_scope)

  if (exp.not_geographic_scope?.length) {
    checks++
    const have = normList(parsed.geographic_scope)
    const leaked = exp.not_geographic_scope.filter((w) => have.includes(w.toLowerCase().trim()))
    if (leaked.length)
      misses.push(`geographic_scope must NOT contain ${JSON.stringify(leaked)} (got ${JSON.stringify(parsed.geographic_scope ?? [])})`)
  }

  if (exp.intl_required !== undefined) {
    checks++
    if (parsed.intl_required !== exp.intl_required)
      misses.push(`intl_required expected ${exp.intl_required} got ${JSON.stringify(parsed.intl_required ?? null)}`)
  }

  const numKeys = ['deal_size_min_usd', 'deal_size_max_usd', 'asset_year'] as const
  for (const k of numKeys) {
    if (!(k in exp)) continue
    checks++
    const want = exp[k] ?? null
    const got = parsed[k] ?? null
    if (got !== want) misses.push(`${k} expected ${want === null ? 'null' : want} got ${got === null ? 'null' : got}`)
  }

  if (misses.length) fail(`understanding WRONG — ${misses.join('; ')}`)
  // An expect_extraction that asserts nothing (empty object, or only empty
  // arrays) is the vacuous pass wearing the new field's clothes.
  else if (checks === 0) fail('expect_extraction present but asserts nothing — an empty assertion is not an assertion')
  else pass(`understanding correct — ${checks} extraction assertion(s) met`)
}

// ---------- retrieval eval ----------
async function runRetrieval(): Promise<void> {
  console.log('\n=== RETRIEVAL EVAL ===')
  const token = process.env.SEARCH_DEBUG_TOKEN
  if (!token) {
    warn('SEARCH_DEBUG_TOKEN unset — retrieval eval skipped (set it + EVAL_BASE_URL to run).')
    return
  }
  const cases = loadCases<RetrievalCase>('retrieval')
  if (!cases.length) {
    warn('no retrieval golden cases found.')
    return
  }

  for (const { file, data: c } of cases) {
    console.log(`\n• ${c.name} ${DIM(`(${file})`)}`)
    let resp: Response
    try {
      resp = await fetch(`${BASE_URL}/api/search/debug`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ q: c.query, asset_classes: c.asset_classes, limit: 50 }),
      })
    } catch (e) {
      fail(`request failed: ${(e as Error).message} (is ${BASE_URL} reachable?)`)
      continue
    }
    if (!resp.ok) {
      fail(`HTTP ${resp.status} from /api/search/debug — ${await resp.text().catch(() => '')}`)
      continue
    }
    const json = (await resp.json()) as {
      ranked: RankedRow[]
      flags?: Record<string, unknown>
      effective?: ParsedCriteria
      extraction?: ParsedCriteria
    }
    const ranked = json.ranked ?? []
    const ids = ranked.map((r) => r.id)
    // What the search RAN ON. `effective` = parse + operator chip edits; older
    // deployments only expose the raw `extraction`.
    const parsedCriteria = json.effective ?? json.extraction
    const parsedSource = json.effective ? 'effective' : 'extraction'

    // Always show the understanding, not just the verdict — a green case whose
    // parse line reads all-empty is the vacuous pass this harness exists to catch.
    console.log(`  ${DIM(summarizeParse(parsedCriteria, parsedSource))}`)

    if (c.expect_extraction) checkExpectExtraction(c.expect_extraction, parsedCriteria)

    // THE firing-level guarantee: no returned lender contradicts the deal.
    const contradictions = ranked.filter(
      (r) =>
        r.fit.geo === 'contradict' ||
        r.fit.asset === 'contradict' ||
        r.fit.size === 'contradict' ||
        r.fit.intl === 'contradict',
    )
    if (contradictions.length === 0) {
      pass(`hard-constraint precision 100% — ${ranked.length} results, zero contradictions`)
    } else {
      fail(
        `hard-constraint precision BROKEN — ${contradictions.length} contradicting lender(s) in results: ` +
          contradictions
            .slice(0, 5)
            .map((r) => `${r.id}[geo:${r.fit.geo},asset:${r.fit.asset},size:${r.fit.size}]`)
            .join(', '),
      )
    }

    if (c.must_not_include_ids?.length) {
      const leaked = c.must_not_include_ids.filter((id) => ids.includes(id))
      if (leaked.length) fail(`forbidden lender(s) appeared: ${leaked.join(', ')}`)
      else pass(`all ${c.must_not_include_ids.length} forbidden lender(s) correctly absent`)
    }

    if (c.expected_lender_ids?.length) {
      const missing = c.expected_lender_ids.filter((id) => !ids.includes(id))
      if (missing.length) warn(`recall gap — expected lender(s) missing: ${missing.join(', ')}`)
      else pass(`all ${c.expected_lender_ids.length} expected lender(s) present`)
    }

    // HARD: an empty (or near-empty) shortlist is a wrong shortlist. This was a
    // WARN, which is how two cases whose query parsed to nothing stayed green.
    if (typeof c.min_results === 'number' && ranked.length < c.min_results)
      fail(`only ${ranked.length} results (< min_results ${c.min_results})`)
    if (typeof c.max_results === 'number' && ranked.length > c.max_results)
      warn(`${ranked.length} results (> max_results ${c.max_results})`)
    if (json.flags && Object.values(json.flags).some((v) => v))
      console.log(`  ${DIM('flags: ' + JSON.stringify(json.flags))}`)
  }
}

// ---------- parse eval ----------
function arraysEqualLoose(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  const norm = (arr: unknown[]) =>
    [...new Set(arr.map((x) => String(x).toLowerCase().trim()))].sort()
  const na = norm(a)
  const nb = norm(b)
  return na.length === nb.length && na.every((x, i) => x === nb[i])
}

function fieldMatches(expected: unknown, actual: unknown, tol: number): boolean {
  if (expected === null) return actual === null || actual === undefined
  if (Array.isArray(expected)) return arraysEqualLoose(expected, actual)
  if (typeof expected === 'number') {
    if (typeof actual !== 'number') return false
    if (expected === 0) return actual === 0
    return Math.abs(actual - expected) / Math.abs(expected) <= tol
  }
  if (typeof expected === 'string')
    return String(actual ?? '').toLowerCase().trim() === expected.toLowerCase().trim()
  return JSON.stringify(expected) === JSON.stringify(actual)
}

async function runParse(): Promise<void> {
  console.log('\n=== PARSE EVAL ===')
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    warn('Supabase env unset — parse eval skipped (needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + AI backend env).')
    return
  }
  const cases = loadCases<ParseCase>('parse')
  if (!cases.length) {
    warn('no parse golden cases found.')
    return
  }
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })

  for (const { file, data: c } of cases) {
    console.log(`\n• ${c.name} ${DIM(`(${file})`)}${c.synthetic ? DIM(' [synthetic]') : ''}`)
    if (c.pending || !c.doc_text.trim()) {
      warn(`pending ground truth — no doc_text yet. Known expected: ${JSON.stringify(c.expected_fields)}`)
      continue
    }
    const tol = c.numeric_tolerance ?? 0.02
    let result
    try {
      result = await aiExtract(c.doc_text, { supabase, module: 'eval.parse' })
    } catch (e) {
      fail(`extraction threw: ${(e as Error).message}`)
      continue
    }
    if (result.fallbackUsed) {
      warn(`extractor fell back to regex (AI unreachable?) — provider=${result.provider}`)
    }
    const parsed = result.parsed as Record<string, unknown>
    const critical = new Set(c.critical_fields ?? [])
    let okCount = 0
    const fields = Object.keys(c.expected_fields)
    for (const f of fields) {
      const exp = c.expected_fields[f]
      const act = parsed[f]
      const ok = fieldMatches(exp, act, tol)
      if (ok) {
        okCount++
        continue
      }
      const msg = `${f}: expected ${JSON.stringify(exp)} got ${JSON.stringify(act ?? null)}`
      if (critical.has(f)) fail(`[critical] ${msg}`)
      else warn(msg)
    }
    const pct = fields.length ? Math.round((okCount / fields.length) * 100) : 100
    const line = `${okCount}/${fields.length} fields (${pct}%) · ${result.provider}/${result.model}`
    if (okCount === fields.length) pass(line)
    else console.log(`  ${DIM(line)}`)
  }
}

// ---------- main ----------
async function main() {
  const args = process.argv.slice(2)
  const retrievalOnly = args.includes('--retrieval-only')
  const parseOnly = args.includes('--parse-only')
  console.log(`Accuracy eval — base=${BASE_URL}`)
  if (!parseOnly) await runRetrieval()
  if (!retrievalOnly) await runParse()

  console.log('\n=== SUMMARY ===')
  console.log(`  hard failures: ${hardFailures}  warnings: ${warnings}`)
  if (hardFailures > 0) {
    console.log(RED('  ACCURACY REGRESSION — hard constraint violated. ✗'))
    process.exit(1)
  }
  console.log(GREEN('  No hard-constraint violations. ✓'))
}

main().catch((e) => {
  console.error('eval crashed:', e)
  process.exit(1)
})
