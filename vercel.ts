import { type VercelConfig } from '@vercel/config/v1'

/**
 * Vercel project configuration for Lender Index.
 *
 * Replaces a hand-edited vercel.json so we can read env at config time
 * and keep this file under code review with the rest of the repo.
 *
 * AI Gateway env keys (LLM_MODEL / LLM_VISION_MODEL / EMBED_MODEL) are
 * managed via `vercel env add` per environment and consumed by
 * `src/lib/llm/client.ts`. To run AI on a self-hosted box instead, the same
 * keys are pointed at a local OpenAI-compatible endpoint and the rest of
 * the codebase stays unchanged.
 */
export const config: VercelConfig = {
  framework: 'nextjs',
  buildCommand: 'pnpm build',
  installCommand: 'pnpm install --no-frozen-lockfile',
  crons: [
    // Schedules are UTC. Shift them to suit your time zone.
    { path: '/api/cron/outreach', schedule: '0 13 * * *' },
    // Daily AI health check. It returns 503 when the AI backend is
    // down or the text model is missing, so a bad day shows up as a FAILED cron
    // run in Vercel instead of being discovered by a user.
    //
    // Daily is the Hobby-plan ceiling. Keeping a self-hosted model warm (as
    // opposed to detecting that it is down) needs a ~5-minute cadence, which
    // means a scheduler on the AI host itself or a paid Vercel plan.
    { path: '/api/cron/warmup', schedule: '0 12 * * *' },
    // Nightly logical backup. It runs here rather than on a self-hosted
    // machine so the one job that protects the data does not depend on a box
    // that can sleep or go unreachable. Reading the rows is also DB activity,
    // which keeps an idle Supabase project from being paused.
    { path: '/api/cron/backup', schedule: '0 7 * * *' },
  ],
}
