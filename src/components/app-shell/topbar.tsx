import Link from 'next/link'
import { UserButton } from '@clerk/nextjs'
import { auth } from '@clerk/nextjs/server'
import { CreateDialog } from '@/components/funding-sources/create-dialog'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { APP_NAME, LOGO_URL, ORG_NAME } from '@/lib/config/org'
import { BrandMark } from '@/components/app-shell/brand-mark'

async function currentUserIsAdmin(): Promise<boolean> {
  try {
    const { userId } = await auth()
    if (!userId) return false
    const admin = getSupabaseAdmin()
    const { data } = await admin
      .from('users')
      .select('role')
      .eq('clerk_user_id', userId)
      .single()
    return data?.role === 'admin'
  } catch {
    return false
  }
}

export async function Topbar() {
  const isAdmin = await currentUserIsAdmin()
  return (
    <header className="sticky top-0 z-20 border-b border-border/80 bg-background/95 backdrop-blur-[8px]">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link
          href="/"
          className="group flex items-center gap-3"
          aria-label={`${ORG_NAME} — ${APP_NAME}`}
        >
          <BrandMark
            imgClassName="h-9 w-auto sm:h-10"
            textClassName="font-heading text-[20px] leading-none tracking-[-0.01em] text-foreground"
          />
          {/* With a logo the app name sits beside it; the text wordmark already is the app name. */}
          {LOGO_URL && (
            <>
              <span className="hidden h-4 w-px self-center bg-border sm:block" aria-hidden />
              <span className="hidden text-[10px] uppercase leading-none tracking-[0.22em] text-muted-foreground sm:block">
                {APP_NAME}
              </span>
            </>
          )}
        </Link>
        <div className="flex items-center gap-5">
          {isAdmin && (
            <>
              <Link
                href="/import"
                className="hidden text-[13px] text-muted-foreground transition-colors hover:text-foreground sm:inline-flex sm:items-center sm:gap-1.5"
              >
                Import
              </Link>
              <Link
                href="/outreach"
                className="hidden text-[13px] text-muted-foreground transition-colors hover:text-foreground sm:inline-flex sm:items-center sm:gap-1.5"
              >
                Outreach
              </Link>
              <Link
                href="/admin"
                className="hidden text-[13px] text-muted-foreground transition-colors hover:text-foreground sm:inline-flex sm:items-center sm:gap-1.5"
              >
                Admin
              </Link>
            </>
          )}
          {/* Outside the admin gate on purpose. Authorized users default to
              `editor`, not `admin`, so most users would never see it in there.
              Reading a report is a read; the whole team gets it. Plain anchor, not next/link, so the
              browser treats it as a file download. */}
          <a
            href="/api/reports/funding-sources?format=xlsx"
            className="hidden text-[13px] text-muted-foreground transition-colors hover:text-foreground sm:inline-flex sm:items-center sm:gap-1.5"
            title="Every funding source as a spreadsheet"
          >
            Report
          </a>
          {/* Same reasoning as Report — outside the admin gate. Activity is how
              the team reports a problem with the input attached, and the people
              who hit the problems are `editor`, not `admin`. */}
          <Link
            href="/activity"
            className="hidden text-[13px] text-muted-foreground transition-colors hover:text-foreground sm:inline-flex sm:items-center sm:gap-1.5"
            title="Searches, imports and record changes"
          >
            Activity
          </Link>
          <CreateDialog
            isAdmin={isAdmin}
            trigger={
              <button
                type="button"
                className="hidden text-[13px] text-muted-foreground transition-colors hover:text-foreground sm:inline-flex sm:items-center sm:gap-1.5"
              >
                <span className="text-foreground/60">＋</span> New source
              </button>
            }
          />
          <div className="h-4 w-px self-center bg-border" aria-hidden />
          <UserButton appearance={{ elements: { avatarBox: 'h-7 w-7' } }} />
        </div>
      </div>
    </header>
  )
}
