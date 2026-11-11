import 'server-only'
import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { isAuthorizedEmail } from './authorized'

/**
 * Server-side auth gate for API routes.
 *
 * `auth.protect()` in middleware only proves a valid Clerk session exists — it
 * does NOT restrict WHICH email signed in. Because most routes use the
 * service-role admin client (RLS bypassed), the email whitelist must be
 * enforced here in app code, or a non-whitelisted Clerk signup could read
 * lender data. This is that enforcement.
 *
 * Returns the userId + email on success, or a ready 401/403 NextResponse.
 *
 * Email source: prefer the session-token claim (zero extra round-trip — set
 * `email` in the Clerk session token to enable). Falls back to currentUser()
 * so it is correct even before that dashboard optimization is applied.
 */

type Ok = { ok: true; userId: string; email: string }
type Err = { ok: false; response: NextResponse }

async function resolveEmail(
  sessionClaims: Record<string, unknown> | null | undefined,
): Promise<string | undefined> {
  const claimEmail =
    typeof sessionClaims?.email === 'string' ? (sessionClaims.email as string) : undefined
  if (claimEmail) return claimEmail
  const user = await currentUser()
  if (!user) return undefined
  const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)
  return primary?.emailAddress ?? user.emailAddresses[0]?.emailAddress
}

export async function requireAuthorizedApiUser(): Promise<Ok | Err> {
  const { userId, sessionClaims } = await auth()
  if (!userId) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
    }
  }
  const email = await resolveEmail(sessionClaims as Record<string, unknown> | null)
  if (!isAuthorizedEmail(email)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'forbidden: this account is not authorized for this app' },
        { status: 403 },
      ),
    }
  }
  return { ok: true, userId, email: email! }
}
