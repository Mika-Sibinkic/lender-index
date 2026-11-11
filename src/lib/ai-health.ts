/**
 * Self-hosted AI liveness probe (Ollama / NIM-self-hosted / vLLM behind
 * OPENAI_COMPAT_BASE_URL). Used by /api/health, uptime checks, and the UI
 * "search degraded" banner. NEVER throws — reports 'down', never a 500.
 *
 * WHAT COUNTS AS UP:
 *   - 2xx from the model-list endpoint (backend answered), OR
 *   - 401 / 403 (a reachable but bearer-gated backend — the box is up).
 *
 * WHAT COUNTS AS DOWN (the bug this fixes):
 *   - A network-level failure (DNS / refused / timeout) — fetch throws, OR
 *   - Any 5xx. When the model host sits behind a reverse proxy or tunnel and
 *     the origin is unreachable, the proxy itself answers (502/503/504, or 530
 *     on some tunnels) — so `fetch` resolves (it does not throw) and a naive
 *     probe reports 'up' while the AI is actually offline. Those codes are the
 *     proxy saying "origin down", not the backend answering, so they count as
 *     down. Otherwise an outage shows `ai:"up"` and drops users into a silent
 *     regex fallback with no "degraded" banner.
 */

export type AiStatus = 'up' | 'down' | 'degraded' | 'unconfigured'

const PROBE_TIMEOUT_MS = 3_000
// Embed can be slower than a model-list, especially on a cold (just-loaded) model.
const EMBED_PROBE_TIMEOUT_MS = 12_000

export async function probeAi(
  opts: { base?: string; fetchImpl?: typeof fetch } = {},
): Promise<AiStatus> {
  const base = (opts.base ?? process.env.OPENAI_COMPAT_BASE_URL)?.replace(/\/$/, '')
  if (!base) return 'unconfigured'

  const doFetch = opts.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await doFetch(`${base}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${process.env.OPENAI_COMPAT_API_KEY ?? 'not-needed'}` },
      signal: controller.signal,
      cache: 'no-store',
    })
    // The edge answered. 2xx = healthy; 401/403 = reachable-but-gated (up).
    // Everything else — 5xx, and Cloudflare's 530 origin-unreachable in
    // particular — means the AI backend is not actually serving → down.
    if (res.ok || res.status === 401 || res.status === 403) return 'up'
    return 'down'
  } catch {
    // AbortError (timeout) or any network-level failure → unreachable.
    return 'down'
  } finally {
    clearTimeout(timer)
  }
}

/**
 * EMBED-capability probe — the status search actually depends on. `probeAi`
 * only checks that the backend is *reachable* (Ollama lists models even when
 * the embed model is evicted), which is why health could read "up" while
 * search embed calls failed (a real outage). This does a real, tiny embed:
 *   - a valid vector back  → 'up'
 *   - reachable but no/empty vector (model not loaded, 4xx) → 'degraded'
 *   - 5xx / Cloudflare 530 / network failure → 'down'
 * Side benefit: a real embed KEEPS THE MODEL WARM — call it on a cron to stop
 * Ollama evicting the embed model between searches.
 */
export async function probeEmbed(
  opts: { base?: string; fetchImpl?: typeof fetch } = {},
): Promise<AiStatus> {
  return (await probeEmbedDetailed(opts)).status
}

/**
 * Same probe, but says WHY.
 *
 * `probeEmbed` collapses every failure into 'down', which is exactly the shape
 * of problem this codebase keeps getting bitten by: on 2026-08-07 the box came
 * back, the tunnel answered, the model list read fine — and the embed returned
 * 'down' in 0.45s with no way to tell from outside whether that was a 500, a
 * refused connection, or a timeout. Diagnosing it cost a round-trip to someone
 * standing at the machine.
 *
 * `reason` is a coarse token (`http_500`, `timeout`, `unreachable`,
 * `empty_vector`) — enough to route the next action, with no internals leaked,
 * so it is safe on the public health endpoint.
 */
export type EmbedFailReason =
  | 'http_4xx'
  | 'http_5xx'
  | 'timeout'
  | 'unreachable'
  | 'empty_vector'
  | null

