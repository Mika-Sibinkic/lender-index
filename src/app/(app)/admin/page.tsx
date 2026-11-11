import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { UsersTable, type AdminUser } from './users-table'

export const dynamic = 'force-dynamic'

export default async function AdminPage() {
  const { userId } = await auth()
  if (!userId) redirect('/sign-in')

  const admin = getSupabaseAdmin()
  const { data: me } = await admin
    .from('users')
    .select('id,role')
    .eq('clerk_user_id', userId)
    .single()
  if (!me || me.role !== 'admin') {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16 text-center text-sm text-muted-foreground">
        Admin access required to manage users.
      </div>
    )
  }

  const { data: users } = await admin
    .from('users')
    .select('id,email,role,last_seen_at')
    .order('email', { ascending: true })
    .returns<AdminUser[]>()

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="font-heading text-[24px] tracking-[-0.01em] text-foreground/95">
        Users &amp; roles
      </h1>
      <p className="mt-1 mb-6 text-[13px] text-muted-foreground">
        Whitelisted accounts sync here on first sign-in as{' '}
        <span className="font-medium">editor</span> — they can add and edit lenders straight away.
        Promote to <span className="font-medium">admin</span> to also allow import and user
        management, or demote to <span className="font-medium">viewer</span> for read-only. You
        can&apos;t remove your own admin role.
      </p>
      <div className="rounded-md border border-border/70 bg-card/40">
        <UsersTable users={users ?? []} currentUserId={me.id} />
      </div>
    </div>
  )
}
