import { z } from 'zod'
import { ORG_NAME, PRINCIPAL_NAME } from '@/lib/config/org'

export const PROMPT_VERSION = 'v0-2026-05-16'

export const draftSchema = z.object({
  subject: z.string().min(3).max(120),
  questions: z.array(z.string().min(3)).min(1).max(3),
  body_text: z.string().min(20),
  body_html: z.string().min(20),
})

export type Draft = z.infer<typeof draftSchema>

/**
 * The outreach system prompt — v0, hand-written (no corpus retrieval yet).
 * Signed by PRINCIPAL_NAME (env), falling back to ORG_NAME.
 */
export const SYSTEM_PROMPT = `You are drafting a short outreach email from ${PRINCIPAL_NAME} at ${ORG_NAME}
to a lender contact, to update ${ORG_NAME}'s records on the lender's current
appetite, rates, and terms.

VOICE
- Warm, direct and conversational. Address the contact by first name if you have it.
- No bullet lists in the body; humans don't format a short check-in that way.
- No marketing tone. No salesy phrasing. No "I hope this finds you well."

HARD RULES
- Never sign or identify as an AI, bot, or automated assistant.
- At most 3 questions in the body. Combine multiple gaps into 3 short
  questions, not 3 sub-bullets.
- Subject line ≤ 8 words.
- Close with "Thanks, ${PRINCIPAL_NAME}" on a single line.
- Body length: 4–8 sentences. Tight.
- Reference the lender by their company / first-name only if you have it.
- If the lender's last interaction was specific (a deal, a quote), pull
  it in naturally — otherwise just ask the check-in.

OUTPUT
Return a JSON object with:
  subject     — the email subject line
  questions   — array of ≤ 3 plain-text questions covering all the gaps
  body_text   — plain-text body, no HTML
  body_html   — same body wrapped in minimal <p>…</p> tags, no CSS
`

export interface DraftInput {
  lender: {
    name: string
    contact_name?: string | null
    contact_email: string
    last_contact_at?: string | null
    notes?: string | null
  }
  missing_fields: string[]
  recent_interaction?: string | null
}

export function renderDraftPrompt(input: DraftInput): string {
  const last = input.lender.last_contact_at
    ? `Last contact: ${input.lender.last_contact_at}`
    : 'No recorded last contact.'
  const contact = input.lender.contact_name
    ? `Contact: ${input.lender.contact_name} <${input.lender.contact_email}>`
    : `Contact email: ${input.lender.contact_email}`
  const lines = [
    `Lender: ${input.lender.name}`,
    contact,
    last,
    input.lender.notes ? `Notes: ${input.lender.notes}` : null,
    input.recent_interaction
      ? `Recent interaction context: ${input.recent_interaction}`
      : null,
    '',
    `Information we need to refresh (turn into ≤3 questions):`,
    ...input.missing_fields.map((f) => `- ${f}`),
  ].filter(Boolean)
  return lines.join('\n')
}
