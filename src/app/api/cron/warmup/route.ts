import { NextRequest, NextResponse } from 'next/server'
import { probeEmbed, probeModels } from '@/lib/ai-health'
import { SYSTEM_PROMPT } from '@/lib/parse/ai-extract'
import { DEFAULT_LOCAL_LLM_MODEL } from '@/lib/parse/local-extract'

export const dynamic = 'force-dynamic'
// 120s, not 30s: priming the extraction prefix is a real generation, and on a
// small CPU-only host a cold model can take most of that. At 30s the function
// is killed mid-prime, so the cache never populates and the warmup buys
// nothing for the path that needs it most.
export const maxDuration = 120

/**
 * Warmup cron — keeps the on-prem embed model loaded so a search never hits a
 * cold (evicted) model and silently degrades. Vercel signs cron calls with a
 * Bearer = CRON_SECRET; we also accept x-cron-secret for manual smokes.
 *
 * This is belt-and-suspenders: the load-bearing fix is box-side
 * (`OLLAMA_KEEP_ALIVE=-1` so the model never evicts).
 * If the model does evict (restart / OOM), this reloads it within the cron
 * interval instead of on a user's next search.
 */
function authorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  if (req.headers.get('authorization') === `Bearer ${expected}`) return true
  if (req.headers.get('x-cron-secret') === expected) return true
  return false
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const ai = await probeEmbed() // a real embed → warms the model + reports status
  const models = await probeModels()

  // Does STRUCTURED EXTRACTION still work? Nothing else asks.
  //
  // /api/health reads the embed hop, and embeddings do not touch this path — so
  // it reported {"ai":"up"} for months while every llm.object call was failing
  // and Past Deals import had never once succeeded. Two separate causes, both
  // invisible: `supportsStructuredOutputs` defaulting to false, and a `.regex()`
  // in a schema crashing Ollama's grammar compiler. A green check that cannot
  // see the thing that broke is not a check.
  const extract = ai === 'up' ? await probeStructuredExtraction() : null
  const healthy =
    ai === 'up' && !models.missing.includes('text') && extract?.ok !== false

  // Prime the extraction prompt's KV cache, not just the model weights.
  //
  // On a small self-hosted model a parse runs much faster right after a prime,
  // because Ollama reuses the cached prefix when the system prompt is
  // byte-identical. A cold parse can approach a reverse proxy's ~120s request
  // timeout, so the first parse after a model load is the one that times out.
  //
  // Sending "hi" (the old behaviour) loads the weights but leaves our actual
  // prefix uncached, so it bought nothing for the path that needed it. This
  // sends the real SYSTEM_PROMPT and asks for a single token.
  const primed = healthy ? await primeExtractionPrefix() : null

  // Fail LOUD when it isn't healthy. This used to answer 200 with `ai:"down"`
  // in the body, which is a silent failure by another name: a green cron run
  // with the bad news buried in JSON nobody reads. A non-2xx makes the run show
  // up as failed in Vercel, so an outage surfaces here rather than being
  // discovered by users days later.
  return NextResponse.json(
    {
      ok: healthy,
      ai,
      missingModels: models.reachable ? models.missing : [],
      extract,
      primedMs: primed,
      ts: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503 },
  )
}

/**
 * A minimal schema-constrained generation — the smallest thing that exercises
 * the same machinery `/api/parse` and the Past Deals importer depend on.
 *
 * Fails OPEN on a transport error and CLOSED on a schema rejection. That split
 * is deliberate: a timeout or a 5xx means the model host is slow or asleep,
 * which the embed probe and the cron's own status already say, and turning it
 * into a red cron every slow morning would train everyone to ignore the signal.
 * A schema rejection means something else — decoding is no longer constrained,
 * or the grammar compiler choked — and that is the exact failure that hid for
 * months. The schema deliberately carries no `.regex()`, `.email()` or `.url()`:
 * Ollama mistranslates patterns into GBNF and the model runner dies.
 */
async function probeStructuredExtraction(): Promise<{
  ok: boolean
  reason: string | null
  latencyMs: number | null
}> {
  const t0 = Date.now()
  try {
    const { llm } = await import('@/lib/llm/client')
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    const { z } = await import('zod')
    const res = await llm.object({
      supabase: getSupabaseAdmin(),
      module: 'health',
      schema: z.object({ company: z.string(), year: z.number().int() }),
      prompt: 'Extract the company and the year: "Acme Equipment Finance, founded 1998."',
    })
    const ok = typeof res.object?.company === 'string'
    return { ok, reason: ok ? null : 'empty_object', latencyMs: Date.now() - t0 }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // Transport / capacity → fail open. Schema or grammar → fail closed.
    const transport = /timeout|abort|fetch failed|ECONN|network|5\d\d|524|530/i.test(msg)
    return {
      ok: transport,
      reason: transport ? `transport: ${msg.slice(0, 120)}` : `schema: ${msg.slice(0, 160)}`,
      latencyMs: Date.now() - t0,
    }
  }
}

/**
 * One near-zero-output generation carrying the real extraction system prompt, so
 * Ollama holds its KV cache. Returns elapsed ms, or null if it failed — a failed
 * prime is not worth failing the cron over, it just means the next parse is cold.
 */
async function primeExtractionPrefix(): Promise<number | null> {
  const base = process.env.OPENAI_COMPAT_BASE_URL
  if (!base) return null
  const t0 = Date.now()
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_COMPAT_API_KEY ?? 'not-needed'}`,
      },
      body: JSON.stringify({
        model: process.env.LLM_MODEL || DEFAULT_LOCAL_LLM_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: 'warmup' },
        ],
        max_tokens: 1,
        temperature: 0,
        keep_alive: -1,
      }),
      signal: AbortSignal.timeout(110_000),
    })
    if (!res.ok) return null
    await res.text()
    return Date.now() - t0
  } catch {
    return null
  }
}
