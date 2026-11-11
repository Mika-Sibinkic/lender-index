import { NextRequest, NextResponse } from 'next/server'
import { requireAuthorizedApiUser } from '@/lib/auth/require-authorized'
import { z } from 'zod'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { indexDocumentChunks } from '@/lib/embeddings/chunks'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const Body = z.object({
  body_text: z.string().min(1),
  file_url: z.string().optional(),
  file_type: z.string().optional(),
  provider: z.string().optional(),
  document_id: z.string().uuid().optional(),
})

/**
 * POST /api/funding-sources/[id]/documents — chunk + embed an uploaded
 * document body so it's searchable via the doc-chunk kNN path in
 * /api/search. Authed editors only.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireAuthorizedApiUser()
  if (!authz.ok) return authz.response
  const { userId } = authz

  const { id: fundingSourceId } = await params
  const parsed = Body.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const admin = getSupabaseAdmin()
  const { data: user } = await admin
    .from('users')
    .select('role')
    .eq('clerk_user_id', userId)
    .single()
  if (!user || !['admin', 'editor'].includes(user.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { data: fs } = await admin
    .from('funding_sources')
    .select('id')
    .eq('id', fundingSourceId)
    .single()
  if (!fs) return NextResponse.json({ error: 'funding_source not found' }, { status: 404 })

  const result = await indexDocumentChunks(admin, {
    fundingSourceId,
    documentId: parsed.data.document_id,
    bodyText: parsed.data.body_text,
    fileUrl: parsed.data.file_url,
    fileType: parsed.data.file_type,
    provider: parsed.data.provider,
  })

  return NextResponse.json(result)
}

/** GET — list chunks for a funding source (admin telemetry / debug). */
export async function GET(
  _: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireAuthorizedApiUser()
  if (!authz.ok) return authz.response
  const { userId } = authz
  const { id } = await params
  const admin = getSupabaseAdmin()
  const { data: docs } = await admin
    .from('funding_source_documents')
    .select('id, file_url, file_type, provider, indexed_at, uploaded_at')
    .eq('funding_source_id', id)
    .order('uploaded_at', { ascending: false })
  const { data: counts } = await admin
    .from('funding_source_doc_chunks')
    .select('document_id')
    .eq('funding_source_id', id)
  const grouped: Record<string, number> = {}
  for (const c of counts ?? []) {
    grouped[c.document_id] = (grouped[c.document_id] ?? 0) + 1
  }
  return NextResponse.json({
    documents: (docs ?? []).map((d) => ({ ...d, chunk_count: grouped[d.id] ?? 0 })),
  })
}
