import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuthorizedApiUser } from '@/lib/auth/require-authorized'
import { getSupabaseAdmin } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

/**
 * POST /api/uploads/sign
 *
 * Mints a one-time, service-role-signed Supabase Storage upload URL so the
 * browser can push a file straight to storage — bypassing Vercel's hard 4.5 MB
 * function request-body limit (FUNCTION_PAYLOAD_TOO_LARGE). The parse routes
 * then fetch the object server-side. See 0019_parse_uploads_bucket.sql.
 *
 * Only whitelisted users with an `admin` or `editor` role can obtain a token;
 * the path is namespaced per user.
 */

export const PARSE_BUCKET = 'parse-uploads'

const Body = z.object({
  file_name: z.string().min(1).max(255),
  content_type: z.string().min(1).max(255).optional(),
  kind: z.enum(['parse', 'deal']).default('parse'),
})

function safeName(name: string): string {
  return (name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'upload')
}

export async function POST(req: NextRequest) {
  const authz = await requireAuthorizedApiUser()
  if (!authz.ok) return authz.response
  const { userId } = authz

  // Role gate: a signed upload URL is the front half of a parse write, so it
  // matches the other mutating/AI routes (e.g. /api/contacts/normalize) —
  // admin or editor only.
  const admin = getSupabaseAdmin()
  const { data: user } = await admin
    .from('users')
    .select('id, role')
    .eq('clerk_user_id', userId)
    .single()
  if (!user || !['admin', 'editor'].includes(user.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }
  const { file_name, kind } = parsed.data

  const path = `${kind}/${userId}/${crypto.randomUUID()}-${safeName(file_name)}`
  const { data, error } = await admin.storage.from(PARSE_BUCKET).createSignedUploadUrl(path)
  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? 'could not sign upload' },
      { status: 500 },
    )
  }
  return NextResponse.json({ path: data.path, token: data.token })
}
