import type { SupabaseClient } from '@supabase/supabase-js'

export interface CostEntry {
  module: string
  model: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  latencyMs: number
}

export async function logCost(supabase: SupabaseClient, entry: CostEntry): Promise<void> {
  const { error } = await supabase.from('cost_log').insert({
    operation_type: entry.module,
    module: entry.module,
    model: entry.model,
    input_tokens: entry.inputTokens,
    output_tokens: entry.outputTokens,
    cost_usd_equivalent: entry.costUsd,
    latency_ms: entry.latencyMs,
  })
  if (error) console.warn('cost_log insert failed:', error.message)
}

const COST_PER_1K: Record<string, { input: number; output: number }> = {
  'anthropic/claude-sonnet-4-6': { input: 0.003, output: 0.015 },
  'anthropic/claude-opus-4-7': { input: 0.015, output: 0.075 },
  'anthropic/claude-haiku-4-5-20251001': { input: 0.0005, output: 0.0025 },
  'openai/text-embedding-3-small': { input: 0.00002, output: 0 },
  'nvidia/nv-embed-v2': { input: 0.0001, output: 0 },
  'meta/llama-3.3-70b-instruct': { input: 0.0008, output: 0.0008 },
}

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const rate = COST_PER_1K[model] ?? { input: 0, output: 0 }
  return (inputTokens / 1000) * rate.input + (outputTokens / 1000) * rate.output
}
