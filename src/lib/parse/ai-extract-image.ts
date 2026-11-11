/**
 * Multimodal funding-source extractor.
 *
 * Strict (default, AI_PRIVACY_MODE=strict): hits the local Ollama vision
 * model via OPENAI_COMPAT_BASE_URL. No cloud egress.
 * Relaxed (AI_PRIVACY_MODE=relaxed): falls back to NIM-direct.
 *
 * For PDFs we extract the text layer server-side and route through the
 * text path — only image-only PDFs hit this code.
 */

import { nimChat, type NimMessage } from '@/lib/parse/nim'
import { localChatVision, isStrictPrivacyMode } from '@/lib/parse/local-extract'
import { aiExtract } from '@/lib/parse/ai-extract'
import type { AiParseResult } from '@/lib/parse/ai-extract'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ASSET_CLASS_IDS, DOMAIN_DESCRIPTION } from '@/lib/config/domain'

const SYSTEM_PROMPT = `You extract structured funding-source records from images (business cards, term sheets, brochures, conference handouts) for a ${DOMAIN_DESCRIPTION} brokerage.

The image may be in any language — cards collected at international conferences are often Portuguese, Spanish, French or German. Translate values to English where helpful but keep proper nouns (company / person names) verbatim, accents included.

Return ONLY a JSON object with these fields. No markdown fences. Use null for unknowns. Never invent.

{
  "company_name": string,
  "primary_contact_name": string | null,
  "primary_contact_title": string | null,
  "primary_contact_email": string | null,
  "primary_contact_phone": string | null,
  "primary_contact_calendar_link": string | null,
  "asset_classes": string[],            // subset of: ${ASSET_CLASS_IDS.join(', ')}
  "deal_size_min_usd": number | null,
  "deal_size_max_usd": number | null,
  "borrower_revenue_min_usd": number | null,
  "borrower_years_in_business_min": number | null,
  "borrower_capex_min_usd": number | null,
  "required_documents": string[],
  "geographic_scope": string[],
  "industry_filters": string[],
  "rate_notes": string | null,
  "internal_notes": string | null,      // include OCR of any handwritten notes
  "introduced_via": string | null,
  "introduced_date": string | null
}

Conversions:
- "$5M" or "$5MM" or "5 million" -> 5000000
- "$500k" -> 500000
- ranges split into min/max
- snake_case required_documents (e.g. "audited_financials_3yr")`

export async function aiExtractFromImage(
  imageDataUrl: string,
  optionalHint?: string,
  ctx?: { supabase: SupabaseClient; module?: string },
): Promise<AiParseResult> {
  const userPrompt =
    'Extract the funding-source record from this image. Return JSON only.' +
    (optionalHint ? `\n\nContext: ${optionalHint}` : '')

  const strict = isStrictPrivacyMode()
  const useLocal = strict && !!ctx?.supabase

  if (strict && !ctx?.supabase) {
    return {
      parsed: {},
      provider: 'privacy-blocked',
      model: 'none',
      rawResponse:
        'AI_PRIVACY_MODE=strict and no supabase ctx; refusing to call any vision provider',
      latencyMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      fallbackUsed: true,
    }
  }

  try {
    let r:
      | {
          text: string
          model: string
          provider: string
          latencyMs: number
          promptTokens: number
          completionTokens: number
        }
    if (useLocal) {
      r = await localChatVision({
        system: SYSTEM_PROMPT,
        user: userPrompt,
        imageDataUrl,
        supabase: ctx!.supabase,
        module: ctx?.module ?? 'parse.image.local',
      })
    } else {
      const model =
        process.env.NIM_VISION_MODEL ?? 'meta/llama-3.2-90b-vision-instruct'
      const messages: NimMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: userPrompt },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ],
        },
      ]
      r = await nimChat({ messages, model, jsonMode: true, temperature: 0.1 })
    }
    return await aiExtract(r.text, ctx)
  } catch (e) {
    return {
      parsed: {},
      provider: useLocal ? 'local-vision' : 'nvidia-nim-vision',
      model: 'unknown',
      rawResponse: e instanceof Error ? e.message : String(e),
      latencyMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      fallbackUsed: true,
    }
  }
}
