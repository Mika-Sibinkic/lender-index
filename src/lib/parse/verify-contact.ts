/**
 * Deterministic DNS check on a contact domain that was read out of a photograph.
 *
 * WHY THIS EXISTS
 *
 * The image path is OCR-first by default: `shouldPreferOcr()` returns true
 * whenever LLM_VISION_MODEL is unset, which is a common self-hosted configuration. So a
 * tilted, glare-lit business-card photo becomes tesseract text, and tesseract
 * text becomes structured fields via an LLM that has no way to know a word was
 * misread. A sibling product running this same design turned
 * `examplefleet` into `samplefleet` and shipped eleven differently-garbled
 * duplicates of one person into a CRM.
 *
 * This app is structurally safer — a human confirms every write — but a human cannot
 * eyeball the difference between examplefleet.example and samplefleet.example. A
 * resolver can: one of those names exists and one does not. That is the entire
 * job here.
 *
 * THE RULES THIS MODULE OBEYS
 *
 *   1. FAIL OPEN. A result is only ever "not-found" when the resolver gave a
 *      definitive answer that the name does not exist, or when the address is
 *      syntactically impossible. Every other outcome — timeout, SERVFAIL,
 *      REFUSED, no resolver at all, an unexpected throw — is "unchecked". Our
 *      network having a bad minute must never cast doubt on a real lender's
 *      contact details. Getting this backwards would invert the accuracy rule
 *      the whole product is built on.
 *   2. FLAG ONLY, NEVER FIX. Nothing here mutates, corrects, or drops the
 *      extracted value. "Did you mean examplefleet.example?" is a guess, and a
 *      guess is the thing we are defending against.
 *   3. THREE OUTCOMES, NOT A BOOLEAN. "We checked and it does not exist" and
 *      "we could not check" are different facts and the reviewer needs to see
 *      which one they are looking at.
 *
 * Portable-cloud invariant: node's own resolver, no third-party library, no
 * HTTP call, no provider URL. Runs unchanged on Vercel and on the on-prem box.
 */

import { resolveMx, resolve4 } from 'node:dns/promises'

/**
 * Hard ceiling on the whole check. DNS answers in tens of milliseconds when it
 * answers at all; anything past this is a resolver that is not going to reply,
 * and the parse response must not wait on it.
 */
export const DEFAULT_DNS_TIMEOUT_MS = 2500

/** Which extracted field the domain came from. */
export type ContactDomainSource = 'email' | 'website'

/** Reasons we can say, with confidence, that this domain is not real. */
export type NotFoundReason =
  /** Not a possible address/domain at all — no lookup was attempted. */
  | 'malformed'
  /** The resolver answered NXDOMAIN for both mail and address records. */
  | 'nxdomain'

/** Reasons we could not reach a verdict. All of these mean "no signal". */
export type UncheckedReason =
  /** Nothing to check — no email and no website. */
  | 'no-input'
  /** The lookup exceeded the timeout budget. */
  | 'timeout'
  /** SERVFAIL, REFUSED, no resolver, or anything else on our side. */
  | 'dns-error'
  /**
   * The name exists but publishes no MX and no A record. Undeliverable in
   * practice, but NOT evidence the word was garbled — a parked or
   * mail-outsourced domain looks like this. Reported as no signal on purpose.
   */
  | 'no-records'
  /**
   * A non-ASCII (internationalised) domain. Node's resolver wants punycode and
   * converting it here would be rewriting the extracted value, so we decline to
   * judge instead of flagging a legitimate French or Brazilian lender.
   */
  | 'non-ascii-domain'

interface VerificationBase {
  /** The domain we looked up, lowercased. Null when we never got one. */
  domain: string | null
  /** Where that domain came from, so the UI flags the right field. */
  source: ContactDomainSource | null
}

export type ContactVerification =
  | (VerificationBase & {
      status: 'resolved'
      domain: string
      source: ContactDomainSource
      /** Which record proved it: a mail exchanger, or just an address. */
      via: 'mx' | 'address'
    })
  | (VerificationBase & { status: 'not-found'; reason: NotFoundReason })
  | (VerificationBase & { status: 'unchecked'; reason: UncheckedReason })