export async function probeEmbedDetailed(
  opts: { base?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ status: AiStatus; reason: EmbedFailReason; httpStatus?: number; dims?: number }> {
  const base = (opts.base ?? process.env.OPENAI_COMPAT_BASE_URL)?.replace(/\/$/, '')
  if (!base) return { status: 'unconfigured', reason: null }
  // openai-compat endpoints want the bare model name (strip any "provider/").
  const model = (process.env.EMBED_MODEL ?? 'nomic-embed-text').replace(/^[^/]+\//, '')

  const doFetch = opts.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), EMBED_PROBE_TIMEOUT_MS)
  try {
    const res = await doFetch(`${base}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_COMPAT_API_KEY ?? 'not-needed'}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, input: 'healthcheck' }),
      signal: controller.signal,
      cache: 'no-store',
    })
    if (res.ok) {
      const j = (await res.json().catch(() => null)) as
        | { data?: Array<{ embedding?: number[] }> }
        | null
      const dims = j?.data?.[0]?.embedding?.length ?? 0
      return dims > 0
        ? { status: 'up', reason: null, dims }
        : { status: 'degraded', reason: 'empty_vector', httpStatus: res.status, dims }
    }
    // 5xx (incl. Cloudflare 530 origin-down) = down; 4xx (model not loaded / bad
    // request) = reachable but the embed model isn't serving = degraded.
    return res.status >= 500
      ? { status: 'down', reason: 'http_5xx', httpStatus: res.status }
      : { status: 'degraded', reason: 'http_4xx', httpStatus: res.status }
  } catch {
    // Our own abort means the backend was reachable but too slow — a cold model
    // load, typically. A transport failure means nothing answered at all. Those
    // point at completely different fixes, so do not merge them.
    return {
      status: 'down',
      reason: controller.signal.aborted ? 'timeout' : 'unreachable',
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Are the models this deployment is CONFIGURED to use actually installed on the
 * backend?
 *
 * Without it, an `LLM_MODEL` that was never pulled onto the model host goes
 * unnoticed: the embed model is fine, so `/api/health` reads healthy while
 * every document parse and every Past Deals import fails with a 404.
 * Monitoring should catch this class, so health reports it.
 *
 * Returns which of the configured models are absent. Deliberately reports
 * ROLES ('text' | 'vision' | 'embed'), never the model names — /api/health is a
 * public, unauthenticated endpoint and internal config is nobody else's
 * business.
 */
export type ModelRole = 'text' | 'vision' | 'embed'

export async function probeModels(
  opts: { base?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ reachable: boolean; missing: ModelRole[] }> {
  const base = (opts.base ?? process.env.OPENAI_COMPAT_BASE_URL)?.replace(/\/$/, '')
  if (!base) return { reachable: false, missing: [] }

  // openai-compat endpoints want the bare tag (strip any "provider/" prefix).
  const bare = (v: string) => v.replace(/^[^/]+\//, '')

  // A vision model is only worth reporting when the image path would actually
  // call it. A small CPU-only host may deliberately have none, with image parse
  // going through OCR instead. Reporting that as a missing model is a permanent false alarm,
  // and a health signal that cries wolf is worse than no signal at all.
  // (Mirrors shouldPreferOcr() in parse/ocr.ts, inlined so the health route
  // doesn't pull tesseract.js into its bundle.)
  const visionUnused =
    process.env.PARSE_OCR_FIRST === 'true' || !process.env.LLM_VISION_MODEL?.trim()

  const configured: Array<[ModelRole, string | undefined]> = [
    ['text', process.env.LLM_MODEL],
    ['vision', visionUnused ? undefined : process.env.LLM_VISION_MODEL],
    ['embed', process.env.EMBED_MODEL],
  ]

  const doFetch = opts.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await doFetch(`${base}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${process.env.OPENAI_COMPAT_API_KEY ?? 'not-needed'}` },
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!res.ok) return { reachable: false, missing: [] }
    const j = (await res.json().catch(() => null)) as { data?: Array<{ id?: string }> } | null
    const installed = (j?.data ?? []).map((m) => bare(m.id ?? '')).filter(Boolean)
    if (installed.length === 0) return { reachable: true, missing: [] } // can't tell — don't cry wolf

    // Ollama reports tags as `name:tag`; a config of `qwen2.5:3b` must match
    // `qwen2.5:3b` exactly, but a config with no tag matches the `:latest` entry.
    const present = (want: string) =>
      installed.some((id) => id === want || (!want.includes(':') && id.split(':')[0] === want))

    const missing = configured
      .filter(([, want]) => !!want && !present(bare(want!)))
      .map(([role]) => role)
    return { reachable: true, missing }
  } catch {
    return { reachable: false, missing: [] }
  } finally {
    clearTimeout(timer)
  }
}
