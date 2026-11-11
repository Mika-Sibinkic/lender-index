import { NextRequest, NextResponse } from 'next/server'
import { requireAuthorizedApiUser } from '@/lib/auth/require-authorized'
import { z } from 'zod'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { normalizeContact, needsNormalization } from '@/lib/contacts/normalize'

const requestSchema = z.object({
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  full_name: z.string().nullable().optional(),
  company: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  source_text: z.string().nullable().optional(),
  force: z.boolean().optional(),
})

export async function POST(req: NextRequest) {
  const authz = await requireAuthorizedApiUser()
  if (!authz.ok) return authz.response
  const { userId } = authz

  // Role gate: contact normalization runs an LLM write-assist, so it matches the
  // other mutating/AI routes (e.g. /api/closed-deals) — admin or editor only.
  const admin = getSupabaseAdmin()
  const { data: user } = await admin
    .from('users')
    .select('id, role')
    .eq('clerk_user_id', userId)
    .single()
  if (!user || !['admin', 'editor'].includes(user.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const body = await req.json()
  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { force, ...raw } = parsed.data
  if (!force && !needsNormalization(raw)) {
    return NextResponse.json({ normalized: null, skipped: true })
  }

  try {
    const normalized = await normalizeContact(admin, raw)
    return NextResponse.json({ normalized, skipped: false })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
