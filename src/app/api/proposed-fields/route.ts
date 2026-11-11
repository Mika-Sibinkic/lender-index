import { NextRequest, NextResponse } from 'next/server'
import { requireAuthorizedApiUser } from '@/lib/auth/require-authorized'
import { getSupabaseAdmin } from '@/lib/supabase/admin'

export async function GET(req: NextRequest) {
  const authz = await requireAuthorizedApiUser()
  if (!authz.ok) return authz.response

  const admin = getSupabaseAdmin()
  const status = req.nextUrl.searchParams.get('status') ?? 'pending'

  const { data, error } = await admin
    .from('proposed_field')
    .select('id, name, data_type, example_value, occurrences, status, created_at, applied_at')
    .eq('status', status)
    .order('occurrences', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ proposals: data ?? [] })
}
