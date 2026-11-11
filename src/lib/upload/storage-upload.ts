'use client'

import { getSupabaseBrowser } from '@/lib/supabase/client'

export const PARSE_BUCKET = 'parse-uploads'

/**
 * Files at or above this size are routed through Supabase Storage instead of a
 * multipart POST, because Vercel rejects function request bodies over 4.5 MB
 * (FUNCTION_PAYLOAD_TOO_LARGE). Kept comfortably under 4.5 MB to leave room for
 * multipart framing overhead.
 */
export const LARGE_FILE_THRESHOLD = 4 * 1024 * 1024 // 4 MB

export interface StorageUploadRef {
  storage_path: string
  file_name: string
  content_type: string
  file_size: number
}

/**
 * Upload a file straight to Supabase Storage (browser → Supabase), bypassing
 * Vercel's 4.5 MB function body limit, and return a reference the parse routes
 * resolve server-side. Throws on failure so callers can surface a toast.
 */
export async function uploadToStorage(
  file: File,
  kind: 'parse' | 'deal',
): Promise<StorageUploadRef> {
  const contentType = file.type || 'application/octet-stream'

  const signRes = await fetch('/api/uploads/sign', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file_name: file.name, content_type: contentType, kind }),
  })
  if (!signRes.ok) {
    const err = await signRes.json().catch(() => ({}))
    throw new Error(
      typeof err?.error === 'string' ? err.error : `upload sign failed (HTTP ${signRes.status})`,
    )
  }
  const { path, token } = (await signRes.json()) as { path: string; token: string }

  const supabase = getSupabaseBrowser()
  const { error } = await supabase.storage
    .from(PARSE_BUCKET)
    .uploadToSignedUrl(path, token, file, { contentType })
  if (error) {
    throw new Error(`upload failed: ${error.message}`)
  }

  return {
    storage_path: path,
    file_name: file.name,
    content_type: contentType,
    file_size: file.size,
  }
}
