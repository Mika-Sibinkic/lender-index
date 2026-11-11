import { NextResponse } from 'next/server'
import { probeEmbedDetailed, probeModels } from '@/lib/ai-health'

// Public, unauthenticated health probe against the on-prem AI backend
// (local Ollama / NIM-self-hosted / vLLM behind OPENAI_COMPAT_BASE_URL).
// `ai` reports EMBED capability — the thing search actually depends on — not
// mere reachability, so it reads 'degraded' when the box answers but the embed
// model is evicted/down (the state that silently degrades search).
//
// `missingModels` closes the other half of that gap: embed can be perfectly
// healthy while the TEXT model this deployment is configured to use was never
// installed, which breaks every document parse and every Past Deals import.
// That has happened in production, and users found it before the operators did.
// Roles only ('text' | 'vision' | 'embed'), never model names — this endpoint is
// public and internal config stays internal.
//
// NEVER throws — a failure is reported as ai:'down', not a 500.

export const dynamic = 'force-dynamic'

export async function GET() {
  const [embed, models] = await Promise.all([probeEmbedDetailed(), probeModels()])
  return NextResponse.json({
    ok: true,
    ai: embed.status,
    // Coarse token only (http_5xx / timeout / unreachable / empty_vector) — enough
    // to route the next action without a trip to the machine, nothing leaked.
    reason: embed.reason,
    httpStatus: embed.httpStatus,
    dims: embed.dims,
    // Only meaningful when the backend answered; an offline box cannot tell us
    // what it has installed, and `ai` already reports that.
    missingModels: models.reachable ? models.missing : [],
    ts: new Date().toISOString(),
  })
}
