/**
 * 100%-local LLM extractor for funding-source records.
 *
 * Hits the OPENAI_COMPAT_BASE_URL chat-completions endpoint directly
 * (Ollama on a dev machine, or a self-hosted box). No cloud egress — the
 * funding-source corpus is the firm's most private asset and must never
 * leave a machine it controls.
 *
 * Strict mode (AI_PRIVACY_MODE=strict, default): only this path runs.
 * Relaxed mode (AI_PRIVACY_MODE=relaxed): callers may fall back to the
 * legacy NIM-direct path in nim.ts.
 *
 * Cost-logs every call into cost_log under module='parse.text.local' or
 * 'parse.image.local' so usage stays auditable.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logCost, estimateCostUsd } from '@/lib/llm/cost'

/** Local text model when LLM_MODEL is unset. Matches .env.local.example. */
export const DEFAULT_LOCAL_LLM_MODEL = 'qwen2.5:7b-instruct'

export interface LocalChatResult {
  text: string
  model: string
  provider: 'local-openai-compat'
  promptTokens: number
  completionTokens: number
  latencyMs: number
}

/**
 * Timeout for the on-prem AI hop.
 *
 * Was 45s, which is less time than a small CPU-only host needs: a business-card
 * extraction on a 3b model can exceed it and return a 504 while the model is
 * healthy and working — we just hung up on it mid-answer.
 *
 * The accuracy mandate is explicit that on the extraction path we "raise
 * timeouts, don't truncate": a slow correct record beats a fast empty one. So
 * this now sits just under the 180s function ceiling of the routes that call it
 * (/api/parse, /api/parse/file, /api/closed-deals), leaving headroom for the
 * response to serialise.
 *
 * An unreachable host still fails in milliseconds — that path throws at the
 * socket, it does not wait for this timeout. This budget only applies when the
 * backend has accepted the request and is genuinely working.
 */
const LOCAL_CHAT_TIMEOUT_MS = Number(process.env.LOCAL_CHAT_TIMEOUT_MS ?? 150_000)

// Stable marker stamped onto the thrown Error.message when the failure is a
// network-level one (DNS / connection-refused / TLS / timeout-abort) — i.e. the
// AI backend is unreachable, as opposed to reachable-but-returning-an-HTTP-error.
// aiExtract / aiExtractFromImage catch the throw and pass message through as
// rawResponse with fallbackUsed=true; the parse routes grep for this marker to
// return HTTP 503 ("AI offline") rather than a misleading regex-only 200.
export const BACKEND_UNREACHABLE_MARKER = 'AI_BACKEND_UNREACHABLE'

/** True when an extract result's rawResponse signals an unreachable AI backend. */
export function isBackendUnreachable(rawResponse: string | undefined | null): boolean {
  return typeof rawResponse === 'string' && rawResponse.includes(BACKEND_UNREACHABLE_MARKER)
}

/**
 * HTTP statuses that mean the tunnel ORIGIN (the on-prem box) is unreachable rather
 * than a reachable backend returning an error. Cloudflare returns 530 (and the
 * 520–527 family) at the EDGE when it can't reach the tunnel origin, and 502/504
 * are gateway "couldn't reach upstream" errors. These get the unreachable marker
 * so the parse routes surface "AI offline — retry" instead of silently degrading
 * to regex. A reachable-but-erroring backend (500 internal, 503 busy, 4xx) is
 * deliberately NOT flagged — those stay on the best-effort path.
 */
export function isOriginUnreachableStatus(status: number): boolean {
  return status === 502 || status === 504 || (status >= 520 && status <= 530)
}

interface TextPart { type: 'text'; text: string }
interface ImagePart { type: 'image_url'; image_url: { url: string } }
type UserContent = string | Array<TextPart | ImagePart>

interface ChatMessage {
  role: 'system' | 'user'
  content: UserContent
}

function baseUrl(): string {
  const u = process.env.OPENAI_COMPAT_BASE_URL
  if (!u) throw new Error('OPENAI_COMPAT_BASE_URL is not set')
  return u.replace(/\/$/, '')
}

function apiKey(): string {
  return process.env.OPENAI_COMPAT_API_KEY ?? 'not-needed'
}

async function localChat(
  messages: ChatMessage[],
  opts: { model: string; jsonMode: boolean; supabase: SupabaseClient; module: string },
): Promise<LocalChatResult> {
  const t0 = Date.now()
  const body: Record<string, unknown> = {
    model: opts.model,
    messages,
    temperature: 0.1,
    max_tokens: 1024,
  }
  if (opts.jsonMode) body.response_format = { type: 'json_object' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LOCAL_CHAT_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(`${baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (e) {
    // Network-level failure (DNS, connection refused, TLS) or our own abort on
    // timeout — the backend never answered. Tag it so the route layer can return
    // a 503 instead of hanging or silently degrading to regex-only output.
    const cause = e instanceof Error ? e.message : String(e)
    const reason = controller.signal.aborted
      ? `timed out after ${LOCAL_CHAT_TIMEOUT_MS}ms`
      : cause
    throw new Error(`${BACKEND_UNREACHABLE_MARKER}: local-llm unreachable (${reason})`)
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    // A Cloudflare 530 / gateway 5xx means the tunnel origin (on-prem box) is
    // unreachable — tag it so the route returns "AI offline, retry" instead of
    // silently degrading to regex. Reachable-but-erroring codes fall through.
    const prefix = isOriginUnreachableStatus(res.status) ? `${BACKEND_UNREACHABLE_MARKER}: ` : ''
    throw new Error(`${prefix}local-llm ${res.status}: ${detail.slice(0, 500)}`)
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const latencyMs = Date.now() - t0
  const text = data.choices?.[0]?.message?.content ?? ''
  const promptTokens = data.usage?.prompt_tokens ?? 0
  const completionTokens = data.usage?.completion_tokens ?? 0

  await logCost(opts.supabase, {
    module: opts.module,
    model: opts.model,
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    costUsd: estimateCostUsd(opts.model, promptTokens, completionTokens),
    latencyMs,
  })

  return {
    text,
    model: opts.model,
    provider: 'local-openai-compat',
    promptTokens,
    completionTokens,
    latencyMs,
  }
}

export async function localChatText(
  args: { system: string; user: string; supabase: SupabaseClient; module: string },
): Promise<LocalChatResult> {
  const model = process.env.LLM_MODEL ?? DEFAULT_LOCAL_LLM_MODEL
  return localChat(
    [
      { role: 'system', content: args.system },
      { role: 'user', content: args.user },
    ],
    { model, jsonMode: true, supabase: args.supabase, module: args.module },
  )
}

export async function localChatVision(
  args: { system: string; user: string; imageDataUrl: string; supabase: SupabaseClient; module: string },
): Promise<LocalChatResult> {
  const model = process.env.LLM_VISION_MODEL ?? 'llama3.2-vision:11b'
  return localChat(
    [
      { role: 'system', content: args.system },
      {
        role: 'user',
        content: [
          { type: 'text', text: args.user },
          { type: 'image_url', image_url: { url: args.imageDataUrl } },
        ],
      },
    ],
    { model, jsonMode: true, supabase: args.supabase, module: args.module },
  )
}

export function isStrictPrivacyMode(): boolean {
  return (process.env.AI_PRIVACY_MODE ?? 'strict') !== 'relaxed'
}