/**
 * Deliberately strict but shape-only: one @, no whitespace, no characters that
 * cannot survive in an address. This catches the OCR garble that produces
 * `john@ examplefleet .example` or `john@examplefleet,example`, which is a real and
 * common tesseract output on an angled card.
 */
const EMAIL_SHAPE = /^[^\s@,;:<>()[\]\\"]+@([^\s@,;:<>()[\]\\"]+)$/

/** Labels of 1-63 chars, at least one dot, an alphabetic TLD, 253 chars total. */
const DOMAIN_SHAPE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

const NON_ASCII = /[^\x00-\x7F]/

/** NXDOMAIN: the resolver answered, and the name does not exist. */
const NXDOMAIN_CODES = new Set(['ENOTFOUND', 'NOTFOUND'])
/** The name exists, but has no record of the type we asked for. */
const NODATA_CODES = new Set(['ENODATA', 'NODATA'])

/** Sentinel so a timeout is never mistaken for a resolver verdict. */
class DnsTimeoutError extends Error {}

function codeOf(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code
  return typeof c === 'string' ? c.toUpperCase() : ''
}

/**
 * Bound a DNS call the way src/lib/llm/client.ts bounds an embed call: a hard
 * stop, so a stalled resolver degrades to "unknown" instead of holding the
 * request open to the function timeout. AbortSignal.timeout's timer is unref'd,
 * so it never keeps the process alive by itself.
 */
function bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DnsTimeoutError(`dns lookup exceeded ${timeoutMs}ms`))
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    // Both handlers are attached, so a late rejection from an already-timed-out
    // lookup is still handled and never surfaces as an unhandled rejection.
    work.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

type LookupOutcome =
  | { kind: 'resolved'; via: 'mx' | 'address' }
  | { kind: 'nxdomain' }
  | { kind: 'unchecked'; reason: UncheckedReason }

/**
 * MX first — a contact domain that receives mail is the thing we actually care
 * about — then A, because plenty of small operators run a domain with a web
 * host and outsourced mail that the MX query does not see. "Does not exist"
 * requires BOTH queries to come back NXDOMAIN.
 */
async function lookupDomain(domain: string, timeoutMs: number): Promise<LookupOutcome> {
  const deadline = Date.now() + timeoutMs
  let mxCode = ''

  try {
    const mx = await bounded(resolveMx(domain), timeoutMs)
    if (mx.length > 0) return { kind: 'resolved', via: 'mx' }
    // An empty answer is ENODATA wearing a different hat.
    mxCode = 'ENODATA'
  } catch (e) {
    if (e instanceof DnsTimeoutError) return { kind: 'unchecked', reason: 'timeout' }
    mxCode = codeOf(e)
    // Anything that is not "no mail record here" is our problem, not the
    // domain's: SERVFAIL, REFUSED, EAI_AGAIN, an unreachable resolver. Stop and
    // report no signal rather than spending the rest of the budget on it.
    if (!NXDOMAIN_CODES.has(mxCode) && !NODATA_CODES.has(mxCode)) {
      return { kind: 'unchecked', reason: 'dns-error' }
    }
  }

  // One shared budget across both hops, not one each.
  const remaining = deadline - Date.now()
  if (remaining <= 0) return { kind: 'unchecked', reason: 'timeout' }

  try {
    const addresses = await bounded(resolve4(domain), remaining)
    if (addresses.length > 0) return { kind: 'resolved', via: 'address' }
  } catch (e) {
    if (e instanceof DnsTimeoutError) return { kind: 'unchecked', reason: 'timeout' }
    const aCode = codeOf(e)
    // The only path to a negative verdict in this whole module.
    if (NXDOMAIN_CODES.has(aCode) && NXDOMAIN_CODES.has(mxCode)) return { kind: 'nxdomain' }
    if (NXDOMAIN_CODES.has(aCode) || NODATA_CODES.has(aCode)) {
      return { kind: 'unchecked', reason: 'no-records' }
    }
    return { kind: 'unchecked', reason: 'dns-error' }
  }

  return { kind: 'unchecked', reason: 'no-records' }
}

