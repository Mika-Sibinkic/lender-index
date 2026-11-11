import { currentUser } from '@clerk/nextjs/server'
import { Topbar } from '@/components/app-shell/topbar'
import { syncCurrentUser } from '@/lib/auth/sync-user'
import { isAuthorizedEmail } from '@/lib/auth/authorized'
import { AccessDenied } from '@/components/app-shell/access-denied'
import { AiStatusBanner } from '@/components/app-shell/ai-status-banner'

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Whitelist gate: a valid Clerk session is not enough — the email must be on
  // the allowlist (AUTH_ALLOWED_EMAIL_DOMAINS / AUTH_ALLOWED_EMAILS). Mirrors the API
  // guard (requireAuthorizedApiUser) and RLS (_is_authorized_user).
  const user = await currentUser()
  const email =
    user?.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress ??
    user?.emailAddresses[0]?.emailAddress
  if (!isAuthorizedEmail(email)) {
    return <AccessDenied email={email} />
  }

  await syncCurrentUser()
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Topbar />
      {/* Tells the team what is and isn't working the moment they open the app,
          instead of after a failed import. Renders nothing when healthy. */}
      <AiStatusBanner />
      <main className="flex-1">{children}</main>
    </div>
  )
}
