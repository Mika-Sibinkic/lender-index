import { auth } from '@clerk/nextjs/server'
import { FilterBar } from '@/components/funding-sources/filter-bar'
import { ListTable } from '@/components/funding-sources/list-table'
import {
  buildFundingSourceQuery,
  listFundingSources,
} from '@/lib/queries/funding-sources'
import { getSupabaseServer } from '@/lib/supabase/server'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { listTags } from '@/lib/tags/repo'

async function currentUserIsAdmin(): Promise<boolean> {
  try {
    const { userId } = await auth()
    if (!userId) return false
    const { data } = await getSupabaseAdmin()
      .from('users')
      .select('role')
      .eq('clerk_user_id', userId)
      .single()
    return data?.role === 'admin'
  } catch {
    return false
  }
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const filters = buildFundingSourceQuery(params)
  const supabase = await getSupabaseServer()
  const [rows, tags, isAdmin] = await Promise.all([
    listFundingSources(filters),
    listTags(supabase),
    currentUserIsAdmin(),
  ])
  return (
    <>
      <FilterBar tags={tags} isAdmin={isAdmin} />
      <ListTable rows={rows} />
    </>
  )
}
