import { SignIn } from '@clerk/nextjs'
import { BrandMark } from '@/components/app-shell/brand-mark'
import { APP_NAME, ORG_NAME } from '@/lib/config/org'

export const metadata = { title: `Sign in · ${APP_NAME}` }

export default function Page() {
  return (
    <div className="min-h-screen grid place-items-center p-4">
      <div className="flex flex-col items-center gap-8">
        <div className="flex flex-col items-center gap-2">
          <BrandMark
            imgClassName="h-12 w-auto"
            textClassName="font-heading text-[28px] leading-tight tracking-[-0.01em]"
          />
          <p className="text-xs text-muted-foreground">
            Access is limited to {ORG_NAME} accounts.
          </p>
        </div>
        <SignIn />
      </div>
    </div>
  )
}
