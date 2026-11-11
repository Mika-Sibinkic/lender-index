/**
 * POST   /api/funding-sources/[id]/tags         { tagId }  → apply
 * DELETE /api/funding-sources/[id]/tags?tagId=  → remove
 *
 * Editor or admin only (RLS enforces; we double-check here for clarity).
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAuthorizedApiUser } from '@/lib/auth/require-authorized'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { applyTag, removeTag } from '@/lib/tags/repo'

async function requireEditor(userId: string) {
  const admin = getSupabaseAdmin()
  const { data } = await admin
    .from('users')
    .select('id, role')
    .eq('clerk_user_id', userId)
    .single()
  return data && ['admin', 'editor'].includes(data.role) ? data : null
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authz = await requireAuthorizedApiUser()
  if (!authz.ok) return authz.response
  const { userId } = authz
  const user = await requireEditor(userId)
  if (!user) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const { id } = await params
  const body = await req.json().catch(() => ({}))
  if (typeof body?.tagId !== 'string') {
    return NextResponse.json({ error: 'tagId required' }, { status: 400 })
  }

  try {
    await applyTag(getSupabaseAdmin(), {
      fundingSourceId: id,
      tagId: body.tagId,
      userId: user.id,
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'failed' },
      { status: 500 },
    )
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authz = await requireAuthorizedApiUser()
  if (!authz.ok) return authz.response
  const { userId } = authz
  const user = await requireEditor(userId)
  if (!user) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const { id } = await params
  const tagId = req.nextUrl.searchParams.get('tagId')
  if (!tagId) return NextResponse.json({ error: 'tagId required' }, { status: 400 })

  try {
    await removeTag(getSupabaseAdmin(), { fundingSourceId: id, tagId })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'failed' },
      { status: 500 },
    )
  }
}