type DomainPick =
  | { ok: true; domain: string; source: ContactDomainSource }
  | { ok: false; result: ContactVerification }

/** Pull the domain out of an email address. Shape checks only, no lookup. */
function domainFromEmail(raw: string): DomainPick {
  const m = EMAIL_SHAPE.exec(raw.trim())
  if (!m) {
    return { ok: false, result: { status: 'not-found', domain: null, source: 'email', reason: 'malformed' } }
  }
  // A trailing dot is a legal fully-qualified name; drop it for the shape test
  // only. This is not a correction — the caller's value is untouched.
  const domain = m[1].trim().toLowerCase().replace(/\.$/, '')
  if (NON_ASCII.test(domain)) {
    return {
      ok: false,
      result: { status: 'unchecked', domain, source: 'email', reason: 'non-ascii-domain' },
    }
  }
  if (!DOMAIN_SHAPE.test(domain)) {
    return {
      ok: false,
      result: { status: 'not-found', domain, source: 'email', reason: 'malformed' },
    }
  }
  return { ok: true, domain, source: 'email' }
}

/** Pull the host out of a website URL. Used only when there is no email. */
function domainFromWebsite(raw: string): DomainPick {
  const trimmed = raw.trim()
  let host = ''
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).hostname
  } catch {
    host = ''
  }
  const domain = host.toLowerCase().replace(/\.$/, '')
  if (!domain) {
    return {
      ok: false,
      result: { status: 'not-found', domain: null, source: 'website', reason: 'malformed' },
    }
  }
  if (NON_ASCII.test(domain)) {
    return {
      ok: false,
      result: { status: 'unchecked', domain, source: 'website', reason: 'non-ascii-domain' },
    }
  }
  if (!DOMAIN_SHAPE.test(domain)) {
    return {
      ok: false,
      result: { status: 'not-found', domain, source: 'website', reason: 'malformed' },
    }
  }
  return { ok: true, domain, source: 'website' }
}

/**
 * Check whether the domain behind an extracted contact actually exists.
 *
 * Prefers the email's domain; falls back to the website's host only when there
 * is no email to check. Never throws — by contract, because losing a user's
 * parse to a DNS hiccup would be a far worse bug than the one this prevents.
 *
 * @param email   the extracted contact email, exactly as extracted
 * @param website the extracted website, used only if `email` is blank
 * @param opts.timeoutMs total budget for the whole check
 */
export async function verifyContactDomain(
  email: string | null | undefined,
  website?: string | null,
  opts: { timeoutMs?: number } = {},
): Promise<ContactVerification> {
  try {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_DNS_TIMEOUT_MS
    const emailRaw = typeof email === 'string' ? email.trim() : ''
    const websiteRaw = typeof website === 'string' ? website.trim() : ''

    if (!emailRaw && !websiteRaw) {
      return { status: 'unchecked', domain: null, source: null, reason: 'no-input' }
    }

    const pick = emailRaw ? domainFromEmail(emailRaw) : domainFromWebsite(websiteRaw)
    if (!pick.ok) return pick.result

    const outcome = await lookupDomain(pick.domain, timeoutMs)
    if (outcome.kind === 'resolved') {
      return { status: 'resolved', domain: pick.domain, source: pick.source, via: outcome.via }
    }
    if (outcome.kind === 'nxdomain') {
      return { status: 'not-found', domain: pick.domain, source: pick.source, reason: 'nxdomain' }
    }
    return { status: 'unchecked', domain: pick.domain, source: pick.source, reason: outcome.reason }
  } catch {
    // Belt and braces on rule 1. Anything unforeseen is no signal, never doubt.
    return { status: 'unchecked', domain: null, source: null, reason: 'dns-error' }
  }
}
