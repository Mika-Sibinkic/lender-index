/**
 * One place that turns "the AI hop blew up" into an operator-facing sentence.
 *
 * Why this exists: when the configured `LLM_MODEL` (say `qwen2.5:7b-instruct`)
 * is not installed on the model host, Ollama answers `404 {"error":{"message":"model
 * 'qwen2.5:7b-instruct' not found"}}` — a *reachable-but-erroring* status, so it
 * missed the unreachable-origin guard in local-extract.ts. Two bad outcomes:
 *   - Add mode silently degraded to the regex `quick-extract` and presented the
 *     result as a normal parse (accuracy mandate: a human must know the AI did
 *     not actually read the document).
 *   - Past Deals import threw → HTTP 500 → the user saw "Could not import
 *     deal / Something went wrong on our end", with no way to act. That is the
 *     exact bug users reported, more than once.
 *
 * A missing model is an OPS problem with a one-line fix (`ollama pull …`). The
 * operator deserves to be told that, not a shrug. Deliberately NOT auto-falling
 * back to whatever model happens to be installed: silently swapping the model on
 * the extraction path changes extraction accuracy, which is a Tier-2 decision,
 * not something an error handler gets to do (accuracy-first mandate).
 */

export type AiFailureKind = 'offline' | 'model_missing' | 'timeout' | 'unknown'

export interface AiFailure {
  kind: AiFailureKind
  /** The model the backend said it does not have, when it named one. */
  model?: string
}

/** Marker local-extract.ts stamps on network-level failures. */
const UNREACHABLE_MARKER = 'AI_BACKEND_UNREACHABLE'

/**
 * Ollama / vLLM / LM Studio all phrase a missing model as some variant of
 * `model "x" not found` or `model 'x' does not exist`. Capture the name when
 * it's quoted so the message can name the exact tag to pull.
 */
// The quote class allows backslashes: the AI SDK hands back the provider's raw
// body as an already-JSON-encoded string, so the tag arrives as \"qwen2.5:3b\"
// rather than "qwen2.5:3b".
const MODEL_MISSING_RE =
  /model\s+[\\"'`]*([\w./:-]+)[\\"'`]*\s+(?:was\s+)?(?:not found|does not exist|doesn't exist|is not available|unknown)/i
/** Same idea, but for backends that omit the model name entirely. */
const MODEL_MISSING_LOOSE_RE = /\b(?:model_not_found|no such model|unknown model)\b/i

/**
 * Cloudflare returns 520–530 at the EDGE when it cannot reach the tunnel origin;
 * 502 is the same story from a plain gateway. 504 is deliberately NOT here — a
 * gateway *timeout* means the origin was reached but did not answer in time,
 * which points the operator at an overloaded box rather than a dead one.
 *
 * 524 is excluded for the same reason. Cloudflare cuts the origin connection at
 * a hard **125 seconds** and returns 524 "a timeout occurred" — the tunnel is
 * healthy and the box is answering, it just did not finish in time. Filing that
 * as "offline" would send someone to switch on a machine that is already running.
 *
 * [VERIFIED 2026-08-10, three measurements against ai.example.com:
 *  a 120.6s parse SUCCEEDED (parse_logs, fallback_used=false); a 125s extraction
 *  returned `error code: 524`; and a deliberately long STREAMED generation also
 *  died at exactly 125s with 16 bytes returned. Streaming does not defeat it, so
 *  this is a wall on total request duration, not an idle-origin timeout.]
 */
function isOriginUnreachableStatus(status: number): boolean {
  if (status === 524) return false
  return status === 502 || (status >= 520 && status <= 530)
}

