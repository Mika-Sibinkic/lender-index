export interface SendArgs {
  from: string
  to: string
  subject: string
  text: string
  html: string
}

export interface SendResult {
  messageId: string
}

/**
 * Microsoft Graph email client — delegated `Mail.Send` against the signed-in
 * user's mailbox. The token comes from a caller-supplied async getter so the
 * factory in ./client.ts can swap in either an env-var stub (M3c) or a
 * refresh-token flow (M3d).
 */
export class GraphEmailClient {
  constructor(private readonly getToken: () => Promise<string>) {}

  async sendOnBehalf(args: SendArgs): Promise<SendResult> {
    const token = await this.getToken()
    const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          subject: args.subject,
          body: { contentType: 'HTML', content: args.html },
          toRecipients: [{ emailAddress: { address: args.to } }],
        },
        saveToSentItems: true,
      }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Graph sendMail failed: ${res.status} ${detail}`)
    }
    return { messageId: res.headers.get('x-ms-request-id') ?? '' }
  }
}
