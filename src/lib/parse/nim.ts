/**
 * NIM (NVIDIA Inference Microservices) client wrapper.
 *
 * Why NIM: an OpenAI-compatible hosted endpoint with a free tier, used only
 * when AI_PRIVACY_MODE=relaxed. Strict mode never calls it.
 *
 * Closed-loop note: every call returns the model/provider used so we can
 * log it for later eval and prompt iteration.
 */

const NIM_BASE = 'https://integrate.api.nvidia.com/v1'

export type NimMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | {
      role: 'user'
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      >
    }

export type NimChatResult = {
  text: string
  model: string
  provider: 'nvidia-nim'
  promptTokens: number
  completionTokens: number
  latencyMs: number
}

type NimChatOptions = {
  messages: NimMessage[]
  model?: string
  temperature?: number
  maxTokens?: number
  jsonMode?: boolean
}

export async function nimChat(opts: NimChatOptions): Promise<NimChatResult> {
  const key = process.env.NVIDIA_API_KEY
  if (!key) throw new Error('NVIDIA_API_KEY not set')

  const model = opts.model ?? process.env.NIM_TEXT_MODEL ?? 'meta/llama-3.3-70b-instruct'
  const t0 = Date.now()

  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 1024,
  }
  if (opts.jsonMode) {
    body.response_format = { type: 'json_object' }
  }

  const res = await fetch(`${NIM_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`NIM ${res.status}: ${text.slice(0, 500)}`)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await res.json()
  return {
    text: data.choices?.[0]?.message?.content ?? '',
    model,
    provider: 'nvidia-nim',
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
    latencyMs: Date.now() - t0,
  }
}
