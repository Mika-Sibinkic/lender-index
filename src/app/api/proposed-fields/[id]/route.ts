import { NextRequest, NextResponse } from 'next/server'
import { requireAuthorizedApiUser } from '@/lib/auth/require-authorized'
import { getSupabaseAdmin } from '@/lib/supabase/admin'

async function requireAdmin(userId: string) {
  const admin = getSupabaseAdmin()
  const { data } = await admin
    .from('users')
    .select('id, role')
    .eq('clerk_user_id', userId)
    .single()
  return data && data.role === 'admin' ? data : null
}

/**
 * POST /api/proposed-fields/[id] — approve and apply the field.
 * Calls the admin-gated apply_proposed_field(uuid) RPC which atomically
 * `alter table funding_sources add column if not exists` + flips status.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authz = await requireAuthorizedApiUser()
  if (!authz.ok) return authz.response
  const { userId } = authz

  const user = await requireAdmin(userId)
  if (!user) return NextResponse.json({ error: 'admin required' }, { status: 403 })

  const { id } = await params
  const admin = getSupabaseAdmin()

  // Belt-and-suspenders: RPC also enforces admin via _is_admin(), but the
  // SDK gateway here checks our app's users table directly.
  const { error: rpcErr } = await admin.rpc('apply_proposed_field', { p_id: id })
  if (rpcErr) {
    return NextResponse.json({ error: rpcErr.message }, { status: 400 })
  }

  // Mark approver
  await admin
    .from('proposed_field')
    .update({ approved_by: user.id })
    .eq('id', id)

  return NextResponse.json({ ok: true })
}

/**
 * DELETE /api/proposed-fields/[id] — reject (no column added).
 */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authz = await requireAuthorizedApiUser()
  if (!authz.ok) return authz.response
  const { userId } = authz

  const user = await requireAdmin(userId)
  if (!user) return NextResponse.json({ error: 'admin required' }, { status: 403 })

  const { id } = await params
  const admin = getSupabaseAdmin()

  const { error } = await admin
    .from('proposed_field')
    .update({ status: 'rejected', approved_by: user.id })
    .eq('id', id)
    .eq('status', 'pending')

  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ ok: true })
}