function statusOf(e: unknown): number | null {
  if (typeof e !== 'object' || e === null) return null
  const anyE = e as Record<string, unknown>
  for (const k of ['statusCode', 'status', 'responseStatus']) {
    const v = anyE[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return null
}

function textOf(e: unknown): string {
  if (e === null || e === undefined) return ''
  if (typeof e === 'string') return e
  if (typeof e !== 'object') return String(e)
  const anyE = e as Record<string, unknown>
  const parts: string[] = []
  for (const k of ['message', 'responseBody', 'body', 'detail', 'cause', 'name']) {
    const v = anyE[k]
    if (typeof v === 'string') parts.push(v)
    else if (v && typeof v === 'object' && 'message' in v) {
      const m = (v as Record<string, unknown>).message
      if (typeof m === 'string') parts.push(m)
    }
  }
  return parts.join(' | ')
}

/**
 * Classify any thrown value from an AI call (our own fetch wrapper, the AI SDK's
 * APICallError, or a bare Error) into an actionable kind.
 *
 * Order matters: a missing model is checked BEFORE the transport buckets,
 * because a 404-carrying "model not found" is a reachable backend telling us
 * something specific — treating it as "offline" would send the operator to
 * check the wrong thing.
 */
export function classifyAiError(e: unknown): AiFailure {
  const text = textOf(e)
  const status = statusOf(e)

  const named = MODEL_MISSING_RE.exec(text)
  if (named) return { kind: 'model_missing', model: named[1] }
  if (MODEL_MISSING_LOOSE_RE.test(text)) return { kind: 'model_missing' }

  // A structured status beats prose. Without this, a 502 whose body happens to
  // read "gateway timeout" would be filed as an overload rather than an
  // unreachable origin, and the operator would go look at the wrong thing.
  if (status === 504 || status === 524) return { kind: 'timeout' }
  if (status !== null && isOriginUnreachableStatus(status)) return { kind: 'offline' }

  if (/\b(timed out|timeout|AbortError|ETIMEDOUT)\b/i.test(text)) return { kind: 'timeout' }

  if (text.includes(UNREACHABLE_MARKER)) return { kind: 'offline' }
  if (/\b(ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|fetch failed|network error)\b/i.test(text)) {
    return { kind: 'offline' }
  }
  // Cloudflare's status embedded in a message string, e.g. `local-llm 530:
  // <!doctype html>…` from our own fetch wrapper.
  const embedded = /\b(?:llm|http|status)\D{0,3}(5\d{2})\b/i.exec(text)
  if (embedded) {
    const code = Number(embedded[1])
    if (code === 524 || code === 504) return { kind: 'timeout' }
    if (isOriginUnreachableStatus(code)) return { kind: 'offline' }
  }

  return { kind: 'unknown' }
}

/**
 * Operator-facing sentence for a failure. Always states (a) what happened in
 * plain words, (b) that nothing was saved, and (c) the next action. No status
 * codes, no stack traces, no provider jargon.
 */
export function aiFailureMessage(f: AiFailure, opts: { action?: string } = {}): string {
  const action = opts.action ?? 'This was not saved.'
  switch (f.kind) {
    // Kept comfortably under humanError()'s 200-char "is this a real sentence"
    // gate, or the message gets swallowed and replaced by a generic apology.
    case 'model_missing':
      return `The office AI server is missing the model it needs${
        f.model ? ` (${f.model})` : ''
      }. ${action} Ask your admin to install it on the office computer.`
    case 'offline':
      return `The office AI server is offline, so nothing could be read from this document. ${action} Try again once it is back on.`
    case 'timeout':
      return `The office AI server took too long to respond. ${action} Try again. If it keeps happening the office computer is likely overloaded.`
    default:
      return `The AI could not read this document. ${action} Try again, or enter the details by hand.`
  }
}

/** HTTP status to return for a given failure — always a 5xx "not your fault". */
export function aiFailureStatus(f: AiFailure): number {
  return f.kind === 'timeout' ? 504 : 503
}

/**
 * Classify an `aiExtract()` / `aiExtractFromImage()` result.
 *
 * Returns a failure ONLY when the AI call itself failed in a way the operator
 * can act on. A reachable model that merely returned unparseable JSON is a
 * different animal — that keeps the existing best-effort regex merge plus the
 * "parsed via fallback" warning, because the document *was* read.
 *
 * The provider check is load-bearing: `rawResponse` holds the thrown error's
 * message only on the `regex-fallback` branch. On the unparseable-output branch
 * it holds the MODEL'S OWN TEXT, which could coincidentally contain a phrase
 * like "model not found" and would then be misread as an ops failure.
 */
export function classifyExtractFailure(result: {
  provider?: string
  rawResponse?: string | null
  fallbackUsed?: boolean
}): AiFailure | null {
  if (!result.fallbackUsed) return null
  if (result.provider !== 'regex-fallback') return null
  const f = classifyAiError(result.rawResponse ?? '')
  return f.kind === 'unknown' ? null : f
}
