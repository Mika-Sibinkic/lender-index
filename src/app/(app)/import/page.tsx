import { redirect } from 'next/navigation'
import { auth } from '@clerk/nextjs/server'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { ImportDropzone } from '@/components/funding-sources/import-dropzone'

export default async function ImportPage() {
  const { userId } = await auth()
  if (!userId) redirect('/sign-in')

  const admin = getSupabaseAdmin()
  const { data: user } = await admin
    .from('users')
    .select('role')
    .eq('clerk_user_id', userId)
    .single()
  if (user?.role !== 'admin') {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16 text-center text-sm text-muted-foreground">
        Admin access required to import funding-source data.
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="font-heading text-[24px] tracking-[-0.01em] text-foreground/95">
        Import funding sources
      </h1>
      <p className="mt-1 mb-6 text-[13px] text-muted-foreground">
        Existing lenders update in place, matched on company name. New ones are added.
      </p>
      <ImportDropzone />
    </div>
  )
}
