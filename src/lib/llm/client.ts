/**
 * Unified LLM client.
 *
 * All AI calls flow through this module so that:
 *   - costs are logged per-module / per-model (see ./cost.ts)
 *   - model selection is one env-var swap at deploy time
 *   - the same code paths run unchanged on a self-hosted on-prem box — pointing
 *     the OPENAI_COMPAT_BASE_URL at the on-prem OpenAI-compatible
 *     endpoint (NIM, vLLM, Ollama) requires no code changes.
 *
 * Two backends, selected at runtime:
 *   - `gateway` (default in cloud): plain "provider/model" strings
 *     routed through the Vercel AI Gateway. Uses AI_GATEWAY_API_KEY (or
 *     OIDC token); falls back to direct provider keys.
 *   - `openai-compat` (default on on-prem box / local Mac dev): any
 *     OpenAI-compatible endpoint — Ollama (http://localhost:11434/v1),
 *     NIM, vLLM, LM Studio, etc. Configured via OPENAI_COMPAT_BASE_URL.
 *
 * Backend is selected by LLM_BACKEND env var. If unset, defaults to
 * `openai-compat` when OPENAI_COMPAT_BASE_URL is set, otherwise
 * `gateway`. Embeddings follow the same resolver.
 */

import { generateText, generateObject, embed, embedMany } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logCost, estimateCostUsd } from './cost'

const TEXT_MODEL = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-4-6'
const VISION_MODEL = process.env.LLM_VISION_MODEL ?? 'anthropic/claude-sonnet-4-6'
const EMBED_MODEL = process.env.EMBED_MODEL ?? 'openai/text-embedding-3-small'
// Hard ceiling on a single embed call so a flaky on-prem endpoint degrades
// gracefully instead of hanging to the serverless function timeout.
const EMBED_TIMEOUT_MS = Number(process.env.EMBED_TIMEOUT_MS ?? 30000)

function resolveBackend(): 'gateway' | 'openai-compat' {
  const explicit = process.env.LLM_BACKEND
  if (explicit === 'gateway' || explicit === 'openai-compat') return explicit
  return process.env.OPENAI_COMPAT_BASE_URL ? 'openai-compat' : 'gateway'
}

let _localProvider: ReturnType<typeof createOpenAICompatible> | null = null
function localProvider() {
  if (_localProvider) return _localProvider
  const baseURL = process.env.OPENAI_COMPAT_BASE_URL
  if (!baseURL) throw new Error('OPENAI_COMPAT_BASE_URL is not set')
  _localProvider = createOpenAICompatible({
    name: 'local',
    baseURL,
    apiKey: process.env.OPENAI_COMPAT_API_KEY ?? 'not-needed',
    // Ollama constrains decoding to a JSON Schema when it's given one, but the
    // openai-compatible provider assumes an unknown endpoint can't and defaults
    // this to false. With it off, generateObject downgrades to asking the model
    // nicely for JSON — which a 3B model does not reliably do, so every
    // llm.object call died on "response did not match schema". That is the
    // reason Past Deals import never once succeeded (closed_deal held 0 rows on
    // 2026-08-10) while /api/health read "up": health only exercises the embed
    // hop, and embeddings don't use this path.
    // Verified against the box: response_format json_schema returns valid,
    // correctly-typed JSON. Override with LLM_STRUCTURED_OUTPUTS=false if a
    // future backend can't do it.
    supportsStructuredOutputs: process.env.LLM_STRUCTURED_OUTPUTS !== 'false',
  })
  return _localProvider
}

/** Resolve a model spec to an AI SDK `LanguageModel`. */
function resolveTextModel(modelSpec: string) {
  if (resolveBackend() === 'openai-compat') {
    return localProvider().chatModel(modelSpec)
  }
  return modelSpec
}

function resolveEmbedModel(modelSpec: string) {
  if (resolveBackend() === 'openai-compat') {
    return localProvider().textEmbeddingModel(modelSpec)
  }
  return modelSpec
}

export interface LlmCallContext {
  supabase: SupabaseClient
  module: string
}

export interface TextResult {
  text: string
  model: string
  latencyMs: number
}

