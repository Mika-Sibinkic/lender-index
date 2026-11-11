/**
 * Maps an HTTP status (and an optional raw server error) to a short, plain
 * sentence safe to surface in a toast. Keeps "HTTP 413" / raw JSON blobs out
 * of the operator's face while preserving a genuinely useful server message
 * when the backend bothered to send a human one.
 *
 * Usage:
 *   toast.error(humanError(res.status, json?.error))
 */

const STATUS_MESSAGES: Record<number, string> = {
  400: 'That request was not valid. Check the fields and try again.',
  401: 'Your session expired. Sign in again.',
  403: 'You do not have permission for that.',
  404: 'We could not find that.',
  408: 'The request timed out. Please retry.',
  409: 'That conflicts with something that already exists.',
  413: 'File is too large.',
  415: 'That file type is not supported.',
  422: 'We could not read that file. Try a clearer copy.',
  429: 'Too many requests. Wait a moment and retry.',
  502: 'A service we depend on is unreachable. Please retry.',
  503: 'That service is temporarily unavailable. Please retry.',
  504: 'That took too long and timed out. Please retry.',
}

/**
 * 5xx statuses where the server DELIBERATELY authors an operator-facing
 * sentence (AI offline, model not installed, upstream timeout). Those are
 * written by us, contain no payload, and are the whole point of the response —
 * so they pass through instead of being replaced by the generic apology.
 * Plain 500s stay opaque: an unhandled exception's message is not for users.
 */
const AUTHORED_5XX = new Set([502, 503, 504])

const SERVER_FALLBACK = 'Something went wrong on our end. Please retry.'

/**
 * Returns true when `msg` looks like a clean, human-readable sentence worth
 * showing — not a code, a token, a stack trace, JSON, or a bare "HTTP 500".
 */
function isHumanMessage(msg: string): boolean {
  const t = msg.trim()
  if (!t || t.length > 200) return false
  if (/^https?:\/\//i.test(t)) return false // a URL
  if (/^[[{]/.test(t)) return false // JSON-ish
  if (/^HTTP\s+\d/i.test(t)) return false // "HTTP 500"
  if (/^\d+$/.test(t)) return false // a bare number
  if (/\b(stack|trace|errno|ECONN|TypeError|undefined is not)\b/i.test(t)) return false
  return /[a-z]/i.test(t)
}

/**
 * @param status   HTTP status code from the response.
 * @param rawError Optional `error` field the server returned (string or any).
 * @returns        A plain, operator-facing sentence.
 */
export function humanError(status: number, rawError?: unknown): string {
  // Prefer a genuinely human server message for client (4xx) errors — the
  // backend often knows the specific reason ("file too large (max 25MB)").
  if (status >= 400 && status < 500 && typeof rawError === 'string' && isHumanMessage(rawError)) {
    return rawError
  }

  // Server-authored 5xx explanations (AI offline / model not installed / upstream
  // timeout). Without this the carefully-worded 503 body was thrown away and the
  // operator saw "Something went wrong on our end" — which is exactly what users
  // hit on the Past Deals import, with no way to know the fix was `ollama pull`.
  if (AUTHORED_5XX.has(status) && typeof rawError === 'string' && isHumanMessage(rawError)) {
    return rawError
  }

  const mapped = STATUS_MESSAGES[status]
  if (mapped) return mapped

  // 5xx and anything unmapped: never leak the raw payload.
  if (status >= 500) return SERVER_FALLBACK
  return 'Something went wrong. Please try again.'
}
