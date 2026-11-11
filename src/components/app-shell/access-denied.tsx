import { SignOutButton } from '@clerk/nextjs'
import { APP_NAME, ORG_NAME } from '@/lib/config/org'

/**
 * Shown when a valid Clerk session belongs to an email outside the allowlist
 * (AUTH_ALLOWED_EMAIL_DOMAINS / AUTH_ALLOWED_EMAILS). The API layer and RLS already
 * refuse such accounts; this is the user-facing wall so they never see the app.
 */
export function AccessDenied({ email }: { email?: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-6">
      <div className="max-w-md text-center space-y-4">
        <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          {APP_NAME}
        </div>
        <h1 className="text-xl font-semibold text-foreground">Access restricted</h1>
        <p className="text-sm text-muted-foreground">
          {email ? (
            <>
              <span className="font-mono text-foreground/90">{email}</span> is not authorized
              for this application.
            </>
          ) : (
            <>This account is not authorized for this application.</>
          )}{' '}
          Access is limited to {ORG_NAME} accounts. If you believe this is a mistake,
          contact your administrator.
        </p>
        <div className="pt-2">
          <SignOutButton>
            <button className="rounded-md border border-border/70 bg-card px-4 py-2 text-sm text-foreground transition-colors hover:bg-muted">
              Sign out
            </button>
          </SignOutButton>
        </div>
      </div>
    </div>
  )
}