export interface ObjectResult<T> {
  object: T
  model: string
  latencyMs: number
}

export interface EmbedResult {
  embeddings: number[][]
  model: string
  latencyMs: number
}

async function emitCost(
  ctx: LlmCallContext,
  model: string,
  inputTokens: number,
  outputTokens: number,
  latencyMs: number,
): Promise<void> {
  await logCost(ctx.supabase, {
    module: ctx.module,
    model,
    inputTokens,
    outputTokens,
    costUsd: estimateCostUsd(model, inputTokens, outputTokens),
    latencyMs,
  })
}

export const llm = {
  async text(opts: LlmCallContext & { prompt: string; system?: string }): Promise<TextResult> {
    const t0 = Date.now()
    const res = await generateText({
      model: resolveTextModel(TEXT_MODEL),
      prompt: opts.prompt,
      system: opts.system,
    })
    const latencyMs = Date.now() - t0
    await emitCost(opts, TEXT_MODEL, res.usage.inputTokens ?? 0, res.usage.outputTokens ?? 0, latencyMs)
    return { text: res.text, model: TEXT_MODEL, latencyMs }
  },

  async object<T>(
    opts: LlmCallContext & { schema: z.ZodType<T>; prompt: string; system?: string },
  ): Promise<ObjectResult<T>> {
    const t0 = Date.now()
    const res = await generateObject({
      model: resolveTextModel(TEXT_MODEL),
      schema: opts.schema,
      prompt: opts.prompt,
      system: opts.system,
    })
    const latencyMs = Date.now() - t0
    await emitCost(opts, TEXT_MODEL, res.usage.inputTokens ?? 0, res.usage.outputTokens ?? 0, latencyMs)
    return { object: res.object as T, model: TEXT_MODEL, latencyMs }
  },

  async vision<T>(
    opts: LlmCallContext & {
      schema: z.ZodType<T>
      prompt: string
      image: { url: string } | { base64: string; mediaType: string }
    },
  ): Promise<ObjectResult<T>> {
    const t0 = Date.now()
    const imagePart =
      'url' in opts.image
        ? { type: 'image' as const, image: new URL(opts.image.url) }
        : {
            type: 'image' as const,
            image: Buffer.from(opts.image.base64, 'base64'),
            mediaType: opts.image.mediaType,
          }
    const res = await generateObject({
      model: resolveTextModel(VISION_MODEL),
      schema: opts.schema,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: opts.prompt }, imagePart],
        },
      ],
    })
    const latencyMs = Date.now() - t0
    await emitCost(opts, VISION_MODEL, res.usage.inputTokens ?? 0, res.usage.outputTokens ?? 0, latencyMs)
    return { object: res.object as T, model: VISION_MODEL, latencyMs }
  },

  async embed(opts: LlmCallContext & { values: string[] }): Promise<EmbedResult> {
    const t0 = Date.now()
    // Fail-fast: a hanging on-prem endpoint must NOT stall the request to the
    // function timeout. On abort the caller (e.g. /api/search) degrades to
    // keyword + graph instead of returning a 504.
    const signal = AbortSignal.timeout(EMBED_TIMEOUT_MS)
    if (opts.values.length === 1) {
      const res = await embed({ model: resolveEmbedModel(EMBED_MODEL), value: opts.values[0], abortSignal: signal, maxRetries: 1 })
      const latencyMs = Date.now() - t0
      await emitCost(opts, EMBED_MODEL, res.usage.tokens ?? 0, 0, latencyMs)
      return { embeddings: [res.embedding], model: EMBED_MODEL, latencyMs }
    }
    const res = await embedMany({ model: resolveEmbedModel(EMBED_MODEL), values: opts.values, abortSignal: signal, maxRetries: 1 })
    const latencyMs = Date.now() - t0
    await emitCost(opts, EMBED_MODEL, res.usage.tokens ?? 0, 0, latencyMs)
    return { embeddings: res.embeddings, model: EMBED_MODEL, latencyMs }
  },
}

export const LLM_MODELS = {
  text: TEXT_MODEL,
  vision: VISION_MODEL,
  embed: EMBED_MODEL,
}

export const LLM_BACKEND = resolveBackend()
