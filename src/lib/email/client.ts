import { GraphEmailClient, type SendArgs, type SendResult } from './graph'

export type { SendArgs, SendResult }

export interface EmailClient {
  sendOnBehalf(args: SendArgs): Promise<SendResult>
}

/**
 * DRY-RUN backend — records the call shape and returns a synthetic id.
 * Used when OUTREACH_DRY_RUN=true and during unit tests so no Graph
 * traffic leaves the process.
 */
class DryRunEmailClient implements EmailClient {
  async sendOnBehalf(args: SendArgs): Promise<SendResult> {
    return { messageId: `dry-run-${Date.now()}` }
  }
}

export function getEmailClient(): EmailClient {
  const backend = process.env.EMAIL_BACKEND ?? 'graph'
  if (process.env.OUTREACH_DRY_RUN === 'true') return new DryRunEmailClient()
  switch (backend) {
    case 'graph':
      return new GraphEmailClient(async () => {
        // Prefer the OAuth refresh-token flow (set up via
        // /api/outreach/graph/install). Fall back to a manually-pasted
        // GRAPH_DELEGATED_TOKEN if AZURE_CLIENT_ID is not configured
        // (dev / break-glass).
        if (process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET) {
          const { getDelegatedToken } = await import('./graph-auth')
          return getDelegatedToken()
        }
        const tok = process.env.GRAPH_DELEGATED_TOKEN
        if (!tok) {
          throw new Error(
            'Graph auth not configured: set AZURE_CLIENT_ID + AZURE_CLIENT_SECRET (then visit /api/outreach/graph/install) or GRAPH_DELEGATED_TOKEN.',
          )
        }
        return tok
      })
    case 'dry-run':
      return new DryRunEmailClient()
    default:
      throw new Error(`Unknown EMAIL_BACKEND: ${backend}`)
  }
}
